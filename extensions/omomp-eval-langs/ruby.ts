// Ruby eval backend — subprocess kernel speaking the NDJSON protocol in
// kernel.ts, running ruby/runner.rb + ruby/prelude.rb. Host tool access
// (`tool.*`, `agent()`, `completion()`, `read`/`write` of internal URLs) goes
// through the same loopback HTTP bridge the Python backend uses, reached via
// kernel.ts's `hostEvalBridge()` (a static relative import of host runtime
// source breaks extension loading — see the comment there).
import type { ExecutorBackendExecOptions, ExecutorBackendResult } from "../../packages/coding-agent/src/eval/backend";
import type { EvalDisplayOutput } from "../../packages/coding-agent/src/eval/types";
import type { ExtensionEvalBackend } from "../../packages/coding-agent/src/extensibility/extensions/types";
import {
	hostEvalBridge,
	type HostEvalBridge,
	probeCommand,
	stageRunnerScript,
	type SubprocessKernel,
	SubprocessKernel as Kernel,
} from "./kernel";

const RUNNER_PATH = new URL("./ruby/runner.rb", import.meta.url).pathname;
const PRELUDE_PATH = new URL("./ruby/prelude.rb", import.meta.url).pathname;

// Preserve the former Ruby runtime's environment boundary. In particular,
// provider credentials and unrelated host secrets must not enter the kernel.
const RUNTIME_ENV_KEYS = new Set([
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LC_MESSAGES",
	"TERM",
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION",
	"TMPDIR",
	"TEMP",
	"TMP",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_RUNTIME_DIR",
	"SSH_AUTH_SOCK",
	"SSH_AGENT_PID",
	"LD_LIBRARY_PATH",
	"DYLD_LIBRARY_PATH",
	"APPDATA",
	"COMPUTERNAME",
	"COMSPEC",
	"HOMEDRIVE",
	"HOMEPATH",
	"LOCALAPPDATA",
	"NUMBER_OF_PROCESSORS",
	"OS",
	"PATHEXT",
	"PROCESSOR_ARCHITECTURE",
	"PROCESSOR_IDENTIFIER",
	"PROCESSOR_LEVEL",
	"PROCESSOR_REVISION",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PROGRAMW6432",
	"SESSIONNAME",
	"SYSTEMDRIVE",
	"SYSTEMROOT",
	"USERDOMAIN",
	"USERPROFILE",
	"USERNAME",
	"WINDIR",
]);
const RUNTIME_ENV_PREFIXES = ["LC_", "XDG_", "PI_", "GEM_", "BUNDLE", "RBENV_", "RUBY", "CHRUBY_", "ASDF_"];

function runtimeEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		const normalized = process.platform === "win32" ? key.toUpperCase() : key;
		if (
			typeof value === "string" &&
			(RUNTIME_ENV_KEYS.has(normalized) || RUNTIME_ENV_PREFIXES.some(prefix => normalized.startsWith(prefix)))
		) {
			env[key] = value;
		}
	}
	return env;
}

function toResult(
	text: string,
	exitCode: number | undefined,
	cancelled: boolean,
	displays: EvalDisplayOutput[],
): ExecutorBackendResult {
	const bytes = new TextEncoder().encode(text).byteLength;
	const lines = text ? text.split("\n").length : 0;
	return {
		output: text,
		exitCode,
		cancelled,
		truncated: false,
		artifactId: undefined,
		totalLines: lines,
		totalBytes: bytes,
		outputLines: lines,
		outputBytes: bytes,
		displayOutputs: displays,
	};
}

function buildInitScript(cwd: string): string {
	return [
		`__omp_init_cwd = ${JSON.stringify(cwd)}`,
		"Dir.chdir(__omp_init_cwd) rescue nil",
		"$LOAD_PATH.delete(__omp_init_cwd)",
		"$LOAD_PATH.unshift(__omp_init_cwd)",
	].join("\n");
}

