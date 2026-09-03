import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const PORTABLE_COMPILE_TARGET = "bun-linux-x64-baseline" as const;
export const PORTABLE_COMPATIBILITY_TIER = "linux-x64-baseline" as const;
export const PORTABLE_NATIVE_FILENAME = "pi_natives.linux-x64-baseline.node" as const;

export interface PortableBundleManifest {
	readonly schemaVersion: 1;
	readonly version: string;
	readonly nativesVersion: string;
	readonly compatibilityTier: typeof PORTABLE_COMPATIBILITY_TIER;
	readonly compileTarget: typeof PORTABLE_COMPILE_TARGET;
	readonly binary: { readonly filename: "omomp"; readonly sha256: string };
	readonly native: { readonly filename: typeof PORTABLE_NATIVE_FILENAME; readonly sha256: string };
	readonly nativeBuildRoute: "bazel" | "cargo";
	readonly rustTargetCpu: "x86-64-v2";
	readonly embeddedNativeVariants: readonly ["baseline"];
}

export interface PortableBundle {
	readonly directory: string;
	readonly binaryPath: string;
	readonly nativePath: string;
	readonly manifestPath: string;
	readonly manifest: PortableBundleManifest;
}

export class PortableBundleError extends Error {}

const RECOVERY =
	"Build a portable bundle first:\n" +
	"  bun run build:portable\n" +
	"  sudo packages/coding-agent/dist/portable/omomp flash <device>";

function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function parseManifest(value: unknown): PortableBundleManifest {
	if (!value || typeof value !== "object") throw new PortableBundleError(`Invalid portable manifest.\n${RECOVERY}`);
	const manifest = value as Record<string, unknown>;
	const binary = manifest.binary as Record<string, unknown> | undefined;
	const native = manifest.native as Record<string, unknown> | undefined;
	if (
		manifest.schemaVersion !== 1 ||
		typeof manifest.version !== "string" ||
		typeof manifest.nativesVersion !== "string" ||
		manifest.compatibilityTier !== PORTABLE_COMPATIBILITY_TIER ||
		manifest.compileTarget !== PORTABLE_COMPILE_TARGET ||
		manifest.rustTargetCpu !== "x86-64-v2" ||
		(manifest.nativeBuildRoute !== "bazel" && manifest.nativeBuildRoute !== "cargo") ||
		!Array.isArray(manifest.embeddedNativeVariants) ||
		manifest.embeddedNativeVariants.length !== 1 ||
		manifest.embeddedNativeVariants[0] !== "baseline" ||
		binary?.filename !== "omomp" ||
		!isSha256(binary.sha256) ||
		native?.filename !== PORTABLE_NATIVE_FILENAME ||
		!isSha256(native.sha256)
	) {
		throw new PortableBundleError(`Portable manifest is not an attested linux-x64 baseline bundle.\n${RECOVERY}`);
	}
	return value as PortableBundleManifest;
}

async function sha256(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filePath)) hash.update(chunk);
	return hash.digest("hex");
}

export async function resolvePortableBundleDirectory(
	env: NodeJS.ProcessEnv = process.env,
	execPath: string = process.execPath,
): Promise<string> {
	return env.OMOMP_PORTABLE_BUNDLE ? path.resolve(env.OMOMP_PORTABLE_BUNDLE) : path.dirname(await fs.realpath(execPath));
}

export async function validatePortableBundle(options: {
	readonly env?: NodeJS.ProcessEnv;
	readonly execPath?: string;
	readonly compileTarget?: string;
} = {}): Promise<PortableBundle> {
	const env = options.env ?? process.env;
	const execPath = options.execPath ?? process.execPath;
	const compileTarget = options.compileTarget ?? process.env.PI_COMPILE_TARGET;
	if (compileTarget !== PORTABLE_COMPILE_TARGET) {
		throw new PortableBundleError(
			`This executable was compiled for ${compileTarget || "an unknown/host target"}, not ${PORTABLE_COMPILE_TARGET}.\n${RECOVERY}`,
		);
	}
	const directory = await resolvePortableBundleDirectory(env, execPath);
	const manifestPath = path.join(directory, "manifest.json");
	let manifest: PortableBundleManifest;
	try {
		manifest = parseManifest(JSON.parse(await fs.readFile(manifestPath, "utf8")));
	} catch (error) {
		if (error instanceof PortableBundleError) throw error;
		throw new PortableBundleError(`Cannot read portable manifest at ${manifestPath}: ${String(error)}\n${RECOVERY}`);
	}
	const binaryPath = path.join(directory, manifest.binary.filename);
	const nativePath = path.join(directory, manifest.native.filename);
	for (const [label, filePath, expected] of [
		["binary", binaryPath, manifest.binary.sha256],
		["native", nativePath, manifest.native.sha256],
	] as const) {
		let actual: string;
		try {
			actual = await sha256(filePath);
		} catch (error) {
			throw new PortableBundleError(`Cannot read portable ${label} at ${filePath}: ${String(error)}\n${RECOVERY}`);
		}
		if (actual !== expected) {
			throw new PortableBundleError(
				`Portable ${label} digest mismatch at ${filePath}: expected ${expected}, got ${actual}.\n${RECOVERY}`,
			);
		}
	}
	return { directory, binaryPath, nativePath, manifestPath, manifest };
}
