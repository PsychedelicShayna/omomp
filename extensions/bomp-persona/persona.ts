import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { BeforeAgentStartEvent, BeforeAgentStartEventResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "/home/shayna/omp/packages/coding-agent/src/extensibility/extensions/types.ts";
import { BompStateStore, type PersonaDefinition, type PersonaMode } from "./state.ts";

export interface PersonaData { items: Array<{ name: string; definition: PersonaDefinition; active: boolean }>; active?: string; warning?: string }
export interface PersonaFeature {
	data(sessionId: string): Promise<PersonaData>;
	list(sessionId: string): Promise<string>;
	show(name: string): Promise<string>;
	status(sessionId: string): Promise<string>;
	use(name: string, ctx: ExtensionCommandContext): Promise<string>;
	off(ctx: ExtensionCommandContext): Promise<string>;
	delete(name: string, ctx: ExtensionCommandContext): Promise<string>;
	create(name: string, definition: PersonaDefinition): Promise<string>;
	edit(name: string, definition: PersonaDefinition): Promise<string>;
	apply(event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<BeforeAgentStartEventResult | undefined>;
}

const warnings = new Map<string, string>();
const annotated = new Set<string>();
function ordered(state: Record<string, PersonaDefinition>) { return Object.entries(state).sort(([a], [b]) => a.localeCompare(b)); }
function setUi(ctx: ExtensionCommandContext, active?: string, warning?: string) {
	ctx.ui.setStatus("bomp-persona", active ? `persona: ${active}` : undefined);
	ctx.ui.setWidget("bomp-persona", warning ? [`Persona warning: ${warning}`] : []);
}
function sessionId(ctx: ExtensionCommandContext) { return ctx.sessionManager.getSessionId(); }
function validName(name: string) { if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error("Persona name must contain only letters, numbers, '.', '_' or '-'"); }

export function createPersonaFeature(store: BompStateStore, agentRoot: string, api?: ExtensionAPI): PersonaFeature {
	async function source(definition: PersonaDefinition): Promise<string> {
		if (definition.source.kind === "inline") {
			if (!definition.source.content.trim()) throw new Error("persona content is empty");
			return definition.source.content;
		}
		const root = await realpath(agentRoot);
		const candidate = await realpath(resolve(root, definition.source.path));
		const rel = relative(root, candidate);
		if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error("persona file escapes profile agent root");
		const content = await readFile(candidate, "utf8");
		if (!content.trim()) throw new Error("persona file is empty");
		return content;
	}
	async function data(id: string): Promise<PersonaData> {
		const state = await store.read(); const active = state.sessionPersonas[id];
		return { items: ordered(state.personas).map(([name, definition]) => ({ name, definition, active: name === active })), active, warning: warnings.get(id) };
	}
	async function activate(name: string, ctx: ExtensionCommandContext): Promise<string> {
		const id = sessionId(ctx); const state = await store.read(); const definition = state.personas[name];
		if (!definition) throw new Error(`Unknown persona: ${name}`);
		await source(definition);
		state.sessionPersonas[id] = name; await store.write(state);
		warnings.delete(id); annotated.forEach(key => { if (key.startsWith(`${id}\0`)) annotated.delete(key); });
		api?.appendEntry("bomp_persona", { name, sessionId: id, metadata: definition.inheritToTasks ? { inheritToTasks: true } : {} });
		ctx.invalidatePromptCache?.(); setUi(ctx, name); return `Persona '${name}' active for this session.`;
	}
	return {
		data,
		async list(id) { const d = await data(id); return d.items.length ? d.items.map(x => `${x.active ? "*" : "-"} ${x.name}`).join("\n") : "No personas."; },
		async show(name) { const d = (await store.read()).personas[name]; if (!d) throw new Error(`Unknown persona: ${name}`); return JSON.stringify(d, null, 2); },
		async status(id) { const d = await data(id); return d.active ? `Persona: ${d.active}${d.warning ? ` (warning: ${d.warning})` : ""}` : "Persona: off"; },
		use: activate,
		async off(ctx) { const id = sessionId(ctx); const state = await store.read(); delete state.sessionPersonas[id]; await store.write(state); warnings.delete(id); ctx.invalidatePromptCache?.(); setUi(ctx); return "Persona off."; },
		async delete(name, ctx) {
			const currentId = sessionId(ctx);
			const state = await store.read();
			if (!state.personas[name]) throw new Error(`Unknown persona: ${name}`);
			const currentSelection = state.sessionPersonas[currentId];
			const deletingActive = currentSelection === name;
			delete state.personas[name];
			for (const [id, selected] of Object.entries(state.sessionPersonas)) {
				if (selected === name) delete state.sessionPersonas[id];
			}
			await store.write(state);
			if (deletingActive) {
				warnings.delete(currentId);
				ctx.invalidatePromptCache?.();
				setUi(ctx);
			} else {
				setUi(ctx, currentSelection, warnings.get(currentId));
			}
			return `Deleted persona '${name}'.`;
		},
		async create(name, definition) { validName(name); const state = await store.read(); if (state.personas[name]) throw new Error(`Persona already exists: ${name}`); await source(definition); state.personas[name] = definition; await store.write(state); return `Created persona '${name}'.`; },
		async edit(name, definition) { validName(name); const state = await store.read(); if (!state.personas[name]) throw new Error(`Unknown persona: ${name}`); await source(definition); state.personas[name] = definition; await store.write(state); return `Updated persona '${name}'.`; },
		async apply(event, ctx) {
			const id = ctx.sessionManager.getSessionId(); const state = await store.read(); const name = state.sessionPersonas[id]; if (!name) return;
			const definition = state.personas[name];
			try {
				if (!definition) throw new Error("selected persona no longer exists");
				const text = await source(definition); let systemPrompt: string[];
				switch (definition.mode) {
					case "replace": systemPrompt = [text]; break;
					case "prepend": systemPrompt = [text, ...event.systemPrompt]; break;
					case "append": systemPrompt = [...event.systemPrompt, text]; break;
					case "literal-substitute": {
						const literal = definition.literal;
						if (!literal) throw new Error("literal substitute requires a non-empty literal");
						const matched = event.systemPrompt.some(segment => segment.includes(literal));
						if (!matched) throw new Error("literal not found in system prompt");
						systemPrompt = event.systemPrompt.map(segment => segment.replaceAll(literal, text));
						break;
					}
				}
				warnings.delete(id);
				ctx.ui.setStatus("bomp-persona", `persona: ${name}`);
				ctx.ui.setWidget("bomp-persona", []);
				return { systemPrompt };
			} catch (error) {
				const warning = error instanceof Error ? error.message : String(error);
				warnings.set(id, warning);
				ctx.ui.setStatus("bomp-persona", `persona: ${name} (warning)`);
				ctx.ui.setWidget("bomp-persona", [`Persona warning: ${warning}`]);
				const key = `${id}\0${name}\0${warning}`;
				if (!annotated.has(key)) {
					annotated.add(key);
					api?.appendEntry("bomp_persona_warning", { command: `/persona use ${name}`, name, warning });
				}
				return;
			}
		}
	};
}

export function parsePersonaDefinition(mode: string, sourceKind: string, value: string, literal?: string, inheritToTasks = false): PersonaDefinition {
	if (!["replace", "prepend", "append", "literal-substitute"].includes(mode)) throw new Error("Invalid persona mode");
	if (sourceKind !== "inline" && sourceKind !== "file") throw new Error("Invalid persona source kind");
	return { mode: mode as PersonaMode, source: sourceKind === "inline" ? { kind: "inline", content: value } : { kind: "file", path: value }, ...(literal ? { literal } : {}), ...(inheritToTasks ? { inheritToTasks: true } : {}) };
}
