import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	assessDevice,
	buildRamFilter,
	confirmationMatches,
	copySelected,
	FLASH_PHASES,
	forceAsciiSymbolPreset,
	missingHostTools,
	nextIncompletePhase,
	partitionPath,
	partitionTypeMatches,
	parseFlashState,
	PORTABLE_AGENT_MANIFEST,
	rewriteGrubDefaults,
	rewriteMkinitcpioHooks,
	STICK_PACKAGES,
	verifyPayload,
} from "../src/cli/flash-cli";

const temps: string[] = [];
afterEach(async () => Promise.all(temps.splice(0).map(temp => fs.rm(temp, { recursive: true, force: true }))));

describe("flash device policy", () => {
	const disk = { path: "/dev/sdc", type: "disk", removable: true, sizeBytes: 16e9, model: "USB" };

	test("uses p before partition numbers for digit-ending devices", () => {
		expect(partitionPath("/dev/sdc", 3)).toBe("/dev/sdc3");
		expect(partitionPath("/dev/nvme0n1", 2)).toBe("/dev/nvme0n1p2");
		expect(partitionPath("/dev/loop0", 1)).toBe("/dev/loop0p1");
	});

	test("requires a whole removable disk unless forced", () => {
		expect(assessDevice(disk, false)).toEqual({ ok: true });
		expect(assessDevice({ ...disk, type: "part" }, true).ok).toBe(false);
		expect(assessDevice({ ...disk, removable: false }, false).ok).toBe(false);
		expect(assessDevice({ ...disk, removable: false }, true)).toEqual({ ok: true });
		expect(assessDevice({ ...disk, type: "loop", removable: false }, true)).toEqual({ ok: true });
		expect(assessDevice({ ...disk, unsafeUsers: ["/dev/sdc1 mounted at /mnt"] }, true).ok).toBe(false);
	});

	test("requires the exact canonical device confirmation", () => {
		expect(confirmationMatches("/dev/sdc\n", "/dev/sdc")).toBe(true);
		expect(confirmationMatches("/dev/sdc1", "/dev/sdc")).toBe(false);
	});

	test("matches the GUID text emitted by sgdisk", () => {
		expect(
			partitionTypeMatches(
				"Partition GUID code: 21686148-6449-6E6F-744E-656564454649 (BIOS boot partition)",
				1,
			),
		).toBe(true);
		expect(partitionTypeMatches("Partition GUID code: C12A7328-F81F-11D2-BA4B-00A0C93EC93B", 2)).toBe(true);
		expect(partitionTypeMatches("Partition GUID code: CA7D7CCB-63ED-4C53-861C-1742536059CC", 3)).toBe(true);
		expect(partitionTypeMatches("Partition GUID code: C12A7328-F81F-11D2-BA4B-00A0C93EC93B", 1)).toBe(false);
	});


	test("skips special files and dereferences portable symlinks", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "portable-copy-"));
		temps.push(root);
		const source = path.join(root, "source");
		const destination = path.join(root, "destination");
		await fs.mkdir(source);
		await fs.writeFile(path.join(root, "target"), "portable");
		await fs.symlink(path.join(root, "target"), path.join(source, "extension"));
		const fifo = path.join(source, "agent.sock");
		const mkfifo = Bun.spawn(["mkfifo", fifo], { stdout: "ignore", stderr: "pipe" });
		expect(await mkfifo.exited).toBe(0);
		const skipped: string[] = [];
		await copySelected(source, destination, skipped);
		expect(await fs.readFile(path.join(destination, "extension"), "utf8")).toBe("portable");
		expect(skipped.join(" ")).toContain("agent.sock (special file)");
		await expect(fs.access(path.join(destination, "agent.sock"))).rejects.toThrow();
	});
	test("reports missing host tools with owning packages", () => {
		const missing = missingHostTools(tool => (tool === "pacstrap" || tool === "sgdisk" ? null : "/bin/x"));
		expect(missing.map(([tool]) => tool).sort()).toEqual(["pacstrap", "sgdisk"]);
	});
});

