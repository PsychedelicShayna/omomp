import type { ExtensionFactory } from "/home/shayna/omp/packages/coding-agent/src/extensibility/extensions/types.ts";
import { discoverJupyterBackends, type KernelAliasRecord } from "./jupyter";
import { discoverShellBackends, type ShellProfileRecord } from "./shell";
import { BompStateStore, defaultStatePath, readReplProfiles } from "./state";
import { createKernelDashboard } from "./ui/kernel-dashboard";
import { createReplDashboard } from "./ui/repl-dashboard";

export interface ReplProfileConfiguration { shellProfiles: readonly ShellProfileRecord[]; kernelAliases: readonly KernelAliasRecord[] }
export interface ReplBackendItem { id: string; label: string; kind: "agent" | "builtin" | "shell" | "kernel" }
export interface ReplRuntimeSnapshot { mode: "agent" | "eval"; active: string; available: readonly ReplBackendItem[] }

type ProfileProvider = () => ReplProfileConfiguration | Promise<ReplProfileConfiguration>;
const BUILTIN_BACKENDS: readonly ReplBackendItem[] = [
	{ id: "py", label: "Python", kind: "builtin" },
	{ id: "js", label: "JavaScript", kind: "builtin" },
	{ id: "rb", label: "Ruby", kind: "builtin" },
	{ id: "jl", label: "Julia", kind: "builtin" },
];
const DEFAULT_BACKENDS: readonly ReplBackendItem[] = [{ id: "agent", label: "Agent", kind: "agent" }, ...BUILTIN_BACKENDS];
const profileProvider: ProfileProvider = async () => {
	const records = await readReplProfiles(new BompStateStore(defaultStatePath()));
	return {
		shellProfiles: Object.entries(records.shellProfiles).map(([alias, profile]) => ({
			alias,
			executable: profile.command,
			args: profile.args,
			env: profile.env,
		})),
		kernelAliases: Object.entries(records.kernelAliases).map(([alias, kernel]) => ({ alias, kernel })),
	};
};
let available: ReplBackendItem[] = [...DEFAULT_BACKENDS];
let active = "agent";

export function getReplRuntimeSnapshot(): ReplRuntimeSnapshot { return { mode: active === "agent" ? "agent" : "eval", active, available: [...available] }; }

function activePrefix(id: string): string {
	switch (id) {
		case "py": return "p";
		case "js": return "$";
		case "rb": return "r";
		case "jl": return "j";
		default: return id;
	}
}
export function setReplBackend(id: string): boolean { if (!available.some(item => item.id === id)) return false; active = id; return true; }
export function cycleReplBackend(): string { const index = available.findIndex(item => item.id === active); active = available[(index + 1) % available.length]?.id ?? "agent"; return active; }

function bypassActiveRewrite(text: string): boolean {
	const trimmed = text.trimStart();
	return trimmed.startsWith("$") || trimmed.startsWith("/") || trimmed.startsWith("!");
}

export const createReplExtension: ExtensionFactory = api => {
	let registered = false;
	let unsubscribeInput: (() => void) | undefined;

	api.on("session_start", async (_event, ctx) => {
		if (!registered) {
			registered = true;
			if (typeof api.registerEvalBackend !== "function") {
				ctx.ui.notify(
					"bomp: this omp build lacks registerEvalBackend — shell/kernel REPL backends disabled (builtins still work)",
					"warning",
				);
			} else {
				// Discovery shells out (jupyter kernelspec, shell probing); run it in
				// the background so session startup never waits on it. The patched
				// runtime forwards late registrations live.
				void (async () => {
					try {
						const config = await profileProvider();
						const shells = await discoverShellBackends(config.shellProfiles);
						const kernels = await discoverJupyterBackends(config.kernelAliases);
						const claimed = new Set(available.map(backend => backend.id));
						for (const [kind, backends] of [["shell", shells], ["kernel", kernels]] as const) {
							for (const backend of backends) {
								if (claimed.has(backend.id)) { await backend.dispose?.(); continue; }
								claimed.add(backend.id); api.registerEvalBackend(backend);
								available.push({ id: backend.id, label: backend.label, kind });
							}
						}
					} catch (error) {
						registered = false;
						ctx.ui.notify(`bomp: REPL backend discovery failed: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
				})();
			}
		}
		unsubscribeInput?.();
		unsubscribeInput = ctx.ui.onTerminalInput(data => {
			if (active !== "agent" && data === "\x1b") {
				active = "agent"; ctx.ui.setStatus("bomp-repl", undefined); ctx.ui.notify("Returned to agent", "info");
			}
			return undefined;
		});
	});

	api.on("input", event => {
		if (active === "agent" || event.source !== "interactive" || bypassActiveRewrite(event.text)) return undefined;
		return { text: `$${activePrefix(active)} ${event.text}` };
	});

	api.registerCommand("repl", {
		description: "Select an eval backend with /repl use <alias>, or return with /repl agent",
		async handler(args, ctx): Promise<void> {
			const words = args.trim().split(/\s+/).filter(Boolean);
			const requested = words[0] === "agent" ? "agent" : words[0] === "use" ? words[1] : undefined;
			if (!requested) {
				const dashboard = createReplDashboard(ctx);
				try {
					if (ctx.hasUI) await dashboard.showOverlay();
					else ctx.ui.notify(dashboard.renderText(80).join("\n"), "info");
				} finally {
					dashboard.dispose();
				}
				return;
			}
			if (!setReplBackend(requested)) { ctx.ui.notify(`Unavailable REPL backend: ${requested}`, "error"); return; }
			ctx.ui.setStatus("bomp-repl", active === "agent" ? undefined : `REPL ${active}`);
			ctx.ui.notify(active === "agent" ? "Returned to agent" : `REPL backend: ${active}`, "info");
		},
	});

	api.registerCommand("kernel", {
		description: "Inspect and control configured Jupyter kernels",
		async handler(args, ctx): Promise<void> {
			if (args.trim()) {
				ctx.ui.notify("Usage: /kernel", "error");
				return;
			}
			const dashboard = createKernelDashboard(ctx);
			try {
				if (ctx.hasUI) await dashboard.showOverlay();
				else ctx.ui.notify(dashboard.renderText(80).join("\n"), "info");
			} finally {
				dashboard.dispose();
			}
		},
	});

	api.registerShortcut("alt+r", {
		description: "Cycle agent and available REPL backends",
		handler(ctx): void {
			const selected = cycleReplBackend();
			ctx.ui.setStatus("bomp-repl", selected === "agent" ? undefined : `REPL ${selected}`);
			ctx.ui.notify(selected === "agent" ? "Agent input" : `REPL backend: ${selected}`, "info");
		},
	});

	api.on("session_shutdown", (_event, ctx) => {
		unsubscribeInput?.(); unsubscribeInput = undefined; active = "agent"; available = [...DEFAULT_BACKENDS];
		ctx.ui.setStatus("bomp-repl", undefined);
	});
};

export default createReplExtension;
