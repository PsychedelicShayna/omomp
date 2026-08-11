import * as fs from "node:fs/promises";
import path from "node:path";
import type { Usage } from "@oh-my-pi/pi-ai";
import type { AgentProgress, SingleResult } from "../types";
import { externalHarnessEnv, type ExternalHarnessAdapter, type ExternalHarnessInput } from "./types";

const PYTHON = "/home/shayna/.omp/python-env/bin/python";
const SIDECAR = path.join(import.meta.dir, "claude-sidecar.py");
const MAX_FRAME_BYTES = 1_048_576;
const TERMINATE_GRACE_MS = 2_000;
const MAX_RECENT_OUTPUT = 20;
const MAX_RECENT_TOOLS = 20;

type SidecarMessage =
	| { type: "metadata"; sessionId?: string; model?: string }
	| { type: "text"; text: string }
	| { type: "tool"; name: string; input: unknown }
	| {
			type: "result";
			output: string;
			sessionId?: string;
			error: boolean;
			turns: number;
			usage?: Record<string, number>;
			modelUsage?: Record<
				string,
				{
					inputTokens?: number;
					outputTokens?: number;
					cacheReadInputTokens?: number;
					cacheCreationInputTokens?: number;
					costUSD?: number;
				}
			>;
			reason?: string;
	  }
	| { type: "error"; error: string };

function externalModel(agent: ExternalHarnessInput["agent"]): string | undefined {
	const configured = agent.model?.[0];
	if (!configured) return undefined;
	const withoutThinking = configured.replace(/:(?:minimal|low|medium|high|max)$/i, "");
	return withoutThinking.includes("/") ? withoutThinking.slice(withoutThinking.lastIndexOf("/") + 1) : withoutThinking;
}

async function assertIsolation(input: ExternalHarnessInput): Promise<void> {
	if (!input.isolation.isolated) return;
	if (!input.isolation.worktree) throw new Error("External Claude writes require an OMP-created worktree");
	const [cwd, worktree] = await Promise.all([fs.realpath(input.cwd), fs.realpath(input.isolation.worktree)]);
	if (cwd !== worktree && !cwd.startsWith(`${worktree}${path.sep}`)) {
		throw new Error("External Claude cwd is outside the OMP-created isolated worktree");
	}
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		if (process.platform !== "win32") process.kill(-pid, signal);
		else process.kill(pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {}
	}
}

async function terminate(proc: Bun.Subprocess): Promise<void> {
	if (proc.exitCode !== null) return;
	killProcessGroup(proc.pid, "SIGTERM");
	const exited = await Promise.race([
		proc.exited.then(() => true),
		Bun.sleep(TERMINATE_GRACE_MS).then(() => false),
	]);
	if (!exited) killProcessGroup(proc.pid, "SIGKILL");
}
async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let buffered = "";
	for await (const chunk of stream) {
		buffered += decoder.decode(chunk, { stream: true });
		if (Buffer.byteLength(buffered) > MAX_FRAME_BYTES && !buffered.includes("\n")) {
			throw new Error("Claude sidecar output frame exceeded 1 MiB");
		}
		let newline = buffered.indexOf("\n");
		while (newline >= 0) {
			yield buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			newline = buffered.indexOf("\n");
		}
	}
	buffered += decoder.decode();
	if (buffered) yield buffered;
}


function usageFrom(message: Extract<SidecarMessage, { type: "result" }>): Usage | undefined {
	const raw = message.usage;
	if (!raw) return undefined;
	const input = raw.input_tokens ?? 0;
	const output = raw.output_tokens ?? 0;
	const cacheRead = raw.cache_read_input_tokens ?? 0;
	const cacheWrite = raw.cache_creation_input_tokens ?? 0;
	const totalCost = Object.values(message.modelUsage ?? {}).reduce(
		(sum, model) => sum + (model.costUSD ?? 0),
		0,
	);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totalCost },
	};
}

