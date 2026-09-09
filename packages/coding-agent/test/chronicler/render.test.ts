import { expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type ChronicleEntry, renderChronicleDelta } from "../../src/chronicler/render";

function text(messages: AgentMessage[]): string {
	return messages
		.filter(message => message.role === "user")
		.map(message =>
			typeof message.content === "string"
				? message.content
				: message.content
						.filter(block => block.type === "text")
						.map(block => block.text)
						.join("\n"),
		)
		.join("\n");
}

test("retains provenance and an explicit empty marker for suppressed transcript content", () => {
	const entries: ChronicleEntry[] = [
		{
			id: "empty-source",
			parentId: "prior-source",
			timestamp: "2026-09-08T10:00:00.000Z",
			message: {
				role: "bashExecution",
				command: "hidden",
				output: "hidden",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				excludeFromContext: true,
				timestamp: 0,
			},
		},
	];
	const rendered = text(renderChronicleDelta(entries, { includeThinking: true }));
	expect(rendered).toContain("empty-source");
	expect(rendered).toContain("prior-source");
	expect(rendered).toContain("Empty rendered content");
	expect(rendered).not.toContain("hidden");
});

test("tool results retain their own source and obfuscation covers entry boundaries", () => {
	const entries: ChronicleEntry[] = [
		{
			id: "intention",
			parentId: null,
			timestamp: "2026-09-08T10:00:00.000Z",
			message: { role: "user", content: "secret begins", timestamp: 0 },
		},
		{
			id: "observed",
			parentId: "intention",
			timestamp: "2026-09-08T10:00:01.000Z",
			message: {
				role: "toolResult",
				toolCallId: "call",
				toolName: "read",
				content: [{ type: "text", text: "secret ends: three exports" }],
				isError: false,
				timestamp: 1,
			},
		},
	];
	const raw = text(renderChronicleDelta(entries, { includeThinking: true }));
	expect(raw).toContain("### Source entry `observed`");
	expect(raw).toContain("three exports");
	expect(raw.indexOf("### Source entry `observed`")).toBeLessThan(raw.indexOf("three exports"));
	const redacted = text(
		renderChronicleDelta(entries, {
			includeThinking: true,
			obfuscator: { obfuscate: value => value.replace(/secret begins[\s\S]*secret ends/, "REDACTED") },
		}),
	);
	expect(redacted).toContain("REDACTED: three exports");
	expect(redacted).not.toContain("secret begins");
	expect(redacted).not.toContain("secret ends");
});

test("retains correlation IDs for two same-name calls and separately sourced results", () => {
	const entries: ChronicleEntry[] = [
		{
			id: "calls",
			parentId: null,
			timestamp: "2026-09-08T10:00:00.000Z",
			message: {
				role: "assistant",
				api: "mock",
				provider: "mock",
				model: "mock",
				timestamp: 0,
				stopReason: "toolUse",
				content: [
					{ type: "toolCall", id: "read-one", name: "read", arguments: { path: "a.ts" } },
					{ type: "toolCall", id: "read-two", name: "read", arguments: { path: "b.ts" } },
				],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		},
		{
			id: "result-two",
			parentId: "calls",
			timestamp: "2026-09-08T10:00:01.000Z",
			message: {
				role: "toolResult",
				toolCallId: "read-two",
				toolName: "read",
				content: [{ type: "text", text: "b has three exports" }],
				isError: false,
				timestamp: 1,
			},
		},
		{
			id: "result-one",
			parentId: "result-two",
			timestamp: "2026-09-08T10:00:02.000Z",
			message: {
				role: "toolResult",
				toolCallId: "read-one",
				toolName: "read",
				content: [{ type: "text", text: "a has one export" }],
				isError: false,
				timestamp: 2,
			},
		},
	];
	const rendered = text(renderChronicleDelta(entries, { includeThinking: true }));
	const sections = rendered.split("### Source entry").slice(1);
	expect(sections).toHaveLength(3);
	expect(sections[0]).toContain("read-one");
	expect(sections[0]).toContain("read-two");
	expect(sections[1]).toContain("result-two");
	expect(sections[1]).toContain("read-two");
	expect(sections[1]).toContain("b has three exports");
	expect(sections[1]).not.toContain("a has one export");
	expect(sections[2]).toContain("result-one");
	expect(sections[2]).toContain("read-one");
	expect(sections[2]).toContain("a has one export");
});
