/**
 * Behavioral coverage for the serialized session Chronicler runtime.
 *
 * Everything here drives the real runtime: a real `Agent` tool loop reaching
 * the real `ChronicleTool`/`FinishChronicleTool`/`ReadChronicleTool` against a
 * real `ChroniclerStore` on a real temp filesystem. The only substitution is
 * the provider: a per-pass `createMockModel` script is bound to the internally
 * created capture Agent through one per-test restored `Agent.prototype.prompt`
 * spy that selects instances by their `finish_chronicle` tool. No module mock,
 * no environment mutation, no fake capture implementation.
 *
 * Scripts never invent source IDs. Each scripted turn parses the actual
 * `### Source entry ...` markup out of the request the runtime really sent, so
 * a rendering or provenance regression fails the tool call instead of silently
 * validating against fabricated data.
 *
 * A capture pass is awaited by polling the committed batch directories the
 * store publishes, which is the same evidence the store verification inspects.
 * `drain()` is the shutdown path (owner settlement plus recorder cleanup) and
 * is used only for terminal assertions and teardown.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentPromptOptions } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Context, ImageContent, Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockHandler, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { parseFrontmatter, TempDir } from "@oh-my-pi/pi-utils";
import { ExtensionRuntime, loadExtensionFromFactory } from "../../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../../src/extensibility/extensions/runner";
import { EventBus } from "../../src/utils/event-bus";
import { Type } from "@sinclair/typebox";
import { AdvisorTranscriptRecorder } from "../../src/advisor/transcript-recorder";
import { createAgentSession } from "../../src/sdk";
import { AgentSession } from "../../src/session/agent-session";
import { SecretObfuscator } from "../../src/secrets/obfuscator";
import { estimateToolSchemaTokens } from "../../src/modes/utils/context-usage";
import { SessionChronicler, type SessionChroniclerHost } from "../../src/chronicler/session-chronicler";
import { type CaptureCheckpoint, ChroniclerStore, chroniclerStoreIO } from "../../src/chronicler/store";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const FINISH_TOOL = "finish_chronicle";
const CAPTURE_MODEL_ID = "chronicler-mock";
const CAPTURE_ROLE_VALUE = `mock/${CAPTURE_MODEL_ID}`;
const BATCH_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_MARKER_RE = /### Source entry `([^`]+)`/g;
/** Deadline for polling committed evidence; retry backoff is 2s then 4s. */
const SETTLE_MS = 20_000;

/**
 * One intercepted capture attempt.
 *
 * `input` is the incoming request the runtime handed to `Agent.prompt` for this
 * pass. Assertions about what a pass was asked to cover read that, never the
 * provider context: a retained capture conversation may legitimately still
 * carry earlier passes' source headers until a budget rebuild drops them.
 */
interface CapturePass {
	readonly agent: Agent;
	readonly mock: MockModel;
	readonly scripted: boolean;
	readonly input: string | AgentMessage | AgentMessage[];
}

interface Harness {
	readonly chronicler: SessionChronicler;
	readonly host: SessionChroniclerHost;
	readonly primary: Agent;
	readonly notices: { level: string; message: string }[];
	readonly root: string;
	disposed: boolean;
}

