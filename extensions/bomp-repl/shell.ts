import type { ExecutorBackendExecOptions, ExecutorBackendResult } from "/home/shayna/omp/packages/coding-agent/src/eval/backend.ts";
import type { ExtensionEvalBackend } from "/home/shayna/omp/packages/coding-agent/src/extensibility/extensions/types.ts";

export interface ShellProfileRecord { alias: string; shell?: "sh" | "fish" | "zsh" | "xonsh" | string; executable?: string; args?: readonly string[]; env?: Readonly<Record<string, string>> }
const TOKEN = /^[a-z][a-z0-9_-]*$/;
const RESERVED = new Set(["py", "python", "js", "javascript", "rb", "ruby", "jl", "julia"]);

function evalResult(output: string, exitCode: number | undefined, cancelled = false): ExecutorBackendResult {
	const bytes = new TextEncoder().encode(output).byteLength; const lines = output ? output.split("\n").length : 0;
	return { output, exitCode, cancelled, truncated: false, artifactId: undefined, totalLines: lines, totalBytes: bytes, outputLines: lines, outputBytes: bytes, displayOutputs: [] };
}

async function resolveExecutable(profile: ShellProfileRecord): Promise<string | undefined> {
	const candidate = profile.executable ?? profile.shell ?? "sh";
	if (candidate.includes("/")) return (await Bun.file(candidate).exists()) ? candidate : undefined;
	return Bun.which(candidate) ?? undefined;
}

function shellDialect(profile: ShellProfileRecord, executable: string): "fish" | "xonsh" | "posix" {
	const declared = profile.shell?.toLowerCase();
	const name = executable.split("/").pop()?.toLowerCase();
	if (declared === "fish" || name === "fish") return "fish";
	if (declared === "xonsh" || name === "xonsh") return "xonsh";
	return "posix";
}

function statusMarker(profile: ShellProfileRecord, executable: string, marker: string): string {
	switch (shellDialect(profile, executable)) {
		case "fish": return `printf '${marker}%s\\n' $status`;
		case "xonsh": return `print('${marker}' + str($LAST_RETURN_CODE))`;
		default: return `printf '${marker}%s\\n' $?`;
	}
}

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }

