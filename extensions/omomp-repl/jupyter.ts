import type { ExecutorBackendExecOptions, ExecutorBackendResult } from "/home/shayna/omp/packages/coding-agent/src/eval/backend.ts";
import type { EvalDisplayOutput } from "/home/shayna/omp/packages/coding-agent/src/eval/types.ts";
import type { ExtensionEvalBackend } from "/home/shayna/omp/packages/coding-agent/src/extensibility/extensions/types.ts";

export interface KernelAliasRecord { alias: string; kernel: string; env?: Readonly<Record<string, string>> }
export interface JupyterRuntimeSnapshot { alias: string; kernelName: string; displayName: string; state: "idle" | "busy" | "starting" | "error" }
interface KernelSpec { resource_dir: string; spec: { argv: string[]; display_name: string; language: string; env?: Record<string, string> } }
interface Pending { resolve(value: Record<string, unknown>): void; reject(error: Error): void; onChunk?: (text: string) => void }

const TOKEN = /^[a-z][a-z0-9_-]*$/;
const states = new Map<string, JupyterRuntimeSnapshot>();
let activeBridge: JupyterBridge | undefined;

function result(output: string, exitCode: number | undefined, displays: EvalDisplayOutput[]): ExecutorBackendResult {
	const bytes = new TextEncoder().encode(output).byteLength;
	const lines = output ? output.split("\n").length : 0;
	return { output, exitCode, cancelled: false, truncated: false, artifactId: undefined, totalLines: lines, totalBytes: bytes, outputLines: lines, outputBytes: bytes, displayOutputs: displays };
}

async function renderKernelDisplay(content: Record<string, unknown>): Promise<{ text: string; outputs: EvalDisplayOutput[] }> {
	const data = (content.data as Record<string, unknown> | undefined) ?? content;
	const outputs: EvalDisplayOutput[] = [];
	if (data["application/x-omp-status"] !== undefined) return { text: "", outputs };
	if (typeof data["image/png"] === "string") outputs.push({ type: "image", data: data["image/png"], mimeType: "image/png" });
	if (typeof data["image/jpeg"] === "string") outputs.push({ type: "image", data: data["image/jpeg"], mimeType: "image/jpeg" });
	if (data["application/json"] !== undefined) outputs.push({ type: "json", data: data["application/json"] });
	if (typeof data["text/markdown"] === "string") {
		outputs.push({ type: "markdown" });
		return { text: `${data["text/markdown"].replace(/\n?$/, "\n")}`, outputs };
	}
	if (typeof data["text/plain"] === "string") return { text: `${data["text/plain"].replace(/\n?$/, "\n")}`, outputs };
	if (typeof data["text/html"] === "string") {
		const text = data["text/html"]
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/(?:p|div|li|h[1-6])>/gi, "\n")
			.replace(/<[^>]+>/g, "")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&amp;/g, "&")
			.replace(/&quot;/g, "\"")
			.replace(/&#39;/g, "'")
			.trim();
		return { text: text ? `${text}\n` : "", outputs };
	}
	return { text: "", outputs };
}

export function getJupyterRuntimeSnapshot(): readonly JupyterRuntimeSnapshot[] { return [...states.values()]; }
export async function interruptJupyterKernel(alias: string): Promise<boolean> {
	if (!states.has(alias) || !activeBridge) return false;
	await activeBridge.request("interrupt", { alias }); return true;
}
export async function restartJupyterKernel(alias: string): Promise<boolean> {
	const state = states.get(alias); if (!state || !activeBridge) return false;
	state.state = "starting";
	try { await activeBridge.request("restart", { alias }); state.state = "idle"; return true; }
	catch { state.state = "error"; return false; }
}

