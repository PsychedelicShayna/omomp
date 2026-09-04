import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { type PortableBundle, PortableBundleError, validatePortableBundle } from "./portable-bundle";

export interface FlashCommandArgs {
	readonly device: string;
	readonly flags: { readonly resume: boolean; readonly force: boolean; readonly user?: string };
}

export interface DeviceInfo {
	readonly path: string;
	readonly type: string;
	readonly removable: boolean;
	readonly sizeBytes: number;
	readonly model: string;
	readonly unsafeUsers?: readonly string[];
}

export const FLASH_PHASES = [
	"partitioned",
	"formatted",
	"base-installed",
	"system-configured",
	"bootloader-installed",
	"user-created",
	"payload-installed",
	"ram-mode-installed",
	"complete",
] as const;
export type FlashPhase = (typeof FLASH_PHASES)[number];

export interface FlashState {
	readonly schemaVersion: 1;
	readonly devicePath: string;
	readonly diskModel: string;
	readonly diskSizeBytes: number;
	readonly espUuid: string;
	readonly luksUuid: string;
	readonly username: string;
	readonly portableVersion: string;
	readonly binarySha256: string;
	readonly nativeSha256: string;
	completedPhases: FlashPhase[];
	warnings: { phase: FlashPhase; message: string }[];
	updatedAt: string;
}

interface PayloadUser {
	readonly name: string;
	readonly home: string;
}

export interface PortableAgentEntry {
	readonly root: "omp" | "agent";
	readonly source: string;
	readonly scopes: readonly ("seed" | "ram")[];
	readonly required?: boolean;
	readonly database?: boolean;
}

export const PORTABLE_AGENT_MANIFEST: readonly PortableAgentEntry[] = [
	{ root: "agent", source: "config.yml", scopes: ["seed", "ram"] },
	{ root: "agent", source: "config.yaml", scopes: ["seed", "ram"] },
	{ root: "agent", source: "WATCHDOG.yml", scopes: ["seed", "ram"] },
	{ root: "agent", source: "WATCHDOG.yaml", scopes: ["seed", "ram"] },
	{ root: "agent", source: "RULES.md", scopes: ["seed", "ram"] },
	{ root: "agent", source: "APPEND_SYSTEM.md", scopes: ["seed", "ram"] },
	{ root: "agent", source: "mcp.json", scopes: ["seed", "ram"] },
	{ root: "agent", source: "ssh.json", scopes: ["seed", "ram"] },
	{ root: "agent", source: "kimi-device-id", scopes: ["seed", "ram"] },
	{ root: "agent", source: "secret-placeholder.key", scopes: ["seed", "ram"] },
	{ root: "agent", source: "models.yml", scopes: ["seed", "ram"] },
	{ root: "agent", source: "omomp-persona.json", scopes: ["seed", "ram"] },
	{ root: "agent", source: "omomp-loadout.json", scopes: ["seed", "ram"] },
	{ root: "agent", source: "omomp-live-personas.json", scopes: ["seed", "ram"] },
	{ root: "agent", source: "last-changelog-version", scopes: ["seed", "ram"] },
	{ root: "agent", source: "agents", scopes: ["seed", "ram"] },
	{ root: "agent", source: "commands", scopes: ["seed", "ram"] },
	{ root: "agent", source: "extensions", scopes: ["seed", "ram"] },
	{ root: "agent", source: "managed-skills", scopes: ["seed", "ram"] },
	{ root: "agent", source: "memories", scopes: ["seed", "ram"] },
	{ root: "agent", source: "rules", scopes: ["seed", "ram"] },
	{ root: "agent", source: "skills", scopes: ["seed", "ram"] },
	{ root: "agent", source: "sessions", scopes: ["ram"] },
	{ root: "agent", source: "blobs", scopes: ["ram"] },
	{ root: "agent", source: "agent.db", scopes: ["seed", "ram"], required: true, database: true },
	{ root: "agent", source: "history.db", scopes: ["ram"], database: true },
	{ root: "omp", source: "install-id", scopes: ["seed"] },
	{ root: "omp", source: "security", scopes: ["seed"] },
	{ root: "omp", source: "ssh.json", scopes: ["seed"] },
];

export const STICK_PACKAGES: readonly string[] = [
	"base",
	"linux",
	"linux-firmware",
	"mkinitcpio",
	"grub",
	"efibootmgr",
	"sudo",
	"networkmanager",
	"usbmuxd",
	"libimobiledevice",
	"python",
	"opus",
	"sqlite",
	"ddrescue",
	"ntfs-3g",
	"qemu-img",
	"partclone",
	"smartmontools",
	"nvme-cli",
	"hdparm",
	"pv",
	"rsync",
	"parted",
	"gptfdisk",
	"dosfstools",
	"e2fsprogs",
	"openssh",
	"tmux",
	"git",
	"curl",
	"jq",
	"lsof",
	"usbutils",
	"pciutils",
	"ethtool",
	"terminus-font",
];

export const REQUIRED_HOST_TOOLS: readonly [tool: string, pkg: string][] = [
	["lsblk", "util-linux"],
	["wipefs", "util-linux"],
	["sgdisk", "gptfdisk"],
	["partprobe", "parted"],
	["cryptsetup", "cryptsetup"],
	["mkfs.vfat", "dosfstools"],
	["mkfs.ext4", "e2fsprogs"],
	["blkid", "util-linux"],
	["pacstrap", "arch-install-scripts"],
	["genfstab", "arch-install-scripts"],
	["arch-chroot", "arch-install-scripts"],
	["rsync", "rsync"],
	["getent", "glibc"],
	["mountpoint", "util-linux"],
	["udevadm", "systemd"],
	["fuser", "psmisc"],
	["gpgconf", "gnupg"],
];

const STICK_HOOKS =
	"HOOKS=(base udev autodetect microcode modconf kms keyboard keymap consolefont block encrypt filesystems fsck)";
const MAPPER_NAME_PREFIX = "ompflash";
const STICK_HOSTNAME = "ompstick";
const STATE_FILENAME = "omomp-flash-state.json";
const PARTITION_TYPE_GUIDS = [
	"21686148-6449-6E6F-744E-656564454649",
	"C12A7328-F81F-11D2-BA4B-00A0C93EC93B",
	"CA7D7CCB-63ED-4C53-861C-1742536059CC",
] as const;