class PersistentShell {
	#process: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
	#fishProcess: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
	#queue: Promise<void> = Promise.resolve();
	#disposed = false;
	#sequence = 0;
	#cwd: string | undefined;
	#buffer = "";
	#notify: (() => void) | undefined;
	#fishCwd: string | undefined;
	#fishEnv: Record<string, string> | undefined;
	#run: Promise<unknown> | undefined;
	constructor(readonly profile: ShellProfileRecord, readonly executable: string) {}
	get available(): boolean { return !this.#disposed; }

	execute(code: string, options: ExecutorBackendExecOptions): Promise<ExecutorBackendResult> {
		const pending = this.#queue.then(() => this.#execute(code, options)); this.#queue = pending.then(() => undefined, () => undefined); return pending;
	}

	async #executeFish(code: string, options: ExecutorBackendExecOptions): Promise<ExecutorBackendResult> {
		if (this.#cwd !== options.cwd || !this.#fishCwd || !this.#fishEnv) {
			this.#cwd = options.cwd;
			this.#fishCwd = options.cwd;
			this.#fishEnv = { ...process.env, ...this.profile.env, TERM: "dumb" };
		}
		const marker = `__BOMP_FISH_${++this.#sequence}_${crypto.randomUUID()}__`;
		const script = `${code}\nset -l __bomp_status $status\nprintf '\\\\0%s\\\\0%d\\\\0%s\\\\0' ${shellQuote(marker)} $__bomp_status (pwd)\nenv -0`;
		const command = ["stty -echo; exec", shellQuote(this.executable), ...(this.profile.args ?? []).map(shellQuote), "-c", shellQuote(script)].join(" ");
		const child = Bun.spawn(["/usr/bin/script", "-qefc", command, "/dev/null"], {
			cwd: this.#fishCwd,
			env: this.#fishEnv,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			detached: process.platform !== "win32",
		});
		this.#fishProcess = child;
		let cancelled = false;
		const stop = () => {
			cancelled = true;
			try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch {}
		};
		options.signal?.addEventListener("abort", stop, { once: true });
		try {
			const outputPromise = new Response(child.stdout).text();
			const exitCode = await child.exited;
			const raw = (await outputPromise).replace(/\r/g, "");
			if (cancelled || options.signal?.aborted) return evalResult(raw, undefined, true);
			const boundary = `\0${marker}\0`;
			const index = raw.lastIndexOf(boundary);
			if (index < 0) throw new Error(`Fish backend closed before completing the cell (exit ${exitCode})`);
			const output = raw.slice(0, index);
			const fields = raw.slice(index + boundary.length).split("\0");
			const status = Number.parseInt(fields.shift() ?? "", 10);
			this.#fishCwd = fields.shift() || this.#fishCwd;
			const env: Record<string, string> = {};
			for (const field of fields) {
				const equals = field.indexOf("="); if (equals > 0) env[field.slice(0, equals)] = field.slice(equals + 1);
			}
			this.#fishEnv = env;
			if (output) options.onChunk(output);
			return evalResult(output, Number.isFinite(status) ? status : exitCode, false);
		} finally {
			options.signal?.removeEventListener("abort", stop);
			if (this.#fishProcess === child) this.#fishProcess = undefined;
		}
	}

	#start(cwd: string): void {
		if (this.#disposed) throw new Error(`Shell ${this.profile.alias} is disposed`);
		const dialect = shellDialect(this.profile, this.executable);
		const prefix = dialect === "fish" ? "exec" : "stty -echo; cat | exec";
		const command = [prefix, shellQuote(this.executable), ...(this.profile.args ?? []).map(shellQuote)].join(" ");
		const child = Bun.spawn(["/usr/bin/script", "-qefc", command, "/dev/null"], {
			cwd,
			env: { ...process.env, ...this.profile.env, TERM: dialect === "fish" ? "dumb" : (process.env.TERM ?? "xterm-256color") },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			detached: process.platform !== "win32",
		});
		this.#process = child; this.#cwd = cwd; this.#buffer = "";
		this.#run = this.#read(child);
	}

	async #read(child: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
		const reader = child.stdout.getReader(); const decoder = new TextDecoder();
		try {
			while (true) {
				const item = await reader.read(); if (item.done) break;
				this.#buffer += decoder.decode(item.value, { stream: true }); this.#notify?.();
			}
		} finally {
			await child.exited.catch(() => undefined);
			if (this.#process === child) { this.#process = undefined; this.#notify?.(); }
		}
	}

	async #execute(code: string, options: ExecutorBackendExecOptions): Promise<ExecutorBackendResult> {
		if (shellDialect(this.profile, this.executable) === "fish") return this.#executeFish(code, options);
		const started = !this.#process || this.#cwd !== options.cwd;
		if (started) {
			await this.#stop();
			this.#start(options.cwd);
			if (shellDialect(this.profile, this.executable) === "fish") {
				this.#process!.stdin.write("function fish_prompt; end; function fish_right_prompt; end\n");
				this.#process!.stdin.flush();
			}
			await Bun.sleep(50);
			this.#buffer = "";
		}
		const child = this.#process!;
		this.#buffer = "";
		const marker = `__BOMP_CELL_${++this.#sequence}__`;
		const markerCommand = statusMarker(this.profile, this.executable, marker);
		let aborted = false;
		const onAbort = () => { aborted = true; void this.#stop(); };
		options.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			child.stdin.write(`${code}\n${markerCommand}\n`);
			child.stdin.flush();
			const deadline = Date.now() + 120_000;
			while (true) {
				const match = new RegExp(`${marker}(-?\\d+)\\r?\\n`).exec(this.#buffer);
				if (match?.index !== undefined) {
					const end = match.index + match[0].length;
					const status = Number.parseInt(match[1]!, 10);
					let output = (this.#buffer.slice(0, match.index) + this.#buffer.slice(end)).replace(/\r/g, "");
					if (output.startsWith(`${code}\n`)) output = output.slice(code.length + 1);
					const echoedMarker = output.lastIndexOf(`${markerCommand}\n`);
					if (echoedMarker >= 0) {
						output = output.slice(0, echoedMarker) + output.slice(echoedMarker + markerCommand.length + 1);
					}
					if (output) options.onChunk(output);
					return evalResult(output, Number.isFinite(status) ? status : undefined, aborted);
				}
				if (!this.#process) throw new Error(`Shell ${this.profile.alias} closed before completing the cell`);
				await this.#waitForChunk(deadline - Date.now());
			}
		} catch (error) {
			if (aborted || options.signal?.aborted) return evalResult(this.#buffer.replace(/\r/g, ""), undefined, true);
			await this.#stop();
			throw error;
		} finally {
			options.signal?.removeEventListener("abort", onAbort);
		}
	}

	async #waitForChunk(timeoutMs: number): Promise<void> {
		if (timeoutMs <= 0) throw new Error(`Shell ${this.profile.alias} cell timed out`);
		const deferred = Promise.withResolvers<void>();
		this.#notify = deferred.resolve;
		const timer = setTimeout(() => deferred.reject(new Error(`Shell ${this.profile.alias} cell timed out`)), timeoutMs);
		timer.unref?.();
		try { await deferred.promise; } finally { clearTimeout(timer); this.#notify = undefined; }
	}
	async reset(): Promise<void> { await this.#queue; await this.#stop(); }
	async interrupt(): Promise<void> { await this.#stop(); }
	async dispose(): Promise<void> { this.#disposed = true; await this.#stop(); }
	async #stop(): Promise<void> {
		const child = this.#process;
		const fishChild = this.#fishProcess;
		const run = this.#run;
		this.#process = undefined;
		this.#fishProcess = undefined;
		this.#run = undefined;
		this.#cwd = undefined;
		this.#notify?.();
		this.#fishCwd = undefined;
		this.#fishEnv = undefined;
		for (const active of [child, fishChild]) {
			if (!active) continue;
			if (active.stdin && typeof active.stdin !== "number") active.stdin.end();
			try { process.kill(process.platform === "win32" ? active.pid : -active.pid, "SIGTERM"); } catch {}
			await Promise.race([active.exited, Bun.sleep(500)]).catch(() => undefined);
			if (active.exitCode === null) {
				try { process.kill(process.platform === "win32" ? active.pid : -active.pid, "SIGKILL"); } catch {}
			}
		}
		if (run) await run.catch(() => undefined);
	}
}

export async function discoverShellBackends(profiles: readonly ShellProfileRecord[]): Promise<ExtensionEvalBackend[]> {
	const records: ShellProfileRecord[] = [{ alias: "sh", shell: "sh" }, ...profiles]; const claimed = new Set(RESERVED); const backends: ExtensionEvalBackend[] = [];
	for (const profile of records) {
		const alias = profile.alias.trim(); if (!TOKEN.test(alias) || claimed.has(alias)) continue; const executable = await resolveExecutable(profile); if (!executable) continue;
		claimed.add(alias); const runtime = new PersistentShell(profile, executable);
		backends.push({ id: alias, aliases: [], label: alias === "sh" ? "Shell" : `Shell (${alias})`, highlightLang: profile.shell === "xonsh" ? "python" : "shell", modelVisible: true, isAvailable: () => runtime.available, execute: (code, options) => runtime.execute(code, options), reset: () => runtime.reset(), interrupt: () => runtime.interrupt(), dispose: () => runtime.dispose() });
	}
	return backends;
}