async function discoverKernelSpecs(): Promise<{ python: string; specs: Record<string, KernelSpec> } | undefined> {
	const candidates = [...new Set([
		"/usr/bin/python3",
		"/usr/bin/python",
		Bun.which("python3"),
		Bun.which("python"),
	].filter((candidate): candidate is string => Boolean(candidate)))];
	for (const python of candidates) {
		if (!(await Bun.file(python).exists())) continue;
		const child = Bun.spawn([python, "-m", "jupyter", "kernelspec", "list", "--json"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const output = await new Response(child.stdout).text();
		const exit = await child.exited;
		if (exit !== 0 || output.length > 4 * 1024 * 1024) continue;
		try {
			const parsed = JSON.parse(output) as { kernelspecs?: Record<string, KernelSpec> };
			return { python, specs: parsed.kernelspecs ?? {} };
		} catch {}
	}
	return undefined;
}

class JupyterBridge {
	readonly #python: string;
	#process: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
	#pending = new Map<string, Pending>();
	#sequence = 0;
	#disposed = false;

	constructor(python: string) { this.#python = python; }

	#start(): void {
		if (this.#disposed) throw new Error("Jupyter sidecar is disposed");
		if (this.#process?.exitCode === null) return;
		this.#process = Bun.spawn([this.#python, `${import.meta.dir}/jupyter-sidecar.py`], { stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: process.platform !== "win32" });
		void this.#read(this.#process);
	}

	async #read(child: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
		const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let buffer = "";
		try {
			while (true) {
				const item = await reader.read(); if (item.done) break;
				buffer += decoder.decode(item.value, { stream: true });
				while (true) {
					const newline = buffer.indexOf("\n"); if (newline < 0) break;
					const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line) continue;
					const message = JSON.parse(line) as Record<string, unknown>; const id = String(message.id ?? ""); const pending = this.#pending.get(id); if (!pending) continue;
					if (message.event === "chunk") { pending.onChunk?.(String(message.text ?? "")); continue; }
					if (message.event === "display") continue;
					if (message.event === "stdin") continue;
					this.#pending.delete(id);
					if (message.ok === false) pending.reject(new Error(String(message.error ?? "Jupyter request failed"))); else pending.resolve(message);
				}
			}
		} catch (error) { this.#failAll(error instanceof Error ? error : new Error(String(error))); }
		finally { if (this.#process === child) this.#process = undefined; this.#failAll(new Error("Jupyter sidecar closed")); }
	}

	request(op: string, fields: Record<string, unknown>, onChunk?: (text: string) => void, signal?: AbortSignal): Promise<Record<string, unknown>> {
		if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Jupyter request aborted"));
		this.#start(); const id = `j${++this.#sequence}`; const deferred = Promise.withResolvers<Record<string, unknown>>();
		const pending: Pending = { resolve: deferred.resolve, reject: deferred.reject, onChunk }; this.#pending.set(id, pending);
		const abort = () => {
			if (this.#pending.delete(id)) {
				deferred.reject(signal?.reason instanceof Error ? signal.reason : new Error("Jupyter request aborted"));
			}
			void this.request("interrupt", { alias: fields.alias }).catch(() => undefined);
		};
		signal?.addEventListener("abort", abort, { once: true });
		const timeoutMs = op === "execute" ? 125_000 : 20_000;
		const timer = setTimeout(() => {
			if (!this.#pending.delete(id)) return;
			deferred.reject(new Error(`Jupyter ${op} request timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		timer.unref?.();
		this.#process!.stdin.write(JSON.stringify({ id, op, ...fields }) + "\n"); this.#process!.stdin.flush();
		return deferred.promise.finally(() => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		});
	}

	#failAll(error: Error): void { for (const pending of this.#pending.values()) pending.reject(error); this.#pending.clear(); }
	async dispose(): Promise<void> {
		this.#disposed = true; const child = this.#process; this.#process = undefined; this.#failAll(new Error("Jupyter sidecar disposed"));
		if (!child || child.exitCode !== null) return;
		child.stdin.end();
		try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM"); } catch {}
		await Promise.race([child.exited, Bun.sleep(1_000)]).catch(() => undefined);
		if (child.exitCode === null) { try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch {} }
		await child.exited.catch(() => undefined);
	}
}

export async function discoverJupyterBackends(configured: readonly KernelAliasRecord[]): Promise<ExtensionEvalBackend[]> {
	const discovery = await discoverKernelSpecs();
	if (!discovery || !Object.keys(discovery.specs).length) return [];
	const { python, specs } = discovery;
	const bridge = new JupyterBridge(python); activeBridge = bridge; states.clear();
	const claimed = new Set<string>(); const selected: KernelAliasRecord[] = [];
	const coconut = Object.keys(specs).find(name => name.toLowerCase() === "coconut"); if (coconut) selected.push({ alias: "coconut", kernel: coconut });
	for (const record of configured) selected.push(record);
	const backends: ExtensionEvalBackend[] = [];
	for (const record of selected) {
		const alias = record.alias.trim(); const spec = specs[record.kernel];
		if (!TOKEN.test(alias) || claimed.has(alias) || !spec) continue; claimed.add(alias);
		states.set(alias, { alias, kernelName: record.kernel, displayName: spec.spec.display_name, state: "idle" });
		backends.push({ id: alias, aliases: [], label: spec.spec.display_name, highlightLang: spec.spec.language || "text", modelVisible: true, isAvailable: () => states.has(alias),
			async execute(code, options) {
				const state = states.get(alias)!; state.state = "busy"; let streamed = "";
				try {
					const response = await bridge.request("execute", { alias, kernel_name: record.kernel, cwd: options.cwd, env: record.env ?? {}, code }, chunk => { streamed += chunk; options.onChunk(chunk); }, options.signal);
					const bundles = Array.isArray(response.bundles) ? response.bundles as Record<string, unknown>[] : []; const displays: EvalDisplayOutput[] = [];
					let rendered = ""; for (const bundle of bundles) { const display = await renderKernelDisplay(bundle); rendered += display.text; displays.push(...display.outputs); }
					if (rendered) options.onChunk(rendered); state.state = "idle"; return result(streamed + rendered, response.ok === false ? 1 : 0, displays);
				} catch (error) { state.state = options.signal?.aborted ? "idle" : "error"; if (options.signal?.aborted) return { ...result(streamed, undefined, []), cancelled: true }; throw error; }
			},
			reset: async () => { await restartJupyterKernel(alias); },
			interrupt: async () => { await interruptJupyterKernel(alias); },
			dispose: async () => {
				await bridge.request("shutdown", { alias }).catch(() => undefined);
				states.delete(alias);
				if (!states.size) {
					await bridge.dispose();
					if (activeBridge === bridge) activeBridge = undefined;
				}
			},
		});
	}
	return backends;
}