class FlashError extends Error {}

export function partitionPath(device: string, index: number): string {
	return /\d$/.test(device) ? `${device}p${index}` : `${device}${index}`;
}

export function assessDevice(info: DeviceInfo, force: boolean): { ok: true } | { ok: false; reason: string } {
	if (info.type !== "disk" && !(force && info.type === "loop")) {
		return { ok: false, reason: `${info.path} is a ${info.type}, not a whole disk` };
	}
	if (info.unsafeUsers && info.unsafeUsers.length > 0) {
		return { ok: false, reason: `${info.path} has active mounts or holders: ${info.unsafeUsers.join(", ")}` };
	}
	if (!info.removable && !force) {
		return { ok: false, reason: `${info.path} reports as non-removable; refusing without --force` };
	}
	return { ok: true };
}

export function confirmationMatches(typed: string, canonicalDevice: string): boolean {
	return typed.trim() === canonicalDevice;
}
export function partitionTypeMatches(partitionInfo: string, index: number): boolean {
	const expected = PARTITION_TYPE_GUIDS[index - 1];
	return expected !== undefined && partitionInfo.toUpperCase().includes(expected);
}


export function rewriteMkinitcpioHooks(contents: string): string {
	if (/^HOOKS=\(.*\)$/m.test(contents)) return contents.replace(/^HOOKS=\(.*\)$/m, STICK_HOOKS);
	return `${contents.length === 0 || contents.endsWith("\n") ? contents : `${contents}\n`}${STICK_HOOKS}\n`;
}

export function rewriteGrubDefaults(contents: string, luksUuid: string): string {
	const cmdline = `cryptdevice=UUID=${luksUuid}:omproot root=/dev/mapper/omproot rw`;
	if (/^GRUB_CMDLINE_LINUX=/m.test(contents)) {
		return contents.replace(/^GRUB_CMDLINE_LINUX=.*$/m, `GRUB_CMDLINE_LINUX="${cmdline}"`);
	}
	return `${contents.length === 0 || contents.endsWith("\n") ? contents : `${contents}\n`}GRUB_CMDLINE_LINUX="${cmdline}"\n`;
}

export function forceAsciiSymbolPreset(contents: string): string {
	if (/^symbolPreset:/m.test(contents)) return contents.replace(/^symbolPreset:.*$/m, "symbolPreset: ascii");
	return `${contents.length === 0 || contents.endsWith("\n") ? contents : `${contents}\n`}symbolPreset: ascii\n`;
}

export function missingHostTools(which: (tool: string) => string | null): [string, string][] {
	return REQUIRED_HOST_TOOLS.filter(([tool]) => which(tool) === null);
}

export function nextIncompletePhase(completed: readonly FlashPhase[]): FlashPhase | null {
	const done = new Set(completed);
	return FLASH_PHASES.find(phase => !done.has(phase)) ?? null;
}

export function buildRamFilter(entries: readonly PortableAgentEntry[] = PORTABLE_AGENT_MANIFEST): string {
	const lines = [
		"# generated by omomp flash; databases use sqlite3 .backup",
		"- /*.db",
		"- /*.db-wal",
		"- /*.db-shm",
	];
	for (const entry of entries) {
		if (entry.root !== "agent" || !entry.scopes.includes("ram") || entry.database) continue;
		lines.push(`+ /${entry.source}`);
		lines.push(`+ /${entry.source}/***`);
	}
	lines.push("- /***");
	return `${lines.join("\n")}\n`;
}

let nonInteractiveRemainder = "";

function promptLine(question: string, hidden: boolean): Promise<string> {
	if (process.stdin.isTTY !== true) {
		const newline = nonInteractiveRemainder.indexOf("\n");
		if (newline !== -1) {
			const value = nonInteractiveRemainder.slice(0, newline).replace(/\r$/, "");
			nonInteractiveRemainder = nonInteractiveRemainder.slice(newline + 1);
			process.stderr.write("\n");
			return Promise.resolve(value);
		}
	}
	process.stderr.write(question);
	const stdin = process.stdin;
	const interactive = stdin.isTTY === true;
	return new Promise((resolve, reject) => {
		let value = "";
		if (interactive) stdin.setRawMode(true);
		const finish = (error?: Error) => {
			stdin.removeListener("data", onData);
			if (interactive) stdin.setRawMode(false);
			stdin.pause();
			process.stderr.write("\n");
			if (error) reject(error);
			else resolve(value);
		};
		const onData = (chunk: Buffer) => {
			if (!interactive) {
				nonInteractiveRemainder += chunk.toString();
				const newline = nonInteractiveRemainder.indexOf("\n");
				if (newline !== -1) {
					value = nonInteractiveRemainder.slice(0, newline).replace(/\r$/, "");
					nonInteractiveRemainder = nonInteractiveRemainder.slice(newline + 1);
					finish();
				}
				return;
			}
			for (const byte of chunk) {
				if (byte === 0x03) return finish(new FlashError("Interrupted"));
				if (byte === 0x0d || byte === 0x0a) return finish();
				if (byte === 0x7f || byte === 0x08) {
					if (value.length > 0) {
						value = value.slice(0, -1);
						if (!hidden) process.stderr.write("\b \b");
					}
					continue;
				}
				value += String.fromCharCode(byte);
				if (!hidden) process.stderr.write(String.fromCharCode(byte));
			}
		};
		stdin.on("data", onData);
		stdin.resume();
	});
}

function logStep(title: string): void {
	process.stderr.write(`\n${chalk.cyan("==>")} ${chalk.bold(title)}\n`);
}

function logCommand(argv: readonly string[]): void {
	process.stderr.write(`${chalk.dim(`  $ ${argv.join(" ")}`)}\n`);
}

