// Shared subprocess-kernel plumbing for extension-provided eval backends.
//
// Speaks a small NDJSON protocol over stdin/stdout with a persistent
// interpreter subprocess (one per session). The host writes one JSON request
// per line ({id, code, cwd?, env?, silent?}); the runner replies with frames:
//   {type:"started", id}
//   {type:"stdout"|"stderr", id, data}
//   {type:"display"|"result", id, bundle}   # bundle = Jupyter-style MIME hash
//   {type:"error", id, ename, evalue, traceback:[...]}
//   {type:"done", id, status, executionCount, cancelled}
// A {type:"exit"} request (or stdin EOF) shuts the runner down.
//
// This protocol is shared by every language-specific runner script
// (ruby/runner.rb, julia/runner.jl, ...) so this file is intentionally
// language-agnostic: it only knows how to spawn a command, staged a script
// to disk, and speak the frame protocol above.

import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { FileSink } from "bun";
import {
	ensurePyToolBridge,
	registerPyToolBridge,
	resolveEvalUrlRoots,
	type PyToolBridgeEntry,
	type PyToolBridgeInfo,
} from "@earendil-works/pi-coding-agent";
import type { ToolSession } from "../../packages/coding-agent/src/tools";

/**
 * The slice of host-internal eval plumbing this extension borrows: the same
 * loopback tool bridge the Python backend uses, plus the internal-URL root
 * mapping its `read`/`write` helpers resolve against.
 */
export interface HostEvalBridge {
	ensurePyToolBridge(): Promise<PyToolBridgeInfo>;
	registerPyToolBridge(sessionId: string, runId: string, entry: PyToolBridgeEntry): () => void;
	resolveEvalUrlRoots(session: ToolSession): Record<string, string>;
}

/**
 * The extension loader remaps this bare host package to the running host,
 * including its bundled module graph in compiled binaries.
 *
 * Relative runtime imports pull host sources into the loader's rewrite graph
 * and break file import attributes. Computed absolute imports avoid that
 * rewrite but fail in compiled binaries: external sources cannot resolve
 * workspace dependencies such as @oh-my-pi/pi-utils outside /$bunfs.
 * Importing the host's exported bridge through its remapped bare specifier
 * avoids both problems and shares the host's existing bridge registry.
 */
const hostBridge: Promise<HostEvalBridge> = Promise.resolve({
	ensurePyToolBridge,
	registerPyToolBridge,
	resolveEvalUrlRoots,
});

export function hostEvalBridge(): Promise<HostEvalBridge> {
	return hostBridge;
}

/** Display output captured during eval execution — matches the host's EvalDisplayOutput shape. */
export type KernelDisplayOutput =
	| { type: "json"; data: unknown }
	| { type: "image"; data: string; mimeType: string }
	| { type: "markdown"; text?: string }
	| { type: "status"; event: { op: string; [key: string]: unknown } };

export interface KernelExecuteOptions {
	/** Runtime working directory applied immediately before this request executes. */
	cwd?: string;
	/** Managed runtime environment variables applied immediately before this request executes. */
	env?: Record<string, string | undefined>;
	signal?: AbortSignal;
	onChunk?: (text: string) => void;
	onDisplay?: (output: KernelDisplayOutput) => void;
	timeoutMs?: number;
	silent?: boolean;
	/**
	 * Protocol message id for this request. Callers that must correlate the
	 * request with an out-of-band registration (e.g. a tool bridge keyed by
	 * `${sessionId}:${runId}`) supply their own id; otherwise one is generated.
	 */
	id?: string;
}

export interface KernelExecuteResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	displayOutputs: KernelDisplayOutput[];
}

interface Frame {
	type: string;
	id?: string;
	data?: string;
	bundle?: Record<string, unknown>;
	ename?: string;
	evalue?: string;
	traceback?: string[];
	status?: string;
	cancelled?: boolean;
}

interface Pending {
	chunks: string[];
	displays: KernelDisplayOutput[];
	started: boolean;
	resolve: (result: KernelExecuteResult) => void;
	onStarted?: () => void;
	onInterrupt?: () => void;
	onChunk?: (text: string) => void;
	onDisplay?: (output: KernelDisplayOutput) => void;
}

