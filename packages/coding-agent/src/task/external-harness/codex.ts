import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { AgentProgress, SingleResult } from "../types";
import { externalHarnessEnv, type ExternalHarnessAdapter, type ExternalHarnessInput } from "./types";

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 128 * 1024;
const SHUTDOWN_GRACE_MS = 2_000;
const DESCENDANT_DEATH_MS = 5_000;
const MAX_OUTPUT_BYTES = 500_000;
const CODEX_MANIFEST_CAPABILITIES = ["bash", "edit", "glob", "grep", "read", "web_search", "write"] as const;
let scopeSequence = 0;

type JsonObject = Record<string, unknown>;
type PendingRequest = {
	generation: number;
	resolve: (value: JsonObject) => void;
	reject: (error: Error) => void;
};

function object(value: unknown): JsonObject | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: undefined;
}

function string(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function errorMessage(value: unknown): string {
	if (value instanceof Error) return value.message;
	return typeof value === "string" ? value : JSON.stringify(value);
}

function assertCodexCapabilities(input: ExternalHarnessInput): void {
	const granted = new Set(input.agent.tools ?? []);
	const missing = CODEX_MANIFEST_CAPABILITIES.filter(capability => !granted.has(capability));
	if (missing.length > 0) {
		throw new Error(
			"Codex external harness requires explicit grants for every indivisible app-server built-in " +
				`(shell, apply_patch, file/image inspection, and web search); missing OMP capabilities: ${missing.join(", ")}`,
		);
	}
}

async function selectSandbox(input: ExternalHarnessInput): Promise<"read-only" | "workspace-write"> {
	const tools = new Set(input.agent.tools ?? []);
	const explicitlyWritable = tools.has("bash") && (tools.has("edit") || tools.has("write"));
	if (!explicitlyWritable || !input.isolation.isolated || !input.isolation.worktree) return "read-only";
	const worktree = await realpath(input.isolation.worktree);
	const cwd = await realpath(input.cwd);
	const rel = relative(worktree, cwd);
	if (!isAbsolute(worktree) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
		throw new Error("refusing workspace-write outside the OMP-created isolated worktree");
	}
	if (input.isolation.repoRoot) {
		const repoRoot = await realpath(input.isolation.repoRoot);
		if (repoRoot === worktree) throw new Error("isolated worktree resolves to the source repository");
	}
	return "workspace-write";
}

function baseProgress(input: ExternalHarnessInput, startedAt: number): AgentProgress {
	return {
		index: 0,
		id: input.agentId,
		agent: input.agent.name,
		agentSource: input.agent.source,
		status: "running",
		task: input.prompt,
		description: input.agent.description,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: Date.now() - startedAt,
	};
}

function scopeUnit(agentId: string): string {
	const safeAgentId = agentId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "agent";
	return `omp-codex-${process.pid}-${++scopeSequence}-${safeAgentId}.scope`;
}

async function systemctl(...args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const process = Bun.spawn({
		cmd: ["systemctl", "--user", ...args],
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: externalHarnessEnv(),
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function inspectScope(unit: string): Promise<{ activeState?: string; controlGroup?: string; members: string[] }> {
	const result = await systemctl("show", unit, "--property=ActiveState", "--property=ControlGroup");
	if (result.exitCode !== 0) {
		if (/not found|could not be found|not loaded/i.test(result.stderr)) return { members: [] };
		throw new Error(`unable to verify Codex systemd scope ${unit}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
	}
	const properties = Object.fromEntries(
		result.stdout
			.trim()
			.split("\n")
			.map(line => line.split("=", 2) as [string, string]),
	);
	const controlGroup = properties.ControlGroup;
	let members: string[] = [];
	if (controlGroup) {
		try {
			members = (await readFile(resolve("/sys/fs/cgroup", controlGroup.replace(/^\/+/, ""), "cgroup.procs"), "utf8"))
				.trim()
				.split(/\s+/)
				.filter(Boolean);
		} catch (error) {
			const code = object(error)?.code;
			if (code !== "ENOENT") throw error;
		}
	}
	return { activeState: properties.ActiveState, controlGroup, members };
}

async function awaitScopeStarted(unit: string, child: { exitCode: number | null }): Promise<void> {
	const deadline = Date.now() + DESCENDANT_DEATH_MS;
	while (Date.now() < deadline) {
		const state = await inspectScope(unit);
		if (state.activeState === "active" && state.controlGroup) return;
		if (state.activeState === "failed" || child.exitCode !== null) {
			throw new Error(`Codex systemd scope ${unit} failed before becoming active`);
		}
		await Bun.sleep(25);
	}
	throw new Error(`Codex systemd scope ${unit} was not verifiably active before startup`);
}

async function cleanupScope(unit: string): Promise<void> {
	await systemctl("kill", "--kill-whom=all", "--signal=SIGTERM", unit);
	await Bun.sleep(SHUTDOWN_GRACE_MS);
	await systemctl("kill", "--kill-whom=all", "--signal=SIGKILL", unit);
	await systemctl("stop", unit);
	const deadline = Date.now() + DESCENDANT_DEATH_MS;
	while (Date.now() < deadline) {
		const state = await inspectScope(unit);
		if (state.members.length === 0 && (!state.activeState || state.activeState === "inactive" || state.activeState === "failed")) {
			await systemctl("reset-failed", unit);
			return;
		}
		await Bun.sleep(50);
	}
	const state = await inspectScope(unit);
	throw new Error(
		`Codex systemd scope ${unit} cleanup verification failed (state=${state.activeState ?? "missing"}, members=${state.members.join(",") || "none"})`,
	);
}
async function requireUserSystemd(): Promise<void> {
	const result = await systemctl("show-environment");
	if (result.exitCode !== 0) {
		throw new Error(
			`Codex external harness requires a reachable user systemd manager: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
		);
	}
}

/** Codex app-server 0.146.0 adapter. OMP remains the lifecycle and result owner. */
export const codexExternalHarnessAdapter: ExternalHarnessAdapter = {
	async execute(input: ExternalHarnessInput): Promise<SingleResult> {
		if (input.signal.aborted) {
			throw new DOMException(String(input.signal.reason ?? "Codex run aborted"), "AbortError");
		}
		// App-server 0.146.0 exposes command/file built-ins as an indivisible
		// capability set. Do not weaken manifest authority with prompt policy.
		assertCodexCapabilities(input);
		const startedAt = Date.now();
		let generation = 1;
		let requestId = 0;
		let threadId: string | undefined;
		let turnId: string | undefined;
		let output = "";
		let reasoning = "";
		let stderr = "";
		let tokens = 0;
		let truncated = false;
		let contextTokens: number | undefined;
		let contextWindow: number | undefined;
		let requests = 0;
		let toolCount = 0;
		let currentTool: string | undefined;
		let turnStatus: string | undefined;
		let turnFailure: string | undefined;
		let settled = false;
		const pending = new Map<number, PendingRequest>();
		const sandbox = await selectSandbox(input);
		const progress = baseProgress(input, startedAt);
		await requireUserSystemd();
		const unit = scopeUnit(input.agentId);
		const child = Bun.spawn({
			cmd: [
				"systemd-run",
				"--user",
				"--scope",
				"--quiet",
				"--collect",
				`--unit=${unit}`,
				"--property=KillMode=control-group",
				"--property=SendSIGKILL=yes",
				`--property=TimeoutStopSec=${Math.ceil(SHUTDOWN_GRACE_MS / 1_000)}s`,
				"codex",
				"app-server",
			],
			cwd: resolve(input.cwd),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: externalHarnessEnv({ OMP_EXTERNAL_HARNESS: "codex" }),
		});

		const emit = (status: AgentProgress["status"] = "running") => {
			progress.status = status;
			progress.durationMs = Date.now() - startedAt;
			progress.tokens = tokens;
			progress.contextTokens = contextTokens;
			progress.contextWindow = contextWindow;
			progress.requests = requests;
			progress.toolCount = toolCount;
			progress.currentTool = currentTool;
			progress.recentOutput = [...output.split("\n"), ...reasoning.split("\n")].filter(Boolean).slice(-20);
			input.onProgress({ ...progress, recentTools: [...progress.recentTools], recentOutput: [...progress.recentOutput] });
		};

		const send = (message: JsonObject) => {
			if (settled) throw new Error("Codex app-server connection is closed");
			child.stdin.write(`${JSON.stringify(message)}\n`);
			child.stdin.flush();
		};
		const request = (method: string, params: unknown): Promise<JsonObject> => {
			const id = ++requestId;
			const requestGeneration = generation;
			return new Promise((resolveRequest, rejectRequest) => {
				pending.set(id, { generation: requestGeneration, resolve: resolveRequest, reject: rejectRequest });
				send({ method, id, params });
			});
		};
		const deny = (id: unknown, method: string) => {
			if (typeof id !== "number" && typeof id !== "string") return;
			let result: JsonObject | undefined;
			switch (method) {
				case "item/commandExecution/requestApproval":
				case "item/fileChange/requestApproval":
					result = { decision: "decline" };
					break;
				case "execCommandApproval":
				case "applyPatchApproval":
					result = { decision: { denied: { rejection: "External harness runs never grant approvals" } } };
					break;
				case "mcpServer/elicitation/request":
					result = { action: "decline", content: null, _meta: null };
					break;
				case "item/tool/call":
					result = { contentItems: [], success: false };
					break;
			}
			if (result) send({ id, result });
			else send({ id, error: { code: -32601, message: `OMP denied unsupported server request: ${method}` } });
		};

		let completedResolve!: () => void;
		let completedReject!: (error: Error) => void;
		const completed = new Promise<void>((resolveCompleted, rejectCompleted) => {
			completedResolve = resolveCompleted;
			completedReject = rejectCompleted;
		});

		const handle = (message: JsonObject, messageGeneration: number) => {
			if (messageGeneration !== generation || settled) return;
			const id = message.id;
			if ((typeof id === "number" || typeof id === "string") && !message.method) {
				const numericId = typeof id === "number" ? id : Number(id);
				const waiter = pending.get(numericId);
				if (!waiter || waiter.generation !== generation) return;
				pending.delete(numericId);
				const protocolError = object(message.error);
				if (protocolError) waiter.reject(new Error(string(protocolError.message) ?? JSON.stringify(protocolError)));
				else waiter.resolve(object(message.result) ?? {});
				return;
			}
			const method = string(message.method);
			if (!method) return;
			const params = object(message.params) ?? {};
			if (id !== undefined) {
				deny(id, method);
				return;
			}
			const eventThread = string(params.threadId);
			const eventTurn = string(params.turnId) ?? string(object(params.turn)?.id);
			if (threadId && eventThread && eventThread !== threadId) return;
			if (turnId && eventTurn && eventTurn !== turnId) return;
			switch (method) {
				case "item/agentMessage/delta": {
					const delta = string(params.delta) ?? "";
					const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(output);
					if (Buffer.byteLength(delta) > remaining) truncated = true;
					if (remaining > 0) output += Buffer.from(delta).subarray(0, remaining).toString();
					emit();
					break;
				}
				case "item/reasoning/summaryTextDelta":
				case "item/reasoning/textDelta":
					{
						const delta = string(params.delta) ?? "";
						const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(reasoning);
						if (Buffer.byteLength(delta) > remaining) truncated = true;
						if (remaining > 0) reasoning += Buffer.from(delta).subarray(0, remaining).toString();
					}
					emit();
					break;
				case "item/started": {
					const item = object(params.item);
					const type = string(item?.type);
					if (type && type !== "agentMessage" && type !== "reasoning") {
						currentTool = type;
						toolCount++;
					}
					emit();
					break;
				}
				case "item/completed":
					if (currentTool) {
						progress.recentTools.push({ tool: currentTool, args: "", endMs: Date.now() });
						progress.recentTools = progress.recentTools.slice(-20);
						currentTool = undefined;
					}
					emit();
					break;
				case "item/commandExecution/outputDelta":
				case "item/fileChange/outputDelta":
				case "item/mcpToolCall/progress":
					progress.lastIntent = string(params.delta) ?? string(params.message) ?? method;
					emit();
					break;
				case "thread/tokenUsage/updated": {
					const usage = object(params.tokenUsage);
					const total = object(usage?.total);
					const last = object(usage?.last);
					tokens = Number(total?.totalTokens ?? tokens);
					contextTokens = Number(last?.totalTokens ?? contextTokens);
					contextWindow = usage?.modelContextWindow == null ? contextWindow : Number(usage.modelContextWindow);
					emit();
					break;
				}
				case "turn/completed": {
					const turn = object(params.turn);
					turnStatus = string(turn?.status);
					turnFailure = string(object(turn?.error)?.message) ?? (turn?.error ? JSON.stringify(turn.error) : undefined);
					requests++;
					completedResolve();
					break;
				}
				case "error":
					completedReject(new Error(string(object(params.error)?.message) ?? string(params.message) ?? "Codex app-server error"));
					break;
			}
		};

		const stdoutTask = (async () => {
			const reader = child.stdout.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
						const line = buffer.slice(0, newline).trim();
						buffer = buffer.slice(newline + 1);
						if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error("Codex app-server frame exceeded 4 MiB");
						if (line) handle(object(JSON.parse(line)) ?? {}, generation);
					}
					if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) throw new Error("Codex app-server frame exceeded 4 MiB");
				}
				if (buffer.trim()) handle(object(JSON.parse(buffer)) ?? {}, generation);
			} catch (error) {
				completedReject(new Error(`Codex app-server framing failure: ${errorMessage(error)}`));
			}
		})();
		const stderrTask = (async () => {
			for await (const chunk of child.stderr) {
				stderr = (stderr + new TextDecoder().decode(chunk)).slice(-MAX_STDERR_BYTES);
			}
		})();

		const rejectPending = (error: Error) => {
			for (const waiter of pending.values()) waiter.reject(error);
			pending.clear();
		};
		const abort = () => {
			const error = new Error(input.signal.reason ? String(input.signal.reason) : "Codex run aborted");
			rejectPending(error);
			completedReject(error);
		};
		input.signal.addEventListener("abort", abort, { once: true });
		void child.exited.then(code => {
			if (settled) return;
			const error = new Error(`Codex app-server exited before completion (code ${code})`);
			rejectPending(error);
			completedReject(error);
		});

		let failure: Error | undefined;
		let watchdog: ReturnType<typeof setTimeout> | undefined;
		try {
			const deadlineAt = input.deadlineAt;
			const timedOut =
				deadlineAt === undefined
					? new Promise<never>(() => {})
					: new Promise<never>((_, reject) => {
							watchdog = setTimeout(
								() => reject(new Error(`Codex app-server exceeded its ${input.maxRuntimeMs}ms task deadline`)),
								Math.max(0, deadlineAt - Date.now()),
							);
							watchdog.unref();
						});
			await Promise.race([
				awaitScopeStarted(unit, child),
				timedOut,
				child.exited.then(code => Promise.reject(new Error(`Codex systemd scope failed during setup (code ${code})`))),
			]);
			const startup = async () => {
				await request("initialize", {
					clientInfo: { name: "oh-my-pi", title: "Oh My Pi", version: "1" },
					capabilities: null,
				});
				send({ method: "initialized" });
				const threadResponse = await request("thread/start", {
					cwd: resolve(input.cwd),
					approvalPolicy: "never",
					sandbox,
					baseInstructions: input.agent.systemPrompt,
					ephemeral: true,
					dynamicTools: [],
				});
				threadId = string(object(threadResponse.thread)?.id);
				if (!threadId) throw new Error("thread/start response omitted thread.id");
				const turnResponse = await request("turn/start", {
					threadId,
					input: [{ type: "text", text: input.prompt, text_elements: [] }],
					cwd: resolve(input.cwd),
					approvalPolicy: "never",
					sandboxPolicy:
						sandbox === "workspace-write"
							? { type: "workspaceWrite", writableRoots: [await realpath(input.isolation.worktree!)], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
							: { type: "readOnly", networkAccess: false },
				});
				turnId = string(object(turnResponse.turn)?.id);
				if (!turnId) throw new Error("turn/start response omitted turn.id");
				emit();
			};
			await Promise.race([startup(), timedOut, child.exited.then(code => Promise.reject(new Error(`Codex app-server exited during startup (code ${code})`)))]);
			await Promise.race([completed, timedOut, child.exited.then(code => Promise.reject(new Error(`Codex app-server exited before turn/completed (code ${code})`)))]);
		} catch (error) {
			failure = error instanceof Error ? error : new Error(errorMessage(error));
		} finally {
			if (watchdog) clearTimeout(watchdog);
			input.signal.removeEventListener("abort", abort);
			settled = true;
			generation++;
			for (const waiter of pending.values()) waiter.reject(new Error("Codex app-server connection closed"));
			pending.clear();
			try {
				child.stdin.end();
			} catch {}
			try {
				await cleanupScope(unit);
			} catch (error) {
				failure = error instanceof Error ? error : new Error(errorMessage(error));
			}
			await Promise.allSettled([stdoutTask, stderrTask, child.exited]);
		}

		const aborted = input.signal.aborted || turnStatus === "interrupted";
		const failed = Boolean(failure || turnFailure || turnStatus === "failed");
		emit(aborted ? "aborted" : failed ? "failed" : "completed");
		return {
			index: 0,
			id: input.agentId,
			agent: input.agent.name,
			agentSource: input.agent.source,
			task: input.prompt,
			description: input.agent.description,
			exitCode: aborted ? 130 : failed ? 1 : 0,
			output,
			stderr,
			truncated,
			durationMs: Date.now() - startedAt,
			tokens,
			requests,
			contextTokens,
			contextWindow,
			error: failure?.message ?? turnFailure,
			aborted: aborted || undefined,
			abortReason: aborted ? failure?.message ?? "Codex turn interrupted" : undefined,
		};
	},
};
