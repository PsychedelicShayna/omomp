// bomp-persona state: personas and per-session selections, persisted in
// <agentDir>/bomp-persona.json. Self-contained; no other extension reads it.
import { copyFile, mkdir, open, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type PersonaMode = "replace" | "prepend" | "append" | "literal-substitute";
export type PersonaSource = { kind: "inline"; content: string } | { kind: "file"; path: string };
export interface PersonaDefinition { mode: PersonaMode; source: PersonaSource; literal?: string; inheritToTasks?: boolean }
export interface BompState {
	schemaVersion: 1;
	personas: Record<string, PersonaDefinition>;
	sessionPersonas: Record<string, string>;
}
export const emptyBompState = (): BompState => ({ schemaVersion: 1, personas: {}, sessionPersonas: {} });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const stringRecord = (v: unknown): v is Record<string, string> => isRecord(v) && Object.values(v).every(x => typeof x === "string");
const persona = (v: unknown): v is PersonaDefinition => isRecord(v) && ["replace", "prepend", "append", "literal-substitute"].includes(String(v.mode)) && isRecord(v.source) && ((v.source.kind === "inline" && typeof v.source.content === "string") || (v.source.kind === "file" && typeof v.source.path === "string")) && (v.literal === undefined || typeof v.literal === "string") && (v.inheritToTasks === undefined || typeof v.inheritToTasks === "boolean");
export function validateBompState(v: unknown): BompState {
	if (!isRecord(v) || v.schemaVersion !== 1 || !isRecord(v.personas) || !Object.values(v.personas).every(persona) || !stringRecord(v.sessionPersonas)) throw new Error("Invalid schema-v1 bomp-persona.json");
	return v as unknown as BompState;
}

/** Active agent directory: profile-aware in-process, plain ~/.omp/agent otherwise. */
export function agentDir(): string { return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent"); }
export const defaultStatePath = (): string => join(agentDir(), "bomp-persona.json");

export class BompStateStore {
	readonly backupPath: string;
	constructor(readonly path: string) { this.backupPath = `${path}.bak`; }
	async read(): Promise<BompState> {
		try { return validateBompState(JSON.parse(await readFile(this.path, "utf8"))); }
		catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyBompState(); throw e; }
	}
	async write(state: BompState): Promise<void> {
		validateBompState(state); await mkdir(dirname(this.path), { recursive: true });
		const temp = join(dirname(this.path), `.${Bun.randomUUIDv7()}.tmp`);
		try { await copyFile(this.path, this.backupPath); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
		const file = await open(temp, "wx", 0o600);
		try { await file.writeFile(`${JSON.stringify(state, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
		await rename(temp, this.path);
		const dir = await open(dirname(this.path), "r"); try { await dir.sync(); } finally { await dir.close(); }
	}
	async update(fn: (state: BompState) => void): Promise<BompState> { const state = await this.read(); fn(state); await this.write(state); return state; }
}