export function createRubyBackend(): ExtensionEvalBackend {
	const kernels = new Map<string, SubprocessKernel>();
	const reportedBridgeFailures = new WeakSet<SubprocessKernel>();
	let rubyPath: string | undefined;
	let bridgeSessionId: string | undefined;

	let initialization: Promise<unknown> = Promise.resolve();
	let generation = 0;

	async function resetKernel(): Promise<void> {
		generation++;
		const active = [...kernels.values()];
		kernels.clear();
		await Promise.all([...active.map(kernel => kernel.dispose()), initialization]).catch(() => {});
	}
	async function resolveRubyPath(): Promise<string | undefined> {
		if (rubyPath !== undefined) return rubyPath;
		const candidate = Bun.which("ruby");
		if (!candidate) return undefined;
		const ok = await probeCommand([candidate, "-e", "exit 0"], process.cwd(), 5_000);
		rubyPath = ok ? candidate : undefined;
		return rubyPath;
	}

	function ensureKernel(cwd: string): Promise<SubprocessKernel> {
		const requestedGeneration = generation;
		const next = initialization.then(async () => {
			if (requestedGeneration !== generation) throw new Error("Ruby kernel reset during initialization");
			const existing = kernels.get(cwd);
			if (existing) return existing;
			const ruby = await resolveRubyPath();
			if (!ruby) throw new Error("Ruby executable not found on PATH");
			const scriptPath = await stageRunnerScript("omp-ruby-runner", "rb", await Bun.file(RUNNER_PATH).text());
			const env = runtimeEnv();
			const prelude = await Bun.file(PRELUDE_PATH).text();
			const started = await Kernel.start([ruby, scriptPath], cwd, env);
			try {
				for (const code of [buildInitScript(cwd), prelude]) {
					const result = await started.execute(code, { silent: true });
					if (result.exitCode !== 0) throw new Error(`Ruby kernel initialization failed: ${result.output}`);
				}
				if (requestedGeneration !== generation) throw new Error("Ruby kernel reset during initialization");
			} catch (err) {
				await started.dispose().catch(() => {});
				throw err;
			}
			kernels.set(cwd, started);
			return started;
		});
		initialization = next.catch(() => {});
		return next;
	}

	return {
		id: "rb",
		aliases: ["ruby"],
		label: "Ruby",
		highlightLang: "ruby",
		modelVisible: true,

		async isAvailable(): Promise<boolean> {
			return (await resolveRubyPath()) !== undefined;
		},

		async execute(code: string, options: ExecutorBackendExecOptions): Promise<ExecutorBackendResult> {
			if (options.reset) await resetKernel();
			const active = await ensureKernel(options.cwd);

			let host: HostEvalBridge | undefined;
			let bridge: { url: string; token: string } | undefined;
			let bridgeDiagnostic = "";
			try {
				host = await hostEvalBridge();
				bridge = await host.ensurePyToolBridge();
			} catch (error) {
				bridge = undefined;
				if (!reportedBridgeFailures.has(active)) {
					reportedBridgeFailures.add(active);
					bridgeDiagnostic = `Ruby host bridge unavailable: ${error instanceof Error ? error.message : String(error)}\n`;
					options.onChunk(bridgeDiagnostic);
				}
			}
			bridgeSessionId ??= `rb-bridge:${crypto.randomUUID()}`;
			const runId = crypto.randomUUID();
			const unregister =
				bridge && host
					? host.registerPyToolBridge(bridgeSessionId, runId, {
							toolSession: options.session,
							signal: options.signal,
							emitStatus: options.onStatus ? event => options.onStatus?.(event) : undefined,
						})
					: () => {};

			const localRoots = host ? host.resolveEvalUrlRoots(options.session) : {};
			const bridgeEnv: Record<string, string | undefined> = {
				PI_SESSION_FILE: options.sessionFile,
				PI_ARTIFACTS_DIR: options.session.getArtifactsDir?.() ?? undefined,
				PI_EVAL_LOCAL_ROOTS: Object.keys(localRoots).length > 0 ? JSON.stringify(localRoots) : undefined,
				PI_TOOL_BRIDGE_URL: bridge?.url,
				PI_TOOL_BRIDGE_TOKEN: bridge?.token,
				PI_TOOL_BRIDGE_SESSION: bridge ? bridgeSessionId : undefined,
			};

			const displays: EvalDisplayOutput[] = [];
			try {
				const result = await active.execute(code, {
					id: runId,
					cwd: options.cwd,
					env: bridgeEnv,
					signal: options.signal,
					onChunk: options.onChunk,
					onDisplay: output => {
						displays.push(output);
						if (output.type === "status" && options.onStatus) options.onStatus(output.event);
					},
				});
				return toResult(bridgeDiagnostic + result.output, result.exitCode, result.cancelled, displays);
			} finally {
				unregister();
			}
		},

		reset: resetKernel,

		async interrupt(): Promise<void> {
			// Host-level interrupt (Esc) that carries no per-cell AbortSignal:
			// SIGINT the interpreter so the running cell raises Interrupt and the
			// kernel stays alive for the next cell.
			for (const kernel of kernels.values()) kernel.interrupt();
		},

		dispose: resetKernel,
	};
}