describe("boot configuration", () => {
	const hooks =
		"HOOKS=(base udev autodetect microcode modconf kms keyboard keymap consolefont block encrypt filesystems fsck)";

	test("replaces systemd initramfs hooks with the pinned udev encrypt set", () => {
		const output = rewriteMkinitcpioHooks("MODULES=()\nHOOKS=(base systemd autodetect block filesystems)\n");
		expect(output).toContain(hooks);
		expect(output).not.toContain("systemd");
		expect(rewriteMkinitcpioHooks(output)).toBe(output);
	});

	test("writes the exact cryptdevice command line", () => {
		const output = rewriteGrubDefaults('GRUB_CMDLINE_LINUX=""\n', "abcd");
		expect(output).toContain('GRUB_CMDLINE_LINUX="cryptdevice=UUID=abcd:omproot root=/dev/mapper/omproot rw"');
	});

	test("carries boot, field, database, and P2V packages", () => {
		for (const pkg of ["grub", "networkmanager", "usbmuxd", "terminus-font", "opus", "sqlite", "python", "qemu-img"]) {
			expect(STICK_PACKAGES).toContain(pkg);
		}
	});
});

describe("resumable phases", () => {
	test("selects the first incomplete phase and never repeats completed phases", () => {
		expect(nextIncompletePhase([])).toBe("partitioned");
		expect(nextIncompletePhase(["partitioned", "formatted"])).toBe("base-installed");
		expect(nextIncompletePhase(FLASH_PHASES)).toBeNull();
	});

	test("accepts only a prefix of the declared phase order", () => {
		const base = {
			schemaVersion: 1,
			devicePath: "/dev/sdc",
			diskModel: "USB",
			diskSizeBytes: 16e9,
			espUuid: "esp",
			luksUuid: "luks",
			username: "shayna",
			portableVersion: "18.1.2",
			binarySha256: "a".repeat(64),
			nativeSha256: "b".repeat(64),
			completedPhases: ["partitioned", "formatted"],
			warnings: [],
			updatedAt: "2026-09-02T00:00:00.000Z",
		};
		expect(parseFlashState(base).completedPhases).toEqual(["partitioned", "formatted"]);
		expect(() => parseFlashState({ ...base, completedPhases: ["partitioned", "base-installed"] })).toThrow(
			"Invalid OMOMP flash state schema",
		);
	});
});

describe("portable payload", () => {
	test("uses one manifest for seed and RAM scopes", () => {
		const names = PORTABLE_AGENT_MANIFEST.map(entry => `${entry.root}/${entry.source}`);
		for (const required of [
			"agent/agent.db",
			"agent/secret-placeholder.key",
			"agent/models.yml",
			"agent/omomp-persona.json",
			"agent/sessions",
			"agent/blobs",
			"omp/install-id",
			"omp/security",
			"omp/ssh.json",
		]) {
			expect(names).toContain(required);
		}
	});

	test("RAM filter includes session jsonl and blobs while excluding databases", () => {
		const filter = buildRamFilter();
		expect(filter).toContain("+ /sessions/***");
		expect(filter).toContain("+ /blobs/***");
		expect(filter).not.toContain("+ /agent.db");
		expect(filter).toContain("- /*.db");
		expect(filter).toContain("- /*.db-wal");
		expect(filter).toContain("- /*.db-shm");
		expect(filter.indexOf("- /*.db")).toBeLessThan(filter.indexOf("+ /sessions/***"));
		expect(filter.trimEnd().endsWith("- /***")).toBe(true);
	});

	test("forces only the top-level symbol preset", () => {
		expect(forceAsciiSymbolPreset("setupVersion: 2\nsymbolPreset: nerd\n")).toBe(
			"setupVersion: 2\nsymbolPreset: ascii\n",
		);
		expect(forceAsciiSymbolPreset("setupVersion: 2")).toBe("setupVersion: 2\nsymbolPreset: ascii\n");
	});

	test("detects missing and changed staged payload files", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "payload-verify-"));
		temps.push(root);
		await fs.writeFile(path.join(root, "one"), "value");
		await fs.chmod(path.join(root, "one"), 0o600);
		const good = "cd42404d52ad55ccfa9aca4adc828aa5800ad9d385a0671fbcbf724118320619";
		expect(await verifyPayload(root, [{ path: "one", type: "file", mode: 0o600, sha256: good }])).toEqual([]);
		await fs.chmod(path.join(root, "one"), 0o644);
		expect((await verifyPayload(root, [{ path: "one", type: "file", mode: 0o600, sha256: good }])).join(" ")).toContain(
			"mode mismatch",
		);
		expect(await verifyPayload(root, [{ path: "missing", type: "file", mode: 0o600, sha256: good }])).toHaveLength(1);
	});
});