describe("SessionChronicler capture runtime", () => {
	const originalPrompt = Agent.prototype.prompt;
	let promptSpy: ReturnType<typeof spyOn<Agent, "prompt">> | undefined;
	let registrySpy: ReturnType<typeof spyOn<ModelRegistry, "getAvailable">> | undefined;

	let tempDir: TempDir;
	let cwd: string;
	let sessionDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let captureModel: MockModel;
	let availableModels: Model<Api>[];
	let primaryModel: Model<Api>;

	/** Scripts consumed one per intercepted capture attempt, in order. */
	let scripts: MockHandler[][];
	let passes: CapturePass[];
	let ignoreProviderAbort = false;
	let harnesses: Harness[];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-chronicler-runtime-");
		cwd = tempDir.path();
		sessionDir = path.join(cwd, "sessions");
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("mock", "test-key");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		captureModel = createMockModel({ id: CAPTURE_MODEL_ID, provider: "mock", contextWindow: 200_000 });
		availableModels = [captureModel];
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected the bundled anthropic model to exist");
		primaryModel = bundled;

		scripts = [];
		passes = [];
		ignoreProviderAbort = false;
		harnesses = [];

		registrySpy = spyOn(modelRegistry, "getAvailable");
		registrySpy.mockImplementation(() => [...availableModels]);
		promptSpy = spyOn(Agent.prototype, "prompt");
		promptSpy.mockImplementation(interceptPrompt as typeof Agent.prototype.prompt);
	});

	afterEach(async () => {
		for (const harness of harnesses) {
			if (harness.disposed) continue;
			harness.disposed = true;
			harness.chronicler.beginStop();
			await harness.chronicler.drain(3_000).catch(() => {});
		}
		promptSpy?.mockRestore();
		promptSpy = undefined;
		registrySpy?.mockRestore();
		registrySpy = undefined;
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
	});

	// ── interception ────────────────────────────────────────────────────────

	/**
	 * Bind the next script to whichever Agent owns the capture tools, then run
	 * the real prompt. Primary agents keep their own provider untouched.
	 */
	async function interceptPrompt(
		this: Agent,
		input: string | AgentMessage | AgentMessage[],
		imagesOrOptions?: ImageContent[] | AgentPromptOptions,
		options?: AgentPromptOptions,
	): Promise<void> {
		if (this.state.tools.some(tool => tool.name === FINISH_TOOL)) {
			const script = scripts.shift();
			const mock = createMockModel({
				responses: script,
				handler: () => ({ content: ["Unscripted capture attempt."], stopReason: "stop" }),
			});
			passes.push({ agent: this, mock, scripted: script !== undefined, input });
			this.streamFn = ignoreProviderAbort
				? (model, context, options) => mock.stream(model, context, { ...options, signal: undefined })
				: mock.stream;
		}
		if (typeof input === "string") {
			return originalPrompt.call(this, input, imagesOrOptions as ImageContent[] | undefined, options);
		}
		const promptMessages: (input: AgentMessage | AgentMessage[], options?: AgentPromptOptions) => Promise<void> =
			originalPrompt;
		return promptMessages.call(this, input, imagesOrOptions as AgentPromptOptions | undefined);
	}

	function parseSourceIds(serialized: string): string[] {
		const ids: string[] = [];
		for (const match of serialized.matchAll(SOURCE_MARKER_RE)) ids.push(match[1]!);
		return ids;
	}

	/**
	 * The source entry IDs of the request currently being answered: the last user
	 * message in the provider context. A retained capture conversation may still
	 * hold earlier passes' deltas, which this pass was not asked to cover.
	 */
	function receivedSourceIds(context: Context): string[] {
		for (let index = context.messages.length - 1; index >= 0; index--) {
			const message = context.messages[index]!;
			if (message.role === "user") return parseSourceIds(JSON.stringify(message));
		}
		return [];
	}

	/** The source entry IDs this pass was actually asked to cover. */
	function passSourceIds(pass: CapturePass): string[] {
		return parseSourceIds(passRequestText(pass));
	}

	/** The incoming request text for this pass: context framing plus its delta. */
	function passRequestText(pass: CapturePass): string {
		return typeof pass.input === "string" ? pass.input : JSON.stringify(pass.input);
	}

	/** Every provider turn in this pass, for tool-loop assertions. */
	function passConversationText(pass: CapturePass): string {
		return JSON.stringify(pass.mock.calls.map(call => call.context.messages));
	}

	// ── scripted capture turns ──────────────────────────────────────────────

	interface BeatOverrides {
		title?: string;
		kind?: string;
		body?: string;
		topics?: string[];
		related?: string[];
		supersedes?: string;
		/** Cite a subset instead of every received source. */
		sources?: string[];
	}

	/** Stage one beat citing the sources this pass really received. */
	function chronicleTurn(over: BeatOverrides = {}): MockHandler {
		return context => ({
			content: [
				{
					type: "toolCall",
					name: "chronicle",
					arguments: {
						title: over.title ?? "Captured beat",
						kind: over.kind ?? "decision",
						body: over.body ?? "The session recorded a decision worth preserving.",
						topics: over.topics ?? ["chronicler"],
						sources: over.sources ?? receivedSourceIds(context),
						...(over.related ? { related: over.related } : {}),
						...(over.supersedes ? { supersedes: over.supersedes } : {}),
					},
				},
			],
		});
	}

	function finishTurn(carry?: { sources?: string[]; text: string }): MockHandler {
		return context => ({
			content: [
				{
					type: "toolCall",
					name: FINISH_TOOL,
					arguments: {
						carry: carry ? { sources: carry.sources ?? receivedSourceIds(context), text: carry.text } : null,
					},
				},
			],
		});
	}

	const stopTurn: MockResponse = { content: ["Capture pass complete."], stopReason: "stop" };

	/** Stage one beat, finalize, stop: the ordinary successful pass. */
	function beatPass(over: BeatOverrides = {}, carry?: { sources?: string[]; text: string }): MockHandler[] {
		return [chronicleTurn(over), finishTurn(carry), stopTurn];
	}

	/** Finalize with no beat: coverage advances, nothing is written. */
	function ackPass(carry?: { sources?: string[]; text: string }): MockHandler[] {
		return [finishTurn(carry), stopTurn];
	}

	// ── fixtures ────────────────────────────────────────────────────────────

	function newSettings(over: Partial<Record<"chronicler.enabled", boolean>> = {}): Settings {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"chronicler.enabled": over["chronicler.enabled"] ?? true,
		});
		settings.setModelRole("chronicler", CAPTURE_ROLE_VALUE);
		return settings;
	}

	async function newSessionManager(): Promise<SessionManager> {
		const manager = SessionManager.create(cwd, sessionDir);
		await manager.ensureOnDisk();
		return manager;
	}

	/**
	 * A session whose file is still lazy: nothing has forced it to disk, which is
	 * the state a primary run is in before its first assistant message lands.
	 */
	function newLazySessionManager(): SessionManager {
		return SessionManager.create(cwd, sessionDir);
	}

	function chroniclerRoot(manager: SessionManager): string {
		const artifacts = manager.getArtifactsDir();
		if (!artifacts) throw new Error("Expected the session to have an artifacts directory");
		return path.join(artifacts, "chronicler");
	}

	function startChronicler(manager: SessionManager, settings: Settings, obfuscator?: SecretObfuscator): Harness {
		const notices: { level: string; message: string }[] = [];
		const primary = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: primaryModel, systemPrompt: ["Primary"], tools: [], messages: [] },
		});
		const host: SessionChroniclerHost = {
			agent: primary,
			sessionManager: manager,
			settings,
			modelRegistry,
			obfuscator,
			providerSessionState: new Map<string, ProviderSessionState>(),
			preferWebsockets: undefined,
			isDisposed: () => false,
			isCaptureEligible: () => true,
			emitNotice: (level, message) => {
				notices.push({ level, message });
			},
			cwd: () => cwd,
		};
		const harness: Harness = {
			chronicler: new SessionChronicler(host),
			host,
			primary,
			notices,
			root: chroniclerRoot(manager),
			disposed: false,
		};
		harnesses.push(harness);
		return harness;
	}

	async function shutdown(harness: Harness, timeoutMs = 5_000): Promise<void> {
		harness.disposed = true;
		harness.chronicler.beginStop();
		await harness.chronicler.drain(timeoutMs);
	}

	// ── session content ─────────────────────────────────────────────────────

	function appendUser(manager: SessionManager, text: string): string {
		return manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
	}

	function assistantMessage(text: string): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	function appendAssistant(manager: SessionManager, text: string): string {
		return manager.appendMessage(assistantMessage(text));
	}

	function appendToolResult(manager: SessionManager, toolName: string, text: string): string {
		return manager.appendMessage({
			role: "toolResult",
			toolCallId: `call_${toolName}_${manager.getEntries().length}`,
			toolName,
			content: [{ type: "text", text }],
			isError: false,
			timestamp: Date.now(),
		});
	}

	// ── committed evidence ──────────────────────────────────────────────────

	async function readCommitted(root: string): Promise<CaptureCheckpoint[]> {
		const beatsDir = path.join(root, "beats");
		let names: string[];
		try {
			names = await fs.readdir(beatsDir);
		} catch {
			return [];
		}
		const found: CaptureCheckpoint[] = [];
		for (const name of names) {
			if (!BATCH_DIR_RE.test(name)) continue;
			const raw = await fs.readFile(path.join(beatsDir, name, "COMMIT.json"), "utf8").catch(() => null);
			if (raw !== null) found.push(JSON.parse(raw) as CaptureCheckpoint);
		}
		found.sort((a, b) =>
			a.committedAt !== b.committedAt
				? a.committedAt.localeCompare(b.committedAt)
				: a.batchId.localeCompare(b.batchId),
		);
		return found;
	}

	async function committedEntryIds(root: string): Promise<string[]> {
		return (await readCommitted(root)).flatMap(batch => batch.entries.map(entry => entry.id));
	}

	/** Poll the published batch directories until `count` batches are visible. */
	async function waitForBatches(root: string, count: number, timeoutMs = SETTLE_MS): Promise<CaptureCheckpoint[]> {
		const deadline = Date.now() + timeoutMs;
		let seen: CaptureCheckpoint[] = [];
		for (;;) {
			seen = await readCommitted(root);
			if (seen.length >= count) return seen;
			if (Date.now() >= deadline) {
				throw new Error(`Timed out waiting for ${count} committed batch(es); saw ${seen.length}`);
			}
			await Bun.sleep(25);
		}
	}

	/** Poll until every listed entry id is covered by a committed manifest. */
	async function waitForCoverage(root: string, ids: readonly string[], timeoutMs = SETTLE_MS): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const covered = new Set(await committedEntryIds(root));
			const missing = ids.filter(id => !covered.has(id));
			if (missing.length === 0) return;
			if (Date.now() >= deadline) {
				throw new Error(`Timed out waiting for coverage of ${missing.length} entry id(s): ${missing.join(", ")}`);
			}
			await Bun.sleep(25);
		}
	}

	async function beatFiles(root: string, batchId: string): Promise<string[]> {
		const names = await fs.readdir(path.join(root, "beats", batchId));
		return names.filter(name => name.endsWith(".md")).sort();
	}

	async function readBeatFile(root: string, batchId: string, file: string): Promise<string> {
		return fs.readFile(path.join(root, "beats", batchId, file), "utf8");
	}

	function duplicates(ids: readonly string[]): string[] {
		const seen = new Set<string>();
		const repeated = new Set<string>();
		for (const id of ids) {
			if (seen.has(id)) repeated.add(id);
			seen.add(id);
		}
		return [...repeated];
	}

	/**
	 * The chronicler root implied by the session file itself, derived
	 * independently of the runtime so a misbound root cannot pass.
	 */
	function rootForSessionFile(sessionFile: string): string {
		return path.join(sessionFile.slice(0, -".jsonl".length), "chronicler");
	}

	/** The session id recorded in the JSONL header actually written to disk. */
	async function headerIdOnDisk(sessionFile: string): Promise<string> {
		const raw = await fs.readFile(sessionFile, "utf8");
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed.startsWith("{")) continue;
			const parsed = JSON.parse(trimmed) as { type?: string; id?: string };
			if (parsed.type === "session" && typeof parsed.id === "string") return parsed.id;
		}
		throw new Error(`No session header found in ${sessionFile}`);
	}

	// ── publication and provenance ──────────────────────────────────────────

	it("publishes a staged beat with real session and entry provenance, without touching the primary", async () => {
		const manager = await newSessionManager();
		const intention = appendUser(manager, "Rename the helper to loadConfig; two callers misuse the old name.");
		const answer = appendAssistant(manager, "Discussing only: the rename would break the plugin API.");
		const observation = appendToolResult(manager, "read", "export const a = 1;\nexport const b = 2;");
		await manager.flush();

		scripts.push(beatPass({ title: "Rename intention", kind: "design-direction" }));
		const harness = startChronicler(manager, newSettings());

		const [batch] = await waitForBatches(harness.root, 1);
		expect(batch).toBeDefined();
		expect(batch!.version).toBe(1);
		expect(batch!.sessionId).toBe(manager.getSessionId());
		// The root and the owner both come from the real session file on disk.
		const sessionFile = manager.getSessionFile()!;
		expect(harness.root).toBe(rootForSessionFile(sessionFile));
		expect(await headerIdOnDisk(sessionFile)).toBe(manager.getSessionId());
		expect(batch!.entries.map(entry => entry.id)).toEqual([intention, answer, observation]);

		const sessionEntries = new Map(manager.getEntries().map(entry => [entry.id, entry]));
		for (const source of batch!.entries) {
			const actual = sessionEntries.get(source.id);
			expect(actual).toBeDefined();
			expect(source.parentId).toBe(actual!.parentId);
			expect(source.timestamp).toBe(actual!.timestamp);
		}

		expect(batch!.beats).toHaveLength(1);
		const files = await beatFiles(harness.root, batch!.batchId);
		expect(files).toEqual([batch!.beats[0]!.file]);
		const contents = await readBeatFile(harness.root, batch!.batchId, files[0]!);
		expect(contents).toContain(`id: ${batch!.beats[0]!.id}`);
		expect(contents).toContain("Rename intention");
		for (const id of [intention, answer, observation]) expect(contents).toContain(id);

		// The capture Agent saw the real transcript, not a fabricated stand-in.
		expect(passes).toHaveLength(1);
		expect(passes[0]!.scripted).toBe(true);
		expect(passSourceIds(passes[0]!)).toEqual([intention, answer, observation]);
		expect(passRequestText(passes[0]!)).toContain("Discussing only");

		// No retain call, no primary model traffic: capture is entirely its own.
		expect(harness.primary.state.messages).toHaveLength(0);
		expect(harness.chronicler.status).toBe("running");
	});

	it("commits entry coverage for an acknowledgement pass that stages no beat", async () => {
		const manager = await newSessionManager();
		const first = appendUser(manager, "Rename the helper to loadConfig.");
		await manager.flush();
		scripts.push(beatPass());
		const harness = startChronicler(manager, newSettings());
		await waitForBatches(harness.root, 1);

		const ack = appendUser(manager, "ok");
		const ackReply = appendAssistant(manager, "Acknowledged.");
		await manager.flush();
		scripts.push(ackPass());
		harness.chronicler.onPrimaryTurnEnd(false);

		const committed = await waitForBatches(harness.root, 2);
		const second = committed[1]!;
		expect(second.beats).toEqual([]);
		expect(second.entries.map(entry => entry.id)).toEqual([ack, ackReply]);
		expect(await beatFiles(harness.root, second.batchId)).toEqual([]);
		expect(await committedEntryIds(harness.root)).toEqual([first, ack, ackReply]);
	});

	it("publishes nothing when a pass stages beats but never finalizes, then republishes on retry", async () => {
		const manager = await newSessionManager();
		const entry = appendUser(manager, "Capture this once the pass actually completes.");
		await manager.flush();

		// Attempt one stages and then simply stops: no finish marker, no commit.
		scripts.push([chronicleTurn({ title: "Never finalized" }), stopTurn]);
		scripts.push(beatPass({ title: "Finalized on retry" }));
		const harness = startChronicler(manager, newSettings());

		const [batch] = await waitForBatches(harness.root, 1);
		expect(passes.length).toBeGreaterThanOrEqual(2);
		expect(batch!.beats).toHaveLength(1);
		expect(batch!.entries.map(source => source.id)).toEqual([entry]);
		const contents = await readBeatFile(
			harness.root,
			batch!.batchId,
			(await beatFiles(harness.root, batch!.batchId))[0]!,
		);
		expect(contents).toContain("Finalized on retry");
		expect(contents).not.toContain("Never finalized");

		// The retry re-sent the same unseen prefix; nothing was skipped.
		expect(passSourceIds(passes[1]!)).toEqual([entry]);
		expect(passConversationText(passes[1]!)).not.toContain("Never finalized");
	});

	it("publishes nothing when the provider fails after beats were staged", async () => {
		const manager = await newSessionManager();
		const entry = appendUser(manager, "A provider failure must not leave a half-written batch.");
		await manager.flush();

		scripts.push([chronicleTurn(), { throw: "provider exploded" }]);
		const harness = startChronicler(manager, newSettings());
		await waitForPassStart(0);
		// drain() settles the owner and cancels the pending retry backoff.
		await shutdown(harness, 1_000);

		expect(await readCommitted(harness.root)).toEqual([]);
		const beatsDir = path.join(harness.root, "beats");
		const remaining = await fs.readdir(beatsDir).catch(() => []);
		expect(remaining.filter(name => BATCH_DIR_RE.test(name))).toEqual([]);

		// The entry stays unseen and recoverable for a later run.
		const store = new ChroniclerStore(harness.root, { sessionId: manager.getSessionId(), project: cwd, model: "m" });
		await store.open();
		expect(store.processedEntryIds.has(entry)).toBe(false);
	}, 30_000);

	/** Block until the pass at `index` exists and its provider has been called. */
	async function waitForPassStart(index: number, timeoutMs = 8_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			if (passes.length > index && passes[index]!.mock.calls.length > 0) return;
			if (Date.now() >= deadline) {
				throw new Error(`Timed out waiting for capture attempt ${index}; saw ${passes.length} attempt(s)`);
			}
			await Bun.sleep(10);
		}
	}

	it("scans only unseen entries after a restart, and carries context into a correction", async () => {
		const manager = await newSessionManager();
		appendUser(manager, "Rename the helper to loadConfig.");
		await manager.flush();
		scripts.push(beatPass({ title: "Original rename intention" }, { text: "Rename decision still open." }));
		const firstRun = startChronicler(manager, newSettings());
		const [firstBatch] = await waitForBatches(firstRun.root, 1);
		const originalBeatId = firstBatch!.beats[0]!.id;
		const originalFile = await readBeatFile(firstRun.root, firstBatch!.batchId, firstBatch!.beats[0]!.file);
		expect(firstBatch!.carry?.text).toBe("Rename decision still open.");
		await shutdown(firstRun);

		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeDefined();
		await manager.close();

		const reopened = await SessionManager.open(sessionFile!, sessionDir, undefined, {
			initialCwd: cwd,
			suppressBreadcrumb: true,
		});
		const correction = appendUser(reopened, "Actually keep the old name; a wrapper preserves the plugin API.");
		await reopened.flush();

		// The idle resumed session captures backlog without another user turn.
		scripts.push(
			beatPass({ title: "Correction to the rename", kind: "correction", supersedes: originalBeatId }, undefined),
		);
		const secondRun = startChronicler(reopened, newSettings());
		expect(secondRun.root).toBe(firstRun.root);
		const committed = await waitForBatches(secondRun.root, 2);

		const correctionPass = passes[1]!;
		expect(passSourceIds(correctionPass)).toEqual([correction]);
		// Carry survived the restart and reached the new pass as prior context.
		expect(passRequestText(correctionPass)).toContain("Rename decision still open.");
		// The committed beat listing offered the original beat as relatable evidence.
		expect(passRequestText(correctionPass)).toContain(originalBeatId);

		const second = committed[1]!;
		expect(second.beats).toHaveLength(1);
		const correctionBody = await readBeatFile(secondRun.root, second.batchId, second.beats[0]!.file);
		expect(correctionBody).toContain(`supersedes: ${originalBeatId}`);
		// The original beat file is untouched: a correction links, never rewrites.
		expect(await readBeatFile(secondRun.root, firstBatch!.batchId, firstBatch!.beats[0]!.file)).toBe(originalFile);
		await reopened.close();
	});

	/**
	 * Commit `count` beats in one real batch so a later runtime pass has more
	 * history than its bounded context listing can show. The synthetic source
	 * ids belong to no session entry, so they never change what the runtime
	 * considers unseen.
	 */
	async function seedCommittedBeats(root: string, sessionId: string, count: number): Promise<string[]> {
		const store = new ChroniclerStore(root, { sessionId, project: cwd, model: "mock/chronicler-mock" });
		await store.open();
		const entries = Array.from({ length: count }, (_unused, index) => ({
			id: `seed-${index}`,
			parentId: index === 0 ? null : `seed-${index - 1}`,
			timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
		}));
		const batch = store.beginBatch(entries);
		const ids: string[] = [];
		for (let index = 0; index < count; index++) {
			const beat = store.stageBeat(batch, {
				title: `Seeded beat ${index}`,
				kind: "anecdote",
				body: `Seeded body number ${index} for listing bounds.`,
				topics: ["seed"],
				eventTime: entries[index]!.timestamp,
				sources: [`seed-${index}`],
				related: [],
			});
			ids.push(beat.id);
		}
		batch.finalized = true;
		await store.commitBatch(batch);
		return ids;
	}

	it("bounds the committed beat listing and still lets the model read an omitted beat", async () => {
		const manager = await newSessionManager();
		const root = chroniclerRoot(manager);
		const seeded = await seedCommittedBeats(root, manager.getSessionId(), 205);
		appendUser(manager, "A turn that follows a long capture history.");
		await manager.flush();

		let omittedId: string | undefined;
		scripts.push([
			context => {
				const listed = new Set(parseListedBeatIds(context));
				omittedId = seeded.find(id => !listed.has(id));
				if (!omittedId) throw new Error("Expected the bounded listing to omit at least one committed beat");
				return { content: [{ type: "toolCall", name: "read_chronicle", arguments: { id: omittedId } }] };
			},
			finishTurn(),
			stopTurn,
		]);
		const harness = startChronicler(manager, newSettings());
		await waitForBatches(harness.root, 2);

		const request = passRequestText(passes[0]!);
		// The framing declares how much history it did not list.
		const omittedRows = /Omitted listing rows: (\d+)/.exec(request);
		expect(omittedRows).not.toBeNull();
		expect(Number(omittedRows![1])).toBeGreaterThan(0);
		expect(omittedId).toBeDefined();
		expect(request).not.toContain(omittedId!);
		// The omitted beat was still reachable through the real read tool.
		expect(passConversationText(passes[0]!)).toContain(
			`Seeded body number ${seeded.indexOf(omittedId!)} for listing bounds.`,
		);
	}, 30_000);

	/** Beat IDs the bounded context listing actually rendered. */
	function parseListedBeatIds(context: Context): string[] {
		const ids: string[] = [];
		for (const message of context.messages) {
			for (const match of JSON.stringify(message).matchAll(/- ID `([^`]+)`/g)) ids.push(match[1]!);
		}
		return ids;
	}

	// ── history and lifecycle regressions ───────────────────────────────────

	it("captures a new branch entry once and preserves the beat from the abandoned branch", async () => {
		const manager = await newSessionManager();
		const rootEntry = appendUser(manager, "Root turn.");
		const branchA = appendAssistant(manager, "Answer on branch A.");
		await manager.flush();
		scripts.push(beatPass({ title: "Branch A beat" }));
		const harness = startChronicler(manager, newSettings());
		const [firstBatch] = await waitForBatches(harness.root, 1);
		const preservedFile = await readBeatFile(harness.root, firstBatch!.batchId, firstBatch!.beats[0]!.file);

		// Rewind the active leaf; the append-only history keeps branch A.
		manager.branch(rootEntry);
		const branchB = appendAssistant(manager, "Shorter answer on branch B.");
		await manager.flush();
		scripts.push(beatPass({ title: "Branch B beat" }));
		harness.chronicler.onPrimaryTurnEnd(false);
		const committed = await waitForBatches(harness.root, 2);

		const covered = await committedEntryIds(harness.root);
		expect(duplicates(covered)).toEqual([]);
		expect(new Set(covered)).toEqual(new Set([rootEntry, branchA, branchB]));
		expect(committed[1]!.entries.map(entry => entry.id)).toEqual([branchB]);
		// Only the new id was sent: the shorter active branch caused no recapture.
		expect(passSourceIds(passes[1]!)).toEqual([branchB]);
		expect(await readBeatFile(harness.root, firstBatch!.batchId, firstBatch!.beats[0]!.file)).toBe(preservedFile);
	});

	it("rebuilds from committed manifests when the diagnostic caches are destroyed", async () => {
		const manager = await newSessionManager();
		const first = appendUser(manager, "Entry A must never be replayed.");
		await manager.flush();
		scripts.push(beatPass({ title: "Entry A beat" }));
		const firstRun = startChronicler(manager, newSettings());
		await waitForBatches(firstRun.root, 1);
		await shutdown(firstRun);

		// Only the rebuildable caches are damaged; committed data is untouched.
		await fs.rm(path.join(firstRun.root, "state.json"), { force: true });
		await fs.writeFile(path.join(firstRun.root, "INDEX.md"), "not an index\n");

		const second = appendUser(manager, "Entry B must still be captured.");
		await manager.flush();
		scripts.push(beatPass({ title: "Entry B beat" }));
		const secondRun = startChronicler(manager, newSettings());
		await waitForBatches(secondRun.root, 2);

		expect(passSourceIds(passes[1]!)).toEqual([second]);
		const covered = await committedEntryIds(secondRun.root);
		expect(covered).toEqual([first, second]);
		expect(duplicates(covered)).toEqual([]);
	});

	it("keeps inherited fork provenance original while capturing child material as the child", async () => {
		const parent = await newSessionManager();
		const parentEntry = appendUser(parent, "Parent decision to inherit.");
		await parent.flush();
		scripts.push(beatPass({ title: "Parent beat" }, { text: "Parent carry to inherit." }));
		const parentRun = startChronicler(parent, newSettings());
		const [parentBatch] = await waitForBatches(parentRun.root, 1);
		await shutdown(parentRun);
		const parentFile = parent.getSessionFile()!;
		const parentSessionId = parent.getSessionId();
		await parent.close();

		const child = await SessionManager.forkFrom(parentFile, cwd, sessionDir, undefined, {
			copyArtifacts: true,
			suppressBreadcrumb: true,
		});
		expect(child.getSessionId()).not.toBe(parentSessionId);
		const childEntry = appendUser(child, "Child-only follow-up.");
		await child.flush();

		scripts.push(beatPass({ title: "Child beat" }));
		const childRun = startChronicler(child, newSettings());
		expect(childRun.root).not.toBe(parentRun.root);
		const committed = await waitForBatches(childRun.root, 2);

		// Only the documented ancestor and the child itself may own committed data.
		const childSessionId = child.getSessionId();
		expect(child.getHeader()?.parentSession).toBe(parentSessionId);
		expect(new Set(committed.map(batch => batch.sessionId))).toEqual(new Set([parentSessionId, childSessionId]));
		const inherited = committed.find(batch => batch.batchId === parentBatch!.batchId);
		expect(inherited).toBeDefined();
		expect(inherited!.sessionId).toBe(parentSessionId);
		const own = committed.find(batch => batch.batchId !== parentBatch!.batchId)!;
		expect(own.sessionId).toBe(childSessionId);
		expect(own.entries.map(entry => entry.id)).toEqual([childEntry]);
		// Inherited coverage prevented replaying the parent's entry.
		expect(passSourceIds(passes[1]!)).toEqual([childEntry]);
		// The fork copied the parent's history, so its carry is still on-branch.
		expect(passRequestText(passes[1]!)).toContain("Parent carry to inherit.");
		expect(parentBatch!.entries.map(entry => entry.id)).toContain(parentEntry);
		await child.close();
	});

	it("withholds inherited carry whose source entry the fork no longer has, preserving it on disk", async () => {
		const parent = await newSessionManager();
		const cited = appendUser(parent, "The entry the inherited carry cites.");
		await parent.flush();
		scripts.push(beatPass({ title: "Carry origin" }, { text: "Carry citing an entry the fork loses." }));
		const parentRun = startChronicler(parent, newSettings());
		const [parentBatch] = await waitForBatches(parentRun.root, 1);
		expect(parentBatch!.carry?.sources).toEqual([cited]);
		await shutdown(parentRun);
		const parentFile = parent.getSessionFile()!;
		const parentSessionId = parent.getSessionId();
		await parent.close();

		const child = await SessionManager.forkFrom(parentFile, cwd, sessionDir, undefined, {
			copyArtifacts: true,
			suppressBreadcrumb: true,
		});
		const childFile = child.getSessionFile()!;
		await child.close();

		// The cited entry is actually removed from the fork's own history.
		const original = await fs.readFile(childFile, "utf8");
		const kept = original
			.split("\n")
			.filter(line => line.trim().length > 0 && !line.includes(`"id":"${cited}"`))
			.join("\n");
		expect(kept).not.toBe(original);
		await fs.writeFile(childFile, `${kept}\n`);

		const reopened = await SessionManager.open(childFile, sessionDir, undefined, {
			initialCwd: cwd,
			suppressBreadcrumb: true,
		});
		expect(reopened.getEntries().some(entry => entry.id === cited)).toBe(false);
		expect(reopened.getHeader()?.parentSession).toBe(parentSessionId);
		const survivor = appendUser(reopened, "The fork's own first entry.");
		await reopened.flush();

		scripts.push(beatPass({ title: "Fork beat" }));
		const childRun = startChronicler(reopened, newSettings());
		await waitForBatches(childRun.root, 2);

		// The inherited carry's evidence is absent here, so it is not offered.
		expect(passRequestText(passes[1]!)).not.toContain("Carry citing an entry the fork loses.");
		// The fork's own entry is captured; the inherited coverage is not replayed.
		expect(passSourceIds(passes[1]!)).toEqual([survivor]);
		const covered = await committedEntryIds(childRun.root);
		expect(duplicates(covered)).toEqual([]);
		expect(covered).toEqual([cited, survivor]);
		// The copied manifest still records the inherited carry verbatim.
		const preserved = await fs.readFile(
			path.join(childRun.root, "beats", parentBatch!.batchId, "COMMIT.json"),
			"utf8",
		);
		expect(preserved).toContain("Carry citing an entry the fork loses.");
		await reopened.close();
	}, 30_000);

	it("lands no beat in a new session root when capture is toggled off and the session is replaced mid-pass", async () => {
		const manager = await newSessionManager();
		const oldEntry = appendUser(manager, "Work belonging to the original session root.");
		await manager.flush();
		const oldRoot = chroniclerRoot(manager);

		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const lateCompletion = "Billed late completion belongs to the original capture session.";
		const settings = newSettings();
		scripts.push([
			chronicleTurn({ title: "Held beat" }),
			async () => {
				entered.resolve();
				await gate.promise;
				return { content: [lateCompletion, { type: "toolCall", name: FINISH_TOOL, arguments: { carry: null } }] };
			},
			stopTurn,
		]);
		const harness = startChronicler(manager, settings);
		await entered.promise;

		settings.override("chronicler.enabled", false);
		const newFile = await manager.newSession();
		expect(newFile).toBeDefined();
		const newRoot = chroniclerRoot(manager);
		expect(newRoot).not.toBe(oldRoot);
		const newEntry = appendUser(manager, "The replacement session owns only its own evidence.");
		await manager.ensureOnDisk();
		await manager.flush();
		scripts.push(ackPass());
		settings.override("chronicler.enabled", true);

		gate.resolve();
		await waitForCoverage(newRoot, [newEntry]);
		await shutdown(harness, 3_000);

		expect(await readCommitted(oldRoot)).toEqual([]);
		const landedInNewRoot = await readCommitted(newRoot);
		expect(landedInNewRoot.flatMap(batch => batch.entries.map(entry => entry.id))).toEqual([newEntry]);
		expect(landedInNewRoot.flatMap(batch => batch.entries.map(entry => entry.id))).not.toContain(oldEntry);
		expect(await fs.readFile(path.join(oldRoot, "__chronicler.jsonl"), "utf8")).toContain(lateCompletion);
		// The revoked attempt left no transcript inside the new session's tree.
		const newSessionFile = manager.getSessionFile()!;
		const newTree = newSessionFile.slice(0, -".jsonl".length);
		const stray = await fs.readFile(path.join(newTree, "chronicler", "__chronicler.jsonl"), "utf8");
		expect(stray).not.toContain("Held beat");
		expect(stray).not.toContain(lateCompletion);
	});

	it("flushes pending work on shutdown and keeps deadline-cut work recoverable", async () => {
		const flushManager = await newSessionManager();
		const flushEntry = appendUser(flushManager, "Pending work at shutdown.");
		await flushManager.flush();
		scripts.push(beatPass({ title: "Flushed at shutdown" }));
		const flushRun = startChronicler(flushManager, newSettings());
		await shutdown(flushRun, 10_000);
		const flushed = await readCommitted(flushRun.root);
		expect(flushed).toHaveLength(1);
		expect(flushed[0]!.entries.map(entry => entry.id)).toEqual([flushEntry]);
		await flushManager.close();

		const stallManager = await newSessionManager();
		const stalled = appendUser(stallManager, "Work that the shutdown deadline cuts.");
		await stallManager.flush();
		const gate = Promise.withResolvers<void>();
		scripts.push([
			chronicleTurn({ title: "Cut by the deadline" }),
			async () => {
				await gate.promise;
				return { content: [{ type: "toolCall", name: FINISH_TOOL, arguments: { carry: null } }] };
			},
			stopTurn,
		]);
		const stallRun = startChronicler(stallManager, newSettings());
		await waitForPassStart(1);
		await shutdown(stallRun, 300);

		// A late provider callback after the deadline cannot start a write.
		gate.resolve();
		await Bun.sleep(200);
		expect(await readCommitted(stallRun.root)).toEqual([]);

		const store = new ChroniclerStore(stallRun.root, {
			sessionId: stallManager.getSessionId(),
			project: cwd,
			model: "m",
		});
		await store.open();
		expect(store.processedEntryIds.has(stalled)).toBe(false);
		await stallManager.close();
	}, 60_000);

	it("reports an unresolved capture role once, consumes nothing, and captures after it is fixed", async () => {
		const manager = await newSessionManager();
		const entry = appendUser(manager, "Backlog waiting on a usable capture model.");
		await manager.flush();

		availableModels = [];
		const settings = newSettings();
		const harness = startChronicler(manager, settings);
		await Bun.sleep(150);
		harness.chronicler.onPrimaryTurnEnd(false);
		await Bun.sleep(150);

		expect(harness.chronicler.status).toBe("no_model");
		expect(passes).toHaveLength(0);
		expect(await readCommitted(harness.root)).toEqual([]);
		const warnings = harness.notices.filter(notice => notice.level === "warning");
		expect(warnings).toHaveLength(1);

		// Model configuration becomes available: the same backlog is captured.
		availableModels = [captureModel];
		scripts.push(beatPass({ title: "Captured after the role was fixed" }));
		settings.setModelRole("chronicler", CAPTURE_ROLE_VALUE);
		harness.chronicler.onPrimaryTurnEnd(false);

		const [batch] = await waitForBatches(harness.root, 1);
		expect(batch!.entries.map(source => source.id)).toEqual([entry]);
		expect(harness.chronicler.status).toBe("running");
	});

	it("captures every backlog entry exactly once, in bounded passes, with no history cap", async () => {
		const manager = await newSessionManager();
		const ids: string[] = [];
		for (let index = 0; index < 401; index++) ids.push(appendUser(manager, `backlog turn ${index}`));
		await manager.flush();
		expect(ids).toHaveLength(401);

		for (let index = 0; index < 40; index++) scripts.push(ackPass());
		const harness = startChronicler(manager, newSettings());
		await waitForCoverage(harness.root, ids, 60_000);

		const covered = await committedEntryIds(harness.root);
		expect(duplicates(covered)).toEqual([]);
		expect(new Set(covered)).toEqual(new Set(ids));
		// Bounded passes: at most 60 unseen entries are materialized per attempt.
		for (const pass of passes) expect(passSourceIds(pass).length).toBeLessThanOrEqual(60);
		expect(passes.length).toBeGreaterThanOrEqual(Math.ceil(401 / 60));
		// Every entry reached the model exactly once across all passes.
		expect(duplicates(passes.flatMap(passSourceIds))).toEqual([]);
	}, 90_000);

	it("reduces the materialized prefix to fit a small positive context window", async () => {
		const manager = await newSessionManager();
		const filler = "x".repeat(4_000);
		const ids: string[] = [];
		for (let index = 0; index < 12; index++) ids.push(appendUser(manager, `turn ${index} ${filler}`));
		await manager.flush();

		availableModels = [createMockModel({ id: CAPTURE_MODEL_ID, provider: "mock", contextWindow: 16_000 })];
		for (let index = 0; index < 20; index++) scripts.push(ackPass());
		const harness = startChronicler(manager, newSettings());
		await waitForCoverage(harness.root, ids);

		const perPass = passes.map(pass => passSourceIds(pass).length);
		expect(perPass.every(count => count > 0)).toBe(true);
		// The window forced a reduced prefix rather than one 12-entry request.
		expect(Math.max(...perPass)).toBeLessThan(12);
		expect(passes.length).toBeGreaterThan(1);
		expect(duplicates(await committedEntryIds(harness.root))).toEqual([]);
		expect(new Set(await committedEntryIds(harness.root))).toEqual(new Set(ids));
	}, 30_000);

	it("captures normally against a null context window using the generic working budget", async () => {
		const manager = await newSessionManager();
		const entry = appendUser(manager, "A model with no declared window still gets captured.");
		await manager.flush();

		const nullWindow: Model<Api> = { ...captureModel, contextWindow: null };
		availableModels = [nullWindow];
		scripts.push(beatPass({ title: "Captured without a declared window" }));
		const harness = startChronicler(manager, newSettings());

		const [batch] = await waitForBatches(harness.root, 1);
		expect(batch!.entries.map(source => source.id)).toEqual([entry]);
		expect(harness.chronicler.status).toBe("running");
	});

	it("pauses instead of skipping when one entry exceeds the capture input budget", async () => {
		const manager = await newSessionManager();
		const oversized = appendUser(manager, `oversized ${"y".repeat(600_000)}`);
		await manager.flush();

		const harness = startChronicler(manager, newSettings());
		const deadline = Date.now() + 20_000;
		while (harness.chronicler.status !== "halted") {
			if (Date.now() >= deadline) throw new Error(`Expected halt; status is ${harness.chronicler.status}`);
			await Bun.sleep(25);
		}

		expect(passes).toHaveLength(0);
		expect(await readCommitted(harness.root)).toEqual([]);
		expect(harness.notices.some(notice => notice.message.includes("exceeds the capture input budget"))).toBe(true);
		expect(harness.notices.some(notice => notice.message.includes("no entries were skipped"))).toBe(true);

		const store = new ChroniclerStore(harness.root, { sessionId: manager.getSessionId(), project: cwd, model: "m" });
		await store.open();
		expect(store.processedEntryIds.has(oversized)).toBe(false);
	}, 30_000);

	it("keeps a published batch and replays nothing when the derived caches cannot be written", async () => {
		const manager = await newSessionManager();
		const entry = appendUser(manager, "Publication succeeds even when the index cache cannot be written.");
		await manager.flush();

		// A directory squatting on the cache path fails the post-rename write.
		const root = chroniclerRoot(manager);
		await fs.mkdir(path.join(root, "INDEX.md"), { recursive: true });

		scripts.push(beatPass({ title: "Committed despite a cache failure" }));
		const harness = startChronicler(manager, newSettings());
		const [batch] = await waitForBatches(harness.root, 1);
		expect(batch!.entries.map(source => source.id)).toEqual([entry]);

		// The next wake finds no unseen work: no model replay of committed data.
		const before = passes.length;
		harness.chronicler.onPrimaryTurnEnd(false);
		await Bun.sleep(300);
		expect(passes).toHaveLength(before);
		await shutdown(harness, 2_000);

		const store = new ChroniclerStore(harness.root, { sessionId: manager.getSessionId(), project: cwd, model: "m" });
		await store.open();
		expect(store.processedEntryIds.has(entry)).toBe(true);
		expect(store.beats).toHaveLength(1);
	});

	it("serializes concurrent wakes on one session into single-coverage batches", async () => {
		const manager = await newSessionManager();
		const first = appendUser(manager, "First turn captured while later wakes queue.");
		await manager.flush();

		const gate = Promise.withResolvers<void>();
		scripts.push([
			async () => {
				await gate.promise;
				return { content: [{ type: "toolCall", name: FINISH_TOOL, arguments: { carry: null } }] };
			},
			stopTurn,
		]);
		for (let index = 0; index < 8; index++) scripts.push(ackPass());
		const harness = startChronicler(manager, newSettings());
		await waitForPassStart(0);

		// Pile on wakes and fresh entries while the first pass is held open.
		const queued: string[] = [];
		for (let index = 0; index < 5; index++) {
			queued.push(appendUser(manager, `queued turn ${index}`));
			harness.chronicler.onPrimaryTurnEnd(false);
		}
		await manager.flush();
		harness.chronicler.onPrimaryTurnEnd(undefined);
		harness.chronicler.onPrimaryTurnEnd(false);
		gate.resolve();

		const all = [first, ...queued];
		await waitForCoverage(harness.root, all);
		await shutdown(harness, 5_000);

		const covered = await committedEntryIds(harness.root);
		expect(duplicates(covered)).toEqual([]);
		expect(new Set(covered)).toEqual(new Set(all));
		// No queued scan re-sent an entry another pass already owned.
		const sent = passes.flatMap(passSourceIds);
		expect(duplicates(sent)).toEqual([]);
		expect(passSourceIds(passes[0]!)).toEqual([first]);
	}, 30_000);

	// ── persistence-order adaptation ────────────────────────────────────────

	it("parks a wake announced with a final message until that message is persisted", async () => {
		const manager = await newSessionManager();
		appendUser(manager, "Explain the rename tradeoff; do not edit.");
		await manager.flush();

		// The producer hands over its own object; the session persists a clone.
		const produced = assistantMessage("A wrapper would preserve the plugin API.");
		scripts.push(beatPass({ title: "Final answer captured" }));
		const harness = startChronicler(manager, newSettings());
		await waitForBatches(harness.root, 1);
		const finished = passes.length;

		const later = appendUser(manager, "Thanks.");
		harness.chronicler.onPrimaryTurnEnd(false, produced);
		await Bun.sleep(250);
		// The final assistant entry is not on the append history yet: no pass ran.
		expect(passes).toHaveLength(finished);

		const persisted = manager.appendMessage(structuredClone(produced));
		await manager.flush();
		scripts.push(beatPass({ title: "Captured after persistence" }));
		harness.chronicler.onPrimaryMessagePersisted(structuredClone(produced));

		const committed = await waitForBatches(harness.root, 2);
		expect(committed[1]!.entries.map(entry => entry.id)).toEqual([later, persisted]);
		expect(passSourceIds(passes[finished]!)).toEqual([later, persisted]);
		expect(passRequestText(passes[finished]!)).toContain("A wrapper would preserve the plugin API.");
	}, 30_000);

	it("captures a delayed tool-free final response once its entry lands", async () => {
		const manager = await newSessionManager();
		// The chronicler binds to an empty history first, so the only wake in this
		// test is the one announced with an unpersisted final message.
		const harness = startChronicler(manager, newSettings());
		await Bun.sleep(150);
		expect(passes).toHaveLength(0);

		const ask = appendUser(manager, "Read a.ts and tell me how many exports it has.");
		const result = appendToolResult(manager, "read", "export const a = 1;\nexport const b = 2;\nexport const c = 3;");
		await manager.flush();

		const produced = assistantMessage("a.ts has three exports.");
		harness.chronicler.onPrimaryTurnEnd(false, produced);
		await Bun.sleep(250);
		expect(passes).toHaveLength(0);
		expect(await readCommitted(harness.root)).toEqual([]);

		const finalId = manager.appendMessage(structuredClone(produced));
		await manager.flush();
		scripts.push(beatPass({ title: "Observed export count", kind: "mechanism" }));
		harness.chronicler.onPrimaryMessagePersisted(structuredClone(produced));

		const [batch] = await waitForBatches(harness.root, 1);
		expect(batch!.entries.map(entry => entry.id)).toEqual([ask, result, finalId]);
		expect(passRequestText(passes[0]!)).toContain("a.ts has three exports.");
	}, 30_000);

	it("captures and recovers a user intention when the primary fails before any assistant message", async () => {
		// Persistence is lazy: no assistant message ever lands, so nothing has
		// forced the session file to disk when capture is asked to preserve it.
		const manager = newLazySessionManager();
		const intention = appendUser(manager, "Keep the old name; a wrapper preserves the plugin API.");
		expect(manager.isSessionOnDisk()).toBe(false);

		scripts.push(beatPass({ title: "Unanswered intention", kind: "design-direction" }));
		const harness = startChronicler(manager, newSettings());
		harness.chronicler.onPrimaryTurnEnd(false);

		const [batch] = await waitForBatches(harness.root, 1);
		expect(batch!.entries.map(entry => entry.id)).toEqual([intention]);
		expect(batch!.sessionId).toBe(manager.getSessionId());
		await shutdown(harness);

		// The committed batch is recoverable from the same root after restart.
		const store = new ChroniclerStore(harness.root, { sessionId: manager.getSessionId(), project: cwd, model: "m" });
		await store.open();
		expect(store.processedEntryIds.has(intention)).toBe(true);
		expect(store.beats).toHaveLength(1);
		await manager.close();
	}, 30_000);
	it("retains successful model conversation but rebuilds when provider usage exhausts the working budget", async () => {
		const manager = await newSessionManager();
		const first = appendUser(manager, "first retained context marker");
		await manager.flush();
		scripts.push(ackPass());
		const harness = startChronicler(manager, newSettings());
		await waitForCoverage(harness.root, [first]);
		const second = appendUser(manager, "second retained context marker");
		await manager.flush();
		scripts.push([finishTurn(), { ...stopTurn, usage: { input: 145_000, output: 1, totalTokens: 145_001 } }]);
		harness.chronicler.onPrimaryTurnEnd(false);
		await waitForCoverage(harness.root, [second]);
		expect(passes[1]!.agent).toBe(passes[0]!.agent);
		expect(passConversationText(passes[1]!)).toContain("first retained context marker");
		expect(passSourceIds(passes[1]!)).toEqual([second]);
		const third = appendUser(manager, "third fresh context marker");
		await manager.flush();
		scripts.push(ackPass());
		harness.chronicler.onPrimaryTurnEnd(false);
		await waitForCoverage(harness.root, [third]);
		expect(passConversationText(passes[2]!)).not.toContain("first retained context marker");
		expect(passConversationText(passes[2]!)).not.toContain("second retained context marker");
		expect(passSourceIds(passes[2]!)).toEqual([third]);
		expect(duplicates(await committedEntryIds(harness.root))).toEqual([]);
	});

	it("defers a failed durable materialization and captures the same intention once after retry", async () => {
		const manager = newLazySessionManager();
		const entry = appendUser(manager, "undurable intention must not be consumed");
		const ensure = spyOn(manager, "ensureOnDisk");
		ensure.mockRejectedValue(new Error("injected materialization failure"));
		const settings = newSettings();
		const harness = startChronicler(manager, settings);
		try {
			await Bun.sleep(150);
			expect(ensure).toHaveBeenCalled();
			expect(passes).toHaveLength(0);
			expect(await readCommitted(harness.root)).toEqual([]);
		} finally {
			ensure.mockRestore();
		}
		scripts.push(ackPass());
		harness.chronicler.onPrimaryTurnEnd(false);
		await waitForCoverage(harness.root, [entry]);
		expect(manager.isSessionOnDisk()).toBe(true);
		const persisted = await fs.readFile(manager.getSessionFile()!, "utf8");
		expect(persisted).toContain(entry);
		expect(await committedEntryIds(harness.root)).toEqual([entry]);
		expect(passes).toHaveLength(1);
	});

	it("uses the generic working budget for an infinite context window rather than accepting an oversized entry", async () => {
		const manager = await newSessionManager();
		const entry = appendUser(manager, "z".repeat(180_000));
		await manager.flush();
		availableModels = [createMockModel({ id: CAPTURE_MODEL_ID, provider: "mock", contextWindow: Infinity })];
		const harness = startChronicler(manager, newSettings());
		await Bun.sleep(200);
		expect(harness.chronicler.status).toBe("halted");
		expect(passes).toHaveLength(0);
		expect(await committedEntryIds(harness.root)).not.toContain(entry);
		expect(harness.notices.map(notice => notice.message)).toContain(
			"Chronicler capture paused: one transcript entry exceeds the capture input budget; no entries were skipped.",
		);
	});

	it("bounds drain when the provider ignores abort and fences its released late tool calls", async () => {
		const manager = await newSessionManager();
		appendUser(manager, "provider ignores the abort signal");
		await manager.flush();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		scripts.push([
			async () => {
				entered.resolve();
				await release.promise;
				return { content: [{ type: "toolCall", name: FINISH_TOOL, arguments: { carry: null } }] };
			},
			stopTurn,
		]);
		ignoreProviderAbort = true;
		const harness = startChronicler(manager, newSettings());
		await entered.promise;
		// The provider's signal is removed; its promise remains pending past drain.
		let drained = false;
		const recorderFile = path.join(harness.root, "__chronicler.jsonl");
		let recorderAtDeadline: string | undefined;
		const draining = shutdown(harness, 50).then(() => {
			drained = true;
		});
		try {
			await Promise.race([draining, Bun.sleep(800)]);
			expect(drained).toBe(true);
			expect(await readCommitted(harness.root)).toEqual([]);
			recorderAtDeadline = await fs.readFile(recorderFile, "utf8");
		} finally {
			release.resolve();
			await draining;
		}
		await Bun.sleep(100);
		expect(await readCommitted(harness.root)).toEqual([]);
		expect(passes).toHaveLength(1);
		expect(await fs.readFile(recorderFile, "utf8")).toBe(recorderAtDeadline);
	});

	it("budgets the whole secret-safe provider request after expansion and never truncates entries", async () => {
		const manager = await newSessionManager();
		const ids = Array.from({ length: 6 }, (_, index) =>
			appendUser(manager, "entry " + index + " " + "secretxy ".repeat(120)),
		);
		await manager.flush();
		availableModels = [createMockModel({ id: CAPTURE_MODEL_ID, provider: "mock", contextWindow: 16_000 })];
		const replacement = "REDACTED".repeat(20);
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: "secretxy", mode: "replace", replacement },
				{ type: "plain", content: cwd, mode: "replace", replacement: "SAFE_PROJECT" },
			],
			"test-key",
		);
		for (let index = 0; index < 10; index++) scripts.push(ackPass());
		const harness = startChronicler(manager, newSettings(), obfuscator);
		await waitForCoverage(harness.root, ids);
		expect(passes.length).toBeGreaterThan(1);
		for (const pass of passes) {
			const context = pass.mock.calls[0]!.context;
			const tokenizer = pass.agent.tokenizer;
			const total =
				tokenizer.countTokens(context.systemPrompt ?? []) +
				tokenizer.countMessages(context.messages) +
				estimateToolSchemaTokens(context.tools ?? [], tokenizer);
			expect(total).toBeLessThanOrEqual(11_200);
			expect(JSON.stringify(context)).not.toContain("secretxy");
			expect(JSON.stringify(context.systemPrompt)).not.toContain(cwd);
			const text = passRequestText(pass);
			expect(text.split(replacement).length - 1).toBe(passSourceIds(pass).length * 120);
		}
		expect(new Set(await committedEntryIds(harness.root))).toEqual(new Set(ids));
	});

	it("captures actual AgentSession tool provenance and persists a tool-free final before its capture", async () => {
		const manager = newLazySessionManager();
		const primaryMock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", name: "read", arguments: {} }] },
				{ content: ["The observed file establishes the decision."], stopReason: "stop" },
			],
		});
		const primary = new Agent({
			getApiKey: () => "test-key",
			streamFn: primaryMock.stream,
			initialState: {
				model: primaryMock,
				systemPrompt: ["Primary"],
				tools: [
					{
						name: "read",
						label: "read",
						description: "Read fixture",
						parameters: Type.Object({}),
						execute: async () => ({
							content: [{ type: "text", text: "durable observed file result" }],
							details: {},
						}),
					},
				],
			},
		});
		const session = new AgentSession({
			agent: primary,
			sessionManager: manager,
			settings: newSettings(),
			modelRegistry,
			advisorTools: [],
		});
		session.subscribe(() => {});
		scripts.push(beatPass(), beatPass(), beatPass());
		try {
			await session.prompt("Please inspect the decision evidence.");
			await primary.waitForIdle();
			await manager.flush();
			const entries = manager.getEntries().filter(entry => entry.type === "message");
			const tool = entries.find(entry => entry.message.role === "toolResult");
			const final = entries.find(
				entry =>
					entry.message.role === "assistant" &&
					JSON.stringify(entry.message).includes("The observed file establishes"),
			);
			expect(tool).toBeDefined();
			expect(final).toBeDefined();
			await waitForCoverage(
				chroniclerRoot(manager),
				entries.map(entry => entry.id),
			);
			const batches = await readCommitted(chroniclerRoot(manager));
			const capturedTool = batches.flatMap(batch => batch.entries).find(entry => entry.id === tool!.id)!;
			expect(capturedTool.parentId).toBe(tool!.parentId);
			expect(batches.find(batch => batch.entries.some(entry => entry.id === tool!.id))!.sessionId).toBe(
				manager.getSessionId(),
			);
			expect(duplicates(batches.flatMap(batch => batch.entries.map(entry => entry.id)))).toEqual([]);
			const jsonl = await fs.readFile(manager.getSessionFile()!, "utf8");
			expect(jsonl).toContain(final!.id);
		} finally {
			await session.dispose();
		}
	});

	it("freezes queued session identity while the prior recorder is closing", async () => {
		const manager = await newSessionManager();
		const first = appendUser(manager, "first root settled");
		await manager.flush();
		scripts.push(ackPass(), ackPass(), ackPass());
		const harness = startChronicler(manager, newSettings());
		await waitForCoverage(harness.root, [first]);
		const closing = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const original = AdvisorTranscriptRecorder.prototype.close;
		let held = false;
		const closeSpy = spyOn(AdvisorTranscriptRecorder.prototype, "close").mockImplementation(
			async function (this: AdvisorTranscriptRecorder) {
				if (!held) {
					held = true;
					closing.resolve();
					await release.promise;
				}
				return original.call(this);
			},
		);
		try {
			await manager.newSession();
			const middleRoot = chroniclerRoot(manager);
			const middle = appendUser(manager, "middle root must never enter the final root");
			await manager.ensureOnDisk();
			await manager.flush();
			harness.chronicler.onPrimaryTurnEnd(false);
			await closing.promise;
			await manager.newSession();
			const last = appendUser(manager, "final root accepted during recorder close");
			await manager.ensureOnDisk();
			await manager.flush();
			const lastRoot = chroniclerRoot(manager);
			const lastSession = manager.getSessionId();
			harness.chronicler.onPrimaryTurnEnd(false);
			release.resolve();
			await waitForCoverage(lastRoot, [last]);
			const batches = await readCommitted(lastRoot);
			expect(batches.flatMap(batch => batch.entries.map(entry => entry.id))).toEqual([last]);
			expect(batches.map(batch => batch.sessionId)).toEqual([lastSession]);
			expect(await committedEntryIds(lastRoot)).not.toContain(middle);
			expect(await committedEntryIds(middleRoot)).not.toContain(last);
		} finally {
			release.resolve();
			closeSpy.mockRestore();
		}
	});

	it("does not capture appended JSONL entries when the durable writer flush rejects", async () => {
		const manager = await newSessionManager();
		const entry = appendUser(manager, "queued durable append");
		const flush = spyOn(manager, "flush").mockRejectedValue(new Error("injected writer failure"));
		const harness = startChronicler(manager, newSettings());
		try {
			await Bun.sleep(150);
			expect(flush).toHaveBeenCalled();
			expect(passes).toHaveLength(0);
			expect(await readCommitted(harness.root)).toEqual([]);
		} finally {
			flush.mockRestore();
		}
		scripts.push(ackPass());
		harness.chronicler.onPrimaryTurnEnd(false);
		await waitForCoverage(harness.root, [entry]);
		expect(await committedEntryIds(harness.root)).toEqual([entry]);
		expect(await fs.readFile(manager.getSessionFile()!, "utf8")).toContain(entry);
	});

	it("revokes during staged manifest IO before rename and retries only after the old publication settles", async () => {
		const manager = await newSessionManager();
		const entry = appendUser(manager, "publication revoked before rename");
		await manager.flush();
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const write = chroniclerStoreIO.writeArtifact;
		let held = false;
		const writeSpy = spyOn(chroniclerStoreIO, "writeArtifact").mockImplementation(async (file, text) => {
			if (!held && file.includes(".pending-") && file.endsWith("/COMMIT.json")) {
				held = true;
				reached.resolve();
				await release.promise;
			}
			return write(file, text);
		});
		const renameSpy = spyOn(chroniclerStoreIO, "rename");
		const settings = newSettings();
		scripts.push(beatPass(), ackPass());
		const harness = startChronicler(manager, settings);
		try {
			await reached.promise;
			expect(await readCommitted(harness.root)).toEqual([]);
			settings.override("chronicler.enabled", false);
			expect(harness.chronicler.status).toBe("off");
			settings.override("chronicler.enabled", true);
			await Bun.sleep(100);
			expect(passes).toHaveLength(1);
			expect(renameSpy).not.toHaveBeenCalled();
			release.resolve();
			await waitForCoverage(harness.root, [entry]);
			expect(passes).toHaveLength(2);
			expect(renameSpy).toHaveBeenCalledTimes(1);
			const batches = await readCommitted(harness.root);
			expect(batches).toHaveLength(1);
			expect(batches[0]!.beats).toEqual([]);
			expect(batches[0]!.entries.map(source => source.id)).toEqual([entry]);
		} finally {
			release.resolve();
			try {
				await shutdown(harness);
			} finally {
				writeSpy.mockRestore();
				renameSpy.mockRestore();
			}
		}
	});

	it("waits for already-started canonical rename settlement beyond the model deadline without replay", async () => {
		const manager = await newSessionManager();
		const entry = appendUser(manager, "canonical publication already started");
		await manager.flush();
		const published = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const rename = chroniclerStoreIO.rename;
		const renameSpy = spyOn(chroniclerStoreIO, "rename").mockImplementation(async (from, to) => {
			await rename(from, to);
			published.resolve();
			await release.promise;
		});
		scripts.push(beatPass());
		const harness = startChronicler(manager, newSettings());
		let draining: Promise<void> | undefined;
		try {
			await published.promise;
			expect(await committedEntryIds(harness.root)).toEqual([entry]);
			let drained = false;
			draining = shutdown(harness, 25).then(() => {
				drained = true;
			});
			await Bun.sleep(150);
			expect(drained).toBe(false);
			expect(passes).toHaveLength(1);
			release.resolve();
			await draining;
			expect(drained).toBe(true);
			expect(await committedEntryIds(harness.root)).toEqual([entry]);
			expect(renameSpy).toHaveBeenCalledTimes(1);
		} finally {
			release.resolve();
			try {
				await draining;
			} finally {
				renameSpy.mockRestore();
			}
		}
	});

	it("does not start a replacement model while a revoked abort-ignoring provider is unsettled", async () => {
		const manager = await newSessionManager();
		const entry = appendUser(manager, "revoked provider must settle before replacement");
		await manager.flush();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		ignoreProviderAbort = true;
		scripts.push(
			[
				async () => {
					entered.resolve();
					await release.promise;
					return stopTurn;
				},
			],
			ackPass(),
		);
		const settings = newSettings();
		const harness = startChronicler(manager, settings);
		try {
			await entered.promise;
			settings.override("chronicler.enabled", false);
			expect(harness.chronicler.status).toBe("off");
			settings.override("chronicler.enabled", true);
			await Bun.sleep(150);
			expect(passes).toHaveLength(1);
			expect(await readCommitted(harness.root)).toEqual([]);
			release.resolve();
			await waitForCoverage(harness.root, [entry]);
			expect(passes).toHaveLength(2);
			expect(await committedEntryIds(harness.root)).toEqual([entry]);
		} finally {
			release.resolve();
			await shutdown(harness);
		}
	});

	it("keeps ten simultaneous same-cwd AgentSession captures in their actual JSONL owners", async () => {
		const sessions: { session: AgentSession; manager: SessionManager; marker: string }[] = [];
		for (let index = 0; index < 10; index++) {
			const manager = newLazySessionManager();
			const mock = createMockModel({ responses: [{ content: ["ack"], stopReason: "stop" }] });
			const agent = new Agent({
				getApiKey: () => "test-key",
				streamFn: mock.stream,
				initialState: { model: mock, tools: [], systemPrompt: ["Primary"] },
			});
			const session = new AgentSession({
				agent,
				sessionManager: manager,
				settings: newSettings(),
				modelRegistry,
				advisorTools: [],
			});
			session.subscribe(() => {});
			sessions.push({ session, manager, marker: "owned intention number " + index });
			scripts.push(beatPass());
		}
		try {
			await Promise.all(sessions.map(({ session, marker }) => session.prompt(marker)));
			await Promise.all(
				sessions.map(async ({ manager }) => {
					await manager.flush();
					await waitForCoverage(
						chroniclerRoot(manager),
						manager
							.getEntries()
							.filter(entry => entry.type === "message")
							.map(entry => entry.id),
					);
				}),
			);
			expect(new Set(sessions.map(({ manager }) => manager.getSessionId())).size).toBe(10);
			expect(new Set(sessions.map(({ manager }) => chroniclerRoot(manager))).size).toBe(10);
			for (const { manager, marker } of sessions) {
				const owner = await headerIdOnDisk(manager.getSessionFile()!);
				expect(owner).toBe(manager.getSessionId());
				const root = chroniclerRoot(manager);
				expect(root).toBe(rootForSessionFile(manager.getSessionFile()!));
				const batches = await readCommitted(root);
				const actual = manager.getEntries().filter(entry => entry.type === "message");
				expect(new Set(batches.flatMap(batch => batch.entries.map(entry => entry.id)))).toEqual(
					new Set(actual.map(entry => entry.id)),
				);
				for (const batch of batches) {
					expect(batch.sessionId).toBe(owner);
					for (const source of batch.entries)
						expect(source.parentId).toBe(actual.find(entry => entry.id === source.id)!.parentId);
				}
				const request = passes.find(pass => passRequestText(pass).includes(marker));
				expect(request).toBeDefined();
				for (const other of sessions)
					if (other.manager !== manager) expect(passRequestText(request!)).not.toContain(other.marker);
			}
			await Promise.all(sessions.map(({ session }) => session.dispose()));
			for (const { manager } of sessions) {
				const root = chroniclerRoot(manager);
				const batches = await readCommitted(root);
				const state = JSON.parse(await fs.readFile(path.join(root, "state.json"), "utf8")) as {
					sessionId: string;
					lastEntryId: string;
					beatCount: number;
				};
				expect(state.sessionId).toBe(manager.getSessionId());
				expect(state.lastEntryId).toBe(batches.at(-1)!.entries.at(-1)!.id);
				expect(state.beatCount).toBe(batches.reduce((count, batch) => count + batch.beats.length, 0));
				const index = await fs.readFile(path.join(root, "INDEX.md"), "utf8");
				const links = [...index.matchAll(/\]\((beats\/[^)]+)\)/g)].map(match => decodeURI(match[1]!));
				const committedPaths = batches.flatMap(batch =>
					batch.beats.map(beat => "beats/" + batch.batchId + "/" + beat.file),
				);
				expect(new Set(links)).toEqual(new Set(committedPaths));
				for (const batch of batches) {
					for (const beat of batch.beats) {
						const raw = await readBeatFile(root, batch.batchId, beat.file);
						const metadata = parseFrontmatter(raw, { rawKeys: true, repair: false, level: "off" }).frontmatter;
						expect(metadata.id).toBe(beat.id);
						expect(metadata.batch).toBe(batch.batchId);
						expect(metadata.session).toBe(await headerIdOnDisk(manager.getSessionFile()!));
						expect(metadata.sources).toEqual(batch.entries.map(source => source.id));
					}
				}
			}
			const files = await fs.readdir(sessionDir, { recursive: true });
			expect(files.filter(file => /(?:^|\/)(?:\.pending-|[^/]*\.tmp$)/.test(file))).toEqual([]);
		} finally {
			await Promise.all(sessions.map(({ session }) => session.dispose()));
		}
	}, 30_000);

	it("records zero beats for an actual AgentSession acknowledgement", async () => {
		const manager = newLazySessionManager();
		const mock = createMockModel({ responses: [{ content: ["You're welcome."], stopReason: "stop" }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			streamFn: mock.stream,
			initialState: { model: mock, tools: [], systemPrompt: ["Primary"] },
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: newSettings(),
			modelRegistry,
			advisorTools: [],
		});
		session.subscribe(() => {});
		scripts.push(ackPass());
		try {
			await session.prompt("Thanks!");
			const ids = manager
				.getEntries()
				.filter(entry => entry.type === "message")
				.map(entry => entry.id);
			expect(ids).toHaveLength(2);
			await waitForCoverage(chroniclerRoot(manager), ids);
			expect((await readCommitted(chroniclerRoot(manager))).flatMap(batch => batch.beats)).toEqual([]);
		} finally {
			await session.dispose();
		}
	});

	it("durably captures the actual AgentSession user intention after the first primary provider failure", async () => {
		const manager = newLazySessionManager();
		const mock = createMockModel({ responses: [{ throw: "primary failed before assistant output" }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			streamFn: mock.stream,
			initialState: { model: mock, tools: [], systemPrompt: ["Primary"] },
		});
		const settings = newSettings();
		settings.override("retry.enabled", false);
		const session = new AgentSession({ agent, sessionManager: manager, settings, modelRegistry, advisorTools: [] });
		session.subscribe(() => {});
		scripts.push(beatPass());
		try {
			await session.prompt("Preserve this intention despite provider failure.").catch(() => {});
			const intention = manager
				.getEntries()
				.find(entry => entry.type === "message" && entry.message.role === "user")!;
			expect(intention).toBeDefined();
			await session.dispose();
			expect(await committedEntryIds(chroniclerRoot(manager))).toContain(intention.id);
			expect(await fs.readFile(manager.getSessionFile()!, "utf8")).toContain(intention.id);
		} finally {
			await session.dispose();
		}
	});

	it("forcibly excludes SDK taskDepth and parentTaskPrefix sessions while an ordinary UUID fork remains eligible", async () => {
		const parent = await newSessionManager();
		const inherited = appendUser(parent, "inherited top-level fork intention");
		await parent.flush();
		const fork = await SessionManager.forkFrom(parent.getSessionFile()!, cwd, sessionDir);
		expect(fork.getHeader()?.parentSession).toBe(parent.getSessionId());
		const makeSdk = async (
			manager: SessionManager,
			classification: { taskDepth?: number; parentTaskPrefix?: string },
		) => {
			const settings = newSettings();
			settings.override("async.enabled", false);
			return createAgentSession({
				cwd,
				agentDir: cwd,
				sessionManager: manager,
				authStorage,
				modelRegistry,
				settings,
				model: primaryModel,
				...classification,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			});
		};
		for (const classification of [{ taskDepth: 1 }, { parentTaskPrefix: "TestParent.Child" }]) {
			const manager = await newSessionManager();
			appendUser(manager, "subagent must not capture even explicitly enabled");
			await manager.flush();
			const { session } = await makeSdk(manager, classification);
			try {
				session.settings.override("chronicler.enabled", false);
				session.settings.override("chronicler.enabled", true);
				await session.dispose();
				expect(passes).toHaveLength(0);
				expect(await readCommitted(chroniclerRoot(manager))).toEqual([]);
			} finally {
				await session.dispose();
			}
		}
		scripts.push(ackPass());
		const { session } = await makeSdk(fork, {});
		try {
			await waitForCoverage(chroniclerRoot(fork), [inherited]);
			expect(passes).toHaveLength(1);
			expect((await readCommitted(chroniclerRoot(fork)))[0]!.sessionId).toBe(fork.getSessionId());
		} finally {
			await session.dispose();
			await parent.close();
		}
	}, 30_000);

	it("keeps path-based AgentSession branch captures child-owned without changing parent artifacts", async () => {
		const manager = newLazySessionManager();
		const mock = createMockModel({
			responses: [
				{ content: ["first response"], stopReason: "stop" },
				{ content: ["second response"], stopReason: "stop" },
				{ content: ["branched response"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			streamFn: mock.stream,
			initialState: { model: mock, tools: [], systemPrompt: ["Primary"] },
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: newSettings(),
			modelRegistry,
			advisorTools: [],
		});
		session.subscribe(() => {});
		for (let index = 0; index < 6; index++) scripts.push(beatPass());
		try {
			await session.prompt("first parent intention");
			await waitForCoverage(
				chroniclerRoot(manager),
				manager
					.getEntries()
					.filter(entry => entry.type === "message")
					.map(entry => entry.id),
			);
			await session.prompt("second parent intention to branch before");
			await waitForCoverage(
				chroniclerRoot(manager),
				manager
					.getEntries()
					.filter(entry => entry.type === "message")
					.map(entry => entry.id),
			);
			const sourceFile = manager.getSessionFile()!;
			const sourceId = manager.getSessionId();
			const sourceRoot = chroniclerRoot(manager);
			const parentBatches = await readCommitted(sourceRoot);
			const parentFiles = await Promise.all(
				parentBatches.flatMap(batch =>
					["COMMIT.json", ...batch.beats.map(beat => beat.file)].map(async name => {
						const file = path.join(sourceRoot, "beats", batch.batchId, name);
						return { file, content: await fs.readFile(file, "utf8") };
					}),
				),
			);
			const secondUser = session
				.getUserMessagesForBranching()
				.find(message => message.text === "second parent intention to branch before")!;
			const branch = await session.branch(secondUser.entryId);
			expect(branch.cancelled).toBe(false);
			expect(manager.getHeader()?.parentSession).toBe(sourceFile);
			expect(await headerIdOnDisk(manager.getHeader()!.parentSession!)).toBe(sourceId);
			expect(chroniclerRoot(manager)).not.toBe(sourceRoot);
			const childId = manager.getSessionId();
			expect(childId).not.toBe(sourceId);
			await session.prompt("new child intention after actual branch");
			const childEntries = manager.getEntries().filter(entry => entry.type === "message");
			expect(childEntries.some(entry => JSON.stringify(entry.message).includes("new child intention"))).toBe(true);
			expect(childEntries.some(entry => JSON.stringify(entry.message).includes("first parent intention"))).toBe(
				true,
			);
			await waitForCoverage(
				chroniclerRoot(manager),
				childEntries.map(entry => entry.id),
			);
			const childBatches = await readCommitted(chroniclerRoot(manager));
			const childJsonl = await fs.readFile(manager.getSessionFile()!, "utf8");
			for (const batch of childBatches) {
				expect(batch.sessionId).toBe(childId);
				for (const source of batch.entries) {
					expect(childEntries.find(entry => entry.id === source.id)?.parentId).toBe(source.parentId);
					expect(childJsonl).toContain(source.id);
				}
			}
			expect(await readCommitted(sourceRoot)).toEqual(parentBatches);
			for (const parentFile of parentFiles)
				expect(await fs.readFile(parentFile.file, "utf8")).toBe(parentFile.content);
		} finally {
			await session.dispose();
		}
	}, 30_000);

	it("parks an actual tool-free final behind an awaited extension event and captures it only after persistence", async () => {
		const manager = newLazySessionManager();
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("message_end", async event => {
					if (event.message.role === "assistant") {
						reached.resolve();
						await release.promise;
					}
				});
			},
			cwd,
			new EventBus(),
			runtime,
			"delayed-final-persistence",
		);
		const extensionRunner = new ExtensionRunner([extension], runtime, cwd, manager, modelRegistry);
		const mock = createMockModel({ responses: [{ content: ["delayed final evidence"], stopReason: "stop" }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			streamFn: mock.stream,
			initialState: { model: mock, tools: [], systemPrompt: ["Primary"] },
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: newSettings(),
			modelRegistry,
			advisorTools: [],
			extensionRunner,
		});
		session.subscribe(() => {});
		scripts.push(beatPass(), beatPass());
		const prompting = session.prompt("intention preceding delayed final");
		try {
			await reached.promise;
			await Bun.sleep(100);
			expect(agent.state.messages.some(message => message.role === "assistant")).toBe(true);
			expect(
				manager.getEntries().some(entry => entry.type === "message" && entry.message.role === "assistant"),
			).toBe(false);
			expect(passes.some(pass => passRequestText(pass).includes("delayed final evidence"))).toBe(false);
			release.resolve();
			await prompting;
			await session.settleInFlightMessagePersistence();
			const final = manager
				.getEntries()
				.find(entry => entry.type === "message" && entry.message.role === "assistant")!;
			expect(final).toBeDefined();
			await waitForCoverage(chroniclerRoot(manager), [final.id]);
			expect(passes.flatMap(passSourceIds).filter(id => id === final.id)).toEqual([final.id]);
			expect(await fs.readFile(manager.getSessionFile()!, "utf8")).toContain(final.id);
		} finally {
			release.resolve();
			await prompting;
			await session.dispose();
		}
	});

	it("rebuilds locally full retained context before reducing a prefix that fits fresh context", async () => {
		const manager = await newSessionManager();
		availableModels = [createMockModel({ id: CAPTURE_MODEL_ID, provider: "mock", contextWindow: 16_000 })];
		const first = appendUser(manager, "locally-heavy-old-entry " + "a".repeat(20_000));
		await manager.flush();
		scripts.push(ackPass());
		const harness = startChronicler(manager, newSettings());
		await waitForCoverage(harness.root, [first]);
		const firstContext = passes[0]!.mock.calls[0]!.context;
		const tokenizer = passes[0]!.agent.tokenizer;
		const oldMessages = [...passes[0]!.agent.state.messages];
		const next = Array.from({ length: 2 }, (_, index) =>
			appendUser(manager, "fresh-prefix-" + index + " " + "b".repeat(12_000)),
		);
		await manager.flush();
		scripts.push(ackPass(), ackPass());
		harness.chronicler.onPrimaryTurnEnd(false);
		await waitForCoverage(harness.root, next);
		expect(passes).toHaveLength(2);
		expect(passSourceIds(passes[1]!)).toEqual(next);
		expect(passConversationText(passes[1]!)).not.toContain("locally-heavy-old-entry");
		const incoming = tokenizer.countMessage({ role: "user", content: passRequestText(passes[1]!), timestamp: 0 });
		const framing =
			tokenizer.countTokens(firstContext.systemPrompt ?? []) +
			estimateToolSchemaTokens(firstContext.tools ?? [], tokenizer);
		expect(framing + incoming).toBeLessThanOrEqual(11_200);
		expect(framing + incoming + tokenizer.countMessages(oldMessages)).toBeGreaterThan(11_200);
		// Reported usage is zero; this rebuild is compelled by local retained bytes.
		expect(
			oldMessages.filter(message => message.role === "assistant").every(message => message.usage.totalTokens === 0),
		).toBe(true);
	});
});
