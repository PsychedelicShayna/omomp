import { claudeExternalHarnessAdapter } from "./claude";
import { codexExternalHarnessAdapter } from "./codex";
import type { ExternalHarnessAdapter } from "./types";
import type { AgentDefinition } from "../types";

export { ClaudeExternalHarnessAdapter, claudeExternalHarnessAdapter } from "./claude";
export { codexExternalHarnessAdapter } from "./codex";
export type {
	ExternalHarnessAdapter,
	ExternalHarnessInput,
	ExternalHarnessIsolationContext,
} from "./types";


const CLAUDE_TOOLS = new Set(["read", "grep", "glob", "web_search", "web_fetch", "edit", "write", "yield"]);

/** Reject manifests whose requested capabilities cannot be represented exactly. */
export function assertExternalHarnessCapabilities(agent: AgentDefinition): void {
	const requested = agent.tools ?? [];
	if (agent.harness === "codex") {
		throw new Error(
			"Codex external harness is unavailable: app-server built-ins cannot represent AgentDefinition.tools exactly and command execution lacks descendant-safe containment",
		);
	}
	if (agent.harness === "claude") {
		const unsupported = requested.filter(tool => !CLAUDE_TOOLS.has(tool));
		if (unsupported.length > 0) {
			throw new Error(`Claude external harness cannot represent requested tools: ${unsupported.join(", ")}`);
		}
	}
}
/** Select an external runtime; native OMP execution deliberately returns undefined. */
export function getExternalHarnessAdapter(
	harness: "omp" | "claude" | "codex" | undefined,
): ExternalHarnessAdapter | undefined {
	switch (harness ?? "omp") {
		case "omp":
			return undefined;
		case "claude":
			return claudeExternalHarnessAdapter;
		case "codex":
			return codexExternalHarnessAdapter;
		default:
			return undefined;
	}
}