async function run(
	argv: readonly string[],
	options: { stdinData?: string; allowedExitCodes?: readonly number[]; capture?: boolean } = {},
): Promise<{ ok: boolean; code: number; stdout: string }> {
	logCommand(argv);
	const child = Bun.spawn([...argv], {
		stdin: options.stdinData === undefined ? "ignore" : "pipe",
		stdout: options.capture ? "pipe" : "inherit",
		stderr: "inherit",
	});
	if (options.stdinData !== undefined) {
		child.stdin?.write(options.stdinData);
		child.stdin?.end();
	}
	const stdoutPromise = options.capture ? new Response(child.stdout).text() : Promise.resolve("");
	const code = await child.exited;
	const stdout = (await stdoutPromise).trim();
	const ok = code === 0 || options.allowedExitCodes?.includes(code) === true;
	return { ok, code, stdout };
}

async function mustRun(argv: readonly string[], options: { stdinData?: string } = {}): Promise<void> {
	const result = await run(argv, options);
	if (!result.ok) throw new FlashError(`${argv[0]} exited with code ${result.code}`);
}

async function capture(argv: readonly string[]): Promise<string> {
	const result = await run(argv, { capture: true });
	if (!result.ok) throw new FlashError(`${argv[0]} exited with code ${result.code}`);
	return result.stdout;
}

async function runQuiet(argv: readonly string[]): Promise<number> {
	try {
		const child = Bun.spawn([...argv], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		return await child.exited;
	} catch {
		return -1;
	}
}

async function inspectDevice(device: string): Promise<DeviceInfo> {
	type LsblkRow = {
		path?: unknown;
		type?: unknown;
		rm?: unknown;
		size?: unknown;
		model?: unknown;
		mountpoints?: unknown;
		children?: LsblkRow[];
	};
	const raw = await capture(["lsblk", "--json", "--bytes", "--output", "NAME,TYPE,RM,SIZE,MODEL,PATH,MOUNTPOINTS", device]);
	const row = (JSON.parse(raw) as { blockdevices?: LsblkRow[] }).blockdevices?.[0];
	if (!row) throw new FlashError(`lsblk returned nothing for ${device}`);
	const unsafeUsers: string[] = [];
	const rootMounts = Array.isArray(row.mountpoints) ? row.mountpoints.filter(Boolean).map(String) : [];
	if (rootMounts.length > 0) {
		unsafeUsers.push(`${typeof row.path === "string" ? row.path : device} mounted at ${rootMounts.join(",")}`);
	}
	const inspectChildren = (children: readonly LsblkRow[] | undefined): void => {
		for (const child of children ?? []) {
			const childPath = typeof child.path === "string" ? child.path : "(unknown)";
			const mounts = Array.isArray(child.mountpoints) ? child.mountpoints.filter(Boolean).map(String) : [];
			if (mounts.length > 0) unsafeUsers.push(`${childPath} mounted at ${mounts.join(",")}`);
			if (child.type !== "part") unsafeUsers.push(`${childPath} holder (${String(child.type)})`);
			inspectChildren(child.children);
		}
	};
	inspectChildren(row.children);
	return {
		path: typeof row.path === "string" ? row.path : device,
		type: String(row.type),
		removable: row.rm === true || row.rm === 1,
		sizeBytes: Number(row.size),
		model: typeof row.model === "string" && row.model.trim() ? row.model.trim() : "(unknown model)",
		unsafeUsers,
	};
}

async function resolvePayloadUser(flagUser: string | undefined): Promise<PayloadUser> {
	const name = flagUser ?? process.env.SUDO_USER;
	if (!name || name === "root") {
		throw new FlashError("Cannot determine payload owner. Run via sudo from your own account, or pass --user <name>.");
	}
	const fields = (await capture(["getent", "passwd", name])).split(":");
	if (!fields[5]) throw new FlashError(`No home directory in passwd entry for ${name}`);
	return { name, home: fields[5] };
}

async function sha256(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filePath)) hash.update(chunk);
	return hash.digest("hex");
}

async function exists(filePath: string): Promise<boolean> {
	return fs.access(filePath).then(
		() => true,
		() => false,
	);
}

interface PayloadManifestEntry {
	readonly path: string;
	readonly type: "file" | "symlink";
	readonly mode: number;
	readonly sha256: string;
}

interface StagedPayload {
	readonly root: string;
	readonly entries: readonly PayloadManifestEntry[];
	readonly skipped: readonly string[];
	readonly warnings: readonly string[];
}

export async function copySelected(
	source: string,
	destination: string,
	skipped: string[] = [],
	seen: Set<string> = new Set(),
): Promise<void> {
	const stat = await fs.lstat(source);
	await fs.mkdir(path.dirname(destination), { recursive: true });
	if (stat.isSymbolicLink()) {
		let target: string;
		try {
			target = await fs.realpath(source);
		} catch {
			skipped.push(`${source} (dangling symlink)`);
			return;
		}
		if (source.endsWith(".db")) {
			await snapshotDatabase(target, destination);
			return;
		}
		await copySelected(target, destination, skipped, seen);
		return;
	}
	if (stat.isDirectory()) {
		const real = await fs.realpath(source);
		if (seen.has(real)) {
			skipped.push(`${source} (symlink cycle)`);
			return;
		}
		seen.add(real);
		await fs.mkdir(destination, { recursive: true, mode: stat.mode & 0o777 });
		for (const dirent of await fs.readdir(source, { withFileTypes: true })) {
			if (dirent.name.endsWith("-wal") || dirent.name.endsWith("-shm")) continue;
			const childSource = path.join(source, dirent.name);
			const childDestination = path.join(destination, dirent.name);
			if (dirent.isFile() && dirent.name.endsWith(".db")) await snapshotDatabase(childSource, childDestination);
			else await copySelected(childSource, childDestination, skipped, seen);
		}
		seen.delete(real);
		return;
	}
	if (!stat.isFile()) {
		skipped.push(`${source} (special file)`);
		return;
	}
	await fs.copyFile(source, destination);
	await fs.chmod(destination, stat.mode & 0o777);
}

async function snapshotDatabase(source: string, destination: string): Promise<void> {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	const db = new Database(source, { readonly: true });
	try {
		await Bun.write(destination, db.serialize());
	} finally {
		db.close();
	}
	await fs.chmod(destination, 0o600);
}

