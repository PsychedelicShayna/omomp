import type { Agent } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { jsBackend, juliaBackend, pythonBackend, rubyBackend } from "../eval";
import type { ExecutorBackend, ExecutorBackendResult } from "../eval/backend";
import { disposeJuliaKernelSessionsByOwner } from "../eval/jl/executor";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import { disposeRubyKernelSessionsByOwner } from "../eval/rb/executor";
import { defaultEvalSessionId } from "../eval/session-id";
import type { ExtensionRunner } from "../extensibility/extensions";
import type { ToolSession } from "../tools";
import { outputMeta } from "../tools/output-meta";
import { evalBackendRegistry, extensionBackendAdapter, invokeEvalCell } from "./eval-service";
import type { EvalExecutionMessage } from "./messages";
import type { SessionManager } from "./session-manager";

export interface EvalRunnerHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	extensionRunner(): ExtensionRunner | undefined;
	toolSession(): ToolSession;
	isStreaming(): boolean;
	appendSessionMessage(message: EvalExecutionMessage): void;
}

export interface UserEvalOptions {
	excludeFromContext?: boolean;
	reset?: boolean;
	/** Prefix alias selected by the user; defaults to the resolved language token. */
	alias?: string;
}

/** Owns user-initiated generic eval execution and retained backend lifecycle. */
export class EvalRunner {
	readonly #kernelOwnerId: string;
	readonly #parentSessionId: string | undefined;
	readonly #host: EvalRunnerHost;
	#abortControllers = new Set<AbortController>();
	#pendingMessages: EvalExecutionMessage[] = [];
	#activeExecutions = new Set<Promise<unknown>>();
	#disposing = false;

	constructor(host: EvalRunnerHost, options: { kernelOwnerId: string; parentSessionId: string | undefined }) {
		this.#host = host;
		this.#kernelOwnerId = options.kernelOwnerId;
		this.#parentSessionId = options.parentSessionId;
	}

