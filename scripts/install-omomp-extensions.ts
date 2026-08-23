#!/usr/bin/env bun
/**
 * Deploy every OMOMP-owned extension from the repo `extensions/` tree into an
 * agent extensions directory.
 *
 * Each source directory becomes a symlink at `<dest>/<name>`. That keeps
 * in-repo relative imports (notably omomp-live-persona's runtime import of
 * `packages/coding-agent/src/live/personas.ts`) resolvable, and it picks up
 * new fork extensions without a hard-coded name list. Entries already in
 * dest that are not in the source tree are left untouched. A same-named
 * dest directory is renamed aside, never deleted.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";

export interface InstallOmompExtensionsOptions {
	sourceDir: string;
	destDir: string;
}

export interface OmompExtensionBackup {
	name: string;
	path: string;
}

export interface InstallOmompExtensionsResult {
	installed: string[];
	refreshed: string[];
	unchanged: string[];
	backups: OmompExtensionBackup[];
}

type ManagedSymlinkOutcome = {
	status: "installed" | "refreshed" | "unchanged";
	backup?: string;
};

let afterRenameAsideForTests: ((dest: string, backup: string) => Promise<void>) | undefined;

/** Test-only hook invoked after dest is renamed aside and before activation. */
export function __setAfterRenameAsideForTests(
	hook: ((dest: string, backup: string) => Promise<void>) | undefined,
): void {
	afterRenameAsideForTests = hook;
}

function isEnoent(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isDirBusy(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "EISDIR" || error.code === "ENOTEMPTY" || error.code === "EPERM")
	);
}

export function defaultOmompExtensionsSourceDir(repoRoot: string): string {
	return path.join(repoRoot, "extensions");
}

export function defaultOmompExtensionsDestDir(agentDir?: string): string {
	return path.join(agentDir ?? getAgentDir(), "extensions");
}

/** Directory names under `sourceDir` that should be deployed. Hidden names and files are ignored. */
export async function listOmompExtensionNames(sourceDir: string): Promise<string[]> {
	let entries: Awaited<ReturnType<typeof fs.readdir>>;
	try {
		entries = await fs.readdir(sourceDir, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) {
			throw new Error(`OMOMP extensions source is missing: ${sourceDir}`);
		}
		throw error;
	}
	const names: string[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		if (!entry.isDirectory()) continue;
		names.push(entry.name);
	}
	names.sort();
	return names;
}

async function sameRealpath(left: string, right: string): Promise<boolean> {
	try {
		return (await fs.realpath(left)) === (await fs.realpath(right));
	} catch {
		return false;
	}
}

function hiddenSibling(dest: string, label: string): string {
	return path.join(path.dirname(dest), `.${path.basename(dest)}.${label}`);
}

async function restoreBackup(backup: string, dest: string, cause: unknown): Promise<never> {
	try {
		await fs.rename(backup, dest);
	} catch (restoreError) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		throw new Error(`Failed to activate symlink at ${dest}; original left at ${backup}: ${reason}`, {
			cause: restoreError,
		});
	}
	throw cause;
}

async function ensureManagedSymlink(source: string, dest: string): Promise<ManagedSymlinkOutcome> {
	const absSource = await fs.realpath(source);
	if (await sameRealpath(dest, absSource)) return { status: "unchanged" };

	let existed = false;
	try {
		await fs.lstat(dest);
		existed = true;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	await fs.mkdir(path.dirname(dest), { recursive: true });
	const tmp = hiddenSibling(dest, `${process.pid}.${Date.now()}.tmp`);
	let backup: string | undefined;
	let tmpMoved = false;

	try {
		await fs.symlink(absSource, tmp);
		try {
			await fs.rename(tmp, dest);
			tmpMoved = true;
		} catch (error) {
			if (!isDirBusy(error)) throw error;
			backup = hiddenSibling(dest, `pre-symlink.${Date.now()}`);
			await fs.rename(dest, backup);
			try {
				if (afterRenameAsideForTests) await afterRenameAsideForTests(dest, backup);
				await fs.rename(tmp, dest);
				tmpMoved = true;
			} catch (activateError) {
				await restoreBackup(backup, dest, activateError);
			}
		}
	} finally {
		if (!tmpMoved) {
			await fs.rm(tmp, { force: true });
		}
	}

	return {
		status: existed ? "refreshed" : "installed",
		backup,
	};
}

/**
 * Symlink every source extension directory into `destDir`. Never deletes dest
 * entries whose names are not in the source set. Same-named dest directories
 * are renamed aside and reported, not removed.
 */
export async function installOmompExtensions(
	options: InstallOmompExtensionsOptions,
): Promise<InstallOmompExtensionsResult> {
	const sourceDir = path.resolve(options.sourceDir);
	const destDir = path.resolve(options.destDir);
	const names = await listOmompExtensionNames(sourceDir);
	await fs.mkdir(destDir, { recursive: true });

	const result: InstallOmompExtensionsResult = { installed: [], refreshed: [], unchanged: [], backups: [] };
	for (const name of names) {
		const outcome = await ensureManagedSymlink(path.join(sourceDir, name), path.join(destDir, name));
		result[outcome.status].push(name);
		if (outcome.backup) result.backups.push({ name, path: outcome.backup });
	}
	return result;
}

export function formatOmompExtensionsResult(result: InstallOmompExtensionsResult): string {
	const parts = [
		result.installed.length ? `linked ${result.installed.join(", ")}` : undefined,
		result.refreshed.length ? `refreshed ${result.refreshed.join(", ")}` : undefined,
		result.unchanged.length ? `already current ${result.unchanged.join(", ")}` : undefined,
		result.backups.length
			? `kept ${result.backups.map(backup => `${backup.name} at ${backup.path}`).join(", ")}`
			: undefined,
	].filter((part): part is string => part !== undefined);
	return parts.length > 0 ? parts.join("; ") : "no OMOMP extensions to deploy";
}

function parseArgs(argv: string[]): { sourceDir?: string; destDir?: string } {
	const parsed: { sourceDir?: string; destDir?: string } = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = argv[i + 1];
		if (arg === "--source" && next) {
			parsed.sourceDir = next;
			i++;
			continue;
		}
		if (arg === "--dest" && next) {
			parsed.destDir = next;
			i++;
			continue;
		}
		throw new Error(`usage: install-omomp-extensions.ts [--source <dir>] [--dest <dir>]`);
	}
	return parsed;
}

if (import.meta.main) {
	const args = parseArgs(process.argv.slice(2));
	const repoRoot = path.join(import.meta.dir, "..");
	const result = await installOmompExtensions({
		sourceDir: args.sourceDir ?? defaultOmompExtensionsSourceDir(repoRoot),
		destDir: args.destDir ?? defaultOmompExtensionsDestDir(),
	});
	console.log(`omomp extensions: ${formatOmompExtensionsResult(result)}`);
}