export class ClaudeExternalHarnessAdapter implements ExternalHarnessAdapter {
	async execute(input: ExternalHarnessInput): Promise<SingleResult> {
		let proc: Bun.Subprocess | undefined;
		let sendInterrupt: ((frame: unknown) => Promise<void>) | undefined;
		let aborting = false;
		const abort = () => {
			aborting = true;
			if (sendInterrupt) void sendInterrupt({ type: "interrupt" }).catch(() => {});
			if (proc) void terminate(proc);
		};
		input.signal.addEventListener("abort", abort, { once: true });
		if (input.signal.aborted) abort();
		try {
			if (aborting) throw new DOMException(String(input.signal.reason ?? "Claude run aborted"), "AbortError");
			await assertIsolation(input);
			if (aborting) throw new DOMException(String(input.signal.reason ?? "Claude run aborted"), "AbortError");
		} catch (error) {
			input.signal.removeEventListener("abort", abort);
			throw error;
		}
		const startedAt = Date.now();
		const task = input.prompt;
		const progress: AgentProgress = {
			index: 0,
			id: input.agentId,
			agent: input.agent.name,
			agentSource: input.agent.source,
			status: "running",
			task,
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 0,
			modelOverride: input.agent.model,
		};
		input.onProgress({ ...progress });
		try {
			proc = Bun.spawn([PYTHON, "-u", SIDECAR], {
				cwd: input.cwd,
				env: externalHarnessEnv({ OMP_EXTERNAL_HARNESS: "claude" }),
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				detached: process.platform !== "win32",
			});
		} catch (error) {
			input.signal.removeEventListener("abort", abort);
			throw error;
		}
		const writer = proc.stdin;
		const stdout = proc.stdout;
		const stderr = proc.stderr;
		if (
			writer === undefined ||
			typeof writer === "number" ||
			stdout === undefined ||
			typeof stdout === "number" ||
			stderr === undefined ||
			typeof stderr === "number"
		) {
			input.signal.removeEventListener("abort", abort);
			await terminate(proc);
			throw new Error("Claude sidecar did not expose piped standard streams");
		}
		const send = async (frame: unknown): Promise<void> => {
			const encoded = `${JSON.stringify(frame)}\n`;
			if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES) throw new Error("Claude sidecar input frame exceeded 1 MiB");
			writer.write(encoded);
			await writer.flush();
		};
		sendInterrupt = send;
		let final: Extract<SidecarMessage, { type: "result" }> | undefined;
		let failure: string | undefined;
		let output = "";
		let sessionId: string | undefined;
		let resolvedModel: string | undefined;
		try {
			if (aborting) throw new DOMException(String(input.signal.reason ?? "Claude run aborted"), "AbortError");
			await send({
				type: "start",
				agentId: input.agentId,
				prompt: input.prompt,
				cwd: input.cwd,
				isolation: input.isolation,
				tools: input.agent.tools ?? [],
				env: externalHarnessEnv({ OMP_AGENT_ID: input.agentId }),
				model: externalModel(input.agent),
				systemPrompt: [
					input.agent.systemPrompt,
					`OMP parent session: ${input.parent.parentSessionId}`,
					`OMP inherited extension state: ${JSON.stringify(input.parent.inheritedExtensionState)}`,
				].filter(Boolean).join("\n\n"),
			});
			for await (const line of lines(stdout)) {
				if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error("Claude sidecar output frame exceeded 1 MiB");
				const message = JSON.parse(line) as SidecarMessage;
				if (message.type === "metadata") {
					sessionId = message.sessionId ?? sessionId;
					resolvedModel = message.model ?? resolvedModel;
				} else if (message.type === "text") {
					output += message.text;
					progress.recentOutput = [...progress.recentOutput, message.text].slice(-MAX_RECENT_OUTPUT);
				} else if (message.type === "tool") {
					const args = JSON.stringify(message.input);
					progress.currentTool = message.name;
					progress.currentToolArgs = args;
					progress.currentToolStartMs = Date.now();
					progress.toolCount++;
					progress.recentTools = [...progress.recentTools, { tool: message.name, args, endMs: Date.now() }].slice(-MAX_RECENT_TOOLS);
				} else if (message.type === "result") {
					final = message;
					sessionId = message.sessionId ?? sessionId;
					progress.requests = message.turns;
					break;
				} else if (message.type === "error") {
					failure = message.error;
				}
				progress.durationMs = Date.now() - startedAt;
				input.onProgress({ ...progress });
			}
			writer.end();
			await proc.exited;
			if (!final && !failure) failure = (await new Response(stderr).text()).trim() || "Claude sidecar exited without a result";
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		} finally {
			input.signal.removeEventListener("abort", abort);
			await terminate(proc);
		}
		const usage = final ? usageFrom(final) : undefined;
		const error = failure ?? (final?.error ? final.reason || final.output || "Claude harness failed" : undefined);
		const aborted = aborting || input.signal.aborted;
		progress.status = aborted ? "aborted" : error ? "failed" : "completed";
		progress.durationMs = Date.now() - startedAt;
		progress.tokens = usage ? usage.input + usage.output + usage.cacheWrite : 0;
		progress.contextTokens = usage?.totalTokens;
		progress.resolvedModel = resolvedModel ? `anthropic/${resolvedModel}` : undefined;
		input.onProgress({ ...progress });
		return {
			index: 0,
			id: input.agentId,
			agent: input.agent.name,
			agentSource: input.agent.source,
			task,
			exitCode: error || aborted ? 1 : 0,
			output: final?.output || output,
			stderr: error ?? "",
			truncated: false,
			durationMs: progress.durationMs,
			tokens: progress.tokens,
			requests: final?.turns ?? 0,
			contextTokens: progress.contextTokens,
			modelOverride: input.agent.model,
			resolvedModel: progress.resolvedModel,
			error,
			aborted: aborted || undefined,
			abortReason: aborted ? String(input.signal.reason ?? "Interrupted") : undefined,
			usage,
			extractedToolData: { externalHarness: [{ provider: "claude", sessionId, modelUsage: final?.modelUsage }] },
		};
	}
}

export const claudeExternalHarnessAdapter: ExternalHarnessAdapter = new ClaudeExternalHarnessAdapter();