const SHUTDOWN_GRACE_MS = 1_000;
const INTERRUPT_ESCALATION_MS = 5_000;

/** Render one Jupyter-style MIME bundle into output text + display outputs. */
export function renderBundle(bundle: Record<string, unknown>): { text: string; displays: KernelDisplayOutput[] } {
	const displays: KernelDisplayOutput[] = [];
	const status = bundle["application/x-omp-status"];
	if (status !== undefined && typeof status === "object" && status !== null) {
		displays.push({ type: "status", event: status as { op: string; [key: string]: unknown } });
		return { text: "", displays };
	}
	if (typeof bundle["image/png"] === "string")
		displays.push({ type: "image", data: bundle["image/png"], mimeType: "image/png" });
	if (typeof bundle["image/jpeg"] === "string")
		displays.push({ type: "image", data: bundle["image/jpeg"], mimeType: "image/jpeg" });
	if (bundle["application/json"] !== undefined) displays.push({ type: "json", data: bundle["application/json"] });
	if (typeof bundle["text/markdown"] === "string") {
		displays.push({ type: "markdown", text: bundle["text/markdown"] });
		return { text: "", displays };
	}
	if (typeof bundle["text/plain"] === "string") {
		const text = bundle["text/plain"];
		return { text: text.endsWith("\n") ? text : `${text}\n`, displays };
	}
	return { text: "", displays };
}

/** Write a runner script to a per-extension cache dir, keyed by content hash, and return its path. */
export async function stageRunnerScript(name: string, extension: string, content: string): Promise<string> {
	const dir = path.join(os.tmpdir(), "omomp-eval-langs");
	await Bun.write(path.join(dir, ".keep"), "");
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(content);
	const digest = hasher.digest("hex").slice(0, 16);
	const scriptPath = path.join(dir, `${name}-${digest}.${extension}`);
	const file = Bun.file(scriptPath);
	if (!(await file.exists())) {
		await Bun.write(scriptPath, content);
	}
	return scriptPath;
}

/** Probe whether `command` runs successfully within `timeoutMs`. */
export async function probeCommand(command: string[], cwd: string, timeoutMs = 5_000): Promise<boolean> {
	try {
		const proc = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		const timeout = new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), timeoutMs));
		const exited = proc.exited.then((code): "ok" | "fail" => (code === 0 ? "ok" : "fail"));
		const result = await Promise.race([exited, timeout]);
		if (result === "timeout") {
			proc.kill();
			return false;
		}
		return result === "ok";
	} catch {
		return false;
	}
}

/**
 * Persistent subprocess-backed kernel speaking the NDJSON frame protocol
 * above. One instance per session; `execute()` serializes requests (the
 * runner is single-threaded per cell) and resolves with the finished cell's
 * output/displays.
 */
export class SubprocessKernel {
	private proc: ReturnType<typeof Bun.spawn> | undefined;
	private stdin: FileSink | undefined;
	private readonly pending = new Map<string, Pending>();
	private lineBuffer = "";
	private stderrBuffer = "";
	private disposed = false;
	private exited = false;
	private queue: Promise<unknown> = Promise.resolve();

	private constructor(
		private readonly command: string[],
		private readonly cwd: string,
		private readonly env: Record<string, string>,
	) {}

	static async start(command: string[], cwd: string, env: Record<string, string>): Promise<SubprocessKernel> {
		const kernel = new SubprocessKernel(command, cwd, env);
		await kernel.spawn();
		return kernel;
	}

