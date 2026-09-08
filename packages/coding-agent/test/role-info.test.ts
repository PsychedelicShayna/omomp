import { describe, expect, test } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { resolveChroniclerRoleSelection } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { getRoleInfo } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

describe("getRoleInfo", () => {
	test("returns built-in role info", () => {
		const settings = Settings.isolated({});

		expect(getRoleInfo("default", settings)).toEqual({
			name: "Default",
			color: "success",
			tag: "DEFAULT",
		});
		expect(getRoleInfo("smol", settings)).toEqual({
			name: "Fast",
			color: "warning",
			tag: "SMOL",
		});
		expect(getRoleInfo("slow", settings)).toEqual({
			name: "Thinking",
			color: "accent",
			tag: "SLOW",
		});
	});

	test("returns custom role info from modelTags", () => {
		const settings = Settings.isolated({
			modelTags: {
				custom: { name: "My Custom Tag", color: "error" },
				another: { name: "Another Tag" },
			},
		});

		expect(getRoleInfo("custom", settings)).toEqual({
			name: "My Custom Tag",
			color: "error",
		});
		expect(getRoleInfo("another", settings)).toEqual({
			name: "Another Tag",
			color: undefined,
		});
	});

	test("returns fallback for unknown roles", () => {
		const settings = Settings.isolated({});

		expect(getRoleInfo("unknown-role", settings)).toEqual({
			name: "unknown-role",
			color: "muted",
		});
	});

	test("configured metadata overrides built-in role info while keeping built-in defaults", () => {
		const settings = Settings.isolated({
			modelTags: {
				smol: { name: "My Smol", color: "success" },
			},
		});

		expect(getRoleInfo("smol", settings)).toEqual({
			tag: "SMOL",
			name: "My Smol",
			color: "success",
		});
	});
});

test("chronicler selection is independent and unset capture uses the slow priority chain", () => {
	const luna = createMockModel({ provider: "openai-codex", id: "gpt-5.6-luna" }).model;
	const sol = createMockModel({ provider: "openai-codex", id: "gpt-5.6-sol" }).model;
	const available = [luna, sol];
	const explicit = Settings.isolated({
		modelRoles: { chronicler: "openai-codex/gpt-5.6-luna", slow: "openai-codex/gpt-5.6-sol" },
	});
	const unset = Settings.isolated({
		modelRoles: { default: "openai-codex/gpt-5.6-luna", slow: "openai-codex/gpt-5.6-luna" },
	});
	expect(resolveChroniclerRoleSelection(explicit, available)?.model).toBe(luna);
	expect(resolveChroniclerRoleSelection(unset, available)?.model).toBe(sol);
});
