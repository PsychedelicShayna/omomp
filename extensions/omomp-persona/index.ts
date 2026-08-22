// omomp-persona: session-scoped system-prompt personas.
// Self-contained extension directory — drag into any omp extensions dir to
// enable, drag out to disable. State lives in <agentDir>/omomp-persona.json.
import type { ExtensionAPI, ExtensionCommandContext } from "/home/shayna/omp/packages/coding-agent/src/extensibility/extensions/types.ts";
import { createPersonaFeature, parsePersonaDefinition } from "./persona.ts";
import type { PersonaFeature } from "./persona.ts";
import { agentDir, BompStateStore, defaultStatePath } from "./state.ts";
import { output, report, words } from "./util.ts";

/** Interactive select-based persona menu — replaces the old overlay dashboard. */
async function personaMenu(personas: PersonaFeature, ctx: ExtensionCommandContext, sessionId: string): Promise<void> {
	// eslint-disable-next-line no-constant-condition
	while (true) {
		const data = await personas.data(sessionId);
		const options = [
			...data.items.map(item => ({
				label: `${item.active ? "● " : "  "}${item.name}`,
				description: `${item.definition.mode} · ${item.definition.source.kind}`,
			})),
			{ label: "✚ Create new persona", description: "Add a new persona definition" },
			...(data.active ? [{ label: "✕ Deactivate persona", description: `Turn off '${data.active}'` }] : []),
		];

		const title = data.active ? `Personas (active: ${data.active})` : "Personas";
		const selected = await ctx.ui.select(title, options);
		if (!selected) return; // user cancelled

		if (selected === "✚ Create new persona") {
			await personaCreateEdit(personas, ctx, "create");
			continue;
		}

		if (selected === "✕ Deactivate persona") {
			const result = await personas.off(ctx);
			ctx.ui.notify(result, "info");
			continue;
		}

		// Selected a persona row — show detail actions
		const personaName = selected.replace(/^[● ] {0,2}/, "");
		const isActive = data.items.find(i => i.name === personaName)?.active ?? false;
		const action = await ctx.ui.select(`${personaName}`, [
			...(isActive ? [] : [{ label: "Use", description: "Activate this persona for the session" }]),
			{ label: "Show", description: "View the full persona definition" },
			{ label: "Edit", description: "Modify this persona" },
			...(isActive ? [{ label: "Deactivate", description: "Turn off this persona" }] : []),
			{ label: "Delete", description: "Remove this persona" },
		]);
		if (!action) continue; // back to list

		switch (action) {
			case "Use": ctx.ui.notify(await personas.use(personaName, ctx), "info"); break;
			case "Show": ctx.ui.notify(await personas.show(personaName), "info"); break;
			case "Edit": await personaCreateEdit(personas, ctx, "edit", personaName); break;
			case "Deactivate": ctx.ui.notify(await personas.off(ctx), "info"); break;
			case "Delete": {
				if (await ctx.ui.confirm("Delete persona", `Delete '${personaName}'?`)) {
					ctx.ui.notify(await personas.delete(personaName, ctx), "info");
				}
				break;
			}
		}
	}
}

/** Shared create/edit flow using built-in selectors and editor. */
async function personaCreateEdit(
	personas: PersonaFeature,
	ctx: ExtensionCommandContext,
	command: "create" | "edit",
	existingName?: string,
): Promise<void> {
	const target = existingName ?? await ctx.ui.input("Persona name");
	if (!target) return;
	const mode = await ctx.ui.select("Persona mode", ["replace", "prepend", "append", "literal-substitute"]);
	if (!mode) return;
	const sourceKind = await ctx.ui.select("Persona source", ["inline", "file"]);
	if (!sourceKind) return;
	const value = sourceKind === "inline"
		? await ctx.ui.editor("Persona content")
		: await ctx.ui.input("Path relative to the agent directory");
	if (value === undefined) return;
	const literal = mode === "literal-substitute" ? await ctx.ui.input("Literal to replace") : undefined;
	const inherit = await ctx.ui.confirm("Task inheritance", "Stamp inheritToTasks metadata for future children?");
	const definition = parsePersonaDefinition(mode, sourceKind, value, literal, inherit);
	const result = command === "create" ? await personas.create(target, definition) : await personas.edit(target, definition);
	ctx.ui.notify(result, "info");
}

export default function omomp_persona(api: ExtensionAPI): void {
	const store = new BompStateStore(defaultStatePath());
	const personas = createPersonaFeature(store, agentDir(), api);
	api.on("before_agent_start", (event, ctx) => personas.apply(event, ctx));

	api.registerCommand("persona", {
		description: "Manage session-scoped omomp personas",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const [command, name] = words(args);
			const id = ctx.sessionManager.getSessionId();
			if (!command) {
				if (!ctx.hasUI) return report(ctx, () => personas.status(id));
				await personaMenu(personas, ctx, id);
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
					await personaCreateEdit(personas, ctx, command, name ?? undefined);
					return;
				}
				default: return output(ctx, "Usage: /persona list|show <name>|create [name]|edit [name]|use <name>|off|delete <name>|status", true);
			}
		}
	});
}
