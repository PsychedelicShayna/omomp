// omomp-loadout: atomic runtime model loadout switching.
// Self-contained extension directory — drag into any omp extensions dir to
// enable, drag out to disable. State lives in <agentDir>/omomp-loadout.json.
// Requires the patched omp build's ctx.applyRuntimeModelLoadout; on a stock
// build /loadout use|off reports the missing capability instead of switching.
import type { ExtensionAPI, ExtensionCommandContext } from "/home/shayna/omp/packages/coding-agent/src/extensibility/extensions/types.ts";
import { createLoadoutFeature } from "./loadout.ts";
import type { LoadoutFeature } from "./loadout.ts";
import { BompStateStore, defaultStatePath } from "./state.ts";
import { output, report, words } from "./util.ts";

/** Interactive select-based loadout menu — replaces the old overlay dashboard. */
async function loadoutMenu(loadouts: LoadoutFeature, ctx: ExtensionCommandContext): Promise<void> {
	// eslint-disable-next-line no-constant-condition
	while (true) {
		const data = await loadouts.data();
		const options = [
			...data.items.map(item => ({
				label: `${item.active ? "● " : "  "}${item.name}`,
				description: item.loadout.mainModel,
			})),
			...(data.active ? [{ label: "✕ Deactivate loadout", description: `Turn off '${data.active}'` }] : []),
		];

		if (options.length === 0) {
			ctx.ui.notify("No loadouts defined.", "info");
			return;
		}

		const title = data.active ? `Loadouts (active: ${data.active})` : "Loadouts";
		const selected = await ctx.ui.select(title, options);
		if (!selected) return;

		if (selected === "✕ Deactivate loadout") {
			ctx.ui.notify(await loadouts.off(ctx), "info");
			continue;
		}

		// Selected a loadout — show detail actions
		const loadoutName = selected.replace(/^[● ] {0,2}/, "");
		const isActive = data.items.find(i => i.name === loadoutName)?.active ?? false;
		const action = await ctx.ui.select(`${loadoutName}`, [
			...(isActive ? [] : [{ label: "Use", description: "Apply this loadout to the session" }]),
			{ label: "Show", description: "View the full loadout definition" },
			...(isActive ? [{ label: "Deactivate", description: "Turn off this loadout" }] : []),
		]);
		if (!action) continue;

		switch (action) {
			case "Use": ctx.ui.notify(await loadouts.use(loadoutName, ctx), "info"); break;
			case "Show": ctx.ui.notify(await loadouts.show(loadoutName), "info"); break;
			case "Deactivate": ctx.ui.notify(await loadouts.off(ctx), "info"); break;
		}
	}
}

export default function omomp_loadout(api: ExtensionAPI): void {
	const store = new BompStateStore(defaultStatePath());
	const loadouts = createLoadoutFeature(store);

	api.registerCommand("loadout", {
		description: "Manage volatile runtime model loadouts",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const [command, name] = words(args);
			if (!command) {
				if (!ctx.hasUI) return report(ctx, () => loadouts.status());
				await loadoutMenu(loadouts, ctx);
				return;
			}
			switch (command) {
				case "list": return report(ctx, () => loadouts.list());
				case "show": if (!name) return output(ctx, "Usage: /loadout show <name>", true); return report(ctx, () => loadouts.show(name));
				case "status": return report(ctx, () => loadouts.status());
				case "use": if (!name) return output(ctx, "Usage: /loadout use <name>", true); return report(ctx, () => loadouts.use(name, ctx));
				case "off": return report(ctx, () => loadouts.off(ctx));
				default: return output(ctx, "Usage: /loadout list|show <name>|use <name>|off|status", true);
			}
		}
	});
}
