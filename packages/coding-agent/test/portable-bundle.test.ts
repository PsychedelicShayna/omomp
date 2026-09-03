import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	PORTABLE_COMPILE_TARGET,
	PORTABLE_NATIVE_FILENAME,
	PORTABLE_WRAPPER_FILENAME,
	resolvePortableBundleDirectory,
	validatePortableBundle,
} from "../src/cli/portable-bundle";

const temps: string[] = [];
afterEach(async () => {
	await Promise.all(temps.splice(0).map(temp => fs.rm(temp, { recursive: true, force: true })));
});

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

async function fixture(): Promise<{ dir: string; binary: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "portable-bundle-"));
	temps.push(dir);
	const binary = path.join(dir, "omomp");
	await fs.writeFile(binary, "binary");
	await fs.writeFile(path.join(dir, PORTABLE_NATIVE_FILENAME), "native");
	await fs.writeFile(path.join(dir, PORTABLE_WRAPPER_FILENAME), "wrapper");
	await fs.writeFile(
		path.join(dir, "manifest.json"),
		JSON.stringify({
			schemaVersion: 1,
			version: "18.1.2",
			nativesVersion: "18.1.2",
			compatibilityTier: "linux-x64-baseline",
			compileTarget: PORTABLE_COMPILE_TARGET,
			binary: { filename: "omomp", sha256: digest("binary") },
			native: { filename: PORTABLE_NATIVE_FILENAME, sha256: digest("native") },
			wrapper: { filename: PORTABLE_WRAPPER_FILENAME, sha256: digest("wrapper") },
			nativeBuildRoute: "cargo",
			rustTargetCpu: "x86-64-v2",
			embeddedNativeVariants: ["baseline"],
		}),
	);
	return { dir, binary };
}

describe("portable bundle gate", () => {
	test("uses the explicit bundle directory before the executable directory", async () => {
		const { dir, binary } = await fixture();
		expect(await resolvePortableBundleDirectory({ OMOMP_PORTABLE_BUNDLE: dir }, "/missing/omomp")).toBe(dir);
		const bundle = await validatePortableBundle({
			env: { OMOMP_PORTABLE_BUNDLE: dir },
			execPath: binary,
			compileTarget: PORTABLE_COMPILE_TARGET,
		});
		expect(bundle.directory).toBe(dir);
	});

	test("resolves a symlinked executable directory", async () => {
		const { dir, binary } = await fixture();
		const links = await fs.mkdtemp(path.join(os.tmpdir(), "portable-link-"));
		temps.push(links);
		const link = path.join(links, "omomp");
		await fs.symlink(binary, link);
		expect(await resolvePortableBundleDirectory({}, link)).toBe(dir);
	});

	test("refuses source, host, and modern builds", async () => {
		const { dir, binary } = await fixture();
		for (const compileTarget of [undefined, "host", "bun-linux-x64-modern"]) {
			await expect(
				validatePortableBundle({ env: { OMOMP_PORTABLE_BUNDLE: dir }, execPath: binary, compileTarget }),
			).rejects.toThrow("bun-linux-x64-baseline");
		}
	});

	test("refuses a digest mismatch", async () => {
		const { dir, binary } = await fixture();
		await fs.writeFile(binary, "changed");
		await expect(
			validatePortableBundle({
				env: { OMOMP_PORTABLE_BUNDLE: dir },
				execPath: binary,
				compileTarget: PORTABLE_COMPILE_TARGET,
			}),
		).rejects.toThrow("digest mismatch");
	});

	test("refuses a wrapper digest mismatch", async () => {
		const { dir, binary } = await fixture();
		await fs.writeFile(path.join(dir, PORTABLE_WRAPPER_FILENAME), "changed");
		await expect(
			validatePortableBundle({
				env: { OMOMP_PORTABLE_BUNDLE: dir },
				execPath: binary,
				compileTarget: PORTABLE_COMPILE_TARGET,
			}),
		).rejects.toThrow("digest mismatch");
	});
});