async function walkManifest(root: string, current: string = root): Promise<PayloadManifestEntry[]> {
	const entries: PayloadManifestEntry[] = [];
	for (const dirent of await fs.readdir(current, { withFileTypes: true })) {
		const absolute = path.join(current, dirent.name);
		const relative = path.relative(root, absolute).split(path.sep).join("/");
		const stat = await fs.lstat(absolute);
		if (dirent.isDirectory()) {
			entries.push(...(await walkManifest(root, absolute)));
		} else if (dirent.isSymbolicLink()) {
			entries.push({
				path: relative,
				type: "symlink",
				mode: stat.mode & 0o777,
				sha256: createHash("sha256").update(await fs.readlink(absolute)).digest("hex"),
			});
		} else if (dirent.isFile()) {
			entries.push({ path: relative, type: "file", mode: stat.mode & 0o777, sha256: await sha256(absolute) });
		}
	}
	return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function stagePayload(user: PayloadUser): Promise<StagedPayload> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omomp-payload-"));
	const stagedHome = path.join(root, "home");
	const sourceOmp = path.join(user.home, ".omp");
	const sourceAgent = path.join(sourceOmp, "agent");
	const skipped: string[] = [];
	const warnings: string[] = [];
	if (!(await exists(sourceAgent))) throw new FlashError(`${sourceAgent} does not exist; nothing to carry`);

	try {
		for (const entry of PORTABLE_AGENT_MANIFEST) {
			if (!entry.scopes.includes("seed")) continue;
			const sourceRoot = entry.root === "agent" ? sourceAgent : sourceOmp;
			const destinationRoot = entry.root === "agent" ? path.join(stagedHome, ".omp", "agent") : path.join(stagedHome, ".omp");
			const source = path.join(sourceRoot, entry.source);
			const destination = path.join(destinationRoot, entry.source);
			if (!(await exists(source))) {
				if (entry.required) throw new FlashError(`Required portable profile entry is missing: ${source}`);
				skipped.push(`${entry.root}/${entry.source}`);
				if (entry.source === "secret-placeholder.key") {
					warnings.push("no secret-placeholder.key: previously obfuscated placeholders in seeded memories/config will not decode on the stick");
				}
				continue;
			}
			if (entry.database) await snapshotDatabase(source, destination);
			else await copySelected(source, destination, skipped);
		}

		const sourceSsh = path.join(user.home, ".ssh");
		if (await exists(sourceSsh)) await copySelected(sourceSsh, path.join(stagedHome, ".ssh"), skipped);
		else skipped.push("~/.ssh");

		const agentDir = path.join(stagedHome, ".omp", "agent");
		await fs.mkdir(agentDir, { recursive: true });
		const yml = path.join(agentDir, "config.yml");
		const yaml = path.join(agentDir, "config.yaml");
		const ymlExists = await exists(yml);
		const yamlExists = await exists(yaml);
		const configPath = ymlExists ? yml : yamlExists ? yaml : yml;
		if (ymlExists && yamlExists) warnings.push("config.yaml is shadowed by canonical config.yml; only config.yml received symbolPreset: ascii");
		await fs.writeFile(configPath, forceAsciiSymbolPreset(await fs.readFile(configPath, "utf8").catch(() => "")));

		const entries = await walkManifest(stagedHome);
		await fs.writeFile(path.join(root, "payload-manifest.json"), `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`);
		return { root, entries, skipped, warnings };
	} catch (error) {
		await fs.rm(root, { recursive: true, force: true });
		throw error;
	}
}

export async function verifyPayload(root: string, entries: readonly PayloadManifestEntry[]): Promise<string[]> {
	const errors: string[] = [];
	for (const entry of entries) {
		const absolute = path.join(root, entry.path);
		try {
			const stat = await fs.lstat(absolute);
			if (entry.type === "symlink") {
				if (!stat.isSymbolicLink()) errors.push(`${entry.path}: expected symlink`);
				else if (createHash("sha256").update(await fs.readlink(absolute)).digest("hex") !== entry.sha256) {
					errors.push(`${entry.path}: symlink digest mismatch`);
				}
			} else if (!stat.isFile()) errors.push(`${entry.path}: expected file`);
			else if ((stat.mode & 0o777) !== entry.mode) errors.push(`${entry.path}: mode mismatch`);
			else if ((await sha256(absolute)) !== entry.sha256) errors.push(`${entry.path}: digest mismatch`);
		} catch (error) {
			errors.push(`${entry.path}: ${String(error)}`);
		}
	}
	return errors;
}

export function parseFlashState(value: unknown): FlashState {
	if (!value || typeof value !== "object") throw new FlashError("Invalid OMOMP flash state");
	const state = value as FlashState;
	if (
		state.schemaVersion !== 1 ||
		typeof state.devicePath !== "string" ||
		typeof state.diskModel !== "string" ||
		typeof state.diskSizeBytes !== "number" ||
		typeof state.espUuid !== "string" ||
		typeof state.luksUuid !== "string" ||
		typeof state.username !== "string" ||
		typeof state.portableVersion !== "string" ||
		typeof state.binarySha256 !== "string" ||
		typeof state.nativeSha256 !== "string" ||
		typeof state.updatedAt !== "string" ||
		!Array.isArray(state.completedPhases) ||
		state.completedPhases.some((phase, index) => phase !== FLASH_PHASES[index]) ||
		!Array.isArray(state.warnings) ||
		state.warnings.some(
			warning =>
				!warning ||
				typeof warning.message !== "string" ||
				!FLASH_PHASES.includes(warning.phase),
		)
	) {
		throw new FlashError("Invalid OMOMP flash state schema");
	}
	return state;
}

async function writeState(bootMount: string, state: FlashState): Promise<void> {
	state.updatedAt = new Date().toISOString();
	const statePath = path.join(bootMount, STATE_FILENAME);
	const tempPath = `${statePath}.new-${process.pid}`;
	await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	await fs.rename(tempPath, statePath);
}

async function probeState(device: string): Promise<FlashState | null> {
	const esp = partitionPath(device, 2);
	if (!(await exists(esp))) return null;
	try {
		const result = await run(["blkid", "-o", "value", "-s", "TYPE", esp], { capture: true });
		if (!result.ok || result.stdout !== "vfat") return null;
		const mountRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omomp-state-probe-"));
		try {
			await mustRun(["mount", "-o", "ro", esp, mountRoot]);
			const statePath = path.join(mountRoot, STATE_FILENAME);
			if (!(await exists(statePath))) return null;
			return parseFlashState(JSON.parse(await fs.readFile(statePath, "utf8")));
		} finally {
			await runQuiet(["umount", mountRoot]);
			await fs.rmdir(mountRoot).catch(() => {});
		}
	} catch (error) {
		process.stderr.write(chalk.yellow(`flash: state probe failed; treating the device as untracked: ${String(error)}\n`));
		return null;
	}
}

