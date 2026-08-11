import type { ExtensionCommandContext, RuntimeModelLoadout } from "/home/shayna/omp/packages/coding-agent/src/extensibility/extensions/types.ts";
import { BompStateStore } from "./state.ts";

export interface LoadoutData { items: Array<{ name: string; loadout: RuntimeModelLoadout; active: boolean }>; active?: string }
export interface LoadoutFeature {
	data(): Promise<LoadoutData>;
	list(): Promise<string>;
	show(name: string): Promise<string>;
	status(): Promise<string>;
	use(name: string, ctx: ExtensionCommandContext): Promise<string>;
	off(ctx: ExtensionCommandContext): Promise<string>;
}
function setUi(ctx: ExtensionCommandContext, name?: string) {
	ctx.ui.setStatus("bomp-loadout", name ? `loadout: ${name}` : undefined);
	ctx.ui.setWidget("bomp-loadout", name ? [`Active model loadout: ${name}`] : []);
}
export function createLoadoutFeature(store: BompStateStore): LoadoutFeature {
	async function data(): Promise<LoadoutData> {
		const state = await store.read();
		return { items: Object.entries(state.loadouts).sort(([a], [b]) => a.localeCompare(b)).map(([name, loadout]) => ({ name, loadout, active: name === state.activeLoadout })), ...(state.activeLoadout ? { active: state.activeLoadout } : {}) };
	}
	function requireLoadoutApi(ctx: ExtensionCommandContext): void {
		if (typeof ctx.applyRuntimeModelLoadout !== "function") throw new Error("This omp build lacks runtime model loadouts (ctx.applyRuntimeModelLoadout); /loadout use|off needs the patched build");
	}
	return {
		data,
		async list() { const d = await data(); return d.items.length ? d.items.map(x => `${x.active ? "*" : "-"} ${x.name}`).join("\n") : "No loadouts."; },
		async show(name) { const value = (await store.read()).loadouts[name]; if (!value) throw new Error(`Unknown loadout: ${name}`); return JSON.stringify(value, null, 2); },
		async status() { const active = (await store.read()).activeLoadout; return active ? `Loadout: ${active}` : "Loadout: off"; },
		async use(name, ctx) {
			if (!ctx.isIdle()) throw new Error("Loadouts can only change while the session is idle");
			requireLoadoutApi(ctx);
			const state = await store.read(); const value = state.loadouts[name]; if (!value) throw new Error(`Unknown loadout: ${name}`);
			const previous = state.activeLoadout;
			await ctx.applyRuntimeModelLoadout(value);
			try { state.activeLoadout = name; await store.write(state); }
			catch (error) {
				await ctx.applyRuntimeModelLoadout(previous ? state.loadouts[previous] : undefined);
				throw error;
			}
			setUi(ctx, name); return `Loadout '${name}' active.`;
		},
		async off(ctx) {
			if (!ctx.isIdle()) throw new Error("Loadouts can only change while the session is idle");
			requireLoadoutApi(ctx);
			const state = await store.read(); const previous = state.activeLoadout;
			await ctx.applyRuntimeModelLoadout(undefined);
			try { state.activeLoadout = null; await store.write(state); }
			catch (error) { if (previous && state.loadouts[previous]) await ctx.applyRuntimeModelLoadout(state.loadouts[previous]); throw error; }
			setUi(ctx); return "Loadout off.";
		}
	};
}
