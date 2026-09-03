import { describe, expect, test } from "bun:test";
import { commands } from "../src/cli-commands";

describe("flash command registration", () => {
	test("loads lazily with only the supported public flags", async () => {
		const entry = commands.find(command => command.name === "flash");
		expect(entry?.help?.description).toContain("encrypted portable OMOMP");
		const Flash = await entry?.load();
		expect(Flash).toBeDefined();
		expect(Object.keys(Flash?.flags ?? {}).sort()).toEqual(["force", "resume", "user"]);
		expect(Object.keys(Flash?.args ?? {})).toEqual(["device"]);
	});
});