interface MountedTarget {
	readonly root: string;
	readonly boot: string;
	readonly mapperName: string;
	readonly mapperPath: string;
	readonly esp: string;
	readonly luks: string;
	state: FlashState;
}

interface Teardown {
	mountRoot?: string;
	readonly mounts: string[];
	mapperName?: string;
	payloadRoot?: string;
}

async function createAndMount(
	device: DeviceInfo,
	user: PayloadUser,
	bundle: PortableBundle,
	passphrase: string,
	teardown: Teardown,
): Promise<MountedTarget> {
	const esp = partitionPath(device.path, 2);
	const luks = partitionPath(device.path, 3);
	logStep("Partitioning GPT");
	await mustRun(["wipefs", "--all", device.path]);
	await mustRun(["sgdisk", "--zap-all", device.path]);
	await mustRun([
		"sgdisk",
		"--new=1:0:+1MiB",
		"--typecode=1:EF02",
		"--new=2:0:+1GiB",
		"--typecode=2:EF00",
		"--new=3:0:0",
		"--typecode=3:8309",
		device.path,
	]);
	await mustRun(["partprobe", device.path]);
	await mustRun(["udevadm", "settle"]);
	await mustRun([
		"cryptsetup",
		"luksFormat",
		"--type",
		"luks2",
		"--pbkdf",
		"argon2id",
		"--pbkdf-memory",
		"262144",
		"--batch-mode",
		"--key-file=-",
		luks,
	], { stdinData: passphrase });
	const mapperName = `${MAPPER_NAME_PREFIX}-${process.pid.toString(36)}`;
	await mustRun(["cryptsetup", "open", "--key-file=-", luks, mapperName], { stdinData: passphrase });
	teardown.mapperName = mapperName;
	const mapperPath = `/dev/mapper/${mapperName}`;
	await mustRun(["mkfs.vfat", "-F", "32", "-n", "OMPBOOT", esp]);
	await mustRun(["mkfs.ext4", "-q", "-L", "omproot", mapperPath]);
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omomp-flash-"));
	const boot = path.join(root, "boot");
	teardown.mountRoot = root;
	await mustRun(["mount", mapperPath, root]);
	teardown.mounts.push(root);
	await fs.mkdir(boot);
	await mustRun(["mount", esp, boot]);
	teardown.mounts.push(boot);
	for (const [offset] of PARTITION_TYPE_GUIDS.entries()) {
		const partitionInfo = await capture(["sgdisk", "-i", String(offset + 1), device.path]);
		if (!partitionTypeMatches(partitionInfo, offset + 1)) {
			throw new FlashError(`partitioned postcondition failed: partition ${offset + 1} type differs`);
		}
	}
	if ((await capture(["blkid", "-o", "value", "-s", "TYPE", esp])) !== "vfat") {
		throw new FlashError("formatted postcondition failed: ESP is not FAT32");
	}
	if (!/Version:\s+2\b/.test(await capture(["cryptsetup", "luksDump", luks]))) {
		throw new FlashError("formatted postcondition failed: root is not LUKS2");
	}
	const state: FlashState = {
		schemaVersion: 1,
		devicePath: device.path,
		diskModel: device.model,
		diskSizeBytes: device.sizeBytes,
		espUuid: await capture(["blkid", "-o", "value", "-s", "UUID", esp]),
		luksUuid: await capture(["blkid", "-o", "value", "-s", "UUID", luks]),
		username: user.name,
		portableVersion: bundle.manifest.version,
		binarySha256: bundle.manifest.binary.sha256,
		nativeSha256: bundle.manifest.native.sha256,
		completedPhases: ["partitioned", "formatted"],
		warnings: [],
		updatedAt: new Date().toISOString(),
	};
	await writeState(boot, state);
	return { root, boot, mapperName, mapperPath, esp, luks, state };
}

async function resumeAndMount(
	device: DeviceInfo,
	user: PayloadUser,
	bundle: PortableBundle,
	passphrase: string,
	state: FlashState,
	teardown: Teardown,
): Promise<MountedTarget> {
	if (
		state.devicePath !== device.path ||
		state.diskModel !== device.model ||
		state.diskSizeBytes !== device.sizeBytes ||
		state.username !== user.name ||
		state.portableVersion !== bundle.manifest.version ||
		state.binarySha256 !== bundle.manifest.binary.sha256 ||
		state.nativeSha256 !== bundle.manifest.native.sha256
	) {
		throw new FlashError("Resume identity, user, or portable bundle does not match the recorded flash state");
	}
	const esp = partitionPath(device.path, 2);
	const luks = partitionPath(device.path, 3);
	if ((await capture(["blkid", "-o", "value", "-s", "UUID", esp])) !== state.espUuid) {
		throw new FlashError("Resume refused: ESP UUID does not match the recorded state");
	}
	if ((await capture(["blkid", "-o", "value", "-s", "UUID", luks])) !== state.luksUuid) {
		throw new FlashError("Resume refused: LUKS UUID does not match the recorded state");
	}
	const mapperName = `${MAPPER_NAME_PREFIX}-${process.pid.toString(36)}`;
	await mustRun(["cryptsetup", "open", "--key-file=-", luks, mapperName], { stdinData: passphrase });
	teardown.mapperName = mapperName;
	const mapperPath = `/dev/mapper/${mapperName}`;
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omomp-flash-"));
	const boot = path.join(root, "boot");
	teardown.mountRoot = root;
	await mustRun(["mount", mapperPath, root]);
	teardown.mounts.push(root);
	await fs.mkdir(boot, { recursive: true });
	await mustRun(["mount", esp, boot]);
	teardown.mounts.push(boot);
	state = parseFlashState(JSON.parse(await fs.readFile(path.join(boot, STATE_FILENAME), "utf8")));
	return { root, boot, mapperName, mapperPath, esp, luks, state };
}

