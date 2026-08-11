// bomp-repl state: shell profiles and Jupyter kernel aliases, persisted in
// <agentDir>/bomp-repl.json. Self-contained.
import { copyFile, mkdir, open, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ShellProfile { command: string; args?: string[]; env?: Record<string, string> }
export interface BompState {
	schemaVersion: 1;
	shellProfiles: Record<string, ShellProfile>;
	kernelAliases: Record<string, string>;
}
export const emptyBompState = (): BompState => ({ schemaVersion: 1, shellProfiles: {}, kernelAliases: {} });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const stringRecord = (v: unknown): v is Record<string, string> => isRecord(v) && Object.values(v).every(x => typeof x === "string");
const shell = (v: unknown): v is ShellProfile => isRecord(v) && typeof v.command === "string" && (v.args === undefined || (Array.isArray(v.args) && v.args.every(x => typeof x === "string"))) && (v.env === undefined || stringRecord(v.env));
export function validateBompState(v: unknown): BompState {
	if (!isRecord(v) || v.schemaVersion !== 1 || !isRecord(v.shellProfiles) || !Object.values(v.shellProfiles).every(shell) || !stringRecord(v.kernelAliases)) throw new Error("Invalid schema-v1 bomp-repl.json");
	return v as unknown as BompState;
}

/** Active agent directory: profile-aware in-process, plain ~/.omp/agent otherwise. */
export function agentDir(): string { return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent"); }
export const defaultStatePath = (): string => join(agentDir(), "bomp-repl.json");

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

export async function readReplProfiles(store: BompStateStore): Promise<Pick<BompState, "shellProfiles" | "kernelAliases">> {
	const { shellProfiles, kernelAliases } = await store.read();
	return { shellProfiles, kernelAliases };
}
