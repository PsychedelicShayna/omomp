import * as os from "node:os";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AudioCapture } from "@oh-my-pi/pi-natives";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionEvent } from "../session/agent-session-events";
import { LIVE_DELEGATION_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../session/messages";
import agentFinalMessageTemplate from "./prompts/agent-final-message.md" with { type: "text" };
import liveInstructionsTemplate from "./prompts/live-instructions.md" with { type: "text" };
import {
	buildDelegationContextAppend,
	buildSessionClose,
	chunkLiveContext,
	type LiveClientMessage,
	type LiveServerEvent,
} from "./protocol";
import { CodexLiveTransport } from "./transport";
import type { LivePhase } from "./visualizer";
import { DEFAULT_LIVE_VOICE } from "./voices";

const OUTPUT_ACTIVE_LEVEL = 0.015;
const MIN_BARGE_IN_LEVEL = 0.04;
const OUTPUT_ECHO_RATIO = 0.65;

/** Incremental or final transcript for one realtime conversational turn. */
export interface LiveTranscript {
	role: "user" | "assistant";
	text: string;
	/** Monotonic role-local turn number used to coalesce streaming updates. */
	turn: number;
	final: boolean;
}

/** UI notifications emitted during a live session. */
export interface LiveSessionCallbacks {
	/** Reports connection and activity phase changes. */
	onPhase(phase: LivePhase): void;
	/** Reports clamped microphone and speaker RMS levels. */
	onLevels(input: number, output: number): void;
	/** Reports the latest available conversational transcript. */
	onTranscript(transcript: LiveTranscript | undefined): void;
	/** Reports one terminal stop, optionally carrying its cause. */
	onTerminal(error?: Error): void;
}

/** Structural transport surface the controller needs (test seam). */
export type LiveTransportLike = Pick<CodexLiveTransport, "connect" | "send" | "close" | "setMuted" | "pushAudio">;

/** Structural recorder surface the controller needs (test seam). */
export interface LiveRecorderLike {
	stop(): void;
}

/** Dependencies and presentation callbacks for a live session. */
export interface LiveSessionControllerOptions {
	/** Agent session that performs all delegated coding work. */
	session: AgentSession;
	/** UI callbacks for live session state. */
	callbacks: LiveSessionCallbacks;
	/** Extracts visible assistant text using the caller's normal UI rules. */
	extractAssistantText(message: AssistantMessage): string;
	/** Realtime output voice, defaulting to sol. */
	voice?: string;
	/** Test seam: builds the realtime transport; defaults to CodexLiveTransport. */
	createTransport?(options: ConstructorParameters<typeof CodexLiveTransport>[0]): LiveTransportLike;
	/** Test seam: builds the microphone recorder; defaults to the native AudioCapture. */
	createRecorder?(sampleRate: number, callback: (error: Error | null, samples: Float32Array) => void): LiveRecorderLike;
}

function errorFrom(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

function clampLevel(level: number): number {
	if (!Number.isFinite(level) || level <= 0) return 0;
	return Math.min(1, level);
}

function microphoneLevel(samples: Float32Array): number {
	if (samples.length === 0) return 0;
	let sumSquares = 0;
	for (let index = 0; index < samples.length; index += 1) {
		const sample = samples[index] ?? 0;
		sumSquares += sample * sample;
	}
	return clampLevel(Math.sqrt(sumSquares / samples.length));
}

function currentUser(): { username: string; firstName: string } {
	let username = "user";
	try {
		const candidate = os.userInfo().username.trim();
		if (candidate) username = candidate;
	} catch {
		// Sandboxed runtimes may not expose OS account information.
	}
	const firstPart = username.split(/[._\-\s]+/).find(part => part.length > 0);
	return { username, firstName: firstPart ?? "there" };
}

/** How one `agent_end` settle drives the voice relay. */
export interface RelaySettleAction {
	/** Whether this settle carries an answer the relay must speak. */
	relay: boolean;
	/** Whether the delegation is finished and its id may be released. */
	closeDelegation: boolean;
}

/**
 * Classify an `agent_end` settle for the voice relay.
 *
 * A terminal settle ends the delegation and speaks its answer. A non-terminal
 * settle is normally a scheduling pause with no answer yet — but when background
 * async work is the only thing keeping the session alive, the main lane already
 * answered (`hasFinalResponse`). The caller is on a phone call and cannot wait for
 * subagents, so that answer is spoken immediately while the delegation stays open
 * to also relay the answer of the turn a later async delivery wakes.
 */
export function classifyRelaySettle(event: { isTerminal?: boolean; hasFinalResponse?: boolean }): RelaySettleAction {
	if (event.isTerminal !== false) return { relay: true, closeDelegation: true };
	return { relay: event.hasFinalResponse === true, closeDelegation: false };
}

/** Coordinates the realtime conversational surface with normal AgentSession turns. */
export class LiveSessionController {
	readonly #session: AgentSession;
	readonly #callbacks: LiveSessionCallbacks;
	readonly #extractAssistantText: (message: AssistantMessage) => string;
	readonly #voice: string;

	readonly #createTransport: (options: ConstructorParameters<typeof CodexLiveTransport>[0]) => LiveTransportLike;
	readonly #createRecorder: (
		sampleRate: number,
		callback: (error: Error | null, samples: Float32Array) => void,
	) => LiveRecorderLike;
	#transport: LiveTransportLike | undefined;
	#recorder: LiveRecorderLike | undefined;
	#unsubscribeSession: (() => void) | undefined;
	#sendChain: Promise<void> = Promise.resolve();
	#stopPromise: Promise<void> | undefined;
	#started = false;
	#stopped = false;
	#terminalEmitted = false;
	#failure: Error | undefined;
	#muted = false;
	#phase: LivePhase = "connecting";
	#inputLevel = 0;
	#outputLevel = 0;
	#activeDelegationId: string | undefined;
	/**
	 * Last assistant message already relayed for the active delegation. A settle
	 * that pauses for background jobs relays the answer while the delegation stays
	 * open, so the next settle must not repeat an answer the caller already heard.
	 */
	#lastRelayedResponse: AgentMessage | undefined;
	/** Monotonic voice-handoff generation; the newest survivor owns dispatch. */
	#delegationGeneration = 0;
	/** Requests not yet delivered to the backend; merged in arrival order by the newest survivor. */
	#pendingDelegationRequests: string[] = [];
	/** Coalesced in-flight live abort, so rapid handoffs never overlap AgentSession.abort(). */
	#liveAbortPromise: Promise<void> | undefined;
	/**
	 * Expected obsolete aborted settles, one per live-handoff abort. Consumed by
	 * the matching `agent_end` whose assistant message has stopReason "aborted".
	 * Covers the bounded drain's timeout tail: a late settle from the torn-down
	 * turn must not relay into — or close — the newly claimed delegation, which
	 * would leave the genuine answer with nowhere to go.
	 */
	#expectedAbortedSettles = 0;
	/** Serialized persistence tail for the live-transcript artifact (order + no double allocation). */
	#transcriptLogChain: Promise<void> = Promise.resolve();
	/** undefined = not yet allocated; null = permanently unavailable. */
	#transcriptLogPath: string | undefined | null;
	#userTranscript = "";
	#assistantTranscript = "";
	#userTranscriptFinal = false;
	#assistantTranscriptFinal = false;
	#userTranscriptTurn = 0;
	#assistantTranscriptTurn = 0;
	#lastTranscript: LiveTranscript | undefined;

	constructor(options: LiveSessionControllerOptions) {
		this.#session = options.session;
		this.#callbacks = options.callbacks;
		this.#extractAssistantText = options.extractAssistantText;
		this.#voice = options.voice?.trim() || DEFAULT_LIVE_VOICE;
		this.#createTransport = options.createTransport ?? (transportOptions => new CodexLiveTransport(transportOptions));
		this.#createRecorder =
			options.createRecorder ?? ((sampleRate, callback) => new AudioCapture(sampleRate, callback));
	}

	/** Current realtime call phase. */
	get phase(): LivePhase {
		return this.#phase;
	}

	/** Whether microphone input is currently muted. */
	get muted(): boolean {
		return this.#muted;
	}

	/** Connects the realtime surface and starts microphone streaming. */
	async start(): Promise<void> {
		if (this.#stopped) {
			throw (
				this.#failure ?? new Error("This live session has already stopped; create a new controller to reconnect.")
			);
		}
		if (this.#started) return;
		this.#started = true;
		this.#emitPhase("connecting", true);
		this.#emitTranscript(undefined);
		if (this.#stopped) {
			throw this.#failure ?? new Error("The live session stopped while starting.");
		}

		try {
			const user = currentUser();
			const instructions = prompt.render(liveInstructionsTemplate, user);
			const transport = this.#createTransport({
				authStorage: this.#session.modelRegistry.authStorage,
				sessionId: this.#session.sessionId,
				instructions,
				voice: this.#voice,
				callbacks: {
					onEvent: event => this.#guardEvent(() => this.#handleLiveEvent(event)),
					onOutputLevel: level => this.#guardEvent(() => this.#handleOutputLevel(level)),
				},
			});
			this.#transport = transport;
			await transport.connect();
			if (this.#stopped) {
				throw this.#failure ?? new Error("The live session stopped while connecting.");
			}
			this.#unsubscribeSession = this.#session.subscribe(event =>
				this.#guardEvent(() => this.#handleSessionEvent(event)),
			);
			if (this.#muted) await transport.setMuted(true);
			if (this.#stopped) {
				throw this.#failure ?? new Error("The live session stopped before recording began.");
			}
			const recorder = this.#createRecorder(16_000, (error, samples) => {
				if (error) {
					this.#reportFailure(error);
					return;
				}
				this.#handleMicrophoneAudio(samples);
			});
			if (this.#stopped) {
				try {
					recorder.stop();
				} catch {
					// Preserve the failure that stopped startup.
				}
				throw this.#failure ?? new Error("The live session stopped while recording began.");
			}
			this.#recorder = recorder;
			this.#refreshAudioPhase();
		} catch (cause) {
			const error = errorFrom(cause);
			this.#reportFailure(error);
			await this.stop();
			throw error;
		}
	}

	/** Toggles microphone capture while leaving output and the session connected. */
	toggleMute(): void {
		if (this.#stopped) return;
		this.#muted = !this.#muted;
		if (this.#muted) {
			this.#inputLevel = 0;
			this.#emitLevels();
		}
		this.#refreshAudioPhase();
		const transport = this.#transport;
		if (transport) {
			void transport.setMuted(this.#muted).catch(cause => this.#reportFailure(errorFrom(cause)));
		}
	}

	/** Stops recording, closes the live session, and emits one terminal callback. */
	stop(): Promise<void> {
		if (!this.#stopPromise) this.#stopPromise = this.#stop();
		return this.#stopPromise;
	}

	async #stop(): Promise<void> {
		this.#stopped = true;
		this.#unsubscribeSession?.();
		this.#unsubscribeSession = undefined;
		// Flush a mid-utterance user transcript (VAD-split or aborted turn) so the
		// literal every-utterance guarantee covers interrupted speech, then drain
		// pending transcript writes before teardown.
		if (this.#userTranscript && !this.#userTranscriptFinal) {
			this.#recordLiveTranscript("user", this.#userTranscript, false);
		}
		await this.#transcriptLogChain;
		let cleanupError: Error | undefined;

		const recorder = this.#recorder;
		this.#recorder = undefined;
		if (recorder) {
			try {
				recorder.stop();
			} catch (cause) {
				cleanupError = errorFrom(cause);
			}
		}

		await this.#sendChain;
		const transport = this.#transport;
		this.#transport = undefined;
		if (transport) {
			try {
				await transport.send(buildSessionClose());
			} catch (cause) {
				cleanupError ??= errorFrom(cause);
			}
			try {
				await transport.close();
			} catch (cause) {
				cleanupError ??= errorFrom(cause);
			}
		}

		if (cleanupError) this.#emitPhaseSafely("error");
		this.#emitTerminal(cleanupError);
	}

	#guardEvent(handler: () => void): void {
		if (this.#stopped) return;
		try {
			handler();
		} catch (cause) {
			this.#reportFailure(errorFrom(cause));
		}
	}

	#handleLiveEvent(event: LiveServerEvent): void {
		switch (event.type) {
			case "session.started":
				this.#emitPhase("listening");
				break;
			case "session.updated":
			case "output_audio.delta":
			case "unknown":
				break;
			case "input_transcript.added":
				this.#recordLiveTranscript("user", event.item.text, false);
				this.#addTranscript("user", event.item.text);
				break;
			case "output_transcript.added":
				this.#addTranscript("assistant", event.item.text);
				break;
			case "turn.done":
				this.#recordLiveTranscript(event.turn.role, event.turn.transcript, true);
				this.#finishTranscript(event.turn.role, event.turn.transcript);
				break;
			case "delegation.created":
				void this.#handleDelegation(event).catch(cause => this.#reportFailure(errorFrom(cause)));
				break;
			case "error":
				this.#reportFailure(new Error(event.message));
				break;
		}
	}

	/**
	 * Deliver a Codex Realtime coding handoff to the main agent session.
	 * Newest intent wins: every delegation bumps a generation; whatever is still
	 * unsent when a newer one arrives is merged, in arrival order, into the
	 * newest survivor's single prompt. This is the committed voice contract
	 * (live-instructions.md): split consecutive turns merge before delegation,
	 * while a request arriving during active work barges in immediately.
	 */
	async #handleDelegation(event: Extract<LiveServerEvent, { type: "delegation.created" }>): Promise<void> {
		let request = "";
		for (const content of event.item.content) {
			if (content.type !== "input_text") continue;
			request += `${request ? "\n" : ""}${content.text}`;
		}
		request = request.trim();
		if (!request) return;

		const generation = ++this.#delegationGeneration;
		this.#pendingDelegationRequests.push(request);
		this.#emitPhase("working");
		if (this.#session.isStreaming || this.#session.isBashRunning || this.#session.isEvalRunning) {
			// Coalesce concurrent live aborts: AgentSession.abort() is not
			// reentrant-safe, and every waiter only needs "some abort finished
			// after I arrived". One expected settle per real abort, not per waiter.
			if (!this.#liveAbortPromise) {
				this.#expectedAbortedSettles += 1;
				this.#liveAbortPromise = this.#session
					.abort({ reason: USER_INTERRUPT_LABEL, drainSubscribers: true })
					.finally(() => {
						this.#liveAbortPromise = undefined;
					});
			}
			await this.#liveAbortPromise;
		}
		if (this.#stopped) return;
		// Superseded while awaiting: leave our request in the accumulator for the
		// newest survivor to merge, and do nothing else — no claim, no dispatch.
		if (generation !== this.#delegationGeneration) return;

		const merged = this.#pendingDelegationRequests.splice(0).join("\n\n").trim();
		if (!merged) return;
		this.#activeDelegationId = event.item.id;
		this.#lastRelayedResponse = undefined;
		try {
			await this.#session.sendCustomMessage(
				{
					customType: LIVE_DELEGATION_MESSAGE_TYPE,
					content: merged,
					display: true,
					attribution: "agent",
				},
				{ triggerTurn: true },
			);
		} catch (cause) {
			// A newer delegation barging in aborts this turn mid-await; that
			// rejection is expected and must not kill the live call.
			if (generation === this.#delegationGeneration) throw cause;
		}
	}

	#handleSessionEvent(event: AgentSessionEvent): void {
		if (event.type === "message_end" && event.message.role === "assistant") {
			if (event.message.stopReason === "toolUse") this.#appendProgress(event.message);
			return;
		}
		if (event.type !== "agent_end") return;
		// Expected obsolete settle from a live-handoff abort: agent-core emits a
		// fresh empty assistant message with stopReason "aborted" for a deliberate
		// abort. Consume the token and ignore the settle entirely — relaying would
		// be empty and closing would retire the delegation the NEW turn owns. All
		// other terminal settles (including genuinely empty completions) keep
		// closing unconditionally so a stale delegation id can never route later
		// unrelated output into the voice call.
		if (this.#expectedAbortedSettles > 0) {
			const settled = [...event.messages].reverse().find(message => message?.role === "assistant");
			if (settled?.role === "assistant" && settled.stopReason === "aborted") {
				this.#expectedAbortedSettles -= 1;
				return;
			}
		}
		const { relay, closeDelegation } = classifyRelaySettle(event);
		if (!relay) return;
		this.#appendFinalResponse(event.messages, { closeDelegation });
	}

	#appendProgress(message: AssistantMessage): void {
		const delegationId = this.#activeDelegationId;
		if (!delegationId) return;
		const progress = this.#extractAssistantText(message).trim();
		if (!progress) return;
		for (const chunk of chunkLiveContext(progress)) {
			this.#queueSend(buildDelegationContextAppend(delegationId, chunk, "commentary"));
		}
	}

	#appendFinalResponse(messages: readonly AgentMessage[], options: { closeDelegation: boolean }): void {
		const delegationId = this.#activeDelegationId;
		if (!delegationId) return;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message?.role !== "assistant") continue;
			// Already relayed at an earlier pause: a wake that produced no new answer
			// must not make the relay repeat itself.
			if (message === this.#lastRelayedResponse) break;
			const text = this.#extractAssistantText(message).trim();
			if (!text) continue;
			this.#lastRelayedResponse = message;
			const finalContext = prompt.render(agentFinalMessageTemplate, { message: text });
			for (const chunk of chunkLiveContext(finalContext)) {
				this.#queueSend(buildDelegationContextAppend(delegationId, chunk));
			}
			break;
		}
		if (options.closeDelegation) {
			this.#activeDelegationId = undefined;
			this.#lastRelayedResponse = undefined;
		}
		this.#refreshAudioPhase();
	}

	#handleOutputLevel(level: number): void {
		this.#outputLevel = clampLevel(level);
		this.#emitLevels();
		if (!this.#activeDelegationId) this.#refreshAudioPhase();
	}

	#handleMicrophoneAudio(samples: Float32Array): void {
		if (this.#stopped || !this.#transport) return;
		if (this.#muted) return;
		this.#inputLevel = microphoneLevel(samples);
		this.#emitLevels();
		const outputActive = this.#outputLevel > OUTPUT_ACTIVE_LEVEL;
		const echoThreshold = Math.max(MIN_BARGE_IN_LEVEL, this.#outputLevel * OUTPUT_ECHO_RATIO);
		if (outputActive && this.#inputLevel < echoThreshold) return;
		try {
			this.#transport.pushAudio(samples);
		} catch (cause) {
			this.#reportFailure(errorFrom(cause));
		}
	}

	#addTranscript(role: LiveTranscript["role"], text: string): void {
		if (!text) return;
		const current = role === "user" ? this.#userTranscript : this.#assistantTranscript;
		const wasFinal = role === "user" ? this.#userTranscriptFinal : this.#assistantTranscriptFinal;
		let next: string;
		if (!current) {
			this.#startTranscriptTurn(role);
			next = text;
		} else if (wasFinal) {
			if (text === current || current.endsWith(text)) return;
			this.#startTranscriptTurn(role);
			next = text;
		} else if (text.startsWith(current)) {
			next = text;
		} else if (current.endsWith(text)) {
			next = current;
		} else {
			next = current + text;
		}
		this.#storeTranscript(role, next, false);
	}

	#finishTranscript(role: LiveTranscript["role"], text: string): void {
		if (!text) return;
		const current = role === "user" ? this.#userTranscript : this.#assistantTranscript;
		const wasFinal = role === "user" ? this.#userTranscriptFinal : this.#assistantTranscriptFinal;
		if (!current) {
			this.#startTranscriptTurn(role);
		} else if (wasFinal) {
			if (text === current) return;
			this.#startTranscriptTurn(role);
		}
		const next = !wasFinal && current.startsWith(text) && current.length > text.length ? current : text;
		this.#storeTranscript(role, next, true);
	}

	#startTranscriptTurn(role: LiveTranscript["role"]): void {
		if (role === "user") {
			this.#userTranscriptTurn += 1;
		} else {
			this.#assistantTranscriptTurn += 1;
		}
	}

	#storeTranscript(role: LiveTranscript["role"], text: string, final: boolean): void {
		const normalized = text.trim();
		if (!normalized) return;
		const turn = role === "user" ? this.#userTranscriptTurn : this.#assistantTranscriptTurn;
		if (role === "user") {
			this.#userTranscript = normalized;
			this.#userTranscriptFinal = final;
		} else {
			this.#assistantTranscript = normalized;
			this.#assistantTranscriptFinal = final;
		}
		if (
			this.#lastTranscript?.role === role &&
			this.#lastTranscript.turn === turn &&
			this.#lastTranscript.text === normalized &&
			this.#lastTranscript.final === final
		) {
			return;
		}
		this.#emitTranscript({ role, turn, text: normalized, final });
	}

	/**
	 * Persist one raw transcript line to the session-scoped live-transcript
	 * artifact. Recorded BEFORE UI dedupe on purpose: repeated identical
	 * utterances and VAD-split fragments must all survive — the point of this
	 * buffer is recovering utterances the voice model consumed. Serialized on a
	 * single promise tail (ordering + no double allocation); never fatal to the
	 * call; transcript text never appears in error logs (PII).
	 */
	#recordLiveTranscript(role: LiveTranscript["role"], text: string, final: boolean): void {
		if (!text.trim()) return;
		const line = JSON.stringify({ ts: new Date().toISOString(), role, final, text });
		this.#transcriptLogChain = this.#transcriptLogChain
			.then(() => this.#appendTranscriptLine(line))
			.catch(error => {
				logger.warn("Live transcript persistence failed", { error: String(error) });
			});
	}

	async #appendTranscriptLine(line: string): Promise<void> {
		if (this.#transcriptLogPath === null) return;
		if (this.#transcriptLogPath === undefined) {
			const allocated = await this.#session.sessionManager.allocateArtifactPath("live-transcript");
			if (allocated.path) {
				this.#transcriptLogPath = allocated.path;
				logger.info("Live transcript artifact allocated", { id: allocated.id, path: allocated.path });
			} else {
				// Unpersisted session: keep the guarantee with a private tmp file
				// (0600, wiped with tmp) rather than silently dropping utterances —
				// but never a durable home-directory copy (voice transcripts are PII).
				const fallback = join(os.tmpdir(), `omp-live-transcript-${Date.now()}.jsonl`);
				this.#transcriptLogPath = fallback;
				logger.warn("Session has no artifact store; live transcript using tmp fallback", { path: fallback });
			}
		}
		await appendFile(this.#transcriptLogPath, `${line}\n`, { mode: 0o600 });
	}

	#queueSend(message: LiveClientMessage): void {
		const transport = this.#transport;
		if (!transport || this.#stopped) return;
		this.#sendChain = this.#sendChain
			.then(async () => {
				if (!this.#stopped) await transport.send(message);
			})
			.catch(cause => this.#reportFailure(errorFrom(cause)));
	}

	#refreshAudioPhase(): void {
		if (this.#stopped) return;
		if (this.#muted) {
			this.#emitPhase("muted");
		} else if (this.#activeDelegationId) {
			this.#emitPhase("working");
		} else if (this.#outputLevel > OUTPUT_ACTIVE_LEVEL) {
			this.#emitPhase("speaking");
		} else {
			this.#emitPhase("listening");
		}
	}

	#emitPhase(phase: LivePhase, force = false): void {
		if (!force && this.#phase === phase) return;
		this.#phase = phase;
		try {
			this.#callbacks.onPhase(phase);
		} catch (cause) {
			this.#reportFailure(errorFrom(cause));
		}
	}

	#emitPhaseSafely(phase: LivePhase): void {
		this.#phase = phase;
		try {
			this.#callbacks.onPhase(phase);
		} catch {
			// Terminal callback is the final error boundary for UI failures.
		}
	}

	#emitLevels(): void {
		try {
			this.#callbacks.onLevels(this.#inputLevel, this.#outputLevel);
		} catch (cause) {
			this.#reportFailure(errorFrom(cause));
		}
	}

	#emitTranscript(transcript: LiveTranscript | undefined): void {
		this.#lastTranscript = transcript;
		try {
			this.#callbacks.onTranscript(transcript);
		} catch (cause) {
			this.#reportFailure(errorFrom(cause));
		}
	}

	#reportFailure(error: Error): void {
		if (this.#terminalEmitted) return;
		this.#failure = error;
		this.#emitPhaseSafely("error");
		this.#emitTerminal(error);
		void this.stop();
	}

	#emitTerminal(error?: Error): void {
		if (this.#terminalEmitted) return;
		this.#terminalEmitted = true;
		try {
			this.#callbacks.onTerminal(error);
		} catch {
			// Nothing remains above the terminal callback to receive its error.
		}
	}
}
