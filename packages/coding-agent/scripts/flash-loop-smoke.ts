#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { partitionPath } from "../src/cli/flash-cli";

if (process.getuid?.() !== 0) throw new Error("flash-loop-smoke must run as root");
const userIndex = process.argv.indexOf("--user");
const username = userIndex >= 0 ? process.argv[userIndex + 1] : process.env.SUDO_USER;
if (!username || username === "root") throw new Error("pass --user <non-root-payload-user>");

const repoRoot = path.resolve(import.meta.dir, "../../..");
const bundle = path.join(repoRoot, "packages/coding-agent/dist/portable");
const binary = path.join(bundle, "omomp");
if (!(await Bun.file(binary).exists())) throw new Error("run bun run build:portable first");
const passphrase = process.env.OMOMP_FLASH_TEST_PASSPHRASE || "omomp-loop-smoke";
const work = await fs.mkdtemp(path.join(os.tmpdir(), "omomp-flash-loop-"));
const image = path.join(work, "stick.img");
let loop = "";
let mapper = "";
let mountRoot = "";

async function run(argv: string[], stdinData?: string): Promise<string> {
	process.stderr.write(`$ ${argv.join(" ")}\n`);
	const child = Bun.spawn(argv, {
		stdin: stdinData === undefined ? "ignore" : "pipe",
		stdout: "pipe",
		stderr: "inherit",
	});
	if (stdinData !== undefined) {
		child.stdin?.write(stdinData);
		child.stdin?.end();
	}
	const stdout = await new Response(child.stdout).text();
	const code = await child.exited;
	if (code !== 0) throw new Error(`${argv[0]} exited with ${code}`);
	return stdout.trim();
}

async function requireFile(relative: string): Promise<void> {
	if (!(await Bun.file(path.join(mountRoot, relative)).exists())) throw new Error(`missing target file: ${relative}`);
}

try {
	await run(["truncate", "-s", "16G", image]);
	loop = await run(["losetup", "--find", "--show", "--partscan", image]);
	const common = [binary, "flash", "--force", "--user", username, loop];
	await run(common, `${loop}\n${passphrase}\n${passphrase}\n`);
	const esp = partitionPath(loop, 2);
	const luks = partitionPath(loop, 3);
	const espUuid = await run(["blkid", "-o", "value", "-s", "UUID", esp]);
	const luksUuid = await run(["blkid", "-o", "value", "-s", "UUID", luks]);

	const stateMount = path.join(work, "state");
	await fs.mkdir(stateMount);
	await run(["mount", esp, stateMount]);
	const statePath = path.join(stateMount, "omomp-flash-state.json");
	const state = JSON.parse(await fs.readFile(statePath, "utf8")) as { completedPhases: string[] };
	state.completedPhases = ["partitioned", "formatted", "base-installed"];
	await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
	await run(["umount", stateMount]);

	await run([binary, "flash", "--resume", "--force", "--user", username, loop], `${loop}\n${passphrase}\n`);
	if ((await run(["blkid", "-o", "value", "-s", "UUID", esp])) !== espUuid)
		throw new Error("ESP UUID changed on resume");
	if ((await run(["blkid", "-o", "value", "-s", "UUID", luks])) !== luksUuid)
		throw new Error("LUKS UUID changed on resume");

	mapper = `omomp-loop-${process.pid}`;
	await run(["cryptsetup", "open", "--key-file=-", luks, mapper], passphrase);
	mountRoot = path.join(work, "mounted");
	await fs.mkdir(mountRoot);
	await run(["mount", `/dev/mapper/${mapper}`, mountRoot]);
	await run(["mount", esp, path.join(mountRoot, "boot")]);
	for (const relative of [
		"boot/grub/grub.cfg",
		"boot/omomp-flash-state.json",
		"etc/mkinitcpio.conf",
		"etc/systemd/system/getty@tty1.service.d/autologin.conf",
		"usr/local/lib/omomp-portable/manifest.json",
		"usr/local/lib/omomp-portable/pi_natives.linux-x64-baseline.node",
		"usr/local/lib/omomp-portable/ram-filter.rules",
		"usr/local/bin/omomp",
	]) {
		await requireFile(relative);
	}
	const hooks = await fs.readFile(path.join(mountRoot, "etc/mkinitcpio.conf"), "utf8");
	if (
		!hooks.includes(
			"HOOKS=(base udev autodetect microcode modconf kms keyboard keymap consolefont block encrypt filesystems fsck)",
		)
	) {
		throw new Error("mkinitcpio HOOKS differ from the pinned set");
	}
	const grub = await fs.readFile(path.join(mountRoot, "boot/grub/grub.cfg"), "utf8");
	if (!grub.includes(`cryptdevice=UUID=${luksUuid}:omproot`))
		throw new Error("GRUB lacks the recorded cryptdevice UUID");
	for (const command of ["sqlite3", "rsync", "flock", "tmux", "realpath", "sha256sum"]) {
		await requireFile(`usr/bin/${command}`);
	}
	process.stdout.write(`flash-loop-smoke: ok (${loop}, ESP ${espUuid}, LUKS ${luksUuid})\n`);
} finally {
	if (mountRoot) await Bun.$`umount -R ${mountRoot}`.quiet().nothrow();
	if (mapper) await Bun.$`cryptsetup close ${mapper}`.quiet().nothrow();
	if (loop) await Bun.$`losetup -d ${loop}`.quiet().nothrow();
	await fs.rm(work, { recursive: true, force: true });
}
