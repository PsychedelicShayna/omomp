/**
 * Serialized session Chronicler runtime.
 *
 * One background owner per host session. A synchronous scheduler freezes a
 * session descriptor and the message-entry snapshot, then appends a request to
 * one serialized async work chain; every attempt closes over that frozen
 * descriptor plus its own store, batch, tools, and Agent, so no completion can
 * resolve a newly selected session's store or artifacts root. A generation
 * token revokes an old attempt — synchronously, including its uncommitted batch
 * — on disable, rebind, model config change, or shutdown deadline.
 *
 * This owns capture only: it never advises the primary, injects recall, or
 * touches the memory backend. It reuses the Agent construction and role/effort
 * helpers established for advisors, but none of their message-count cursor or
 * advice machinery.
 */
import { Agent, type AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { estimateTranscriptTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { Api, Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { AdvisorTranscriptRecorder, deriveAdvisorTelemetry } from "../advisor";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelString, resolveChroniclerRoleSelection } from "../config/model-resolver";
import type { SettingPath, Settings } from "../config/settings";
import { estimateToolSchemaTokens } from "../modes/utils/context-usage";
import contextTemplate from "../prompts/chronicler/context.md" with { type: "text" };
import systemTemplate from "../prompts/chronicler/system.md" with { type: "text" };
import type { SecretObfuscator } from "../secrets/obfuscator";
import type { SessionMessageEntry } from "../session/session-entries";
import type { SessionManager } from "../session/session-manager";
import { sameMessageContent, sessionMessagePersistenceKey } from "../session/turn-persistence";
import {
	concreteThinkingLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "../thinking";
import { CHRONICLER_TOOL_SCHEMAS, ChronicleTool, FinishChronicleTool, ReadChronicleTool } from "./chronicle-tool";
import type { ChronicleEntry } from "./render";
import { renderChronicleDelta } from "./render";
import { type CaptureBatch, type CaptureSource, ChroniclerStore, isChroniclerCorruption } from "./store";

/**
 * Host seam the runtime binds against. The two persistence-order callbacks and
 * `isCaptureEligible` are wired by {@link AgentSession}; everything else mirrors
 * the advisor host surface.
 */
export interface SessionChroniclerHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	modelRegistry: ModelRegistry;
	obfuscator: SecretObfuscator | undefined;
	providerSessionState: Map<string, ProviderSessionState>;
	preferWebsockets: boolean | undefined;
	isDisposed(): boolean;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	cwd(): string;
	/** True only for a capturable top-level session (SDK taskDepth 0, no parentTaskPrefix). */
	isCaptureEligible(): boolean;
}

type ChroniclerStatus = "off" | "no_model" | "running" | "halted";

interface RoleSelection {
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	modelString: string;
}

/** Session identity frozen at scheduling time; never re-read from the live manager. */
interface SessionDescriptor {
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly artifactsDir: string;
	readonly cwd: string;
}

/** One scheduled wake: frozen descriptor plus the entry snapshot taken with it. */
interface ScheduledScan {
	readonly gen: number;
	readonly descriptor: SessionDescriptor;
	readonly entries: readonly ChronicleEntry[];
	readonly entryIds: ReadonlySet<string>;
	forceFlush: boolean;
}

/**
 * A bound writer. The Agent is retained across passes so a successful pass keeps
 * its model context; it is rebuilt only under budget pressure or after a failed
 * attempt. Nothing here is re-derived from the live SessionManager.
 */
interface ChroniclerBinding {
	readonly gen: number;
	readonly descriptor: SessionDescriptor;
	readonly store: ChroniclerStore;
	readonly recorder: AdvisorTranscriptRecorder;
	readonly model: Model<Api>;
	readonly modelString: string;
	readonly thinkingLevel: ThinkingLevel;
	readonly systemText: string;
	readonly agent: Agent;
	readonly agentUnsubscribe: () => void;
}

interface PendingRendezvous {
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly message: AgentMessage;
	readonly gen: number;
	readonly willContinue: boolean | undefined;
}

type PrefixSelection = { kind: "ok"; entries: readonly ChronicleEntry[]; requestText: string } | { kind: "oversized" };

type AttemptOutcome =
	| { kind: "committed" }
	| { kind: "revoked" }
	| { kind: "failed"; error: string }
	| { kind: "corruption"; error: string };

/** Chronicler model transcript, recorded per binding beneath the session dir. */
const RECORDER_FILENAME = "chronicler/__chronicler.jsonl";
/** At most this many unseen entries materialize into one capture pass. */
const MAX_PREFIX_ENTRIES = 60;
/** At most this many committed beats are listed in the framing before trimming. */
const MAX_BEAT_LISTING = 200;
/** willContinue-true wakes defer until this many unseen serialized chars accrue. */
const UNSEEN_FLUSH_CHARS = 80_000;
/** Generic working budget when the model reports no usable context window. */
const GENERIC_BUDGET_TOKENS = 32_000;
/** Fraction of a known positive context window a capture pass may fill. */
const CONTEXT_BUDGET_FRACTION = 0.7;
/** Consecutive failed attempts on one prefix before capture halts. */
const MAX_CONSECUTIVE_FAILURES = 3;
/** Backoff before each retry of the same unseen prefix. */
const RETRY_BACKOFF_MS = [2_000, 4_000];
/** Default drain deadline for model work at shutdown. */
const DEFAULT_DRAIN_MS = 20_000;
/** Recent persisted-message identities kept for the turn-end rendezvous. */
const SETTLED_KEY_LIMIT = 32;

export class SessionChronicler {
	readonly #host: SessionChroniclerHost;

	#generation = 0;
	#status: ChroniclerStatus = "off";
	#stopping = false;
	#cleanedUp = false;
	#deadlineExpired = false;
	#deadlineSignal = Promise.withResolvers<void>();
	#scheduledDescriptor: SessionDescriptor | undefined;

	#chain: Promise<void> = Promise.resolve();
	#scanQueued = false;
	#pendingScan: ScheduledScan | undefined;

	#binding: ChroniclerBinding | undefined;
	/** The only uncommitted batch that may exist; revoked synchronously on any fence. */
	#activeBatch: CaptureBatch | undefined;

	#settingsUnsub: (() => void) | undefined;
	#noModelWarned: string | undefined;

	/** Recent persisted-message identities: cloned assistants break object identity. */
	#settled = new Map<string, AgentMessage[]>();
	#pendingRendezvous: PendingRendezvous | undefined;

	constructor(host: SessionChroniclerHost) {
		this.#host = host;
		this.#settingsUnsub = host.settings.onEffectiveChange(path => this.#onSettingChange(path));
		// An idle resumed on-disk session must catch up its backlog without
		// requiring another user turn, so scan once at construction.
		this.#scheduleWake(true);
	}

	get status(): ChroniclerStatus {
		return this.#status;
	}

	/**
	 * The primary finished a turn. Schedules a capture wake; when `lastMessage`
	 * is supplied the wake parks until that message's persistence settles, so the
	 * frozen snapshot includes it. Model work is never awaited here.
	 */
	onPrimaryTurnEnd(willContinue: boolean | undefined, lastMessage?: AgentMessage): void {
		if (!this.#enabled() || !this.#host.isCaptureEligible()) return;
		if (this.#stopping || this.#cleanedUp || this.#host.isDisposed()) return;
		this.#fenceSessionChange();
		// A new turn end supersedes any earlier park: a stale generation's
		// persistence may never notify, and a dangling park must not linger.
		this.#pendingRendezvous = undefined;
		if (lastMessage) {
			const key = sessionMessagePersistenceKey(lastMessage);
			if (key && !this.#isSettled(lastMessage)) {
				this.#pendingRendezvous = {
					message: lastMessage,
					gen: this.#generation,
					willContinue,
					sessionId: this.#host.sessionManager.getSessionId(),
					sessionFile: this.#host.sessionManager.getSessionFile(),
				};
				return;
			}
		}
		this.#scheduleWake(willContinue !== true);
	}

	/**
	 * Existing session persistence completed for one message (including entries
	 * intentionally skipped by the primary path). Records the settled identity,
	 * materializes a durable root for a first-turn user intention, and resolves a
	 * parked turn-end wake. Never scans or copies `getEntries()` on its own.
	 */
	onPrimaryMessagePersisted(message: AgentMessage): void {
		if (!this.#enabled() || !this.#host.isCaptureEligible()) return;
		if (this.#stopping || this.#cleanedUp || this.#host.isDisposed()) return;
		this.#fenceSessionChange();
		this.#recordSettled(message);
		if (message.role === "user") this.#maybeEnsureOnDisk();

		const pending = this.#pendingRendezvous;
		if (
			pending &&
			pending.gen === this.#generation &&
			pending.sessionId === this.#host.sessionManager.getSessionId() &&
			pending.sessionFile === this.#host.sessionManager.getSessionFile() &&
			this.#messagesMatch(pending.message, message)
		) {
			this.#pendingRendezvous = undefined;
			this.#scheduleWake(pending.willContinue !== true);
		}
	}

	/**
	 * Snapshot still-unseen work and schedule a final flush, then reject further
	 * scheduling even though the host is disposed. Idempotent; a disabled runtime
	 * stays off (the enable gate still applies inside the scan).
	 */
	beginStop(): void {
		if (this.#stopping) return;
		this.#pendingRendezvous = undefined;
		this.#scheduleWake(true, true);
		this.#stopping = true;
	}

	/**
	 * Wait for the owner chain to settle, then release ownership. The deadline
	 * bounds model work: at expiry every attempt is fenced and the model aborted,
	 * and the only remaining wait is an already-started publication, so a provider
	 * that ignores its abort cannot extend shutdown.
	 */
	async drain(timeoutMs: number = DEFAULT_DRAIN_MS): Promise<void> {
		this.beginStop();

		const deadline = Promise.withResolvers<void>();
		const timer = setTimeout(() => deadline.resolve(), Math.max(0, timeoutMs));
		let settledInTime: boolean;
		try {
			settledInTime = await Promise.race([
				this.#chain.then(
					() => true,
					() => true,
				),
				deadline.promise.then(() => false),
			]);
		} finally {
			clearTimeout(timer);
		}

		if (!settledInTime) {
			this.#deadlineExpired = true;
			this.#deadlineSignal.resolve();
			this.#pendingScan = undefined;
			this.#revokeNow("chronicler drain deadline");
		}
		// Only the shutdown deadline can release an unsettled model prompt.
		// Publication and recorder writes stay owned until they settle.
		await this.#chain;
		await this.#cleanup();
	}

	// ---- scheduling -------------------------------------------------------

	/**
	 * Freeze the session descriptor and message-entry snapshot synchronously, then
	 * queue one serialized scan. Redundant wakes collapse onto the freshest
	 * snapshot; nothing downstream re-reads the live manager for identity.
	 */
	#scheduleWake(forceFlush: boolean, bypassStop = false): void {
		if (this.#deadlineExpired || this.#cleanedUp) return;
		if ((this.#stopping || this.#host.isDisposed()) && !bypassStop) return;
		if (!this.#enabled()) return;
		if (!this.#host.isCaptureEligible()) return;

		const manager = this.#host.sessionManager;
		const sessionFile = manager.getSessionFile();
		const artifactsDir = manager.getArtifactsDir();
		// No allocated file or root means a truly in-memory session: skip until a
		// later wake rather than invent a fake artifacts root.
		if (!sessionFile || !artifactsDir) return;

		const descriptor: SessionDescriptor = Object.freeze({
			sessionId: manager.getSessionId(),
			sessionFile,
			artifactsDir,
			cwd: this.#host.cwd(),
		});

		const previous = this.#scheduledDescriptor;
		if (previous && !this.#sameDescriptor(previous, descriptor)) {
			this.#revokeNow("chronicler session changed");
			this.#status = "off";
			this.#settled.clear();
		}
		this.#scheduledDescriptor = descriptor;

		const entries: ChronicleEntry[] = [];
		const entryIds = new Set<string>();
		for (const entry of manager.getEntries()) {
			if (entry.type !== "message") continue;
			const message = entry as SessionMessageEntry;
			entries.push({
				id: message.id,
				parentId: message.parentId,
				timestamp: message.timestamp,
				message: message.message,
			});
			entryIds.add(message.id);
		}

		this.#pendingScan = {
			gen: this.#generation,
			descriptor,
			entries,
			entryIds,
			forceFlush: forceFlush || (this.#pendingScan?.gen === this.#generation && this.#pendingScan.forceFlush),
		};

		if (this.#scanQueued) return;
		this.#scanQueued = true;
		this.#chain = this.#chain
			.then(() => this.#runScan())
			.catch(error => {
				logger.warn("Chronicler scan chain failed", { error: String(error) });
			});
	}

	#onSettingChange(path: SettingPath): void {
		if (path !== "chronicler.enabled" && path !== "modelRoles" && !path.startsWith("modelRoles.")) return;
		if (this.#cleanedUp || this.#deadlineExpired) return;
		// Reopen canonical committed state on configuration changes, including a
		// corruption halt: strict store validation will halt again if it persists.
		if (this.#status === "halted") {
			this.#status = "off";
		}
		if (!this.#enabled()) {
			this.#status = "off";
		}
		this.#revokeNow("chronicler settings change");
		if (!this.#enabled()) {
			this.#pendingScan = undefined;
			this.#chain = this.#chain
				.then(() => {
					if (!this.#enabled()) return this.#disableBinding();
				})
				.catch(error => {
					logger.warn("Chronicler disable failed", { error: String(error) });
				});
		}
		this.#settled.clear();
		this.#scheduleWake(true);
	}

	/**
	 * Synchronously fence everything in flight: bump the generation, revoke the
	 * single uncommitted batch so a publication cannot slip past its pre-rename
	 * check. Ordinary revocation lets the in-flight provider settle; only the
	 * terminal deadline aborts its Agent. A committed batch is never revoked.
	 */
	#revokeNow(reason: string): void {
		this.#generation++;
		const batch = this.#activeBatch;
		if (batch && !Object.isFrozen(batch)) batch.revoked = true;
		if (this.#deadlineExpired) this.#binding?.agent.abort(reason);
		this.#pendingRendezvous = undefined;
	}

	// ---- persistence rendezvous ------------------------------------------

	#fenceSessionChange(): void {
		const previous = this.#scheduledDescriptor;
		const manager = this.#host.sessionManager;
		if (
			previous &&
			(previous.sessionId !== manager.getSessionId() ||
				previous.sessionFile !== manager.getSessionFile() ||
				previous.artifactsDir !== manager.getArtifactsDir() ||
				previous.cwd !== this.#host.cwd())
		) {
			this.#revokeNow("chronicler session changed");
			this.#status = "off";
			this.#scheduledDescriptor = undefined;
			this.#pendingScan = undefined;
			this.#settled.clear();
		}
	}

	#settledKey(message: AgentMessage): string | undefined {
		const key = sessionMessagePersistenceKey(message);
		return key === undefined
			? undefined
			: JSON.stringify([
					this.#generation,
					this.#host.sessionManager.getSessionId(),
					this.#host.sessionManager.getSessionFile(),
					key,
				]);
	}

	#recordSettled(message: AgentMessage): void {
		const key = this.#settledKey(message);
		if (!key) return;
		const existing = this.#settled.get(key);
		if (existing) {
			existing.push(message);
			return;
		}
		this.#settled.set(key, [message]);
		while (this.#settled.size > SETTLED_KEY_LIMIT) {
			const oldest = this.#settled.keys().next().value;
			if (oldest === undefined) break;
			this.#settled.delete(oldest);
		}
	}

	#isSettled(message: AgentMessage): boolean {
		const key = this.#settledKey(message);
		if (!key) return false;
		const seen = this.#settled.get(key);
		return seen?.some(candidate => sameMessageContent(candidate, message)) ?? false;
	}

	#messagesMatch(a: AgentMessage, b: AgentMessage): boolean {
		const key = sessionMessagePersistenceKey(a);
		return key !== undefined && key === sessionMessagePersistenceKey(b) && sameMessageContent(a, b);
	}

	/**
	 * Persistence is lazy, so a first-turn user intention can exist with no file
	 * even though its path is allocated. Materialize it against a frozen
	 * descriptor, rechecked immediately before the call.
	 */
	#maybeEnsureOnDisk(): void {
		if (this.#stopping || this.#cleanedUp || this.#host.isDisposed()) return;
		if (!this.#host.isCaptureEligible() || !this.#enabled()) return;
		const manager = this.#host.sessionManager;
		const frozenFile = manager.getSessionFile();
		const frozenId = manager.getSessionId();
		// Only a session with an allocated file may be materialized: never invent
		// a fake artifacts root for an in-memory session.
		if (!frozenFile || manager.isSessionOnDisk()) return;
		this.#chain = this.#chain
			.then(async () => {
				if (manager.getSessionFile() !== frozenFile || manager.getSessionId() !== frozenId) return;
				if (manager.isSessionOnDisk()) return;
				await manager.ensureOnDisk();
			})
			.catch(error => {
				logger.debug("Chronicler ensureOnDisk failed", { error: String(error) });
			});
	}

	// ---- scan -------------------------------------------------------------

	#enabled(): boolean {
		return this.#host.settings.get("chronicler.enabled") === true;
	}

	async #runScan(): Promise<void> {
		this.#scanQueued = false;
		const scan = this.#pendingScan;
		this.#pendingScan = undefined;
		if (!scan) return;

		const gen = scan.gen;
		if (this.#deadlineExpired || this.#cleanedUp || gen !== this.#generation) return;
		if (!this.#host.isCaptureEligible()) return;
		if (this.#status === "halted") return;

		if (!this.#enabled()) {
			await this.#disableBinding();
			return;
		}

		const selection = this.#resolveSelection();
		if (!selection) {
			this.#status = "no_model";
			const unresolved = JSON.stringify(this.#host.settings.get("modelRoles") ?? null);
			if (this.#noModelWarned !== unresolved) {
				this.#noModelWarned = unresolved;
				this.#host.emitNotice(
					"warning",
					"Chronicler enabled but no model resolved for the chronicler role",
					"chronicler",
				);
			}
			return;
		}
		this.#noModelWarned = undefined;

		if (!(await this.#materialize(scan.descriptor, gen))) return;

		let binding: ChroniclerBinding | undefined;
		try {
			binding = await this.#ensureBinding(scan.descriptor, selection);
		} catch (error) {
			if (this.#generation === gen) this.#handleBindingError(error);
			return;
		}
		if (!binding || this.#generation !== binding.gen) return;
		this.#status = "running";

		await this.#drainBacklog(binding, scan);
	}

	/**
	 * Force the frozen session onto disk when persistence has not yet fired.
	 * Returns false when the wake was fenced or the host moved off this session
	 * across the await.
	 */
	async #materialize(descriptor: SessionDescriptor, gen: number): Promise<boolean> {
		const manager = this.#host.sessionManager;
		const stillCurrent = () =>
			this.#generation === gen &&
			!this.#deadlineExpired &&
			manager.getSessionFile() === descriptor.sessionFile &&
			manager.getSessionId() === descriptor.sessionId;
		if (!stillCurrent()) return false;
		try {
			await manager.ensureOnDisk();
			if (!stillCurrent() || !manager.isSessionOnDisk()) return false;
			await manager.flush();
			return stillCurrent() && manager.isSessionOnDisk();
		} catch (error) {
			logger.debug("Chronicler transcript durability deferred", { error: String(error) });
			return false;
		}
	}

	/**
	 * Capture the frozen snapshot's backlog in bounded passes until nothing
	 * remains or the wake defers. Each pass recomputes unseen from the committed
	 * union, so a committed pass strictly shrinks the remaining work.
	 */
	async #drainBacklog(binding: ChroniclerBinding, scan: ScheduledScan): Promise<void> {
		while (this.#generation === binding.gen) {
			const processed = binding.store.processedEntryIds;
			const unseen = scan.entries.filter(entry => !processed.has(entry.id));
			if (unseen.length === 0) return;

			if (!scan.forceFlush && this.#serializedChars(unseen) < UNSEEN_FLUSH_CHARS) return;

			const outcome = await this.#capturePass(binding, unseen, scan.entryIds);
			if (outcome !== "committed") return;
		}
	}

	#serializedChars(entries: readonly ChronicleEntry[]): number {
		let total = 0;
		for (const entry of entries) total += JSON.stringify(entry.message).length;
		return total;
	}

	// ---- one capture pass -------------------------------------------------

	async #capturePass(
		binding: ChroniclerBinding,
		unseen: readonly ChronicleEntry[],
		ownedIds: ReadonlySet<string>,
	): Promise<"committed" | "revoked" | "halted"> {
		const selected = this.#selectPrefix(binding, unseen, ownedIds);
		if (selected.kind === "oversized") {
			this.#status = "halted";
			this.#host.emitNotice(
				"warning",
				"Chronicler capture paused: one transcript entry exceeds the capture input budget; no entries were skipped.",
				"chronicler",
			);
			return "halted";
		}

		let attempt = 0;
		while (true) {
			if (this.#generation !== binding.gen) return "revoked";

			const outcome = await this.#runAttempt(binding, selected.entries, selected.requestText);
			if (outcome.kind === "committed") return "committed";
			if (outcome.kind === "revoked") return "revoked";
			if (outcome.kind === "corruption") {
				this.#status = "halted";
				this.#host.emitNotice("warning", `Chronicler capture halted: ${outcome.error}`, "chronicler");
				return "halted";
			}

			attempt += 1;
			if (attempt >= MAX_CONSECUTIVE_FAILURES) {
				this.#status = "halted";
				this.#host.emitNotice(
					"warning",
					`Chronicler capture paused after repeated failures: ${outcome.error}`,
					"chronicler",
				);
				return "halted";
			}
			// A failed attempt is never retained as if committed: rebuild the model
			// conversation from committed framing before retrying the same prefix.
			this.#rebuildConversation(binding);
			const backoff = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)];
			if (!(await this.#sleep(backoff, binding.gen))) return "revoked";
		}
	}

	/**
	 * Run a single model pass over a fixed unseen prefix, then commit only when
	 * the pass genuinely succeeded and finalized the still-valid batch.
	 */
	async #runAttempt(
		binding: ChroniclerBinding,
		entries: readonly ChronicleEntry[],
		requestText: string,
	): Promise<AttemptOutcome> {
		const sources: CaptureSource[] = entries.map(entry => ({
			id: entry.id,
			parentId: entry.parentId,
			timestamp: entry.timestamp,
		}));

		let batch: CaptureBatch;
		try {
			batch = binding.store.beginBatch(sources);
		} catch (error) {
			if (isChroniclerCorruption(error)) return { kind: "corruption", error: errorText(error) };
			return { kind: "failed", error: errorText(error) };
		}
		this.#activeBatch = batch;

		try {
			const knownSources = this.#buildKnownSources(binding, batch);
			binding.agent.setTools([
				new ChronicleTool(binding.store, batch, knownSources),
				new FinishChronicleTool(binding.store, batch, knownSources),
				new ReadChronicleTool(binding.store, batch, this.#host.obfuscator),
			]);

			const request: AgentMessage = {
				role: "user",
				content: [{ type: "text", text: requestText }],
				timestamp: Date.now(),
			};

			try {
				await Promise.race([binding.agent.prompt([request]), this.#deadlineSignal.promise]);
			} catch (error) {
				if (this.#generation !== binding.gen || batch.revoked) return { kind: "revoked" };
				return { kind: "failed", error: errorText(error) };
			}

			if (this.#generation !== binding.gen || batch.revoked) return { kind: "revoked" };

			const failure = this.#passFailure(binding.agent, batch);
			if (failure) return { kind: "failed", error: failure };

			// Publication starts here. A fence landing before the store's pre-rename
			// check revokes this batch and the rename never happens; a fence landing
			// after it settles in this frozen root and is never turned into a retry.
			const publication = binding.store.commitBatch(batch);
			try {
				await publication;
			} catch (error) {
				// A rename that landed but whose cache write failed is committed
				// success (the store swallows cache errors). Reaching here means the
				// batch never published, so this is retryable — unless the committed
				// data itself disagrees, which halts.
				if (isChroniclerCorruption(error)) return { kind: "corruption", error: errorText(error) };
				if (this.#generation !== binding.gen || batch.revoked) return { kind: "revoked" };
				return { kind: "failed", error: errorText(error) };
			}
			return { kind: "committed" };
		} finally {
			// Clear the active reference synchronously at settlement so no later
			// fence can touch a batch the store has frozen.
			if (!Object.isFrozen(batch)) batch.revoked = true;
			if (this.#activeBatch === batch) this.#activeBatch = undefined;
		}
	}

	/** A non-empty string names why the pass is not a committable success. */
	#passFailure(agent: Agent, batch: CaptureBatch): string | null {
		if (agent.state.error) return agent.state.error;
		for (let i = agent.state.messages.length - 1; i >= 0; i--) {
			const message = agent.state.messages[i];
			if (message.role !== "assistant") continue;
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				return message.errorMessage ?? `model turn ended with stopReason ${message.stopReason}`;
			}
			break;
		}
		if (!batch.finalized) return "capture pass ended without a finish_chronicle marker";
		return null;
	}

	/** Drop the retained model conversation, keeping the static system framing. */
	#rebuildConversation(binding: ChroniclerBinding): void {
		binding.agent.reset();
		binding.agent.replaceMessages([]);
	}

	// ---- budget & framing -------------------------------------------------

	/**
	 * Reduce the beat listing (oldest first) then the unseen prefix until the
	 * exact request that will be sent fits the budget. If retained model context
	 * is what pushes it over, rebuild the conversation once and retry the whole
	 * selection. A single entry still over budget on a fresh context is an
	 * explicit preservation halt, never a silent truncation.
	 */
	#selectPrefix(
		binding: ChroniclerBinding,
		unseen: readonly ChronicleEntry[],
		ownedIds: ReadonlySet<string>,
	): PrefixSelection {
		const tokenizer = binding.agent.tokenizer;
		const systemTokens = tokenizer.countTokens(binding.systemText);
		const toolTokens = estimateToolSchemaTokens(CHRONICLER_TOOL_SCHEMAS, tokenizer);
		const budget = this.#budgetTokens(binding.model);
		const carry = this.#resolvableCarry(binding, ownedIds);
		const beats = binding.store.beats;

		let rebuilt = false;
		while (true) {
			const stored = binding.agent.state.messages;
			const storedLocal = tokenizer.countMessages(stored, { excludeEncryptedReasoning: true });
			const storedProvider = estimateTranscriptTokens(stored, tokenizer, { excludeEncryptedReasoning: true });

			let prefixCount = Math.min(MAX_PREFIX_ENTRIES, unseen.length);
			let listingCount = Math.min(MAX_BEAT_LISTING, beats.length);

			while (true) {
				const entries = unseen.slice(0, prefixCount);
				const listing = beats.slice(beats.length - listingCount);
				const framed = this.#renderFramed(binding, entries, listing, beats.length - listing.length, carry);
				// Count the exact bytes that will be sent: obfuscation happens once,
				// here, and the same text is handed to the model.
				const requestText = this.#host.obfuscator?.obfuscate(framed) ?? framed;
				const incoming = tokenizer.countMessage({
					role: "user",
					content: [{ type: "text", text: requestText }],
					timestamp: Date.now(),
				});
				const localTotal = systemTokens + toolTokens + storedLocal + incoming;
				const providerTotal = storedProvider + incoming;

				if (Math.max(localTotal, providerTotal) <= budget) return { kind: "ok", entries, requestText };
				if (listingCount > 0) {
					listingCount -= 1;
					continue;
				}
				if (!rebuilt && stored.length > 0) break;
				if (prefixCount > 1) {
					prefixCount -= 1;
					continue;
				}
				break;
			}

			if (!rebuilt && binding.agent.state.messages.length > 0) {
				this.#rebuildConversation(binding);
				rebuilt = true;
				continue;
			}
			return { kind: "oversized" };
		}
	}

	#budgetTokens(model: Model<Api>): number {
		const window = model.contextWindow;
		if (typeof window === "number" && Number.isFinite(window) && window > 0) {
			return Math.floor(window * CONTEXT_BUDGET_FRACTION);
		}
		return GENERIC_BUDGET_TOKENS;
	}

	/**
	 * Inherited carry is off-branch history unless this session still holds every
	 * entry it cites; a fork that lost a cited source withholds the carry from
	 * framing while the copied manifest keeps it. Own carry passes trivially.
	 */
	#resolvableCarry(
		binding: ChroniclerBinding,
		ownedIds: ReadonlySet<string>,
	): { sources: string[]; text: string } | null {
		const carry = binding.store.carry;
		if (!carry) return null;
		return carry.sources.every(id => ownedIds.has(id)) ? carry : null;
	}

	#renderFramed(
		binding: ChroniclerBinding,
		entries: readonly ChronicleEntry[],
		listing: readonly { id: string; title: string; kind: string; eventTime: string }[],
		omitted: number,
		carry: { sources: string[]; text: string } | null,
	): string {
		// The delta is rendered without an obfuscator: the whole framed request is
		// obfuscated once by the caller, so a secret spanning fragments is caught.
		const rendered = renderChronicleDelta(entries, { includeThinking: true });
		const message = rendered[0];
		const block = message?.role === "user" && Array.isArray(message.content) ? message.content[0] : undefined;
		const delta = block?.type === "text" ? block.text : "";
		return prompt.render(contextTemplate, {
			sessionId: binding.descriptor.sessionId,
			cwd: binding.descriptor.cwd,
			beatCount: binding.store.beats.length,
			beats: listing.map(beat => ({
				id: beat.id,
				title: beat.title,
				kind: beat.kind,
				eventTime: beat.eventTime,
			})),
			omitted,
			carry,
			delta,
		});
	}

	#buildKnownSources(binding: ChroniclerBinding, batch: CaptureBatch): ReadonlyMap<string, CaptureSource> {
		const known = new Map<string, CaptureSource>(binding.store.sourceEntries);
		for (const entry of batch.entries) known.set(entry.id, entry);
		return known;
	}

	// ---- binding lifecycle ------------------------------------------------

	#sameDescriptor(a: SessionDescriptor, b: SessionDescriptor): boolean {
		return (
			a.sessionId === b.sessionId &&
			a.sessionFile === b.sessionFile &&
			a.artifactsDir === b.artifactsDir &&
			a.cwd === b.cwd
		);
	}

	#resolveSelection(): RoleSelection | undefined {
		const selection = resolveChroniclerRoleSelection(this.#host.settings, this.#host.modelRegistry.getAvailable());
		if (!selection) return undefined;
		const requested = concreteThinkingLevel(selection.thinkingLevel) ?? ThinkingLevel.Medium;
		const resolved = resolveThinkingLevelForModel(selection.model, requested);
		return {
			model: selection.model,
			thinkingLevel: resolved ?? ThinkingLevel.Inherit,
			modelString: formatModelString(selection.model),
		};
	}

	async #ensureBinding(
		descriptor: SessionDescriptor,
		selection: RoleSelection,
	): Promise<ChroniclerBinding | undefined> {
		const gen = this.#generation;
		const current = this.#binding;
		const rebind =
			!current ||
			current.gen !== this.#generation ||
			!this.#sameDescriptor(current.descriptor, descriptor) ||
			current.modelString !== selection.modelString;
		if (!rebind) return current;

		// Serialized on the owner chain, so any previous prompt/publication has
		// already settled before another writer starts.
		if (current) await this.#teardownBinding(current);
		this.#binding = undefined;

		if (gen !== this.#generation || this.#deadlineExpired || !this.#enabled()) return undefined;
		const store = new ChroniclerStore(
			`${descriptor.artifactsDir}/chronicler`,
			{ sessionId: descriptor.sessionId, project: descriptor.cwd, model: selection.modelString },
			{ warn: message => this.#host.emitNotice("warning", message, "chronicler") },
		);
		await store.open();
		if (this.#generation !== gen) return undefined;

		const recorder = new AdvisorTranscriptRecorder(
			() => descriptor.sessionFile,
			() => descriptor.cwd,
			RECORDER_FILENAME,
		);
		const renderedSystem = prompt.render(systemTemplate, {
			sessionId: descriptor.sessionId,
			cwd: descriptor.cwd,
		});
		const systemText = this.#host.obfuscator?.obfuscate(renderedSystem) ?? renderedSystem;
		const agent = this.#buildAgent(descriptor, selection, systemText);
		// Ordinary revocation still owns the billed completion until this binding
		// settles; only teardown or the terminal deadline closes its diagnostics.
		let recording = true;
		const unsubscribe = agent.subscribe(event => {
			if (recording && !this.#deadlineExpired && !this.#cleanedUp && event.type === "message_end") {
				recorder.record(event.message);
			}
		});
		const agentUnsubscribe = () => {
			recording = false;
			unsubscribe();
		};

		const binding: ChroniclerBinding = {
			gen,
			descriptor,
			store,
			recorder,
			model: selection.model,
			modelString: selection.modelString,
			thinkingLevel: selection.thinkingLevel,
			systemText,
			agent,
			agentUnsubscribe,
		};
		agent.addBeforeModelCallHook(() => {
			if (this.#generation !== gen || this.#deadlineExpired || this.#cleanedUp) {
				throw new Error("Chronicler binding was revoked");
			}
		});
		this.#binding = binding;
		return binding;
	}

	#buildAgent(descriptor: SessionDescriptor, selection: RoleSelection, systemText: string): Agent {
		const providerSessionId = Bun.randomUUIDv7();
		const agent = new Agent({
			initialState: {
				systemPrompt: [systemText],
				model: selection.model,
				thinkingLevel: toReasoningEffort(selection.thinkingLevel),
				tools: [],
			},
			sessionId: providerSessionId,
			promptCacheKey: Bun.randomUUIDv7(),
			providerSessionState: this.#host.providerSessionState,
			cwdResolver: () => descriptor.cwd,
			preferWebsockets: this.#host.preferWebsockets,
			getApiKey: requestModel => this.#host.modelRegistry.resolver(requestModel, providerSessionId),
			streamFn: streamSimple,
			intentTracing: false,
			telemetry: deriveAdvisorTelemetry(this.#host.agent.telemetry, {
				id: `${providerSessionId}-chronicler`,
				name: "Chronicler",
				description: selection.modelString,
			}),
		});
		agent.setDisableReasoning(shouldDisableReasoning(selection.thinkingLevel));
		return agent;
	}

	async #teardownBinding(binding: ChroniclerBinding): Promise<void> {
		binding.agentUnsubscribe();
		binding.agent.abort("chronicler binding released");
		try {
			await binding.recorder.close();
		} catch (error) {
			logger.debug("Chronicler recorder close failed", { error: String(error) });
		}
	}

	async #disableBinding(): Promise<void> {
		this.#status = "off";
		this.#settled.clear();
		if (this.#binding) {
			await this.#teardownBinding(this.#binding);
			this.#binding = undefined;
		}
	}

	#handleBindingError(error: unknown): void {
		this.#status = "halted";
		this.#host.emitNotice("warning", `Chronicler capture halted: ${errorText(error)}`, "chronicler");
	}

	async #cleanup(): Promise<void> {
		if (this.#cleanedUp) return;
		this.#cleanedUp = true;
		this.#settingsUnsub?.();
		this.#settingsUnsub = undefined;
		if (this.#binding) {
			await this.#teardownBinding(this.#binding);
			this.#binding = undefined;
		}
	}

	/** Interruptible sleep; resolves false when the generation is revoked. */
	async #sleep(ms: number, gen: number): Promise<boolean> {
		const step = 50;
		let waited = 0;
		while (waited < ms) {
			if (this.#generation !== gen) return false;
			await Bun.sleep(Math.min(step, ms - waited));
			waited += step;
		}
		return this.#generation === gen;
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
