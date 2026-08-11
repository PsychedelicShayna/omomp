// bomp-persona: session-scoped system-prompt personas.
// Self-contained extension directory — drag into any omp extensions dir to
// enable, drag out to disable. State lives in <agentDir>/bomp-persona.json.
import type { ExtensionAPI, ExtensionCommandContext } from "/home/shayna/omp/packages/coding-agent/src/extensibility/extensions/types.ts";
import { createPersonaFeature, parsePersonaDefinition } from "./persona.ts";
import { agentDir, BompStateStore, defaultStatePath } from "./state.ts";
import { createPersonaDashboard } from "./ui/persona-dashboard.ts";
import { output, report, words } from "./util.ts";

export default function bompPersona(api: ExtensionAPI): void {
	const store = new BompStateStore(defaultStatePath());
	const personas = createPersonaFeature(store, agentDir(), api);
	api.on("before_agent_start", (event, ctx) => personas.apply(event, ctx));

	api.registerCommand("persona", {
		description: "Manage session-scoped bomp personas",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const [command, name] = words(args); const id = ctx.sessionManager.getSessionId();
			if (!command) {
				if (!ctx.hasUI) return report(ctx, () => personas.status(id));
				const dashboard = createPersonaDashboard(personas, ctx, id);
				try { await dashboard.showOverlay(); } finally { dashboard.dispose(); }
				return;
			}
			switch (command) {
				case "list": return report(ctx, () => personas.list(id));
				case "show": if (!name) return output(ctx, "Usage: /persona show <name>", true); return report(ctx, () => personas.show(name));
				case "status": return report(ctx, () => personas.status(id));
				case "use": if (!name) return output(ctx, "Usage: /persona use <name>", true); return report(ctx, () => personas.use(name, ctx));
				case "off": return report(ctx, () => personas.off(ctx));
				case "delete": if (!name) return output(ctx, "Usage: /persona delete <name>", true); return report(ctx, () => personas.delete(name, ctx));
				case "create":
				case "edit": {
					if (!ctx.hasUI) return output(ctx, `/persona ${command} requires the interactive editor`, true);
					const target = name ?? await ctx.ui.input("Persona name"); if (!target) return;
					const mode = await ctx.ui.select("Persona mode", ["replace", "prepend", "append", "literal-substitute"]); if (!mode) return;
					const sourceKind = await ctx.ui.select("Persona source", ["inline", "file"]); if (!sourceKind) return;
					const value = sourceKind === "inline" ? await ctx.ui.editor("Persona content") : await ctx.ui.input("Path relative to the agent directory"); if (value === undefined) return;
					const literal = mode === "literal-substitute" ? await ctx.ui.input("Literal to replace") : undefined;
					const inherit = await ctx.ui.confirm("Task inheritance", "Stamp inheritToTasks metadata for future children?");
					const definition = parsePersonaDefinition(mode, sourceKind, value, literal, inherit);
					return report(ctx, () => command === "create" ? personas.create(target, definition) : personas.edit(target, definition));
				}
				default: return output(ctx, "Usage: /persona list|show <name>|create [name]|edit [name]|use <name>|off|delete <name>|status", true);
			}
		}
	});
}
