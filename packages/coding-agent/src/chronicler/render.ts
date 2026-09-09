import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { ADVISOR_RENDER_OPTIONS } from "../advisor/delta-split";
import entryTemplate from "../prompts/chronicler/entry.md" with { type: "text" };
import { formatSessionHistoryMarkdown } from "../session/session-history-format";
import type { CaptureSource } from "./store";

export interface ChronicleEntry extends CaptureSource {
	message: AgentMessage;
}

export interface RenderChronicleDeltaOptions {
	includeThinking: boolean;
	obfuscator?: { obfuscate(text: string, shared?: ReadonlySet<string>): string };
}

export function renderChronicleDelta(
	entries: readonly ChronicleEntry[],
	opts: RenderChronicleDeltaOptions,
): AgentMessage[] {
	if (!entries.length) return [];
	const text = entries
		.map(entry =>
			prompt.render(entryTemplate, {
				id: entry.id,
				parentId: entry.parentId,
				timestamp: entry.timestamp,
				// Deliberately no cross-entry result index: a result retains its own source marker.
				transcript: formatSessionHistoryMarkdown([entry.message], {
					...ADVISOR_RENDER_OPTIONS,
					includeThinking: opts.includeThinking,
				}).trim(),
			}),
		)
		.join("\n\n");
	return [
		{
			role: "user",
			content: [{ type: "text", text: opts.obfuscator?.obfuscate(text) ?? text }],
			timestamp: Date.now(),
		},
	];
}