	async execute(
		language: string,
		code: string,
		onChunk?: (chunk: string) => void,
		options?: UserEvalOptions,
	): Promise<ExecutorBackendResult> {
		const excludeFromContext = options?.excludeFromContext === true;
		const cwd = this.#host.sessionManager.getCwd();
		this.assertExecutionAllowed();
		const abortController = new AbortController();
		const execution = (async () => {
			const extensionRunner = this.#host.extensionRunner();
			if (extensionRunner?.hasHandlers("user_eval")) {
				const hookResult = await extensionRunner.emitUserEval({
					type: "user_eval",
					language,
					alias: options?.alias ?? language,
					code,
					excludeFromContext,
					cwd,
				});
				this.assertExecutionAllowed();
				if (hookResult?.result) {
					this.recordResult(language, code, hookResult.result, options);
					return hookResult.result;
				}
			}

			const session = this.#host.toolSession();
			const backend = await this.#resolveBackend(language, session);
			const sessionId =
				this.getSessionId() ??
				defaultEvalSessionId({ cwd, getSessionFile: () => this.#host.sessionManager.getSessionFile() ?? null });
			const result = await invokeEvalCell(backend, code, {
				cwd,
				sessionId,
				sessionFile: this.#host.sessionManager.getSessionFile() ?? undefined,
				kernelOwnerId: this.#kernelOwnerId,
				signal: abortController.signal,
				session,
				reset: options?.reset === true,
				onChunk: onChunk ?? (() => {}),
			});
			this.recordResult(backend.id, code, result, options);
			return result;
		})();
		return await this.trackExecution(execution, abortController);
	}

	/** Compatibility caller surface; new user-input routing calls execute("py", ...). */
	executePython(code: string, onChunk?: (chunk: string) => void, options?: UserEvalOptions): Promise<ExecutorBackendResult> {
		return this.execute("py", code, onChunk, options);
	}

	async #resolveBackend(token: string, session: ToolSession): Promise<ExecutorBackend> {
		const builtin: Record<string, ExecutorBackend> = {
			py: pythonBackend,
			python: pythonBackend,
			js: jsBackend,
			javascript: jsBackend,
			rb: rubyBackend,
			ruby: rubyBackend,
			jl: juliaBackend,
			julia: juliaBackend,
		};
		const backend = builtin[token] ?? (() => {
			const registered = evalBackendRegistry(this.#host.sessionManager).resolve(token);
			return registered ? extensionBackendAdapter(registered) : undefined;
		})();
		if (!backend) throw new Error(`Unknown eval backend: ${token}`);
		if (!(await backend.isAvailable(session))) throw new Error(`Eval backend "${token}" is unavailable`);
		return backend;
	}

	assertExecutionAllowed(): void {
		if (this.#disposing) throw new Error("Eval execution is unavailable while session disposal is in progress");
	}

	trackExecution<T>(execution: Promise<T>, abortController: AbortController): Promise<T> {
		this.#abortControllers.add(abortController);
		this.#activeExecutions.add(execution);
		void execution.finally(() => {
			this.#abortControllers.delete(abortController);
			this.#activeExecutions.delete(execution);
		}).catch(() => undefined);
		return execution;
	}

	recordResult(language: string, code: string, result: ExecutorBackendResult, options?: UserEvalOptions): void {
		const message: EvalExecutionMessage = {
			role: "evalExecution",
			language,
			code,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			meta: outputMeta().truncationFromSummary(result, { direction: "tail" }).get(),
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};
		if (this.#host.isStreaming()) this.#pendingMessages.push(message);
		else this.#host.appendSessionMessage(message);
	}

	abort(): void {
		if (this.#abortControllers.size === 0) return;
		for (const controller of this.#abortControllers) controller.abort();
		void evalBackendRegistry(this.#host.sessionManager).interrupt();
	}

	get isRunning(): boolean { return this.#abortControllers.size > 0; }
	get hasPendingMessages(): boolean { return this.#pendingMessages.length > 0; }
	getKernelOwnerId(): string { return this.#kernelOwnerId; }
	getSessionId(): string | null {
		if (this.#parentSessionId !== undefined) return this.#parentSessionId;
		return defaultEvalSessionId({
			cwd: this.#host.sessionManager.getCwd(),
			getSessionFile: () => this.#host.sessionManager.getSessionFile() ?? null,
		});
	}
	flushPending(): void {
		for (const message of this.#pendingMessages) this.#host.appendSessionMessage(message);
		this.#pendingMessages = [];
	}
	beginDispose(): void { this.#disposing = true; }

	async disposeKernels(): Promise<void> {
		const settled = await this.#prepareExecutionsForDispose();
		if (!settled) logger.warn("Detaching retained eval-kernel ownership while eval execution is still active");
		const results = await Promise.allSettled([
			disposeKernelSessionsByOwner(this.#kernelOwnerId),
			disposeRubyKernelSessionsByOwner(this.#kernelOwnerId),
			disposeJuliaKernelSessionsByOwner(this.#kernelOwnerId),
			disposeVmContextsByOwner(this.#kernelOwnerId),
			evalBackendRegistry(this.#host.sessionManager).dispose(),
		]);
		const errors = results.flatMap(result => (result.status === "rejected" ? [result.reason] : []));
		if (errors.length) throw new AggregateError(errors, "Failed to dispose one or more eval kernels");
	}

	async #waitForExecutionsToSettle(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (this.#activeExecutions.size) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) return false;
			const settled = await Promise.race([
				Promise.allSettled([...this.#activeExecutions]).then(() => true),
				Bun.sleep(remaining).then(() => false),
			]);
			if (!settled && this.#activeExecutions.size) return false;
		}
		return true;
	}
	async #prepareExecutionsForDispose(): Promise<boolean> {
		if (await this.#waitForExecutionsToSettle(3_000)) return true;
		logger.warn("Aborting active eval execution during dispose before retained kernel cleanup");
		this.abort();
		return await this.#waitForExecutionsToSettle(1_000);
	}
}