	private async spawn(): Promise<void> {
		const proc = Bun.spawn(this.command, {
			cwd: this.cwd,
			env: this.env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.proc = proc;
		this.stdin = proc.stdin;
		const stdout = this.pump(proc.stdout);
		const stderr = this.pumpStderr(proc.stderr);
		void proc.exited.then(async () => {
			await Promise.all([stdout, stderr]);
			this.exited = true;
			this.failAllPending("kernel process exited unexpectedly");
		});
	}

	private async pump(stream: ReadableStream<Uint8Array>): Promise<void> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				this.lineBuffer += decoder.decode(value, { stream: true });
				let newlineIndex: number;
				// biome-ignore lint: intentional reassignment loop
				while ((newlineIndex = this.lineBuffer.indexOf("\n")) >= 0) {
					if (newlineIndex > 64 * 1024 * 1024) throw new Error("kernel protocol frame exceeds 64 MiB");
					const line = this.lineBuffer.slice(0, newlineIndex);
					this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
					if (line.trim().length > 0) this.handleLine(line);
				}
				if (this.lineBuffer.length > 64 * 1024 * 1024) throw new Error("kernel protocol frame exceeds 64 MiB");
			}
		} catch (error) {
			this.failAllPending(`kernel output reader failed: ${error instanceof Error ? error.message : String(error)}`);
			void this.dispose();
		}
	}

	private async pumpStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				this.stderrBuffer += decoder.decode(value, { stream: true });
				if (this.stderrBuffer.length > 16_384) this.stderrBuffer = this.stderrBuffer.slice(-16_384);
			}
		} catch {
			// Reader closed; process teardown handles cleanup.
		}
	}

	private handleLine(line: string): void {
		let frame: Frame;
		try {
			frame = JSON.parse(line);
		} catch {
			return;
		}
		const id = frame.id;
		if (!id) return;
		const pending = this.pending.get(id);
		if (!pending) return;
		switch (frame.type) {
			case "started":
				pending.started = true;
				pending.onStarted?.();
				return;
			case "stdout":
			case "stderr": {
				const text = frame.data ?? "";
				pending.chunks.push(text);
				pending.onChunk?.(text);
				return;
			}
			case "display":
			case "result": {
				if (!frame.bundle) return;
				const { text, displays } = renderBundle(frame.bundle);
				if (text) {
					pending.chunks.push(text);
					pending.onChunk?.(text);
				}
				for (const display of displays) {
					pending.displays.push(display);
					pending.onDisplay?.(display);
				}
				return;
			}
			case "error": {
				const lines = [`${frame.ename ?? "Error"}: ${frame.evalue ?? ""}`, ...(frame.traceback ?? []).slice(1)];
				const text = `${lines.join("\n")}\n`;
				pending.chunks.push(text);
				pending.onChunk?.(text);
				return;
			}
			case "done": {
				this.pending.delete(id);
				pending.resolve({
					output: pending.chunks.join(""),
					exitCode: frame.status === "ok" ? 0 : 1,
					cancelled: frame.cancelled === true,
					displayOutputs: pending.displays,
				});
				return;
			}
			default:
				return;
		}
	}

	private failAllPending(reason: string): void {
		// The runner writes protocol frames on stdout; anything on stderr is the
		// interpreter itself dying (missing gem, prelude syntax error, OOM kill).
		// Without it a crash reads as a bare "exited unexpectedly".
		const diagnostics = this.stderrBuffer.trim();
		const detail = diagnostics ? `${reason}\n${diagnostics.slice(-4_000)}` : reason;
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			pending.resolve({
				output: `${pending.chunks.join("")}\n${detail}`,
				exitCode: 1,
				cancelled: false,
				displayOutputs: pending.displays,
			});
		}
	}

	/**
	 * Deliver SIGINT to the interpreter when a cell is in flight, for a host
	 * interrupt that does not travel through a per-cell `AbortSignal`. Idle
	 * runners ignore SIGINT, so this is a no-op with nothing executing.
	 */
	interrupt(): boolean {
		if (this.disposed) return false;
		for (const pending of this.pending.values()) {
			if (pending.started) {
				pending.onInterrupt?.();
				return true;
			}
		}
		return false;
	}

	private async writeLine(payload: string): Promise<void> {
		const sink = this.stdin;
		if (!sink) throw new Error("kernel stdin is not available");
		sink.write(`${payload}\n`);
		await sink.flush();
	}

	/** Execute one cell and resolve once the runner reports `done`. */
	execute(code: string, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		const cancelled = (): KernelExecuteResult => ({
			output: "",
			exitCode: 1,
			cancelled: true,
			displayOutputs: [],
		});
		if (options?.signal?.aborted) return Promise.resolve(cancelled());
		let dispatched = false;
		let abort!: () => void;
		const aborted = new Promise<KernelExecuteResult>(resolve => {
			abort = () => {
				if (!dispatched) resolve(cancelled());
			};
			options?.signal?.addEventListener("abort", abort, { once: true });
		});
		const queued = this.queue.then(() => {
			dispatched = true;
			options?.signal?.removeEventListener("abort", abort);
			if (options?.signal?.aborted) return cancelled();
			return this.executeNow(code, options);
		});
		this.queue = queued.catch(() => {});
		return Promise.race([queued, aborted]);
	}

	private async executeNow(code: string, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		if (this.disposed || this.exited) return this.deadResult();
		const id = options?.id ?? randomUUID();
		const envPayload: Record<string, string | null> = {};
		for (const key in options?.env) {
			envPayload[key] = options?.env[key] ?? null;
		}
		const request = JSON.stringify({
			id,
			code,
			cwd: options?.cwd,
			env: Object.keys(envPayload).length > 0 ? envPayload : undefined,
			silent: options?.silent ?? false,
		});

		const resultPromise = new Promise<KernelExecuteResult>(resolve => {
			this.pending.set(id, {
				chunks: [],
				displays: [],
				started: false,
				resolve,
				onChunk: options?.onChunk,
				onDisplay: options?.onDisplay,
			});
		});

		let interrupted = false;
		let escalationTimer: ReturnType<typeof setTimeout> | undefined;
		const sendInterrupt = () => {
			if (!this.pending.get(id)?.started || escalationTimer) return;
			this.proc?.kill("SIGINT");
			escalationTimer = setTimeout(() => {
				if (this.pending.has(id)) void this.dispose().catch(() => {});
			}, INTERRUPT_ESCALATION_MS);
		};
		const onAbort = () => {
			interrupted = true;
			sendInterrupt();
		};
		this.pending.get(id)!.onStarted = () => {
			if (interrupted) sendInterrupt();
		};
		this.pending.get(id)!.onInterrupt = onAbort;
		options?.signal?.addEventListener("abort", onAbort);
		if (options?.signal?.aborted) onAbort();

		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		if (options?.timeoutMs !== undefined) {
			timeoutTimer = setTimeout(onAbort, options.timeoutMs);
		}

		try {
			await this.writeLine(request);
			// A process that died before this request was registered never
			// triggers `failAllPending` for it, so the caller would wait on a
			// frame that can never arrive.
			if (this.exited && this.pending.delete(id)) return this.deadResult();
			const result = await resultPromise;
			return interrupted ? { ...result, cancelled: true } : result;
		} catch (error) {
			// Already resolved by `failAllPending`: that result is the real one.
			if (!this.pending.delete(id)) return await resultPromise;
			return this.deadResult(error instanceof Error ? error.message : String(error));
		} finally {
			options?.signal?.removeEventListener("abort", onAbort);
			if (escalationTimer) clearTimeout(escalationTimer);
			if (timeoutTimer) clearTimeout(timeoutTimer);
		}
	}

	/** Result for a request that can never run: the interpreter is already gone. */
	private deadResult(reason = "kernel process exited unexpectedly"): KernelExecuteResult {
		const diagnostics = this.stderrBuffer.trim();
		return {
			output: diagnostics ? `${reason}\n${diagnostics.slice(-4_000)}` : reason,
			exitCode: 1,
			cancelled: false,
			displayOutputs: [],
		};
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.failAllPending("kernel disposed");
		try {
			await this.writeLine(JSON.stringify({ type: "exit" }));
		} catch {
			// stdin already closed
		}
		const proc = this.proc;
		if (!proc) return;
		const exited = proc.exited.then(() => "exited" as const);
		const grace = new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), SHUTDOWN_GRACE_MS));
		const outcome = await Promise.race([exited, grace]);
		if (outcome === "timeout") {
			proc.kill("SIGKILL");
			await proc.exited;
		}
	}
}
