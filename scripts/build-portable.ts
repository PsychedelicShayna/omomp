#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const packageDir = path.join(repoRoot, "packages/coding-agent");
const nativeDir = path.join(repoRoot, "packages/natives/native");
const baselineNativeName = "pi_natives.linux-x64-baseline.node";
const compileTarget = "bun-linux-x64-baseline" as const;
const wrapperName = "omomp-ram-wrapper.sh" as const;

export interface PortableManifest {
	readonly schemaVersion: 1;
	readonly version: string;
	readonly nativesVersion: string;
	readonly compatibilityTier: "linux-x64-baseline";
	readonly compileTarget: typeof compileTarget;
	readonly binary: { readonly filename: "omomp"; readonly sha256: string };
	readonly native: { readonly filename: typeof baselineNativeName; readonly sha256: string };
	readonly wrapper: { readonly filename: typeof wrapperName; readonly sha256: string };
	readonly nativeBuildRoute: "bazel" | "cargo";
	readonly rustTargetCpu: "x86-64-v2";
	readonly embeddedNativeVariants: readonly ["baseline"];
}

export function resolvePortableNativeBuild(which: (name: string) => string | null = Bun.which): "bazel" | "cargo" {
	return which("bazelisk") || which("bazel") ? "bazel" : "cargo";
}

export function assertBaselineEmbedding(source: string): void {
	const variants = [...source.matchAll(/variant:\s*["'](modern|baseline|default)["']/g)].map(match => match[1]);
	if (variants.length !== 1 || variants[0] !== "baseline") {
		throw new Error(`Portable build requires exactly one embedded baseline native (found: ${variants.join(", ") || "none"})`);
	}
}

async function sha256(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filePath)) hash.update(chunk);
	return hash.digest("hex");
}

async function run(command: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd: options.cwd ?? repoRoot,
		env: options.env ?? Bun.env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
}

async function moveExistingNativesAside(): Promise<{ backupDir: string; names: string[] }> {
	await fs.mkdir(nativeDir, { recursive: true });
	const backupDir = await fs.mkdtemp(path.join(nativeDir, ".portable-backup-"));
	const names = (await fs.readdir(nativeDir)).filter(name => /^pi_natives\..+\.node$/.test(name));
	for (const name of names) await fs.rename(path.join(nativeDir, name), path.join(backupDir, name));
	return { backupDir, names };
}

async function restoreNatives(backup: { backupDir: string; names: string[] }): Promise<void> {
	for (const name of await fs.readdir(nativeDir)) {
		if (/^pi_natives\..+\.node$/.test(name)) await fs.rm(path.join(nativeDir, name), { force: true });
	}
	for (const name of backup.names) await fs.rename(path.join(backup.backupDir, name), path.join(nativeDir, name));
	await fs.rm(backup.backupDir, { recursive: true, force: true });
}

async function publishPortable(stagingDir: string, portableDir: string): Promise<void> {
	const backupDir = `${portableDir}.old-${process.pid}`;
	let movedOld = false;
	try {
		try {
			await fs.rename(portableDir, backupDir);
			movedOld = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await fs.rename(stagingDir, portableDir);
		if (movedOld) await fs.rm(backupDir, { recursive: true, force: true });
	} catch (error) {
		if (movedOld) await fs.rename(backupDir, portableDir).catch(() => {});
		throw error;
	}
}

export async function buildPortable(): Promise<PortableManifest> {
	const codingManifest = (await Bun.file(path.join(packageDir, "package.json")).json()) as { version: string };
	const nativesManifest = (await Bun.file(path.join(repoRoot, "packages/natives/package.json")).json()) as {
		version: string;
	};
	const transformersManifest = createRequire(import.meta.url)("@huggingface/transformers/package.json") as {
		version: string;
	};
	const distDir = path.join(packageDir, "dist");
	await fs.mkdir(distDir, { recursive: true });
	const stagingDir = await fs.mkdtemp(path.join(distDir, ".portable-"));
	const portableDir = path.join(distDir, "portable");
	const nativeBuildRoute = resolvePortableNativeBuild();
	const nativeBackup = await moveExistingNativesAside();
	let generatedNative = false;
	let generatedStats = false;

	try {
		if (nativeBuildRoute === "bazel") {
			await run([process.execPath, "scripts/bazel-natives.ts", "linux-x64-baseline"]);
		} else {
			await run([process.execPath, "scripts/bazel-natives.ts", "host"], {
				env: {
					...Bun.env,
					OMP_NATIVE_X64_VARIANT: "baseline",
					RUSTFLAGS: "-C target-cpu=x86-64-v2",
				},
			});
		}

		const nativePath = path.join(nativeDir, baselineNativeName);
		if (!(await Bun.file(nativePath).exists())) throw new Error(`Baseline native build did not produce ${nativePath}`);

		await run([process.execPath, "--cwd=packages/stats", "run", "gen:stats"]);
		generatedStats = true;
		await run([process.execPath, "--cwd=packages/collab-web", "run", "gen:tool-views"]);
		await run([process.execPath, "--cwd=packages/natives", "run", "gen:native"], {
			env: { ...Bun.env, TARGET_PLATFORM: "linux", TARGET_ARCH: "x64" },
		});
		generatedNative = true;
		assertBaselineEmbedding(await Bun.file(path.join(nativeDir, "embedded-addon.js")).text());
		const { compileCodingAgent } = await import("../packages/coding-agent/scripts/compile-binary");

		const binaryPath = path.join(stagingDir, "omomp");
		await compileCodingAgent({
			repoRoot,
			entrypoint: path.join(packageDir, "src/cli.ts"),
			outfile: binaryPath,
			transformersVersion: transformersManifest.version,
			target: compileTarget,
			compileTarget,
		});
		await fs.chmod(binaryPath, 0o755);
		await fs.copyFile(nativePath, path.join(stagingDir, baselineNativeName));
		const wrapperSource = path.join(repoRoot, "scripts", wrapperName);
		const wrapperPath = path.join(stagingDir, wrapperName);
		await fs.copyFile(wrapperSource, wrapperPath);
		await fs.chmod(wrapperPath, 0o755);

		const manifest: PortableManifest = {
			schemaVersion: 1,
			version: codingManifest.version,
			nativesVersion: nativesManifest.version,
			compatibilityTier: "linux-x64-baseline",
			compileTarget,
			binary: { filename: "omomp", sha256: await sha256(binaryPath) },
			native: { filename: baselineNativeName, sha256: await sha256(nativePath) },
			wrapper: { filename: wrapperName, sha256: await sha256(wrapperPath) },
			nativeBuildRoute,
			rustTargetCpu: "x86-64-v2",
			embeddedNativeVariants: ["baseline"],
		};
		await Bun.write(path.join(stagingDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
		await publishPortable(stagingDir, portableDir);
		return manifest;
	} catch (error) {
		await fs.rm(stagingDir, { recursive: true, force: true });
		throw error;
	} finally {
		if (generatedNative) await run([process.execPath, "--cwd=packages/natives", "run", "gen:native:reset"]);
		if (generatedStats) await run([process.execPath, "--cwd=packages/stats", "run", "gen:stats:reset"]);
		await restoreNatives(nativeBackup);
	}
}

if (import.meta.main) {
	const manifest = await buildPortable();
	console.log(`Portable bundle ready: packages/coding-agent/dist/portable (${manifest.binary.sha256})`);
}
