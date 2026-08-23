// omomp-live-persona: named instruction sets for the live voice model.
// Command-surface twin of omomp-persona. The store, validation, and resolver
// live in the fork at packages/coding-agent/src/live/personas.ts so the live
// controller resolves the exact same state file
// (<agentDir>/omomp-live-personas.json); this extension is only the command UX.
import type { ExtensionAPI, ExtensionCommandContext } from "/home/shayna/omp/packages/coding-agent/src/extensibility/extensions/types.ts";
import type { LivePersonaFeature } from "../../packages/coding-agent/src/live/personas.ts";
import { createLivePersonaFeature, DEFAULT_LIVE_PERSONA } from "../../packages/coding-agent/src/live/personas.ts";
import { output, report, words } from "./util.ts";

/** Reflect the current selection in the footer, mirroring omomp-persona's status line. */
async function syncStatus(personas: LivePersonaFeature, ctx: ExtensionCommandContext): Promise<void> {
	const data = await personas.data();
	ctx.ui.setStatus("omomp-live-persona", data.active === DEFAULT_LIVE_PERSONA ? undefined : `live persona: ${data.active}`);
}

async function livePersonaUse(personas: LivePersonaFeature, ctx: ExtensionCommandContext, name: string): Promise<void> {
	await report(ctx, async () => {
		const result = await personas.use(name);
		await syncStatus(personas, ctx);
		return result;
	});
}

async function livePersonaDelete(personas: LivePersonaFeature, ctx: ExtensionCommandContext, name: string): Promise<void> {
	await report(ctx, async () => {
		const result = await personas.delete(name);
		await syncStatus(personas, ctx);
		return result;
	});
}

/** Clone-and-tweak flow: pick a source, name the copy, optionally edit right away. */
async function livePersonaClone(personas: LivePersonaFeature, ctx: ExtensionCommandContext, source?: string): Promise<void> {
	let from = source;
	if (!from) {
		const data = await personas.data();
		from = await ctx.ui.select("Clone from", data.items.map(item => item.name));
		if (!from) return;
	}
	const name = await ctx.ui.input("New live persona name");
	if (!name) return;
	await report(ctx, () => personas.clone(from, name));
	if (await ctx.ui.confirm("Edit now", `Open '${name}' in the editor?`)) {
		await livePersonaEdit(personas, ctx, name);
	}
}

/** Edit flow using the built-in editor, prefilled with the current instructions. */
async function livePersonaEdit(personas: LivePersonaFeature, ctx: ExtensionCommandContext, existingName?: string): Promise<void> {
	const name = existingName ?? (await ctx.ui.input("Live persona name"));
	if (!name) return;
	let current: string;
	try {
		current = await personas.show(name);
	} catch (error) {
		output(ctx, error instanceof Error ? error.message : String(error), true);
		return;
	}
	const instructions = await ctx.ui.editor("Live persona instructions", current);
	if (instructions === undefined) return;
	await report(ctx, () => personas.edit(name, instructions));
}

/** Interactive select-based menu, mirroring the /persona menu. */
async function livePersonaMenu(personas: LivePersonaFeature, ctx: ExtensionCommandContext): Promise<void> {
	// eslint-disable-next-line no-constant-condition
	while (true) {
		const data = await personas.data();
		const options = [
			...data.items.map(item => ({
				label: `${item.active ? "● " : "  "}${item.name}`,
				description: item.builtin ? "built-in default (immutable, clone to customize)" : `${item.instructions.length} chars`,
			})),
			{ label: "✚ Clone persona", description: "Create a new live persona from an existing one" },
		];

		const selected = await ctx.ui.select(`Live personas (active: ${data.active})`, options);
		if (!selected) return; // user cancelled

		if (selected === "✚ Clone persona") {
			await livePersonaClone(personas, ctx);
			continue;
		}

		// Selected a persona row — show detail actions
		const personaName = selected.replace(/^[● ] {0,2}/, "");
		const item = data.items.find(i => i.name === personaName);
		if (!item) continue;
		const action = await ctx.ui.select(`${personaName}`, [
			...(item.active ? [] : [{ label: "Use", description: "Send these instructions to the next live session" }]),
			{ label: "Show", description: "View the full instruction text" },
			{ label: "Clone", description: "Copy into a new live persona" },
			...(item.builtin
				? []
				: [
					{ label: "Edit", description: "Modify the instruction text" },
					{ label: "Delete", description: "Remove this persona" },
				]),
		]);
		if (!action) continue; // back to list

		switch (action) {
			case "Use": await livePersonaUse(personas, ctx, personaName); break;
			case "Show": await report(ctx, () => personas.show(personaName)); break;
			case "Clone": await livePersonaClone(personas, ctx, personaName); break;
			case "Edit": await livePersonaEdit(personas, ctx, personaName); break;
			case "Delete": {
				if (await ctx.ui.confirm("Delete live persona", `Delete '${personaName}'?`)) {
					await livePersonaDelete(personas, ctx, personaName);
				}
				break;
			}
		}
	}
}

export default function omomp_live_persona(api: ExtensionAPI): void {
	const personas = createLivePersonaFeature();

	api.registerCommand("live-persona", {
		description: "Manage named instruction sets for the live voice model",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const [command, first, second] = words(args);
			if (!command) {
				if (!ctx.hasUI) return report(ctx, () => personas.status());
				await livePersonaMenu(personas, ctx);
				return;
			}
			switch (command) {
				case "list": return report(ctx, () => personas.list());
				case "show": {
					if (!first) return output(ctx, "Usage: /live-persona show <name>", true);
					return report(ctx, () => personas.show(first));
				}
				case "status": return report(ctx, () => personas.status());
				case "use": {
					if (!first) return output(ctx, "Usage: /live-persona use <name>", true);
					return livePersonaUse(personas, ctx, first);
				}
				case "delete": {
					if (!first) return output(ctx, "Usage: /live-persona delete <name>", true);
					return livePersonaDelete(personas, ctx, first);
				}
				case "clone": {
					if (!first) return output(ctx, "Usage: /live-persona clone <source> [name]", true);
					if (second) return report(ctx, () => personas.clone(first, second));
					if (!ctx.hasUI) return output(ctx, "Usage: /live-persona clone <source> <name>", true);
					await livePersonaClone(personas, ctx, first);
					return;
				}
				case "edit": {
					if (!ctx.hasUI) return output(ctx, "/live-persona edit requires the interactive editor", true);
					await livePersonaEdit(personas, ctx, first);
					return;
				}
				default:
					return output(ctx, "Usage: /live-persona list|show <name>|clone <source> [name]|edit [name]|use <name>|delete <name>|status", true);
			}
		},
	});
}
