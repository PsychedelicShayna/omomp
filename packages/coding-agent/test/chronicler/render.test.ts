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
	expect(raw.indexOf("observed")).toBeLessThan(raw.indexOf("three exports"));
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