function recordWarning(target: MountedTarget, phase: FlashPhase, message: string): void {
	target.state.warnings.push({ phase, message });
	process.stderr.write(chalk.yellow(`flash: ${message}\n`));
}

async function phaseBaseInstalled(target: MountedTarget): Promise<void> {
	logStep("Installing base system");
	await mustRun(["pacstrap", "-c", "-K", target.root, ...STICK_PACKAGES]);
	await fs.writeFile(path.join(target.root, "etc/fstab"), `${await capture(["genfstab", "-U", target.root])}\n`);
}

async function phaseSystemConfigured(target: MountedTarget): Promise<void> {
	logStep("Configuring initramfs, locale, and services");
	await fs.writeFile(path.join(target.root, "etc/hostname"), `${STICK_HOSTNAME}\n`);
	await fs.writeFile(path.join(target.root, "etc/vconsole.conf"), "KEYMAP=us\nFONT=ter-132b\n");
	const localeGenPath = path.join(target.root, "etc/locale.gen");
	const localeGen = await fs.readFile(localeGenPath, "utf8");
	await fs.writeFile(localeGenPath, localeGen.replace(/^#\s*(en_US\.UTF-8 UTF-8)\b.*$/m, "$1"));
	await fs.writeFile(path.join(target.root, "etc/locale.conf"), "LANG=en_US.UTF-8\n");
	const locale = await run(["arch-chroot", target.root, "locale-gen"]);
	if (!locale.ok) recordWarning(target, "system-configured", `locale-gen exited with ${locale.code}`);
	await fs.rm(path.join(target.root, "etc/localtime"), { force: true });
	await fs.symlink("/usr/share/zoneinfo/UTC", path.join(target.root, "etc/localtime"));
	const mkinitcpioPath = path.join(target.root, "etc/mkinitcpio.conf");
	await fs.writeFile(mkinitcpioPath, rewriteMkinitcpioHooks(await fs.readFile(mkinitcpioPath, "utf8")));
	await mustRun(["arch-chroot", target.root, "mkinitcpio", "-P"]);
	await mustRun(["arch-chroot", target.root, "systemctl", "enable", "NetworkManager", "systemd-timesyncd"]);
}

async function phaseBootloaderInstalled(target: MountedTarget, device: DeviceInfo): Promise<void> {
	logStep("Installing BIOS and UEFI GRUB");
	const defaultsPath = path.join(target.root, "etc/default/grub");
	await fs.writeFile(defaultsPath, rewriteGrubDefaults(await fs.readFile(defaultsPath, "utf8"), target.state.luksUuid));
	const bios = await run(["arch-chroot", target.root, "grub-install", "--target=i386-pc", device.path]);
	const efi = await run([
		"arch-chroot",
		target.root,
		"grub-install",
		"--target=x86_64-efi",
		"--efi-directory=/boot",
		"--removable",
		"--no-nvram",
	]);
	if (!bios.ok && !efi.ok) throw new FlashError("both GRUB targets failed; the stick cannot boot");
	if (!bios.ok) recordWarning(target, "bootloader-installed", `BIOS GRUB install exited with ${bios.code}`);
	if (!efi.ok) recordWarning(target, "bootloader-installed", `UEFI GRUB install exited with ${efi.code}`);
	await mustRun(["arch-chroot", target.root, "grub-mkconfig", "-o", "/boot/grub/grub.cfg"]);
}

async function phaseUserCreated(target: MountedTarget, user: PayloadUser): Promise<void> {
	logStep(`Creating payload user ${user.name}`);
	if ((await run(["arch-chroot", target.root, "getent", "passwd", user.name])).code !== 0) {
		await mustRun(["arch-chroot", target.root, "useradd", "--create-home", "--groups", "wheel", "--shell", "/bin/bash", user.name]);
	}
	await fs.mkdir(path.join(target.root, "etc/sudoers.d"), { recursive: true });
	await fs.writeFile(path.join(target.root, "etc/sudoers.d/10-ompflash"), `${user.name} ALL=(ALL:ALL) NOPASSWD: ALL\n`, {
		mode: 0o440,
	});
	const gettyDir = path.join(target.root, "etc/systemd/system/getty@tty1.service.d");
	await fs.mkdir(gettyDir, { recursive: true });
	await fs.writeFile(
		path.join(gettyDir, "autologin.conf"),
		`[Service]\nExecStart=\nExecStart=-/sbin/agetty --autologin ${user.name} --noclear %I $TERM\n`,
	);
}

async function phasePayloadInstalled(target: MountedTarget, user: PayloadUser, payload: StagedPayload): Promise<void> {
	logStep("Installing bounded portable profile");
	for (const warning of payload.warnings) recordWarning(target, "payload-installed", warning);
	const home = path.join(target.root, "home", user.name);
	await fs.mkdir(home, { recursive: true });
	const copied = await run(["rsync", "-aH", "--numeric-ids", `${path.join(payload.root, "home")}/`, `${home}/`], {
		allowedExitCodes: [23, 24],
	});
	const errors = await verifyPayload(home, payload.entries);
	if (errors.length > 0) throw new FlashError(`Payload verification failed:\n${errors.map(error => `  ${error}`).join("\n")}`);
	if (copied.code === 23 || copied.code === 24) {
		recordWarning(target, "payload-installed", `rsync exited with ${copied.code}, but every staged payload entry verified`);
	}
	await fs.mkdir(path.join(home, ".omp"), { recursive: true });
	await fs.copyFile(path.join(payload.root, "payload-manifest.json"), path.join(home, ".omp", "portable-payload-manifest.json"));
	await mustRun(["arch-chroot", target.root, "chown", "-R", `${user.name}:${user.name}`, `/home/${user.name}`]);
}

async function phaseRamModeInstalled(target: MountedTarget, bundle: PortableBundle): Promise<void> {
	logStep("Installing portable bundle and RAM launcher");
	const bundleDest = path.join(target.root, "usr/local/lib/omomp-portable");
	await fs.rm(bundleDest, { recursive: true, force: true });
	await fs.mkdir(path.dirname(bundleDest), { recursive: true });
	await fs.cp(bundle.directory, bundleDest, { recursive: true, preserveTimestamps: true });
	await fs.chmod(path.join(bundleDest, "omomp"), 0o755);
	await fs.writeFile(path.join(bundleDest, "ram-filter.rules"), buildRamFilter());
	const libexec = path.join(target.root, "usr/local/libexec");
	const bin = path.join(target.root, "usr/local/bin");
	await fs.mkdir(libexec, { recursive: true });
	await fs.mkdir(bin, { recursive: true });
	await fs.rm(path.join(libexec, "omomp-portable"), { force: true });
	await fs.symlink("../lib/omomp-portable/omomp", path.join(libexec, "omomp-portable"));
	await fs.copyFile(bundle.wrapperPath, path.join(bin, "omomp"));
	await fs.chmod(path.join(bin, "omomp"), 0o755);
	await fs.rm(path.join(bin, "omp"), { force: true });
	await fs.symlink("omomp", path.join(bin, "omp"));
}

async function verifyPhase(phase: FlashPhase, target: MountedTarget, device: DeviceInfo, user: PayloadUser, payload: StagedPayload): Promise<void> {
	const fail = (message: string): never => {
		throw new FlashError(`${phase} postcondition failed: ${message}`);
	};
	if (phase === "base-installed") {
		if (!(await exists(path.join(target.root, "usr/bin/pacman")))) fail("usr/bin/pacman is missing");
		if (!(await exists(path.join(target.boot, "vmlinuz-linux")))) fail("boot/vmlinuz-linux is missing");
	} else if (phase === "system-configured") {
		if (!(await fs.readFile(path.join(target.root, "etc/mkinitcpio.conf"), "utf8")).includes(STICK_HOOKS)) fail("HOOKS differ");
		if (!(await exists(path.join(target.boot, "initramfs-linux.img")))) fail("initramfs-linux.img is missing");
		const locales = await run(["arch-chroot", target.root, "localedef", "--list-archive"], { capture: true });
		if (!locales.ok || !locales.stdout.toLowerCase().split(/\s+/).includes("en_us.utf8")) fail("en_US.UTF-8 locale is missing");
		for (const service of ["NetworkManager", "systemd-timesyncd"]) {
			if (!(await run(["arch-chroot", target.root, "systemctl", "is-enabled", service])).ok) fail(`${service} is disabled`);
		}
	} else if (phase === "bootloader-installed") {
		const bios = await exists(path.join(target.boot, "grub/i386-pc/core.img"));
		const efi = await exists(path.join(target.boot, "EFI/BOOT/BOOTX64.EFI"));
		if (!bios && !efi) fail("neither BIOS nor UEFI loader exists");
		const grub = await fs.readFile(path.join(target.boot, "grub/grub.cfg"), "utf8");
		if (!grub.includes(`cryptdevice=UUID=${target.state.luksUuid}:omproot`)) fail("grub.cfg lacks cryptdevice");
	} else if (phase === "user-created") {
		if (!(await run(["arch-chroot", target.root, "getent", "passwd", user.name])).ok) fail("user is missing");
		if (!(await exists(path.join(target.root, "etc/systemd/system/getty@tty1.service.d/autologin.conf")))) fail("autologin is missing");
	} else if (phase === "payload-installed") {
		const errors = await verifyPayload(path.join(target.root, "home", user.name), payload.entries);
		if (errors.length > 0) fail(errors.join("; "));
	} else if (phase === "ram-mode-installed") {
		const wrapper = path.join(target.root, "usr/local/bin/omomp");
		const bundleRoot = path.join(target.root, "usr/local/lib/omomp-portable");
		const manifestPath = path.join(bundleRoot, "manifest.json");
		if (!(await exists(wrapper)) || !(await exists(manifestPath))) fail("wrapper or bundle manifest is missing");
		const installedManifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
			binary?: { filename?: string; sha256?: string };
			native?: { filename?: string; sha256?: string };
			wrapper?: { filename?: string; sha256?: string };
		};
		const binaryFilename = installedManifest.binary?.filename;
		const nativeFilename = installedManifest.native?.filename;
		const wrapperFilename = installedManifest.wrapper?.filename;
		if (!binaryFilename || !nativeFilename || !wrapperFilename) {
			throw new FlashError("ram-mode-installed postcondition failed: bundle manifest lacks filenames");
		}
		if (
			installedManifest.binary?.sha256 !== target.state.binarySha256 ||
			installedManifest.native?.sha256 !== target.state.nativeSha256
		) {
			fail("installed bundle manifest differs from flash state");
		}
		if ((await sha256(path.join(bundleRoot, binaryFilename))) !== target.state.binarySha256) {
			fail("installed executable digest differs");
		}
		if ((await sha256(path.join(bundleRoot, nativeFilename))) !== target.state.nativeSha256) {
			fail("installed native digest differs");
		}
		if ((await sha256(wrapper)) !== installedManifest.wrapper?.sha256) {
			fail("installed wrapper digest differs");
		}
		if ((await fs.readlink(path.join(target.root, "usr/local/libexec/omomp-portable"))) !== "../lib/omomp-portable/omomp") fail("libexec link differs");
		if ((await fs.readlink(path.join(target.root, "usr/local/bin/omp"))) !== "omomp") fail("omp link differs");
	} else if (phase === "partitioned") {
		for (const [offset] of PARTITION_TYPE_GUIDS.entries()) {
			if (!partitionTypeMatches(await capture(["sgdisk", "-i", String(offset + 1), device.path]), offset + 1)) {
				fail(`partition ${offset + 1} type differs`);
			}
		}
	} else if (phase === "formatted") {
		if ((await capture(["blkid", "-o", "value", "-s", "TYPE", target.esp])) !== "vfat") fail("ESP is not FAT32");
		if (!/Version:\s+2\b/.test(await capture(["cryptsetup", "luksDump", target.luks]))) fail("root is not LUKS2");
	} else if (phase === "complete" && FLASH_PHASES.slice(0, -1).some(required => !target.state.completedPhases.includes(required))) {
		fail("an earlier phase is incomplete");
	}
}

async function runRemainingPhases(
	target: MountedTarget,
	device: DeviceInfo,
	user: PayloadUser,
	bundle: PortableBundle,
	payload: StagedPayload,
): Promise<void> {
	const actions: Partial<Record<FlashPhase, () => Promise<void>>> = {
		"base-installed": () => phaseBaseInstalled(target),
		"system-configured": () => phaseSystemConfigured(target),
		"bootloader-installed": () => phaseBootloaderInstalled(target, device),
		"user-created": () => phaseUserCreated(target, user),
		"payload-installed": () => phasePayloadInstalled(target, user, payload),
		"ram-mode-installed": () => phaseRamModeInstalled(target, bundle),
		complete: async () => {},
	};
	while (true) {
		const phase = nextIncompletePhase(target.state.completedPhases);
		if (!phase) return;
		if (phase === "partitioned" || phase === "formatted") {
			throw new FlashError(`Cannot resume before the formatted checkpoint (${phase} is incomplete)`);
		}
		await actions[phase]?.();
		await verifyPhase(phase, target, device, user, payload);
		target.state.completedPhases.push(phase);
		await writeState(target.boot, target.state);
	}
}

async function isMounted(target: string): Promise<boolean> {
	return (await runQuiet(["mountpoint", "-q", target])) === 0;
}

async function unwind(teardown: Teardown): Promise<void> {
	if (teardown.mountRoot && teardown.mounts.length > 0) {
		process.stderr.write(`\n${chalk.cyan("==>")} Unmounting and flushing the stick; do not unplug.\n`);
		await runQuiet(["gpgconf", "--homedir", path.join(teardown.mountRoot, "etc/pacman.d/gnupg"), "--kill", "all"]);
		await runQuiet(["fuser", "-k", "-TERM", "-m", teardown.mountRoot]);
		await Bun.sleep(1500);
	}
	for (const mount of [...teardown.mounts].reverse()) {
		const code = await runQuiet(["umount", "-R", mount]);
		if (code !== 0 && (await isMounted(mount))) {
			process.stderr.write(`flash: could not unmount ${mount}; run sudo umount -R ${mount} after holders exit\n`);
		}
	}
	if (teardown.mapperName && (!teardown.mountRoot || !(await isMounted(teardown.mountRoot)))) {
		await runQuiet(["cryptsetup", "close", teardown.mapperName]);
	}
	if (teardown.mountRoot && !(await isMounted(teardown.mountRoot))) await fs.rmdir(teardown.mountRoot).catch(() => {});
	if (teardown.payloadRoot) await fs.rm(teardown.payloadRoot, { recursive: true, force: true });
}

async function flash(cmd: FlashCommandArgs): Promise<void> {
	if (process.getuid?.() !== 0) throw new FlashError(`flash partitions a disk; run: sudo omomp flash ${cmd.device}`);
	const missing = missingHostTools(tool => Bun.which(tool));
	if (missing.length > 0) {
		throw new FlashError(`Missing host tools:\n${missing.map(([tool, pkg]) => `  ${tool} (pacman -S ${pkg})`).join("\n")}`);
	}
	const bundle = await validatePortableBundle();
	const user = await resolvePayloadUser(cmd.flags.user);
	const device = await inspectDevice(cmd.device);
	const verdict = assessDevice(device, cmd.flags.force);
	if (!verdict.ok) throw new FlashError(verdict.reason);
	const previousState = await probeState(device.path);
	if (!cmd.flags.resume && previousState?.completedPhases.includes("complete") && !cmd.flags.force) {
		throw new FlashError("this device already holds a finished omomp stick; pass --force to re-flash");
	}
	if (!cmd.flags.resume && previousState && !cmd.flags.force) {
		throw new FlashError(`this device holds an incomplete omomp flash; run sudo omomp flash --resume ${device.path}`);
	}
	if (cmd.flags.resume && !previousState) throw new FlashError("--resume requested, but no readable OMOMP flash state exists");
	if (!(await exists(bundle.wrapperPath))) throw new FlashError(`RAM wrapper is missing from this build: ${bundle.wrapperPath}`);
	const payload = await stagePayload(user).catch(error => {
		throw error instanceof FlashError ? error : new FlashError(`Cannot stage portable payload: ${String(error)}`);
	});
	const teardown: Teardown = { mounts: [], payloadRoot: payload.root };
	try {
		if (payload.skipped.length > 0) {
			process.stderr.write(`Portable payload skipped absent optional paths: ${payload.skipped.join(", ")}\n`);
		}

		const sizeGib = (device.sizeBytes / 1024 ** 3).toFixed(1);
		process.stderr.write(
			`\n${chalk.red.bold("ALL DATA WILL BE DESTROYED")} on ${chalk.bold(device.path)}\n` +
				`  model: ${device.model}\n  size: ${sizeGib} GiB\n  removable: ${device.removable ? "yes" : "no (--force)"}\n\n`,
		);
		const typed = await promptLine(`Type the device path (${device.path}) to continue: `, false);
		if (!confirmationMatches(typed, device.path)) {
			throw new FlashError(`Confirmation mismatch ("${typed.trim()}" != "${device.path}"); aborting`);
		}
		const passphrase = await promptLine("LUKS passphrase for the stick: ", true);
		if (!passphrase) throw new FlashError("Empty passphrase; aborting");
		if (!cmd.flags.resume) {
			const confirmed = await promptLine("Confirm passphrase: ", true);
			if (passphrase !== confirmed) throw new FlashError("Passphrases do not match; aborting");
		}

		const target = cmd.flags.resume
			? await resumeAndMount(device, user, bundle, passphrase, previousState as FlashState, teardown)
			: await createAndMount(device, user, bundle, passphrase, teardown);
		try {
			await runRemainingPhases(target, device, user, bundle, payload);
		} catch (error) {
			process.stderr.write(`Resume with: sudo omomp flash --resume ${device.path}\n`);
			throw error;
		}
	} finally {
		await unwind(teardown);
	}
	process.stderr.write(`\n${chalk.green("Done.")} ${device.path} is complete and safe to unplug. Boot, unlock, then run omp.\n`);
	if (payload.skipped.length > 0) {
		process.stderr.write(`Skipped optional payload entries: ${payload.skipped.join(", ")}\n`);
	}
}

export async function runFlashCommand(cmd: FlashCommandArgs): Promise<number> {
	try {
		await flash(cmd);
		return 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${chalk.red("flash:")} ${message}\n`);
		return 1;
	}
}
