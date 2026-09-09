import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ReadChronicleTool } from "../../src/chronicler/chronicle-tool";
import { ChroniclerStore } from "../../src/chronicler/store";

test("discovers and reads an older beat outside the newest 200 without filesystem access", async () => {
	const temp = TempDir.createSync("chronicler-discovery-");
	try {
		const store = new ChroniclerStore(temp.path(), { sessionId: "session", project: "project", model: "mock/model" });
		await store.open();
		const source = { id: "evidence", parentId: null, timestamp: "2026-09-08T00:00:00.000Z" };
		const batch = store.beginBatch([source]);
		for (let index = 0; index < 205; index++) {
			store.stageBeat(batch, {
				title: index === 0 ? "SECRET ".repeat(100) : `Beat ${index}`,
				kind: "concept",
				body: `Standalone evidence ${index}. SECRET`,
				topics: [],
				sources: [source.id],
				eventTime: source.timestamp,
				related: [],
			});
		}
		batch.finalized = true;
		await store.commitBatch(batch);
		const attempt = store.beginBatch([]);
		const reader = new ReadChronicleTool(store, attempt, {
			obfuscate: value => value.replaceAll("SECRET", "redacted"),
		});
		const listed = await reader.execute("list", { offset: 200, limit: 10 });
		const listing = listed.content[0];
		if (listing.type !== "text") throw new Error("Expected textual metadata page");
		const page = JSON.parse(listing.text) as {
			beats: { id: string; title: string }[];
			total: number;
			nextOffset: number | null;
		};
		expect(page.total).toBe(205);
		expect(page.beats.map(beat => beat.id)).toEqual(
			store.beats
				.slice(0, 5)
				.reverse()
				.map(beat => beat.id),
		);
		expect(page.nextOffset).toBeNull();
		expect(listing.text).not.toContain("SECRET");
		expect(page.beats.at(-1)!.title.length).toBeLessThan(400);
		const oldest = page.beats.at(-1)!;
		const read = await reader.execute("read", { id: oldest.id });
		expect(JSON.stringify(read.content)).toContain("Standalone evidence 0. redacted");
		await expect(reader.execute("bad", { id: "../arbitrary" })).rejects.toThrow();
		await expect(reader.execute("bad", { offset: -1 })).rejects.toThrow();
		await expect(reader.execute("bad", { limit: 101 })).rejects.toThrow();
		await expect(reader.execute("bad", { id: oldest.id, offset: 0 })).rejects.toThrow();
		const first = await reader.execute("first", {});
		if (first.content[0].type !== "text") throw new Error("Expected textual page");
		const initial = JSON.parse(first.content[0].text) as { beats: { id: string }[]; nextOffset: number };
		expect(initial.beats).toHaveLength(50);
		expect(initial.nextOffset).toBe(50);
		const second = await reader.execute("next", { offset: initial.nextOffset });
		if (second.content[0].type !== "text") throw new Error("Expected textual page");
		const next = JSON.parse(second.content[0].text) as { beats: { id: string }[] };
		expect(next.beats[0].id).toBe(store.beats[154].id);
		attempt.revoked = true;
		await expect(reader.execute("late", {})).rejects.toThrow();
	} finally {
		await temp.remove();
	}
});
