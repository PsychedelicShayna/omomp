import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { buildRamFilter } from "../packages/coding-agent/src/cli/flash-cli";

const wrapper = path.join(import.meta.dir, "omomp-ram-wrapper.sh");
const temps: string[] = [];
afterEach(async () => Promise.all(temps.splice(0).map(temp => fs.rm(temp, { recursive: true, force: true }))));

interface Fixture {
	root: string;
	persistent: string;
	ram: string;
	bundle: string;
	binary: string;
}

async function fixture(): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omomp-ram-test-"));
	temps.push(root);
	const persistent = path.join(root, "persistent");
	const ram = path.join(root, "ram");
	const bundle = path.join(root, "bundle");
	const binary = path.join(root, "fake-omomp");
	await fs.mkdir(persistent, { recursive: true });
	await fs.mkdir(bundle, { recursive: true });
	await fs.writeFile(path.join(bundle, "ram-filter.rules"), buildRamFilter());
	await fs.writeFile(
		binary,
		`#!/usr/bin/env bash\nset -eu\ncase "\${1:-}" in\n  show) cat "$PI_CODING_AGENT_DIR/config.yml" ;;\n  mutate) mkdir -p "$PI_CODING_AGENT_DIR/sessions/work" "$PI_CODING_AGENT_DIR/blobs" "$PI_CODING_AGENT_DIR/memories/mnemopi/banks/new"; printf session >"$PI_CODING_AGENT_DIR/sessions/work/new.jsonl"; printf blob >"$PI_CODING_AGENT_DIR/blobs/new"; sqlite3 "$PI_CODING_AGENT_DIR/agent.db" "insert into values_table values ('ram')"; sqlite3 "$PI_CODING_AGENT_DIR/memories/mnemopi/banks/seed/triples.db" "insert into values_table values ('ram')"; sqlite3 "$PI_CODING_AGENT_DIR/memories/mnemopi/banks/new/triples.db" "create table values_table(value text); insert into values_table values ('new')" ;;\n  sleep) sleep 2 ;;\n  exit7) exit 7 ;;\nesac\n`,
		{ mode: 0o755 },
	);
	return { root, persistent, ram, bundle, binary };
}

async function run(f: Fixture, args: string[], extra: Record<string, string> = {}) {
	const proc = Bun.spawn([wrapper, ...args], {
		env: {
			...process.env,
			HOME: f.root,
			PI_CODING_AGENT_DIR: f.persistent,
			OMOMP_RAM_ROOT: f.ram,
			OMOMP_REAL_BINARY: f.binary,
			OMOMP_PORTABLE_BUNDLE: f.bundle,
			OMOMP_RAM_SYNC: "never",
			...extra,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: await proc.exited,
		stdout: await new Response(proc.stdout).text(),
		stderr: await new Response(proc.stderr).text(),
	};
}

describe("omomp RAM wrapper", () => {
	test("copies once, reuses warm state, refreshes, and preserves child status", async () => {
		const f = await fixture();
		await fs.writeFile(path.join(f.persistent, "config.yml"), "first\n");
		expect((await run(f, ["show"])).stdout).toBe("first\n");
		await fs.writeFile(path.join(f.persistent, "config.yml"), "second\n");
		expect((await run(f, ["show"])).stdout).toBe("first\n");
		expect((await run(f, ["show"], { OMOMP_RAM_REFRESH: "1" })).stdout).toBe("second\n");
		expect((await run(f, ["exit7"])).code).toBe(7);
		expect((await run(f, ["show"], { OMOMP_RAM_MAX_BYTES: "1" })).stdout).toBe("second\n");
	});

	test("refuses the size cap before creating a partial profile", async () => {
		const f = await fixture();
		await fs.writeFile(path.join(f.persistent, "config.yml"), "too large");
		const result = await run(f, ["show"], { OMOMP_RAM_MAX_BYTES: "1" });
		expect(result.code).toBe(75);
		expect(result.stderr).toContain("OMOMP_RAM_DISABLE=1");
		const initialized = [...new Bun.Glob("**/.initialized").scanSync(f.ram)];
		expect(initialized).toEqual([]);
	});

	test("syncs sessions, blobs, and database snapshots without deleting unrelated state", async () => {
		const f = await fixture();
		await fs.writeFile(path.join(f.persistent, "config.yml"), "config\n");
		await fs.writeFile(path.join(f.persistent, "unrelated"), "keep");
		const db = new Database(path.join(f.persistent, "agent.db"));
		db.exec("create table values_table(value text); insert into values_table values ('disk')");
		db.close();
		const seedDir = path.join(f.persistent, "memories/mnemopi/banks/seed");
		await fs.mkdir(seedDir, { recursive: true });
		const seed = new Database(path.join(seedDir, "triples.db"));
		seed.exec("create table values_table(value text); insert into values_table values ('disk')");
		seed.close();
		await fs.writeFile(path.join(f.persistent, "agent.db-wal"), "stale");
		await fs.writeFile(path.join(f.persistent, "agent.db-shm"), "stale");
		const result = await run(f, ["mutate"], { OMOMP_RAM_SYNC: "always" });
		expect(result.code).toBe(0);
		expect(await fs.readFile(path.join(f.persistent, "sessions/work/new.jsonl"), "utf8")).toBe("session");
		expect(await fs.readFile(path.join(f.persistent, "blobs/new"), "utf8")).toBe("blob");
		expect(await fs.readFile(path.join(f.persistent, "unrelated"), "utf8")).toBe("keep");
		const saved = new Database(path.join(f.persistent, "agent.db"), { readonly: true });
		expect(saved.query("select value from values_table order by rowid").values()).toEqual([["disk"], ["ram"]]);
		saved.close();
		const savedSeed = new Database(path.join(seedDir, "triples.db"), { readonly: true });
		expect(savedSeed.query("select value from values_table order by rowid").values()).toEqual([["disk"], ["ram"]]);
		savedSeed.close();
		const savedNew = new Database(path.join(f.persistent, "memories/mnemopi/banks/new/triples.db"), { readonly: true });
		expect(savedNew.query("select value from values_table").values()).toEqual([["new"]]);
		savedNew.close();
		await expect(fs.access(path.join(f.persistent, "agent.db-wal"))).rejects.toThrow();
		await expect(fs.access(path.join(f.persistent, "agent.db-shm"))).rejects.toThrow();
	});
});
