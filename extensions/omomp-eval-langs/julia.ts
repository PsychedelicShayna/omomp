// Julia eval backend — subprocess kernel speaking the NDJSON protocol in
// kernel.ts, running julia/runner.jl + julia/prelude.jl. Host tool access
// (`tool.*`, `agent()`, `completion()`, `wait()`, `read`/`write` of internal
// URLs) goes through the same loopback HTTP bridge the Python backend uses.
// Host runtime is reached through kernel.ts's `hostEvalBridge()` (a static
// relative import of host runtime source breaks the extension loader; see
// kernel.ts). Type-only host imports are safe.
import type { ExecutorBackendExecOptions, ExecutorBackendResult } from "../../packages/coding-agent/src/eval/backend";
import type { EvalDisplayOutput } from "../../packages/coding-agent/src/eval/types";
import type { ExtensionEvalBackend } from "../../packages/coding-agent/src/extensibility/extensions/types";
import {
	type HostEvalBridge,
	hostEvalBridge,
	probeCommand,
	type SubprocessKernel,
	stageRunnerScript,
	SubprocessKernel as Kernel,
} from "./kernel";

const RUNNER_PATH = new URL("./julia/runner.jl", import.meta.url).pathname;
const PRELUDE_PATH = new URL("./julia/prelude.jl", import.meta.url).pathname;

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

/**
 * Pin the kernel's working directory and make it the first `include`/`using`
 * search root, so a cell can load code sitting next to the project it runs in.
 */
function buildInitScript(cwd: string): string {
	return [
		`__omp_init_cwd = ${JSON.stringify(cwd)}`,
		"try; cd(__omp_init_cwd); catch; end",
		"filter!(!isequal(__omp_init_cwd), LOAD_PATH)",
		"pushfirst!(LOAD_PATH, __omp_init_cwd)",
	].join("\n");
}

export function createJuliaBackend(): ExtensionEvalBackend {
	const kernels = new Map<string, SubprocessKernel>();
	const reportedBridgeFailures = new WeakSet<SubprocessKernel>();
	let juliaPath: string | undefined;
	let bridgeSessionId: string | undefined;

	let initialization: Promise<unknown> = Promise.resolve();
	let generation = 0;

	async function resetKernel(): Promise<void> {
		generation++;
		const active = [...kernels.values()];
		kernels.clear();
		await Promise.all([...active.map(kernel => kernel.dispose()), initialization]).catch(() => {});
	}
	async function resolveJuliaPath(): Promise<string | undefined> {
		if (juliaPath !== undefined) return juliaPath;
		const candidate = Bun.which("julia");
		if (!candidate) return undefined;
		const ok = await probeCommand([candidate, "--startup-file=no", "-e", "exit(0)"], process.cwd(), 15_000);
		juliaPath = ok ? candidate : undefined;
		return juliaPath;
	}

	function ensureKernel(cwd: string): Promise<SubprocessKernel> {
		const requestedGeneration = generation;
		const next = initialization.then(async () => {
			if (requestedGeneration !== generation) throw new Error("Julia kernel reset during initialization");
			const existing = kernels.get(cwd);
			if (existing) return existing;
			const julia = await resolveJuliaPath();
			if (!julia) throw new Error("Julia executable not found on PATH");
			const scriptPath = await stageRunnerScript("omp-julia-runner", "jl", await Bun.file(RUNNER_PATH).text());
			const env: Record<string, string> = {};
			for (const key in process.env) {
				const value = process.env[key];
				if (typeof value === "string") env[key] = value;
			}
			const started = await Kernel.start([julia, "--startup-file=no", "--color=no", scriptPath], cwd, env);
			const prelude = await Bun.file(PRELUDE_PATH).text();
			try {
				for (const code of [buildInitScript(cwd), prelude]) {
					const result = await started.execute(code, { silent: true });
					if (result.exitCode !== 0) throw new Error(`Julia kernel initialization failed: ${result.output}`);
				}
				if (requestedGeneration !== generation) throw new Error("Julia kernel reset during initialization");
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
		id: "jl",
		aliases: ["julia"],
		label: "Julia",
		highlightLang: "julia",
		modelVisible: true,

		async isAvailable(): Promise<boolean> {
			return (await resolveJuliaPath()) !== undefined;
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
					bridgeDiagnostic = `Julia host bridge unavailable: ${error instanceof Error ? error.message : String(error)}\n`;
					options.onChunk(bridgeDiagnostic);
				}
			}
			bridgeSessionId ??= `jl-bridge:${crypto.randomUUID()}`;
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
			for (const kernel of kernels.values()) kernel.interrupt();
		},

		dispose: resetKernel,
	};
}
