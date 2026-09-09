import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseFrontmatter, TempDir } from "@oh-my-pi/pi-utils";
import {
	type BeatInput,
	type BeatRecord,
	type CaptureBatch,
	type CaptureCheckpoint,
	type CaptureSource,
	ChroniclerStore,
	type ChroniclerStoreHooks,
	isChroniclerCorruption,
} from "../../src/chronicler/store";

/**
 * Behavioral coverage for the transactional Chronicler store: a batch becomes
 * visible only at its single directory rename, corruption halts capture instead
 * of silently recapturing over it, and the rebuildable caches never hold
 * history the committed manifests do not.
 *
 * Failures are injected through the real filesystem (permission bits, a
 * directory squatting on a cache path, a pre-occupied publication destination)
 * rather than by replacing `fs`/`Bun` for unrelated code, so the store under
 * test runs unmodified.
 */
describe("ChroniclerStore transactions", () => {
	const MODEL = "openai-codex/gpt-5.6-luna";
	/** A well-formed beat id that was never committed anywhere. */
	const MISSING_BEAT = "01a08000-0000-7000-8000-000000000000";
	let tempDir: TempDir;
	let root: string;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-chronicler-store-");
		root = path.join(tempDir.path(), "artifacts", "chronicler");
	});

	afterEach(async () => {
		// Restore any permission bits a failure-injection test dropped, or the
		// temp tree cannot be unlinked.
		try {
			await fs.chmod(path.join(root, "beats"), 0o700);
		} catch {}
		try {
			await tempDir.remove();
		} catch {}
	});

	function newStore(sessionId = "session-a", hooks?: ChroniclerStoreHooks): ChroniclerStore {
		return new ChroniclerStore(root, { sessionId, project: tempDir.path(), model: MODEL }, hooks);
	}

	async function openStore(sessionId = "session-a"): Promise<ChroniclerStore> {
		const store = newStore(sessionId);
		await store.open();
		return store;
	}

	/**
	 * Assert `open()` refused the committed data as corrupt: the rejection is a
	 * classified corruption error, no history is exposed, and the store then
	 * refuses to capture over what it cannot understand.
	 */
	async function expectHaltedOpen(store: ChroniclerStore): Promise<void> {
		let failure: unknown;
		await store.open().catch((error: unknown) => {
			failure = error;
		});
		expect(failure).toBeDefined();
		expect(isChroniclerCorruption(failure)).toBe(true);
		expect(store.beats).toEqual([]);
		expect([...store.processedEntryIds]).toEqual([]);
		expect(() => store.beginBatch([source("probe-1", null, 9)])).toThrow();
	}

	function source(id: string, parentId: string | null, minute: number): CaptureSource {
		return {
			id,
			parentId,
			timestamp: new Date(Date.UTC(2026, 8, 8, 12, minute)).toISOString(),
		};
	}

	function beatInput(over: Partial<BeatInput> & Pick<BeatInput, "title" | "sources">): BeatInput {
		return {
			kind: "decision",
			body: "The store publishes a whole batch at one rename.",
			topics: ["chronicler"],
			eventTime: "2026-09-08T12:00:00.000Z",
			related: [],
			...over,
		};
	}

	function stage(
		store: ChroniclerStore,
		entries: readonly CaptureSource[],
		inputs: readonly BeatInput[],
		carry: { sources: string[]; text: string } | null = null,
	): CaptureBatch {
		const batch = store.beginBatch(entries);
		for (const input of inputs) store.stageBeat(batch, input);
		batch.carry = carry;
		batch.finalized = true;
		return batch;
	}

	async function commit(
		store: ChroniclerStore,
		entries: readonly CaptureSource[],
		inputs: readonly BeatInput[],
		carry: { sources: string[]; text: string } | null = null,
	): Promise<CaptureBatch> {
		const batch = stage(store, entries, inputs, carry);
		await store.commitBatch(batch);
		return batch;
	}

	async function beatsDirEntries(): Promise<string[]> {
		return await fs.readdir(path.join(root, "beats")).catch(() => [] as string[]);
	}

	async function committedBatchIds(): Promise<string[]> {
		return (await beatsDirEntries()).filter(name => !name.startsWith(".")).sort();
	}

	async function stagingDirs(): Promise<string[]> {
		return (await beatsDirEntries()).filter(name => name.startsWith(".pending-")).sort();
	}

	async function allFiles(dir = root, prefix = ""): Promise<string[]> {
		const out: string[] = [];
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) out.push(...(await allFiles(path.join(dir, entry.name), rel)));
			else out.push(rel);
		}
		return out.sort();
	}

	async function readManifest(batchId: string): Promise<CaptureCheckpoint> {
		return (await Bun.file(path.join(root, "beats", batchId, "COMMIT.json")).json()) as CaptureCheckpoint;
	}

	async function readBeatFrontmatter(beatPath: string): Promise<Record<string, unknown>> {
		const raw = await Bun.file(path.join(root, beatPath)).text();
		return parseFrontmatter(raw, { rawKeys: true, repair: false, level: "off" }).frontmatter;
	}

	/**
	 * Rewrite exactly one frontmatter line of a committed beat, matching the
	 * store's own `key: <yaml>` rendering, so a fixture corrupts one field and
	 * nothing else.
	 */
	async function patchBeatFrontmatter(beatPath: string, key: string, rendered: string): Promise<void> {
		const file = path.join(root, beatPath);
		const raw = await Bun.file(file).text();
		const line = new RegExp(`^${key}: .*$`, "m");
		if (!line.test(raw)) throw new Error(`committed beat has no ${key} frontmatter line`);
		await Bun.write(file, raw.replace(line, `${key}: ${rendered}`));
	}

	async function patchManifest(batchId: string, patch: Record<string, unknown>): Promise<void> {
		const file = path.join(root, "beats", batchId, "COMMIT.json");
		const manifest = (await Bun.file(file).json()) as Record<string, unknown>;
		await Bun.write(file, JSON.stringify({ ...manifest, ...patch }));
	}

	/** One committed beat plus the exact file set a halt must preserve. */
	async function seedOneBeat(): Promise<{
		batchId: string;
		record: BeatRecord;
		files: string[];
	}> {
		const store = await openStore();
		const batch = await commit(
			store,
			[source("entry-1", null, 0)],
			[beatInput({ title: "Preserve me", sources: ["entry-1"] })],
			{ sources: ["entry-1"], text: "carry text" },
		);
		// The seeded data must reopen cleanly, so each halt below is caused by
		// the mutation under test and not by the fixture itself.
		expect((await openStore()).beats.map(beat => beat.title)).toEqual(["Preserve me"]);
		return {
			batchId: batch.id,
			record: batch.beats[0]!,
			files: await allFiles(),
		};
	}

	it("keeps a staged batch invisible until commit publishes beats and coverage together", async () => {
		const store = await openStore();
		const entries = [source("entry-1", null, 0), source("entry-2", "entry-1", 1)];
		const batch = stage(store, entries, [
			beatInput({ title: "Rename discussed", sources: ["entry-1"] }),
			beatInput({
				title: "Wrapper preferred",
				kind: "correction",
				sources: ["entry-2"],
			}),
		]);

		// Staged only: no canonical batch, no coverage, nothing a reader can see.
		expect(await committedBatchIds()).toEqual([]);
		expect(store.beats).toEqual([]);
		expect([...store.processedEntryIds]).toEqual([]);
		expect((await openStore()).beats).toEqual([]);

		await store.commitBatch(batch);

		expect(await committedBatchIds()).toEqual([batch.id]);
		expect(await stagingDirs()).toEqual([]);
		const manifest = await readManifest(batch.id);
		expect(manifest.beats).toHaveLength(2);
		expect(manifest.entries.map(entry => entry.id)).toEqual(["entry-1", "entry-2"]);
		expect(manifest.entries.map(entry => entry.parentId)).toEqual([null, "entry-1"]);
		expect(manifest.entries.map(entry => entry.timestamp)).toEqual(entries.map(entry => entry.timestamp));

		// Both beat files arrived with the manifest, not one ahead of it.
		for (const listed of manifest.beats) {
			expect(listed.file).not.toInclude("/");
			expect(await Bun.file(path.join(root, "beats", batch.id, listed.file)).exists()).toBe(true);
		}

		const reopened = await openStore();
		expect(reopened.beats.map(beat => beat.title).sort()).toEqual(["Rename discussed", "Wrapper preferred"]);
		expect([...reopened.processedEntryIds].sort()).toEqual(["entry-1", "entry-2"]);
		expect([...reopened.sourceEntries.keys()].sort()).toEqual(["entry-1", "entry-2"]);
		expect(reopened.sourceEntries.get("entry-2")?.parentId).toBe("entry-1");

		const recovered = reopened.beats.find(beat => beat.title === "Wrapper preferred");
		expect(recovered).toBeDefined();
		expect(recovered?.sources).toEqual(["entry-2"]);
		const frontmatter = await readBeatFrontmatter(recovered!.path);
		expect(frontmatter.batch).toBe(batch.id);
		expect(frontmatter.session).toBe("session-a");
		expect(frontmatter.model).toBe(MODEL);
		expect(frontmatter.sources).toEqual(["entry-2"]);
		expect(frontmatter.kind).toBe("correction");
	});

	it("records entry coverage for a completed pass that produced no beat", async () => {
		const store = await openStore();
		const batch = await commit(store, [source("ack-1", null, 3)], []);

		expect(store.beats).toEqual([]);
		expect([...store.processedEntryIds]).toEqual(["ack-1"]);
		const manifest = await readManifest(batch.id);
		expect(manifest.beats).toEqual([]);
		expect(manifest.entries.map(entry => entry.id)).toEqual(["ack-1"]);

		const reopened = await openStore();
		expect([...reopened.processedEntryIds]).toEqual(["ack-1"]);
		expect(reopened.beats).toEqual([]);
	});

	it("leaves every entry unprocessed when publication fails, then retries into one complete batch", async () => {
		const store = await openStore();
		const entries = [source("entry-1", null, 0), source("entry-2", "entry-1", 1)];
		const batch = stage(store, entries, [beatInput({ title: "First observation", sources: ["entry-1"] })]);

		// Deny writes beneath beats/ so the attempt can neither stage nor rename.
		await fs.chmod(path.join(root, "beats"), 0o500);
		await expect(store.commitBatch(batch)).rejects.toThrow();

		expect(await committedBatchIds()).toEqual([]);
		expect(store.beats).toEqual([]);
		expect([...store.processedEntryIds]).toEqual([]);
		expect([...(await openStore()).processedEntryIds]).toEqual([]);

		await fs.chmod(path.join(root, "beats"), 0o700);
		await store.commitBatch(batch);

		expect(await committedBatchIds()).toEqual([batch.id]);
		expect(await stagingDirs()).toEqual([]);
		expect(store.beats).toHaveLength(1);
		expect([...store.processedEntryIds].sort()).toEqual(["entry-1", "entry-2"]);

		const reopened = await openStore();
		expect(reopened.beats.map(beat => beat.title)).toEqual(["First observation"]);
		expect([...reopened.processedEntryIds].sort()).toEqual(["entry-1", "entry-2"]);
	});

	it("keeps a renamed batch committed when the rebuildable caches cannot be written", async () => {
		const store = await openStore();
		const entries = [source("entry-1", null, 0), source("entry-2", "entry-1", 1)];
		// Directories squatting on the cache paths fail the post-rename cache
		// writes while the publication rename itself still succeeds.
		for (const cache of ["INDEX.md", "state.json"]) {
			await fs.rm(path.join(root, cache), { force: true });
			await fs.mkdir(path.join(root, cache));
		}

		const batch = await commit(
			store,
			entries,
			[
				beatInput({ title: "Survived cache failure", sources: ["entry-1"] }),
				beatInput({
					title: "Also survived",
					kind: "mechanism",
					sources: ["entry-2"],
				}),
			],
			{ sources: ["entry-2"], text: "carry survives" },
		);

		expect(await committedBatchIds()).toEqual([batch.id]);
		expect(store.beats).toHaveLength(2);
		expect([...store.processedEntryIds].sort()).toEqual(["entry-1", "entry-2"]);
		// The injected fault really fired: neither cache could be produced, and no
		// half-written temporary file was left in the root.
		for (const cache of ["INDEX.md", "state.json"]) {
			expect(await fs.readdir(path.join(root, cache))).toEqual([]);
		}
		expect((await fs.readdir(root)).filter(name => name.includes(".tmp-"))).toEqual([]);

		await fs.rm(path.join(root, "INDEX.md"), { recursive: true });
		await fs.rm(path.join(root, "state.json"), { recursive: true });

		const reopened = await openStore();
		expect(reopened.beats.map(beat => beat.title).sort()).toEqual(["Also survived", "Survived cache failure"]);
		expect(reopened.carry).toEqual({
			sources: ["entry-2"],
			text: "carry survives",
		});
		// A runtime scan of the same entries finds nothing unseen: no model replay.
		expect(entries.filter(entry => !reopened.processedEntryIds.has(entry.id))).toEqual([]);
	});

	it("recovers identical history when only the caches are missing or corrupt", async () => {
		const store = await openStore();
		await commit(
			store,
			[source("entry-1", null, 0)],
			[beatInput({ title: "Cache independent", sources: ["entry-1"] })],
			{
				sources: ["entry-1"],
				text: "still here",
			},
		);
		const expected = store.beats.map(beat => ({
			id: beat.id,
			path: beat.path,
			title: beat.title,
		}));

		await fs.rm(path.join(root, "state.json"), { force: true });
		await Bun.write(path.join(root, "INDEX.md"), "not a table {{{\n");
		const afterBadIndex = await openStore();
		// A healthy reopen: it neither rejected nor lost anything.
		expect(
			afterBadIndex.beats.map(beat => ({
				id: beat.id,
				path: beat.path,
				title: beat.title,
			})),
		).toEqual(expected);
		expect([...afterBadIndex.processedEntryIds]).toEqual(["entry-1"]);
		expect(afterBadIndex.carry).toEqual({
			sources: ["entry-1"],
			text: "still here",
		});

		await Bun.write(path.join(root, "state.json"), "{ not json");
		await fs.rm(path.join(root, "INDEX.md"), { force: true });
		const afterBadState = await openStore();
		expect(
			afterBadState.beats.map(beat => ({
				id: beat.id,
				path: beat.path,
				title: beat.title,
			})),
		).toEqual(expected);
		expect([...afterBadState.processedEntryIds]).toEqual(["entry-1"]);
		expect(afterBadState.carry).toEqual({
			sources: ["entry-1"],
			text: "still here",
		});
	});

	it("halts capture and preserves every file when a committed manifest is malformed", async () => {
		const seed = await openStore();
		const batch = await commit(
			seed,
			[source("entry-1", null, 0)],
			[beatInput({ title: "Do not lose me", sources: ["entry-1"] })],
		);
		const beatFile = path.join(root, batch.beats[0]!.path);
		const before = await allFiles();
		await Bun.write(path.join(root, "beats", batch.id, "COMMIT.json"), '{"version": 1, "batchId":');

		await expectHaltedOpen(newStore());

		expect(await allFiles()).toEqual(before);
		expect(await Bun.file(beatFile).text()).toInclude("Do not lose me");
	});

	it("halts capture on a committed manifest version it cannot validate", async () => {
		const seed = await openStore();
		const batch = await commit(seed, [source("entry-1", null, 0)], []);
		const manifestPath = path.join(root, "beats", batch.id, "COMMIT.json");
		const manifest = await readManifest(batch.id);
		await Bun.write(manifestPath, JSON.stringify({ ...manifest, version: 2 }));

		await expectHaltedOpen(newStore());

		const preserved = (await Bun.file(manifestPath).json()) as Record<string, unknown>;
		expect(preserved.version).toBe(2);
	});

	it("halts capture rather than dropping a committed beat whose file is gone", async () => {
		const seed = await openStore();
		const batch = await commit(
			seed,
			[source("entry-1", null, 0), source("entry-2", "entry-1", 1)],
			[
				beatInput({ title: "Kept beat", sources: ["entry-1"] }),
				beatInput({
					title: "Deleted beat",
					kind: "anecdote",
					sources: ["entry-2"],
				}),
			],
		);
		const manifest = await readManifest(batch.id);
		await fs.rm(path.join(root, "beats", batch.id, manifest.beats[1]!.file));
		const before = await allFiles();

		await expectHaltedOpen(newStore());

		expect(await allFiles()).toEqual(before);
		expect(await Bun.file(path.join(root, "beats", batch.id, manifest.beats[0]!.file)).exists()).toBe(true);
	});

	it("halts capture when two committed manifests claim the same beat identity", async () => {
		const seed = await openStore();
		const batch = await commit(
			seed,
			[source("entry-1", null, 0)],
			[beatInput({ title: "Duplicated identity", sources: ["entry-1"] })],
		);
		const manifest = await readManifest(batch.id);
		const listed = manifest.beats[0]!;
		// A second internally consistent batch that claims the same beat id:
		// two manifests, one identity. Neither may be silently preferred.
		const cloneId = Bun.randomUUIDv7();
		const cloneDir = path.join(root, "beats", cloneId);
		await fs.mkdir(cloneDir, { recursive: true });
		const beatBody = await Bun.file(path.join(root, "beats", batch.id, listed.file)).text();
		await Bun.write(path.join(cloneDir, listed.file), beatBody.replace(batch.id, cloneId));
		await Bun.write(
			path.join(cloneDir, "COMMIT.json"),
			JSON.stringify({
				...manifest,
				batchId: cloneId,
				committedAt: new Date(Date.parse(manifest.committedAt) + 1000).toISOString(),
			}),
		);
		const before = await allFiles();

		await expectHaltedOpen(newStore());

		expect(await allFiles()).toEqual(before);
	});

	it("refuses to overwrite an occupied publication destination", async () => {
		const store = await openStore();
		const batch = stage(
			store,
			[source("entry-1", null, 0)],
			[beatInput({ title: "Collides", sources: ["entry-1"] })],
		);
		const occupied = path.join(root, "beats", batch.id);
		await fs.mkdir(occupied, { recursive: true });
		await Bun.write(path.join(occupied, "PRIOR.txt"), "existing batch content");

		let failure: unknown;
		await store.commitBatch(batch).catch((error: unknown) => {
			failure = error;
		});
		expect(failure).toBeDefined();
		// An ordinary publication failure, not committed-data corruption: the
		// store stays usable and captures the same entries into a later batch.
		expect(isChroniclerCorruption(failure)).toBe(false);

		expect(await Bun.file(path.join(occupied, "PRIOR.txt")).text()).toBe("existing batch content");
		expect(await fs.readdir(occupied)).toEqual(["PRIOR.txt"]);
		expect(await stagingDirs()).toEqual([]);
		expect(store.beats).toEqual([]);
		expect([...store.processedEntryIds]).toEqual([]);
		const retried = await commit(
			store,
			[source("entry-1", null, 0)],
			[beatInput({ title: "Published elsewhere", sources: ["entry-1"] })],
		);
		expect(retried.id).not.toBe(batch.id);
		expect(store.beats.map(beat => beat.title)).toEqual(["Published elsewhere"]);
		expect([...store.processedEntryIds]).toEqual(["entry-1"]);
	});

	it("ignores abandoned staging and never recovers a checkpoint from it", async () => {
		const seed = await openStore();
		const batch = await commit(
			seed,
			[source("entry-1", null, 0)],
			[beatInput({ title: "Committed", sources: ["entry-1"] })],
		);
		// A crash before rename leaves a complete-looking staging directory.
		const abandonedId = Bun.randomUUIDv7();
		const abandoned = path.join(root, "beats", `.pending-${abandonedId}`);
		await fs.cp(path.join(root, "beats", batch.id), abandoned, {
			recursive: true,
		});
		const manifest = await readManifest(batch.id);
		await Bun.write(
			path.join(abandoned, "COMMIT.json"),
			JSON.stringify({
				...manifest,
				batchId: abandonedId,
				entries: [source("ghost-1", null, 9)],
				carry: { sources: ["ghost-1"], text: "never published" },
			}),
		);

		const store = await openStore();

		// Only the committed batch is indexed; the staging copy contributes nothing.
		expect(store.beats.map(beat => beat.title)).toEqual(["Committed"]);
		expect([...store.processedEntryIds]).toEqual(["entry-1"]);
		expect(store.sourceEntries.has("ghost-1")).toBe(false);
		expect(store.carry).toBeNull();
		// Preserved, just unindexed.
		expect((await fs.readdir(abandoned)).length).toBeGreaterThan(0);
	});

	it("recovers the newest own carry, including an explicit null", async () => {
		const store = await openStore();
		await commit(store, [source("entry-1", null, 0)], [beatInput({ title: "First", sources: ["entry-1"] })], {
			sources: ["entry-1"],
			text: "older carry",
		});
		expect(store.carry).toEqual({ sources: ["entry-1"], text: "older carry" });

		await commit(store, [source("entry-2", "entry-1", 1)], [beatInput({ title: "Second", sources: ["entry-2"] })], {
			sources: ["entry-2"],
			text: "newest carry",
		});
		expect((await openStore()).carry).toEqual({
			sources: ["entry-2"],
			text: "newest carry",
		});

		// A completed pass with nothing left over must not resurrect old carry.
		await commit(store, [source("entry-3", "entry-2", 2)], [], null);
		expect(store.carry).toBeNull();
		expect((await openStore()).carry).toBeNull();
		expect([...(await openStore()).processedEntryIds].sort()).toEqual(["entry-1", "entry-2", "entry-3"]);
	});

	it("exposes inherited carry and provenance until this session commits its own batch", async () => {
		const parent = await openStore("session-parent");
		await commit(
			parent,
			[source("parent-1", null, 0)],
			[beatInput({ title: "Parent beat", sources: ["parent-1"] })],
			{
				sources: ["parent-1"],
				text: "inherited carry",
			},
		);

		// A fork copies artifacts: the child opens foreign-session committed history.
		const child = await openStore("session-child");
		expect(child.carry).toEqual({
			sources: ["parent-1"],
			text: "inherited carry",
		});
		expect([...child.processedEntryIds]).toEqual(["parent-1"]);
		expect(child.beats.map(beat => beat.sessionId)).toEqual(["session-parent"]);

		const own = await commit(child, [source("child-1", "parent-1", 5)], [], null);
		expect(child.carry).toBeNull();

		const reopened = await openStore("session-child");
		expect(reopened.carry).toBeNull();
		// Inherited provenance stays original; child material stays child's.
		expect(reopened.beats.map(beat => beat.sessionId)).toEqual(["session-parent"]);
		expect([...reopened.processedEntryIds].sort()).toEqual(["child-1", "parent-1"]);
		expect((await readManifest(own.id)).sessionId).toBe("session-child");
	});

	it("halts when a committed beat cites a source no manifest lists", async () => {
		const seeded = await seedOneBeat();
		// Validation is against the global union of every committed manifest's
		// entries, not just this beat's own manifest.
		await patchBeatFrontmatter(seeded.record.path, "sources", "[entry-1,ghost-1]");

		await expectHaltedOpen(newStore());

		expect(await allFiles()).toEqual(seeded.files);
	});

	it("halts when a committed carry cites a source no manifest lists", async () => {
		const seeded = await seedOneBeat();
		await patchManifest(seeded.batchId, {
			carry: { sources: ["ghost-1"], text: "off-branch carry" },
		});

		await expectHaltedOpen(newStore());

		expect(await allFiles()).toEqual(seeded.files);
		// The unusable carry is preserved verbatim, not rewritten or dropped.
		expect((await readManifest(seeded.batchId)).carry).toEqual({
			sources: ["ghost-1"],
			text: "off-branch carry",
		});
	});

	it("halts when a committed beat claims a session its manifest does not", async () => {
		const seeded = await seedOneBeat();
		// Foreign-session beats are legitimate when inherited whole; a beat
		// disagreeing with the manifest that published it is corruption.
		await patchBeatFrontmatter(seeded.record.path, "session", "session-impostor");

		await expectHaltedOpen(newStore());

		expect(await allFiles()).toEqual(seeded.files);
	});

	it("halts when a committed beat relates to a beat that does not exist", async () => {
		const seeded = await seedOneBeat();
		await patchBeatFrontmatter(seeded.record.path, "related", `[${MISSING_BEAT}]`);

		await expectHaltedOpen(newStore());

		expect(await allFiles()).toEqual(seeded.files);
	});

	it("halts when a committed beat supersedes a beat that does not exist", async () => {
		const seeded = await seedOneBeat();
		const raw = await Bun.file(path.join(root, seeded.record.path)).text();
		await Bun.write(
			path.join(root, seeded.record.path),
			raw.replace(/^related: .*$/m, `related: []\nsupersedes: ${MISSING_BEAT}`),
		);

		await expectHaltedOpen(newStore());

		expect(await allFiles()).toEqual(seeded.files);
	});

	it("halts when a committed beat references itself", async () => {
		const seeded = await seedOneBeat();
		await patchBeatFrontmatter(seeded.record.path, "related", `[${seeded.record.id}]`);
		await expectHaltedOpen(newStore());

		await patchBeatFrontmatter(seeded.record.path, "related", "[]");
		const restored = await openStore();
		expect(restored.beats.map(beat => beat.title)).toEqual(["Preserve me"]);

		const raw = await Bun.file(path.join(root, seeded.record.path)).text();
		await Bun.write(
			path.join(root, seeded.record.path),
			raw.replace(/^related: .*$/m, `related: []\nsupersedes: ${seeded.record.id}`),
		);
		await expectHaltedOpen(newStore());

		expect(await allFiles()).toEqual(seeded.files);
	});

	it("publishes nothing for a revoked batch", async () => {
		const store = await openStore();
		const batch = stage(store, [source("entry-1", null, 0)], [beatInput({ title: "Revoked", sources: ["entry-1"] })]);
		batch.revoked = true;

		await expect(store.commitBatch(batch)).rejects.toThrow();

		expect(await committedBatchIds()).toEqual([]);
		expect(await stagingDirs()).toEqual([]);
		expect(store.beats).toEqual([]);
		expect([...store.processedEntryIds]).toEqual([]);
		// A revoked attempt leaves the entries available to a later batch.
		const retried = await commit(
			store,
			[source("entry-1", null, 0)],
			[beatInput({ title: "Recaptured", sources: ["entry-1"] })],
		);
		expect(await committedBatchIds()).toEqual([retried.id]);
		expect(store.beats.map(beat => beat.title)).toEqual(["Recaptured"]);
	});

	it("commits and reopens through a warn hook that throws while the caches are unwritable", async () => {
		const warnings: string[] = [];
		const hooks: ChroniclerStoreHooks = {
			warn(message: string) {
				warnings.push(message);
				throw new Error("hook exploded");
			},
		};
		const store = newStore("session-a", hooks);
		await store.open();
		for (const cache of ["INDEX.md", "state.json"]) {
			await fs.rm(path.join(root, cache), { force: true });
			await fs.mkdir(path.join(root, cache));
		}

		const batch = await commit(
			store,
			[source("entry-1", null, 0)],
			[beatInput({ title: "Cache blocked", sources: ["entry-1"] })],
		);

		expect(await committedBatchIds()).toEqual([batch.id]);
		expect(store.beats).toHaveLength(1);
		expect([...store.processedEntryIds]).toEqual(["entry-1"]);
		expect(warnings.length).toBeGreaterThan(0);

		// The obstacle and the throwing hook both survive the restart: history
		// still loads, because caches carry none of it.
		const reopened = newStore("session-a", hooks);
		await reopened.open();
		expect(reopened.beats.map(beat => beat.title)).toEqual(["Cache blocked"]);
		expect([...reopened.processedEntryIds]).toEqual(["entry-1"]);
	});
});
