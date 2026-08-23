import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createLivePersonaFeature,
	defaultLiveInstructions,
	type LivePersonaFeature,
	LivePersonaStore,
	resolveLiveInstructions,
} from "@oh-my-pi/pi-coding-agent/live/personas";

describe("live personas", () => {
	let dir: string;
	let statePath: string;
	let personas: LivePersonaFeature;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-personas-"));
		statePath = path.join(dir, "omomp-live-personas.json");
		personas = createLivePersonaFeature(new LivePersonaStore(statePath));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("default is immutable: edit, delete, and clone-over are rejected loudly", async () => {
		await expect(personas.edit("default", "hijacked")).rejects.toThrow(/immutable/);
		await expect(personas.delete("default")).rejects.toThrow(/immutable/);
		await personas.clone("default", "iris");
		await expect(personas.clone("iris", "default")).rejects.toThrow(/immutable/);
		// Case-variant shadowing of the reserved name is also refused.
		await expect(personas.clone("iris", "Default")).rejects.toThrow(/immutable/);
		// After every rejected mutation the resolver still serves the bundled template.
		expect(await resolveLiveInstructions(statePath)).toBe(defaultLiveInstructions);
	});

	test("clone copies instruction text from the bundled default and from custom personas", async () => {
		await personas.clone("default", "iris");
		expect(await personas.show("iris")).toBe(defaultLiveInstructions);
		await personas.edit("iris", "You are Iris but sassy, {{firstName}}.");
		await personas.clone("iris", "iris2");
		expect(await personas.show("iris2")).toBe("You are Iris but sassy, {{firstName}}.");
		await expect(personas.clone("default", "iris")).rejects.toThrow(/already exists/);
		await expect(personas.clone("ghost", "copy")).rejects.toThrow(/Unknown live persona/);
		await expect(personas.clone("default", "bad name")).rejects.toThrow(/letters, numbers/);
	});

	test("selection drives the resolver and survives store round-trips", async () => {
		await personas.clone("default", "iris");
		await personas.edit("iris", "Custom instructions for {{firstName}} ({{username}}).");
		await personas.use("iris");
		// Fresh store instance (the controller's resolver) sees the persisted selection,
		// template variables intact for prompt.render.
		expect(await resolveLiveInstructions(statePath)).toBe("Custom instructions for {{firstName}} ({{username}}).");
		await personas.use("default");
		expect(await resolveLiveInstructions(statePath)).toBe(defaultLiveInstructions);
		await expect(personas.use("ghost")).rejects.toThrow(/Unknown live persona/);
	});

	test("deleting the active persona falls back to the bundled default", async () => {
		await personas.clone("default", "iris");
		await personas.edit("iris", "Short-lived instructions.");
		await personas.use("iris");
		expect(await resolveLiveInstructions(statePath)).toBe("Short-lived instructions.");
		await personas.delete("iris");
		expect(await resolveLiveInstructions(statePath)).toBe(defaultLiveInstructions);
		expect(await personas.status()).toBe("Live persona: default");
	});

	test("resolver degrades to the bundled template on missing, corrupt, or dangling stores", async () => {
		// No state file at all.
		expect(await resolveLiveInstructions(statePath)).toBe(defaultLiveInstructions);
		// Corrupt JSON must not throw out of the resolver.
		await fs.writeFile(statePath, "{ not json", "utf8");
		expect(await resolveLiveInstructions(statePath)).toBe(defaultLiveInstructions);
		// Valid JSON, wrong schema.
		await fs.writeFile(statePath, JSON.stringify({ schemaVersion: 99 }), "utf8");
		expect(await resolveLiveInstructions(statePath)).toBe(defaultLiveInstructions);
		// Dangling selection: active names a persona that no longer exists.
		await fs.writeFile(statePath, `${JSON.stringify({ schemaVersion: 1, personas: {}, active: "ghost" }, null, 2)}\n`, "utf8");
		expect(await resolveLiveInstructions(statePath)).toBe(defaultLiveInstructions);
		// The fallback text still carries the render variables the controller substitutes.
		expect(defaultLiveInstructions).toContain("{{firstName}}");
		expect(defaultLiveInstructions).toContain("{{username}}");
	});
});
