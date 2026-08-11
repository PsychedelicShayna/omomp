// bomp-loadout state: named runtime model loadouts and the active selection,
// persisted in <agentDir>/bomp-loadout.json. Self-contained.
import { copyFile, mkdir, open, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RuntimeModelLoadout } from "/home/shayna/omp/packages/coding-agent/src/extensibility/extensions/types.ts";

export interface BompState {
	schemaVersion: 1;
	loadouts: Record<string, RuntimeModelLoadout>;
	activeLoadout: string | null;
}
export const emptyBompState = (): BompState => ({ schemaVersion: 1, loadouts: {}, activeLoadout: null });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const stringRecord = (v: unknown): v is Record<string, string> => isRecord(v) && Object.values(v).every(x => typeof x === "string");
const loadout = (v: unknown): v is RuntimeModelLoadout => isRecord(v) && typeof v.name === "string" && typeof v.mainModel === "string" && stringRecord(v.modelRoles) && isRecord(v.retryFallbackChains) && Object.values(v.retryFallbackChains).every(x => Array.isArray(x) && x.every(y => typeof y === "string")) && stringRecord(v.taskAgentModelOverrides);
export function validateBompState(v: unknown): BompState {
	if (!isRecord(v) || v.schemaVersion !== 1 || !isRecord(v.loadouts) || !Object.values(v.loadouts).every(loadout) || (v.activeLoadout !== null && typeof v.activeLoadout !== "string")) throw new Error("Invalid schema-v1 bomp-loadout.json");
	return v as unknown as BompState;
}

/** Active agent directory: profile-aware in-process, plain ~/.omp/agent otherwise. */
export function agentDir(): string { return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent"); }
export const defaultStatePath = (): string => join(agentDir(), "bomp-loadout.json");

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
