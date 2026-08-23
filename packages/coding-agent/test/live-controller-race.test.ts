/**
 * Live controller delegation ownership under barge-in.
 *
 * The classifier test (live-relay-async-settle.test.ts) cannot catch these:
 * they are ownership races between the voice handoff's abort and the torn-down
 * turn's fire-and-forget `agent_end`. Covered here:
 *
 * 1. A late aborted settle must be suppressed — it must not close the newly
 *    claimed delegation (which silenced the genuine turn on the call).
 * 2. Rapid delegations merge: the newest survivor dispatches ONE backend turn
 *    carrying every still-unsent request, in arrival order (the committed
 *    voice contract: merge split turns, barge in on active work).
 * 3. A genuine empty terminal settle still closes unconditionally, so a stale
 *    delegation id can never route later unrelated output into the call.
 * 4. Raw transcript persistence: pre-dedupe, ordered, duplicates survive,
 *    mid-utterance partial flushed on stop, drained before teardown.
 * 5. Fleet feed: crew IRC messages ride the speakable channel, attributed and
 *    session-scoped when no delegation is active.
 * 6. Fleet feed: reasoning narration flushes once at a sentence boundary and
 *    never re-sends already-narrated thinking.
 */
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { LiveSessionController } from "../src/live/controller";
import type { LiveClientMessage, LiveServerEvent } from "../src/live/protocol";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (cause: unknown) => void } {
	let resolve!: (value: T) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function settle(rounds = 8): Promise<void> {
	for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

function assistant(text: string, stopReason: string): AgentMessage {
	return { role: "assistant", stopReason, testText: text } as unknown as AgentMessage;
}

function agentEnd(
	messages: AgentMessage[],
	flags: { isTerminal?: boolean; hasFinalResponse?: boolean } = {},
): AgentSessionEvent {
	return { type: "agent_end", messages, ...flags } as unknown as AgentSessionEvent;
}

function delegation(id: string, text: string): LiveServerEvent {
	return {
		type: "delegation.created",
		item: { type: "delegation", target: "client", id, content: [{ type: "input_text", text }] },
	};
}

interface Harness {
	controller: LiveSessionController;
	sent: LiveClientMessage[];
	aborts: Array<Record<string, unknown>>;
	prompts: string[];
	fireLive(event: LiveServerEvent): void;
	fireSession(event: AgentSessionEvent): void;
	setStreaming(value: boolean): void;
	nextAbort(): { promise: Promise<void>; resolve: () => void };
	artifactPath: string;
}

function makeHarness(options?: { artifactPath?: string | undefined }): Harness {
	const sent: LiveClientMessage[] = [];
	const aborts: Array<Record<string, unknown>> = [];
	const prompts: string[] = [];
	const abortGates: Array<{ promise: Promise<void>; resolve: () => void }> = [];
	let streaming = false;
	let sessionSubscriber: ((event: AgentSessionEvent) => void) | undefined;
	let liveCallbacks: { onEvent(event: LiveServerEvent): void; onOutputLevel(level: number): void } | undefined;
	const artifactPath =
		options && "artifactPath" in options
			? options.artifactPath
			: join(mkdtempSync(join(tmpdir(), "live-race-")), "t.live-transcript.log");

	const session = {
		modelRegistry: { authStorage: {} },
		sessionId: "live-race-test",
		sessionManager: {
			allocateArtifactPath: async () => (artifactPath ? { id: "t", path: artifactPath } : {}),
		},
		subscribe(callback: (event: AgentSessionEvent) => void) {
			sessionSubscriber = callback;
			return () => {
				sessionSubscriber = undefined;
			};
		},
		get isStreaming() {
			return streaming;
		},
		get isBashRunning() {
			return false;
		},
		get isEvalRunning() {
			return false;
		},
		abort(abortOptions: Record<string, unknown>) {
			aborts.push(abortOptions);
			const gate = deferred();
			abortGates.push(gate);
			streaming = false;
			return gate.promise;
		},
		sendCustomMessage(message: { content: string }) {
			prompts.push(message.content);
			return new Promise(() => {}); // turn stays in flight; tests never need it settled
		},
	} as unknown as AgentSession;

	const controller = new LiveSessionController({
		session,
		callbacks: { onPhase() {}, onLevels() {}, onTranscript() {}, onTerminal() {} },
		extractAssistantText: message => (message as unknown as { testText?: string }).testText ?? "",
		createTransport: transportOptions => {
			liveCallbacks = transportOptions.callbacks;
			return {
				async connect() {},
				async send(message: LiveClientMessage) {
					sent.push(message);
				},
				async close() {},
				async setMuted() {},
				pushAudio() {},
			};
		},
		createRecorder: () => ({ stop() {} }),
	});

	return {
		controller,
		sent,
		aborts,
		prompts,
		fireLive: event => liveCallbacks?.onEvent(event),
		fireSession: event => sessionSubscriber?.(event),
		setStreaming: value => {
			streaming = value;
		},
		nextAbort: () => {
			const gate = abortGates.shift();
			if (!gate) throw new Error("no abort in flight");
			return gate;
		},
		artifactPath: artifactPath ?? "",
	};
}

function finalAppends(sent: LiveClientMessage[]): Array<{ delegation_item_id: string; text: string }> {
	const appends: Array<{ delegation_item_id: string; text: string }> = [];
	for (const message of sent) {
		if (message.type !== "delegation.context.append") continue;
		if (message.channel) continue; // commentary/progress rides its own channel
		const text = message.content.map(item => item.text).join("");
		if (!text.includes("Agent Final Message")) continue;
		appends.push({ delegation_item_id: message.delegation_item_id, text });
	}
	return appends;
}

function speakableTexts(sent: LiveClientMessage[]): string[] {
	const texts: string[] = [];
	for (const message of sent) {
		if (message.type !== "session.context.append" && message.type !== "delegation.context.append") continue;
		if (message.channel !== "speakable") continue;
		texts.push(message.content.map(item => item.text).join(""));
	}
	return texts;
}

describe("live controller delegation ownership", () => {
	it("suppresses the torn-down turn's late aborted settle instead of closing the new delegation", async () => {
		const h = makeHarness();
		await h.controller.start();
		h.setStreaming(true);
		h.fireLive(delegation("dlg-A", "fix the bug"));
		await settle();
		expect(h.aborts).toHaveLength(1);
		expect(h.aborts[0]?.drainSubscribers).toBe(true);
		h.nextAbort().resolve();
		await settle();
		expect(h.prompts).toEqual(["fix the bug"]);

		// The ghost: torn-down turn's terminal settle lands AFTER dlg-A is claimed.
		h.fireSession(agentEnd([assistant("", "aborted")]));
		await settle();

		// The genuine turn's answer must still have a delegation to land on.
		h.fireSession(agentEnd([assistant("the real answer", "stop")]));
		await settle();
		const appends = finalAppends(h.sent);
		expect(appends).toHaveLength(1);
		expect(appends[0]?.delegation_item_id).toBe("dlg-A");
		expect(appends[0]?.text).toContain("the real answer");
	});

	it("merges rapid delegations into one prompt owned by the newest survivor", async () => {
		const h = makeHarness();
		await h.controller.start();
		h.setStreaming(true);
		h.fireLive(delegation("dlg-A", "first thing"));
		await settle();
		h.fireLive(delegation("dlg-B", "second thing"));
		await settle();
		// Coalesced: one real abort for both waiters.
		expect(h.aborts).toHaveLength(1);
		h.nextAbort().resolve();
		await settle();
		expect(h.prompts).toEqual(["first thing\n\nsecond thing"]);

		h.fireSession(agentEnd([assistant("done both", "stop")]));
		await settle();
		const appends = finalAppends(h.sent);
		expect(appends).toHaveLength(1);
		expect(appends[0]?.delegation_item_id).toBe("dlg-B");
	});

	it("closes unconditionally on a genuine empty terminal settle so no stale id lingers", async () => {
		const h = makeHarness();
		await h.controller.start();
		h.fireLive(delegation("dlg-A", "quick question"));
		await settle();
		expect(h.aborts).toHaveLength(0); // idle session: no abort, no suppression token

		// Genuine completion with no extractable text: still closes.
		h.fireSession(agentEnd([assistant("", "stop")]));
		await settle();

		// Later unrelated output must NOT reach the call through a stale id.
		h.fireSession(agentEnd([assistant("stray later output", "stop")]));
		await settle();
		expect(finalAppends(h.sent)).toHaveLength(0);
	});

	it("persists raw transcripts pre-dedupe, in order, and flushes the partial on stop", async () => {
		const h = makeHarness();
		await h.controller.start();
		h.fireLive({ type: "input_transcript.added", item: { text: "hel" } });
		h.fireLive({ type: "turn.done", turn: { role: "user", transcript: "hello" } });
		h.fireLive({ type: "turn.done", turn: { role: "user", transcript: "hello" } }); // exact repeat must survive
		h.fireLive({ type: "turn.done", turn: { role: "assistant", transcript: "hi" } });
		h.fireLive({ type: "input_transcript.added", item: { text: "unfinished thou" } });
		await h.controller.stop();

		const lines = (await readFile(h.artifactPath, "utf8"))
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as { role: string; final: boolean; text: string });
		expect(lines.map(l => [l.role, l.final, l.text])).toEqual([
			["user", false, "hel"],
			["user", true, "hello"],
			["user", true, "hello"],
			["assistant", true, "hi"],
			["user", false, "unfinished thou"],
			["user", false, "unfinished thou"], // stop-time flush of the mid-utterance partial
		]);
	});

	it("relays crew IRC messages onto the speakable channel, attributed and session-scoped", async () => {
		const h = makeHarness();
		await h.controller.start();
		h.fireSession({
			type: "irc_message",
			message: {
				role: "custom",
				customType: "irc:incoming",
				content: "templated wrapper noise",
				display: true,
				details: { id: "m1", from: "Helios", message: "build is green" },
				attribution: "agent",
				timestamp: 1,
			},
		} as unknown as AgentSessionEvent);
		await settle();
		const texts = speakableTexts(h.sent);
		expect(texts).toEqual(["Crew report from Helios: build is green"]);
		// No active delegation: must ride the session-level append, not a stale delegation id.
		expect(h.sent.some(m => m.type === "session.context.append" && m.channel === "speakable")).toBe(true);
	});

	it("narrates in-progress reasoning once per sentence boundary without re-sending", async () => {
		const h = makeHarness();
		await h.controller.start();
		const thinking = "The main agent weighs option one carefully against two. ".repeat(6).trim();
		const update = {
			type: "message_update",
			message: { role: "assistant", content: [{ type: "thinking", thinking }] },
		} as unknown as AgentSessionEvent;
		h.fireSession(update);
		await settle();
		const first = speakableTexts(h.sent);
		expect(first).toHaveLength(1);
		expect(first[0]).toStartWith("Main agent reasoning (live, provisional): The main agent weighs");

		// Same accumulated thinking again: remainder below threshold, nothing re-sent.
		h.fireSession(update);
		await settle();
		expect(speakableTexts(h.sent)).toHaveLength(1);
	});
});
