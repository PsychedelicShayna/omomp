import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	assertExternalHarnessCapabilities,
	ClaudeExternalHarnessAdapter,
	claudeExternalHarnessAdapter,
} from "../../src/task/external-harness";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import {
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	type AgentDefinition,
	type SingleResult,
	type SubagentLifecyclePayload,
} from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const claudeAgent: AgentDefinition = {
	name: "claude-contract",
	description: "external harness contract fixture",
	systemPrompt: "Run the supplied fixture.",
	source: "project",
	harness: "claude",
	tools: ["read", "yield"],
};

function settledResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "external-contract",
		agent: claudeAgent.name,
		agentSource: claudeAgent.source,
		task: "do work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

function lifecycleRunOptions(eventBus: EventBus) {
	return {
		cwd: "/tmp",
		agent: claudeAgent,
		task: "do work",
		index: 0,
		id: "external-contract",
		settings: Settings.isolated(),
		modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
		enableLsp: false,
		eventBus,
	};
}

function collectLifecycle(eventBus: EventBus): SubagentLifecyclePayload[] {
	const events: SubagentLifecyclePayload[] = [];
	eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
		events.push(data as SubagentLifecyclePayload);
	});
	return events;
}

describe("external harness contracts", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("accepts the host-owned yield capability while rejecting unsupported runtime tools", () => {
		expect(() => assertExternalHarnessCapabilities(claudeAgent)).not.toThrow();
		expect(() => assertExternalHarnessCapabilities({ ...claudeAgent, tools: ["read", "bash", "yield"] })).toThrow(
			"Claude external harness cannot represent requested tools: bash",
		);
	});

	it("observes cancellation that arrives during asynchronous isolation validation", async () => {
		const spawn = vi.spyOn(Bun, "spawn").mockImplementation(() => {
			throw new Error("sidecar spawned after cancellation");
		});
		const controller = new AbortController();
		const run = new ClaudeExternalHarnessAdapter().execute({
			agent: claudeAgent,
			agentId: "claude-cancel",
			prompt: "do work",
			cwd: "/tmp",
			isolation: { isolated: true, worktree: "/tmp", repoRoot: "/tmp" },
			parent: { parentSessionId: "Main", inheritedExtensionState: {} },
			signal: controller.signal,
			maxRuntimeMs: 1_000,
			deadlineAt: Date.now() + 1_000,
			onProgress: () => {},
		});

		controller.abort("cancel during isolation");

		await expect(run).rejects.toMatchObject({ name: "AbortError" });
		expect(spawn).not.toHaveBeenCalled();
	});

	it("brackets a successful external run with exactly one start and terminal event", async () => {
		const eventBus = new EventBus();
		const events = collectLifecycle(eventBus);
		vi.spyOn(claudeExternalHarnessAdapter, "execute").mockImplementation(async () => {
			expect(events.map(event => event.status)).toEqual(["started"]);
			return settledResult();
		});

		const result = await runSubprocess(lifecycleRunOptions(eventBus));

		expect(result.exitCode).toBe(0);
		expect(events.map(event => event.status)).toEqual(["started", "completed"]);
	});

	it("emits one failed settlement when an external adapter throws", async () => {
		const eventBus = new EventBus();
		const events = collectLifecycle(eventBus);
		vi.spyOn(claudeExternalHarnessAdapter, "execute").mockRejectedValue(new Error("adapter failed"));

		await expect(runSubprocess(lifecycleRunOptions(eventBus))).rejects.toThrow("adapter failed");
		expect(events.map(event => event.status)).toEqual(["started", "failed"]);
	});
});
