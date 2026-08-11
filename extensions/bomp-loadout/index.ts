// bomp-loadout: atomic runtime model loadout switching.
// Self-contained extension directory — drag into any omp extensions dir to
// enable, drag out to disable. State lives in <agentDir>/bomp-loadout.json.
// Requires the patched omp build's ctx.applyRuntimeModelLoadout; on a stock
// build /loadout use|off reports the missing capability instead of switching.
import type { ExtensionAPI, ExtensionCommandContext } from "/home/shayna/omp/packages/coding-agent/src/extensibility/extensions/types.ts";
import { createLoadoutFeature } from "./loadout.ts";
import { BompStateStore, defaultStatePath } from "./state.ts";
import { createLoadoutDashboard } from "./ui/loadout-dashboard.ts";
import { output, report, words } from "./util.ts";

export default function bompLoadout(api: ExtensionAPI): void {
	const store = new BompStateStore(defaultStatePath());
	const loadouts = createLoadoutFeature(store);

	api.registerCommand("loadout", {
		description: "Manage volatile runtime model loadouts",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const [command, name] = words(args);
			if (!command) {
				if (!ctx.hasUI) return report(ctx, () => loadouts.status());
				const dashboard = createLoadoutDashboard(loadouts, ctx);
				try { await dashboard.showOverlay(); } finally { dashboard.dispose(); }
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
