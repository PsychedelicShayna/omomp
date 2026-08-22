/**
 * Live voice relay vs. background async work.
 *
 * A settle that only pauses for a running background job is tagged
 * `isTerminal: false` so the TUI keeps its working state. That tag used to also
 * suppress the live controller's answer relay, so a session that answered while
 * subagents ran went silent on the call. The settle now also carries
 * `hasFinalResponse`, which the relay keys off independently of `isTerminal`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { classifyRelaySettle } from "../src/live/controller";

type AgentEndEvent = Extract<AgentSessionEvent, { type: "agent_end" }>;

describe("live relay settle classification", () => {
	it("relays and closes on a terminal settle", () => {
		expect(classifyRelaySettle({ isTerminal: true, hasFinalResponse: true })).toEqual({
			relay: true,
			closeDelegation: true,
		});
		// Legacy/untagged emitters: an absent isTerminal is a terminal settle.
		expect(classifyRelaySettle({})).toEqual({ relay: true, closeDelegation: true });
	});

	it("relays a non-terminal settle that already answered, keeping the delegation open", () => {
		expect(classifyRelaySettle({ isTerminal: false, hasFinalResponse: true })).toEqual({
			relay: true,
			closeDelegation: false,
		});
	});

	it("stays silent on a non-terminal settle that is only a scheduling pause", () => {
		expect(classifyRelaySettle({ isTerminal: false })).toEqual({ relay: false, closeDelegation: false });
		expect(classifyRelaySettle({ isTerminal: false, hasFinalResponse: false })).toEqual({
			relay: false,
			closeDelegation: false,
		});
	});
});

describe("AgentSession agent_end final-response tagging", () => {
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	afterEach(async () => {
		if (session) await session.dispose();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		AsyncJobManager.resetForTests();
	});

	it("tags a pause-for-background-job settle as carrying the turn's answer", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["All set."] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			asyncJobManager: manager,
		});

		const settles: AgentEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "agent_end") settles.push(event);
		});

		const gate = Promise.withResolvers<string>();
		manager.register("task", "gated subagent", () => gate.promise, { id: "sub-1", ownerId: "Main" });
		expect(session.hasPendingAsyncWork()).toBe(true);

		// The main lane answers while the background job is still running.
		await session.prompt("what is the status?");
		await session.waitForIdle();

		expect(settles.length).toBeGreaterThanOrEqual(1);
		const pauseSettle = settles.at(-1)!;
		// The TUI contract is unchanged: this settle is NOT terminal.
		expect(pauseSettle.isTerminal).toBe(false);
		// The relay contract is new: the answer is here, so speak it.
		expect(pauseSettle.hasFinalResponse).toBe(true);
		expect(classifyRelaySettle(pauseSettle)).toEqual({ relay: true, closeDelegation: false });

		// The woken turn's answer is relayed too, and closes the delegation.
		settles.length = 0;
		gate.resolve("subagent finished");
		await session.settleAsyncWork();
		await session.waitForIdle();

		expect(session.hasPendingAsyncWork()).toBe(false);
		const finalSettle = settles.at(-1)!;
		expect(finalSettle.isTerminal).toBe(true);
		expect(finalSettle.hasFinalResponse).toBe(true);
		expect(classifyRelaySettle(finalSettle)).toEqual({ relay: true, closeDelegation: true });
	});
});
