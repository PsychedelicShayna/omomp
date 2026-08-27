import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import {
	__setAfterRenameAsideForTests,
	defaultOmompExtensionsDestDir,
	defaultOmompExtensionsSourceDir,
	formatOmompExtensionsResult,
	installOmompExtensions,
	listOmompExtensionNames,
} from "./install-omomp-extensions";

const tempDirs: string[] = [];

afterEach(async () => {
	__setAfterRenameAsideForTests(undefined);
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function writeExtension(
	root: string,
	name: string,
	body = `export default function ${name.replaceAll("-", "_")}() {}\n`,
): Promise<string> {
	const dir = path.join(root, name);
	await Bun.write(path.join(dir, "index.ts"), body);
	return dir;
}

describe("listOmompExtensionNames", () => {
	test("lists every source directory and ignores files plus hidden names", async () => {
		const source = await tempDir("omomp-ext-src-");
		await writeExtension(source, "omomp-live-persona");
		await writeExtension(source, "omomp-loadout");
		await writeExtension(source, "omomp-persona");
		await Bun.write(path.join(source, "README.md"), "not an extension\n");
		await writeExtension(source, ".hidden");

		expect(await listOmompExtensionNames(source)).toEqual(["omomp-live-persona", "omomp-loadout", "omomp-persona"]);
	});

	test("fails loudly when the source tree is missing", async () => {
		const missing = path.join(await tempDir("omomp-ext-missing-"), "extensions");
		await expect(listOmompExtensionNames(missing)).rejects.toThrow(/OMOMP extensions source is missing/);
	});
});

describe("installOmompExtensions", () => {
	test("symlinks the whole source set and leaves unrelated dest entries alone", async () => {
		const source = await tempDir("omomp-ext-src-");
		const dest = await tempDir("omomp-ext-dest-");
		await writeExtension(source, "omomp-live-persona");
		await writeExtension(source, "omomp-repl");
		await writeExtension(source, "third-party-looking-fork-ext");
		const userExt = path.join(dest, "copy-all");
		await Bun.write(path.join(userExt, "index.ts"), "export default function copy_all() {}\n");

		const first = await installOmompExtensions({ sourceDir: source, destDir: dest });
		expect(first.installed).toEqual(["omomp-live-persona", "omomp-repl", "third-party-looking-fork-ext"]);
		expect(first.refreshed).toEqual([]);
		expect(first.unchanged).toEqual([]);

		for (const name of first.installed) {
			expect((await fs.lstat(path.join(dest, name))).isSymbolicLink()).toBe(true);
			expect(await fs.realpath(path.join(dest, name))).toBe(await fs.realpath(path.join(source, name)));
		}
		expect((await fs.lstat(userExt)).isDirectory()).toBe(true);
		expect((await fs.lstat(userExt)).isSymbolicLink()).toBe(false);
		expect(await Bun.file(path.join(userExt, "index.ts")).text()).toBe("export default function copy_all() {}\n");

		const second = await installOmompExtensions({ sourceDir: source, destDir: dest });
		expect(second.installed).toEqual([]);
		expect(second.refreshed).toEqual([]);
		expect(second.unchanged).toEqual(["omomp-live-persona", "omomp-repl", "third-party-looking-fork-ext"]);
		expect(await fs.readdir(dest)).toEqual(
			expect.arrayContaining(["copy-all", "omomp-live-persona", "omomp-repl", "third-party-looking-fork-ext"]),
		);
	});

	test("replaces a managed directory copy with a symlink so repo-relative imports keep working", async () => {
		const source = await tempDir("omomp-ext-src-");
		const dest = await tempDir("omomp-ext-dest-");
		await writeExtension(
			source,
			"omomp-live-persona",
			'export { x } from "../../packages/coding-agent/src/live/personas.ts";\n',
		);
		await Bun.write(path.join(dest, "omomp-live-persona", "index.ts"), "stale copy\n");

		const result = await installOmompExtensions({ sourceDir: source, destDir: dest });
		expect(result.refreshed).toEqual(["omomp-live-persona"]);
		expect((await fs.lstat(path.join(dest, "omomp-live-persona"))).isSymbolicLink()).toBe(true);
		expect(await Bun.file(path.join(dest, "omomp-live-persona", "index.ts")).text()).toContain(
			"../../packages/coding-agent/src/live/personas.ts",
		);
	});

	test("retargets a managed symlink that points at the wrong directory", async () => {
		const source = await tempDir("omomp-ext-src-");
		const dest = await tempDir("omomp-ext-dest-");
		const other = await tempDir("omomp-ext-other-");
		await writeExtension(source, "omomp-persona");
		await writeExtension(other, "omomp-persona", "wrong\n");
		await fs.symlink(path.join(other, "omomp-persona"), path.join(dest, "omomp-persona"));

		const result = await installOmompExtensions({ sourceDir: source, destDir: dest });
		expect(result.refreshed).toEqual(["omomp-persona"]);
		expect(await fs.realpath(path.join(dest, "omomp-persona"))).toBe(
			await fs.realpath(path.join(source, "omomp-persona")),
		);
	});

	test("renames a divergent dest directory aside instead of deleting it", async () => {
		const source = await tempDir("omomp-ext-src-");
		const dest = await tempDir("omomp-ext-dest-");
		await writeExtension(source, "omomp-live-persona");
		const destExt = path.join(dest, "omomp-live-persona");
		await Bun.write(path.join(destExt, "keep-me.ts"), "user edits\n");

		const result = await installOmompExtensions({ sourceDir: source, destDir: dest });
		expect(result.refreshed).toEqual(["omomp-live-persona"]);
		expect(result.backups).toHaveLength(1);
		expect(result.backups[0]?.name).toBe("omomp-live-persona");
		const backup = result.backups[0]!.path;
		expect(path.basename(backup).startsWith(".")).toBe(true);
		expect(path.dirname(backup)).toBe(dest);
		expect((await fs.lstat(destExt)).isSymbolicLink()).toBe(true);
		expect(await fs.realpath(destExt)).toBe(await fs.realpath(path.join(source, "omomp-live-persona")));
		expect((await fs.lstat(backup)).isDirectory()).toBe(true);
		expect((await fs.lstat(backup)).isSymbolicLink()).toBe(false);
		expect(await Bun.file(path.join(backup, "keep-me.ts")).text()).toBe("user edits\n");
		expect(formatOmompExtensionsResult(result)).toContain(backup);
	});

	test("restores the old dest and removes staging files if activation fails", async () => {
		const source = await tempDir("omomp-ext-src-");
		const dest = await tempDir("omomp-ext-dest-");
		await writeExtension(source, "omomp-live-persona");
		const destExt = path.join(dest, "omomp-live-persona");
		await Bun.write(path.join(destExt, "keep-me.ts"), "user edits\n");
		__setAfterRenameAsideForTests(async () => {
			throw new Error("activation failed");
		});

		await expect(installOmompExtensions({ sourceDir: source, destDir: dest })).rejects.toThrow(/activation failed/);

		expect((await fs.lstat(destExt)).isDirectory()).toBe(true);
		expect((await fs.lstat(destExt)).isSymbolicLink()).toBe(false);
		expect(await Bun.file(path.join(destExt, "keep-me.ts")).text()).toBe("user edits\n");
		const leftovers = (await fs.readdir(dest)).filter(name => name.includes(".tmp") || name.includes("pre-symlink"));
		expect(leftovers).toEqual([]);
	});
});

describe("default OMOMP extension paths", () => {
	test("source is the repo extensions directory and dest stays under the agent dir", () => {
		expect(defaultOmompExtensionsSourceDir("/repo")).toBe(path.join("/repo", "extensions"));
		expect(defaultOmompExtensionsDestDir("/tmp/agent")).toBe(path.join("/tmp/agent", "extensions"));
	});

	test("default dest follows getAgentDir, including profiles and PI_CODING_AGENT_DIR", async () => {
		expect(defaultOmompExtensionsDestDir()).toBe(path.join(getAgentDir(), "extensions"));

		const installer = path.join(import.meta.dir, "install-omomp-extensions.ts");
		const script = `import { defaultOmompExtensionsDestDir } from ${JSON.stringify(installer)}; process.stdout.write(defaultOmompExtensionsDestDir());`;
		const destFor = async (env: Record<string, string>): Promise<string> => {
			const proc = Bun.spawn(["bun", "-e", script], {
				cwd: path.join(import.meta.dir, ".."),
				env: {
					...process.env,
					OMP_PROFILE: "",
					PI_PROFILE: "",
					PI_CODING_AGENT_DIR: "",
					...env,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (exitCode !== 0) {
				throw new Error(stderr || `default dest helper exited ${exitCode}`);
			}
			return stdout;
		};

		const configDir = process.env.PI_CONFIG_DIR || ".omp";
		expect(await destFor({ OMP_PROFILE: "omomp-ext-review" })).toBe(
			path.join(os.homedir(), configDir, "profiles", "omomp-ext-review", "agent", "extensions"),
		);
		expect(await destFor({ PI_CODING_AGENT_DIR: "/tmp/pi-coding-agent-dir" })).toBe(
			path.join("/tmp/pi-coding-agent-dir", "extensions"),
		);
	});

	test("the live repo tree includes omomp-live-persona among the owned set", async () => {
		const names = await listOmompExtensionNames(defaultOmompExtensionsSourceDir(path.join(import.meta.dir, "..")));
		expect(names).toContain("omomp-live-persona");
		expect(names).toContain("omomp-loadout");
		expect(names).toContain("omomp-persona");
		expect(names).toContain("omomp-repl");
	});
});
