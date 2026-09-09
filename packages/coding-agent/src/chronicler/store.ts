/**
 * Transactional Chronicler store.
 *
 * Committed history is a set of immutable batch directories beneath
 * `<root>/beats`. Each batch holds one `COMMIT.json` checkpoint plus the beat
 * markdown files it lists, and becomes visible at a single `fs.rename` of its
 * private staging directory. There is no partially visible batch: a crash
 * before the rename leaves only `beats/.pending-<batchId>` (ignored on the next
 * open, so the transcript is retried), and a crash after it leaves a complete
 * checkpoint whose entries are never replayed.
 *
 * `INDEX.md` and `state.json` are derived caches. They are rebuilt from the
 * committed manifests and are never consulted as the commit authority, so
 * losing or corrupting them cannot lose or duplicate history.
 *
 * The durability guarantee is process interruption and restart on a local
 * filesystem. `rename` without `fsync` is not a power-loss claim.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { writeArtifact } from "../session/artifacts";

/** Keep staged-file writes and directory publication separately observable. */
export const chroniclerStoreIO = {
	writeArtifact,
	rename: (staging: string, destination: string): Promise<void> => fs.rename(staging, destination),
};

export type BeatKind =
	| "anecdote"
	| "concept"
	| "mechanism"
	| "decision"
	| "design-direction"
	| "open-question"
	| "experiment"
	| "reflection"
	| "correction";

/** Every beat kind, in the order tool schemas and prompts should present them. */
export const CHRONICLER_BEAT_KINDS: readonly BeatKind[] = [
	"anecdote",
	"concept",
	"mechanism",
	"decision",
	"design-direction",
	"open-question",
	"experiment",
	"reflection",
	"correction",
];

export interface BeatInput {
	title: string;
	kind: BeatKind;
	body: string;
	topics: string[];
	eventTime: string;
	sources: string[];
	related: string[];
	supersedes?: string;
	uncertainty?: string;
}

export interface BeatRecord extends BeatInput {
	id: string;
	path: string;
	sessionId: string;
	capturedAt: string;
	model: string;
}

export interface CaptureSource {
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface CaptureCheckpoint {
	version: 1;
	batchId: string;
	sessionId: string;
	committedAt: string;
	entries: CaptureSource[];
	beats: { id: string; file: string }[];
	carry: { sources: string[]; text: string } | null;
}

export interface CaptureBatch {
	id: string;
	entries: readonly CaptureSource[];
	beats: BeatRecord[];
	carry: { sources: string[]; text: string } | null;
	finalized: boolean;
	revoked: boolean;
}

/** Optional host notification seam; the store always logs as well. */
export interface ChroniclerStoreHooks {
	warn?(message: string, detail?: Record<string, unknown>): void;
}

/**
 * Committed data on disk disagrees with itself. Capture halts and every file is
 * preserved: the store never rewrites, deletes, or recaptures over corruption.
 */
export class ChroniclerCorruptionError extends Error {
	constructor(
		readonly reason: string,
		readonly file?: string,
	) {
		super(file ? `Chronicler store halted: ${reason} (${file})` : `Chronicler store halted: ${reason}`);
		this.name = "ChroniclerCorruptionError";
	}
}

export function isChroniclerCorruption(error: unknown): error is ChroniclerCorruptionError {
	return error instanceof ChroniclerCorruptionError;
}

const BEAT_SCHEMA_VERSION = 1;
const CHECKPOINT_VERSION = 1;
const MANIFEST_FILE = "COMMIT.json";
const INDEX_FILE = "INDEX.md";
const STATE_FILE = "state.json";
const STAGING_PREFIX = ".pending-";
const MAX_SLUG = 60;
const MAX_CARRY_CHARS = 8000;
const MAX_INDEX_SOURCE_IDS = 6;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BEAT_FILE_RE = /^[0-9A-Za-z][0-9A-Za-z._-]*\.md$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?$/;
const BEAT_KIND_SET: ReadonlySet<string> = new Set<string>(CHRONICLER_BEAT_KINDS);

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/** Canonical UTC ISO form, or null when the value is not a usable timestamp. */
function normalizeTimestamp(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!ISO_RE.test(trimmed)) return null;
	const parsed = Date.parse(trimmed);
	if (Number.isNaN(parsed)) return null;
	return new Date(parsed).toISOString();
}

function stringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const out: string[] = [];
	for (const item of value) {
		if (!isNonEmptyString(item)) return null;
		out.push(item.trim());
	}
	return out;
}

function compactTimestamp(iso: string): string {
	return iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function slugifyTitle(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_SLUG)
		.replace(/-+$/g, "");
	return slug.length > 0 ? slug : "beat";
}

function isSimpleBeatFilename(file: unknown): file is string {
	return (
		typeof file === "string" &&
		BEAT_FILE_RE.test(file) &&
		!file.includes("/") &&
		!file.includes("\\") &&
		!file.includes("..") &&
		file === path.basename(file)
	);
}

function escapeCell(value: string): string {
	return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function freezeCarry(carry: { sources: string[]; text: string } | null): { sources: string[]; text: string } | null {
	if (!carry) return null;
	return Object.freeze({
		sources: Object.freeze([...carry.sources]) as unknown as string[],
		text: carry.text,
	});
}

function freezeRecord(record: BeatRecord): BeatRecord {
	Object.freeze(record.topics);
	Object.freeze(record.sources);
	Object.freeze(record.related);
	return Object.freeze(record);
}

function sameSource(a: CaptureSource, b: CaptureSource): boolean {
	return a.parentId === b.parentId && a.timestamp === b.timestamp;
}

interface LoadedBatch {
	checkpoint: CaptureCheckpoint;
	records: BeatRecord[];
}

/**
 * One serialized owner per store instance; distinct sessions use distinct
 * artifact roots and therefore need no shared lock.
 */
export class ChroniclerStore {
	readonly #root: string;
	readonly #beatsDir: string;
	readonly #meta: { sessionId: string; project: string; model: string };
	readonly #hooks: ChroniclerStoreHooks;

	#opened = false;
	#haltReason: string | null = null;

	#records: BeatRecord[] = [];
	#processed = new Set<string>();
	#sources = new Map<string, CaptureSource>();
	#carry: { sources: string[]; text: string } | null = null;
	#committedBatchIds = new Set<string>();
	#beatIds = new Set<string>();
	#lastEntryId: string | null = null;

	/** Latest committed manifest per session, in commit order, for carry recovery. */
	#ownCarry: { sources: string[]; text: string } | null = null;
	#ownCarrySeen = false;
	#inheritedCarry: { sources: string[]; text: string } | null = null;

	#recordsView: readonly BeatRecord[] | null = null;
	#processedView: ReadonlySet<string> | null = null;
	#sourcesView: ReadonlyMap<string, CaptureSource> | null = null;

	#ownBatches = new WeakSet<CaptureBatch>();
	#committedBatches = new WeakSet<CaptureBatch>();

	constructor(
		rootDir: string,
		meta: { sessionId: string; project: string; model: string },
		hooks: ChroniclerStoreHooks = {},
	) {
		this.#root = rootDir;
		this.#beatsDir = path.join(rootDir, "beats");
		this.#meta = { ...meta };
		this.#hooks = hooks;
	}

	get beats(): readonly BeatRecord[] {
		this.#recordsView ??= Object.freeze([...this.#records]);
		return this.#recordsView;
	}

	get processedEntryIds(): ReadonlySet<string> {
		this.#processedView ??= new Set(this.#processed);
		return this.#processedView;
	}

	get sourceEntries(): ReadonlyMap<string, CaptureSource> {
		this.#sourcesView ??= new Map(this.#sources);
		return this.#sourcesView;
	}

	get carry(): { sources: string[]; text: string } | null {
		return this.#carry;
	}

	/**
	 * Load every committed batch, rebuild the processed-entry union and the
	 * derived caches. Staging directories and unreferenced files are preserved
	 * but never indexed; malformed committed data halts capture instead of being
	 * silently skipped and recaptured over.
	 */
	async open(): Promise<void> {
		this.#assertNotHalted();
		await fs.mkdir(this.#beatsDir, { recursive: true });

		const entries = await fs.readdir(this.#beatsDir, { withFileTypes: true });
		const loaded: LoadedBatch[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.name.startsWith(STAGING_PREFIX)) continue;
			if (!UUID_RE.test(entry.name)) continue;
			loaded.push(await this.#loadBatch(entry.name));
		}

		loaded.sort((a, b) => {
			if (a.checkpoint.committedAt !== b.checkpoint.committedAt) {
				return a.checkpoint.committedAt < b.checkpoint.committedAt ? -1 : 1;
			}
			return a.checkpoint.batchId < b.checkpoint.batchId ? -1 : a.checkpoint.batchId > b.checkpoint.batchId ? 1 : 0;
		});

		this.#records = [];
		this.#processed = new Set();
		this.#sources = new Map();
		this.#committedBatchIds = new Set();
		this.#beatIds = new Set();
		this.#lastEntryId = null;
		this.#ownCarry = null;
		this.#ownCarrySeen = false;
		this.#inheritedCarry = null;

		for (const batch of loaded) this.#absorb(batch);
		this.#invalidateViews();

		// Committed provenance must be complete. A beat, relation, or carry that
		// points at metadata no longer on disk is malformed committed data, not a
		// recoverable cache miss: capture halts rather than recapturing over it.
		for (const record of this.#records) {
			const dangling = record.sources.filter(id => !this.#sources.has(id));
			if (dangling.length > 0) {
				throw this.#halt(
					`beat ${record.id} cites source entries with no committed metadata (${dangling.join(", ")})`,
					record.path,
				);
			}
			for (const ref of record.related) {
				if (ref === record.id) {
					throw this.#halt(`beat ${record.id} relates to itself`, record.path);
				}
				if (!this.#beatIds.has(ref)) {
					throw this.#halt(`beat ${record.id} relates to unknown beat ${ref}`, record.path);
				}
			}
			if (record.supersedes === record.id) {
				throw this.#halt(`beat ${record.id} supersedes itself`, record.path);
			}
			if (record.supersedes && !this.#beatIds.has(record.supersedes)) {
				throw this.#halt(`beat ${record.id} supersedes unknown beat ${record.supersedes}`, record.path);
			}
		}
		for (const { checkpoint } of loaded) {
			if (!checkpoint.carry) continue;
			const dangling = checkpoint.carry.sources.filter(id => !this.#sources.has(id));
			if (dangling.length > 0) {
				throw this.#halt(
					`batch ${checkpoint.batchId} carry cites source entries with no committed metadata (${dangling.join(", ")})`,
					path.join(this.#beatsDir, checkpoint.batchId, MANIFEST_FILE),
				);
			}
		}

		this.#opened = true;

		await this.#refreshCaches();
	}

	/** Reserve a batch identity and freeze a copy of the supplied source metadata. */
	beginBatch(entries: readonly CaptureSource[]): CaptureBatch {
		this.#assertUsable();
		const copied: CaptureSource[] = [];
		const seen = new Set<string>();
		for (const entry of entries) {
			if (!isNonEmptyString(entry?.id))
				throw new Error("Chronicler batch: source entry id must be a nonempty string");
			const id = entry.id.trim();
			if (seen.has(id)) throw new Error(`Chronicler batch: duplicate source entry ${id}`);
			if (this.#processed.has(id)) throw new Error(`Chronicler batch: entry ${id} is already committed`);
			if (entry.parentId !== null && !isNonEmptyString(entry.parentId)) {
				throw new Error(`Chronicler batch: entry ${id} has an invalid parentId`);
			}
			if (!normalizeTimestamp(entry.timestamp)) {
				throw new Error(`Chronicler batch: entry ${id} has an invalid timestamp`);
			}
			seen.add(id);
			// Timestamps stay verbatim: the checkpoint is the provenance record of
			// what the session actually reported, not a reformatting of it.
			copied.push(
				Object.freeze({
					id,
					parentId: entry.parentId === null ? null : entry.parentId.trim(),
					timestamp: entry.timestamp.trim(),
				}),
			);
		}

		const batch: CaptureBatch = {
			id: Bun.randomUUIDv7(),
			entries: Object.freeze(copied),
			beats: [],
			carry: null,
			finalized: false,
			revoked: false,
		};
		this.#ownBatches.add(batch);
		return batch;
	}

	/**
	 * Validate one model-authored beat and collect it in memory. Nothing is
	 * written until {@link commitBatch}.
	 */
	stageBeat(batch: CaptureBatch, input: BeatInput): BeatRecord {
		this.#assertUsable();
		this.#assertStageable(batch);

		const title = isNonEmptyString(input.title) ? input.title.trim() : null;
		if (!title) throw new Error("Chronicler beat: title must be a nonempty string");
		const body = typeof input.body === "string" ? input.body.trim() : "";
		if (body.length === 0) throw new Error("Chronicler beat: body must be a nonempty string");
		if (!BEAT_KIND_SET.has(input.kind)) throw new Error(`Chronicler beat: unknown kind ${String(input.kind)}`);

		const eventTime = normalizeTimestamp(input.eventTime);
		if (!eventTime) throw new Error("Chronicler beat: eventTime must be an ISO timestamp");

		const topics = stringArray(input.topics ?? []);
		if (!topics) throw new Error("Chronicler beat: topics must be an array of nonempty strings");

		const known = this.#knownSources(batch);
		const sources = stringArray(input.sources ?? []);
		if (!sources) throw new Error("Chronicler beat: sources must be an array of nonempty strings");
		if (sources.length === 0) throw new Error("Chronicler beat: at least one source entry id is required");
		const uniqueSources = new Set(sources);
		if (uniqueSources.size !== sources.length) throw new Error("Chronicler beat: duplicate source entry ids");
		for (const id of sources) {
			if (!known.has(id)) throw new Error(`Chronicler beat: unknown source entry ${id}`);
		}

		const id = Bun.randomUUIDv7();
		const relatable = this.#relatableBeatIds(batch);
		const related = stringArray(input.related ?? []);
		if (!related) throw new Error("Chronicler beat: related must be an array of nonempty strings");
		for (const ref of related) {
			if (ref === id) throw new Error("Chronicler beat: related cannot reference the beat itself");
			if (!relatable.has(ref)) throw new Error(`Chronicler beat: unknown related beat ${ref}`);
		}

		let supersedes: string | undefined;
		if (input.supersedes !== undefined && input.supersedes !== null) {
			if (!isNonEmptyString(input.supersedes)) throw new Error("Chronicler beat: supersedes must be a beat id");
			supersedes = input.supersedes.trim();
			if (supersedes === id) throw new Error("Chronicler beat: supersedes cannot reference the beat itself");
			if (!relatable.has(supersedes)) throw new Error(`Chronicler beat: unknown superseded beat ${supersedes}`);
		}

		let uncertainty: string | undefined;
		if (input.uncertainty !== undefined && input.uncertainty !== null) {
			if (!isNonEmptyString(input.uncertainty))
				throw new Error("Chronicler beat: uncertainty must be nonempty text");
			uncertainty = input.uncertainty.trim();
		}

		const file = `${compactTimestamp(eventTime)}-${slugifyTitle(title)}-${id}.md`;
		const record = freezeRecord({
			id,
			path: `beats/${batch.id}/${file}`,
			sessionId: this.#meta.sessionId,
			capturedAt: new Date().toISOString(),
			model: this.#meta.model,
			title,
			kind: input.kind,
			body,
			topics,
			eventTime,
			sources,
			related,
			...(supersedes ? { supersedes } : {}),
			...(uncertainty ? { uncertainty } : {}),
		});
		batch.beats.push(record);
		return record;
	}

	/**
	 * Publish a finalized batch. Beat files and the checkpoint are written into a
	 * private staging directory, then one `fs.rename` makes them visible
	 * together. Everything before the rename leaves the batch's entries
	 * unprocessed; nothing after it can turn a committed batch into a retry.
	 */
	async commitBatch(batch: CaptureBatch): Promise<void> {
		this.#assertUsable();
		this.#assertOwned(batch);
		if (this.#committedBatches.has(batch)) {
			throw new Error(`Chronicler batch ${batch.id} is already committed`);
		}
		if (batch.revoked) throw new Error(`Chronicler batch ${batch.id} was revoked`);
		if (!batch.finalized) throw new Error(`Chronicler batch ${batch.id} was not finalized by the capture pass`);
		if (this.#committedBatchIds.has(batch.id)) {
			throw new ChroniclerCorruptionError(`batch id ${batch.id} is already committed on disk`, batch.id);
		}
		this.#assertBatchCurrent(batch);

		const checkpoint = this.#buildCheckpoint(batch);
		const staging = path.join(this.#beatsDir, `${STAGING_PREFIX}${batch.id}`);
		const destination = path.join(this.#beatsDir, batch.id);

		await fs.mkdir(this.#beatsDir, { recursive: true });
		await fs.mkdir(staging);
		try {
			for (const record of batch.beats) {
				await chroniclerStoreIO.writeArtifact(
					path.join(staging, path.basename(record.path)),
					this.#renderBeatFile(batch.id, record),
				);
			}
			await chroniclerStoreIO.writeArtifact(
				path.join(staging, MANIFEST_FILE),
				`${JSON.stringify(checkpoint, null, "\t")}\n`,
			);
			await this.#publish(staging, destination, checkpoint, () => {
				if (batch.revoked) {
					throw new Error(`Chronicler batch ${batch.id} was revoked before publication`);
				}
				this.#assertBatchCurrent(batch);
			});
		} catch (error) {
			// The attempt's own staging is not history; only the destination is
			// preserved. A crash (rather than a thrown failure) may leave staging
			// behind, which `open()` ignores.
			await fs.rm(staging, { recursive: true, force: true });
			throw error;
		}

		this.#committedBatches.add(batch);
		this.#absorb({
			checkpoint,
			records: batch.beats.map(record => freezeRecord({ ...record })),
		});
		this.#invalidateViews();
		Object.freeze(batch.beats);
		Object.freeze(batch);

		await this.#refreshCaches();
	}

	/**
	 * The single publication point. A rename failure is resolved by reading the
	 * destination back: only a manifest exactly matching this attempt counts as
	 * committed. Any other occupant is preserved untouched.
	 */
	async #publish(
		staging: string,
		destination: string,
		checkpoint: CaptureCheckpoint,
		assertPublishable: () => void,
	): Promise<void> {
		// `rename` would silently replace an empty destination directory, so a
		// batch-identity collision has to be rejected before it is attempted.
		if (await this.#pathExists(destination)) {
			throw new Error(`Chronicler publication destination ${destination} already exists; refusing to overwrite it`);
		}
		// Revocation or a competing commit can land while the precheck above
		// awaits, so the last look must sit immediately before the rename: that is
		// the point of no return.
		assertPublishable();
		try {
			await chroniclerStoreIO.rename(staging, destination);
			return;
		} catch (error) {
			const readback = await this.#readManifest(destination);
			if (readback && this.#manifestMatches(readback, checkpoint)) {
				// The rename landed despite the reported failure. Accept it only once
				// the destination's beat files load and validate too: a matching
				// manifest over unreadable beats is corruption, not a publication.
				await this.#loadBatch(checkpoint.batchId);
				await fs.rm(staging, { recursive: true, force: true });
				return;
			}
			if (readback) {
				throw this.#halt(
					`publication destination already holds a different committed batch (${readback.batchId})`,
					destination,
				);
			}
			if (await this.#pathExists(destination)) {
				throw this.#halt("publication destination exists but holds no readable checkpoint", destination);
			}
			throw error;
		}
	}

	#buildCheckpoint(batch: CaptureBatch): CaptureCheckpoint {
		const known = this.#knownSources(batch);
		const beats: { id: string; file: string }[] = [];
		const beatIds = new Set<string>();
		const files = new Set<string>();
		for (const record of batch.beats) {
			const file = path.basename(record.path);
			if (!isSimpleBeatFilename(file) || record.path !== `beats/${batch.id}/${file}`) {
				throw new Error(`Chronicler batch ${batch.id}: beat ${record.id} has an unusable path ${record.path}`);
			}
			if (beatIds.has(record.id)) throw new Error(`Chronicler batch ${batch.id}: duplicate beat id ${record.id}`);
			if (this.#beatIds.has(record.id)) {
				throw new Error(`Chronicler batch ${batch.id}: beat id ${record.id} is already committed`);
			}
			if (files.has(file)) throw new Error(`Chronicler batch ${batch.id}: duplicate beat file ${file}`);
			for (const source of record.sources) {
				if (!known.has(source)) {
					throw new Error(`Chronicler batch ${batch.id}: beat ${record.id} cites unknown source ${source}`);
				}
			}
			beatIds.add(record.id);
			files.add(file);
			beats.push({ id: record.id, file });
		}

		let carry: { sources: string[]; text: string } | null = null;
		if (batch.carry) {
			const text = typeof batch.carry.text === "string" ? batch.carry.text.trim() : "";
			const sources = stringArray(batch.carry.sources ?? []);
			if (!sources) throw new Error(`Chronicler batch ${batch.id}: carry sources must be nonempty strings`);
			if (text.length > MAX_CARRY_CHARS) {
				throw new Error(`Chronicler batch ${batch.id}: carry text exceeds ${MAX_CARRY_CHARS} characters`);
			}
			for (const source of sources) {
				if (!known.has(source)) {
					throw new Error(`Chronicler batch ${batch.id}: carry cites unknown source ${source}`);
				}
			}
			if (text.length > 0) carry = { sources, text };
		}

		return {
			version: CHECKPOINT_VERSION,
			batchId: batch.id,
			sessionId: this.#meta.sessionId,
			committedAt: new Date().toISOString(),
			entries: batch.entries.map(entry => ({ ...entry })),
			beats,
			carry,
		};
	}

	#renderBeatFile(batchId: string, record: BeatRecord): string {
		const fields: [string, unknown][] = [
			["schema", BEAT_SCHEMA_VERSION],
			["id", record.id],
			["batch", batchId],
			["title", record.title],
			["kind", record.kind],
			["event_time", record.eventTime],
			["captured_at", record.capturedAt],
			["session", record.sessionId],
			["project", this.#meta.project],
			["sources", [...record.sources]],
			["topics", [...record.topics]],
			["related", [...record.related]],
			["model", record.model],
		];
		if (record.supersedes) fields.push(["supersedes", record.supersedes]);
		if (record.uncertainty) fields.push(["uncertainty", record.uncertainty]);
		const frontmatter = fields.map(([key, value]) => `${key}: ${YAML.stringify(value)}`).join("\n");
		return `---\n${frontmatter}\n---\n\n# ${record.title}\n\n${record.body}\n`;
	}

	async #loadBatch(batchId: string): Promise<LoadedBatch> {
		const dir = path.join(this.#beatsDir, batchId);
		const manifestPath = path.join(dir, MANIFEST_FILE);
		let raw: string;
		try {
			raw = await Bun.file(manifestPath).text();
		} catch (error) {
			throw this.#halt(`committed batch is missing its ${MANIFEST_FILE} (${String(error)})`, manifestPath);
		}
		const checkpoint = this.#parseCheckpoint(raw, batchId, manifestPath);

		const records: BeatRecord[] = [];
		const seen = new Set<string>();
		for (const listed of checkpoint.beats) {
			if (seen.has(listed.id)) {
				throw this.#halt(`manifest lists beat ${listed.id} twice`, manifestPath);
			}
			seen.add(listed.id);
			records.push(await this.#loadBeat(checkpoint, listed, path.join(dir, listed.file)));
		}
		return { checkpoint, records };
	}

	#parseCheckpoint(raw: string, batchId: string, file: string): CaptureCheckpoint {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw this.#halt(`checkpoint is not valid JSON (${String(error)})`, file);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw this.#halt("checkpoint is not a JSON object", file);
		}
		const record = parsed as Record<string, unknown>;
		if (record.version !== CHECKPOINT_VERSION) {
			throw this.#halt(`unknown checkpoint version ${String(record.version)}`, file);
		}
		if (record.batchId !== batchId) {
			throw this.#halt(`checkpoint batchId ${String(record.batchId)} does not match its directory`, file);
		}
		if (!isNonEmptyString(record.sessionId)) throw this.#halt("checkpoint sessionId is missing", file);
		const committedAt = normalizeTimestamp(record.committedAt);
		if (!committedAt) throw this.#halt("checkpoint committedAt is not a timestamp", file);

		if (!Array.isArray(record.entries)) throw this.#halt("checkpoint entries is not an array", file);
		const entries: CaptureSource[] = [];
		const entryIds = new Set<string>();
		for (const item of record.entries) {
			if (typeof item !== "object" || item === null || Array.isArray(item)) {
				throw this.#halt("checkpoint entry is not an object", file);
			}
			const entry = item as Record<string, unknown>;
			if (!isNonEmptyString(entry.id)) throw this.#halt("checkpoint entry id is missing", file);
			const id = entry.id.trim();
			if (entryIds.has(id)) throw this.#halt(`checkpoint lists entry ${id} twice`, file);
			if (entry.parentId !== null && !isNonEmptyString(entry.parentId)) {
				throw this.#halt(`checkpoint entry ${id} has an invalid parentId`, file);
			}
			if (!normalizeTimestamp(entry.timestamp)) {
				throw this.#halt(`checkpoint entry ${id} has an invalid timestamp`, file);
			}
			entryIds.add(id);
			entries.push({
				id,
				parentId: entry.parentId === null ? null : (entry.parentId as string).trim(),
				timestamp: (entry.timestamp as string).trim(),
			});
		}

		if (!Array.isArray(record.beats)) throw this.#halt("checkpoint beats is not an array", file);
		const beats: { id: string; file: string }[] = [];
		for (const item of record.beats) {
			if (typeof item !== "object" || item === null || Array.isArray(item)) {
				throw this.#halt("checkpoint beat entry is not an object", file);
			}
			const listed = item as Record<string, unknown>;
			if (!isNonEmptyString(listed.id)) throw this.#halt("checkpoint beat id is missing", file);
			if (!isSimpleBeatFilename(listed.file)) {
				throw this.#halt(`checkpoint beat ${listed.id} has an unusable filename ${String(listed.file)}`, file);
			}
			beats.push({ id: listed.id.trim(), file: listed.file });
		}

		let carry: { sources: string[]; text: string } | null = null;
		if (record.carry !== null && record.carry !== undefined) {
			if (typeof record.carry !== "object" || Array.isArray(record.carry)) {
				throw this.#halt("checkpoint carry is neither null nor an object", file);
			}
			const value = record.carry as Record<string, unknown>;
			const sources = stringArray(value.sources ?? []);
			if (!sources) throw this.#halt("checkpoint carry sources are invalid", file);
			if (!isNonEmptyString(value.text)) throw this.#halt("checkpoint carry text is empty", file);
			carry = { sources, text: value.text };
		}

		return {
			version: CHECKPOINT_VERSION,
			batchId,
			sessionId: record.sessionId.trim(),
			committedAt,
			entries,
			beats,
			carry,
		};
	}

	async #loadBeat(
		checkpoint: CaptureCheckpoint,
		listed: { id: string; file: string },
		file: string,
	): Promise<BeatRecord> {
		let content: string;
		try {
			content = await Bun.file(file).text();
		} catch (error) {
			throw this.#halt(`referenced beat ${listed.id} is missing or unreadable (${String(error)})`, file);
		}
		const { frontmatter, body } = parseFrontmatter(content, {
			rawKeys: true,
			repair: false,
			level: "off",
		});

		if (frontmatter.schema !== BEAT_SCHEMA_VERSION) {
			throw this.#halt(`beat ${listed.id} has unknown schema ${String(frontmatter.schema)}`, file);
		}
		if (frontmatter.id !== listed.id) {
			throw this.#halt(`beat frontmatter id ${String(frontmatter.id)} does not match manifest ${listed.id}`, file);
		}
		if (frontmatter.batch !== checkpoint.batchId) {
			throw this.#halt(`beat ${listed.id} claims batch ${String(frontmatter.batch)}`, file);
		}
		if (!isNonEmptyString(frontmatter.title)) throw this.#halt(`beat ${listed.id} has no title`, file);
		if (typeof frontmatter.kind !== "string" || !BEAT_KIND_SET.has(frontmatter.kind)) {
			throw this.#halt(`beat ${listed.id} has unknown kind ${String(frontmatter.kind)}`, file);
		}
		const eventTime = normalizeTimestamp(frontmatter.event_time);
		if (!eventTime) throw this.#halt(`beat ${listed.id} has an invalid event_time`, file);
		const capturedAt = normalizeTimestamp(frontmatter.captured_at);
		if (!capturedAt) throw this.#halt(`beat ${listed.id} has an invalid captured_at`, file);
		if (!isNonEmptyString(frontmatter.session)) throw this.#halt(`beat ${listed.id} has no session`, file);
		if (frontmatter.session.trim() !== checkpoint.sessionId)
			throw this.#halt(
				`beat ${listed.id} claims session ${frontmatter.session.trim()} but its manifest recorded ${checkpoint.sessionId}`,
				file,
			);
		if (!isNonEmptyString(frontmatter.project)) throw this.#halt(`beat ${listed.id} has no project`, file);
		if (!isNonEmptyString(frontmatter.model)) throw this.#halt(`beat ${listed.id} has no model`, file);

		const sources = stringArray(frontmatter.sources ?? []);
		if (!sources || sources.length === 0) throw this.#halt(`beat ${listed.id} has no source entries`, file);
		if (new Set(sources).size !== sources.length) throw this.#halt(`beat ${listed.id} repeats a source entry`, file);
		const topics = stringArray(frontmatter.topics ?? []);
		if (!topics) throw this.#halt(`beat ${listed.id} has invalid topics`, file);
		const related = stringArray(frontmatter.related ?? []);
		if (!related) throw this.#halt(`beat ${listed.id} has invalid related ids`, file);

		let supersedes: string | undefined;
		if (frontmatter.supersedes !== undefined && frontmatter.supersedes !== null) {
			if (!isNonEmptyString(frontmatter.supersedes)) {
				throw this.#halt(`beat ${listed.id} has an invalid supersedes id`, file);
			}
			supersedes = frontmatter.supersedes.trim();
		}
		let uncertainty: string | undefined;
		if (frontmatter.uncertainty !== undefined && frontmatter.uncertainty !== null) {
			if (!isNonEmptyString(frontmatter.uncertainty)) {
				throw this.#halt(`beat ${listed.id} has invalid uncertainty text`, file);
			}
			uncertainty = frontmatter.uncertainty.trim();
		}

		const title = frontmatter.title.trim();
		const text = this.#stripTitleHeading(body, title);
		if (text.length === 0) throw this.#halt(`beat ${listed.id} has an empty body`, file);

		return freezeRecord({
			id: listed.id,
			path: `beats/${checkpoint.batchId}/${listed.file}`,
			sessionId: frontmatter.session.trim(),
			capturedAt,
			model: frontmatter.model.trim(),
			title,
			kind: frontmatter.kind as BeatKind,
			body: text,
			topics,
			eventTime,
			sources,
			related,
			...(supersedes ? { supersedes } : {}),
			...(uncertainty ? { uncertainty } : {}),
		});
	}

	#stripTitleHeading(body: string, title: string): string {
		const trimmed = body.trim();
		const heading = `# ${title}`;
		if (!trimmed.startsWith(heading)) return trimmed;
		return trimmed.slice(heading.length).trim();
	}

	/** Fold one validated batch into the in-memory committed view. */
	#absorb(batch: LoadedBatch): void {
		const { checkpoint, records } = batch;
		if (this.#committedBatchIds.has(checkpoint.batchId)) {
			throw this.#halt(`batch ${checkpoint.batchId} is loaded twice`, checkpoint.batchId);
		}
		for (const entry of checkpoint.entries) {
			const existing = this.#sources.get(entry.id);
			if (existing) {
				throw this.#halt(
					sameSource(existing, entry)
						? `entry ${entry.id} is covered by more than one committed batch`
						: `conflicting manifests describe entry ${entry.id} differently`,
					path.join(this.#beatsDir, checkpoint.batchId, MANIFEST_FILE),
				);
			}
			this.#sources.set(entry.id, entry);
			this.#processed.add(entry.id);
			this.#lastEntryId = entry.id;
		}
		for (const record of records) {
			if (this.#beatIds.has(record.id)) {
				throw this.#halt(`beat ${record.id} is committed in more than one batch`, record.path);
			}
			this.#beatIds.add(record.id);
			this.#records.push(record);
		}
		this.#committedBatchIds.add(checkpoint.batchId);

		const carry = freezeCarry(checkpoint.carry);
		if (checkpoint.sessionId === this.#meta.sessionId) {
			this.#ownCarry = carry;
			this.#ownCarrySeen = true;
		} else {
			this.#inheritedCarry = carry;
		}
		// A fork with no batch of its own still surfaces the ancestor's carry; a
		// session that has committed keeps its own latest value, including null.
		this.#carry = this.#ownCarrySeen ? this.#ownCarry : this.#inheritedCarry;
	}

	#invalidateViews(): void {
		this.#recordsView = null;
		this.#processedView = null;
		this.#sourcesView = null;
	}

	#knownSources(batch: CaptureBatch): ReadonlySet<string> {
		const known = new Set<string>(this.#sources.keys());
		for (const entry of batch.entries) known.add(entry.id);
		return known;
	}

	#relatableBeatIds(batch: CaptureBatch): ReadonlySet<string> {
		const ids = new Set<string>(this.#beatIds);
		for (const record of batch.beats) ids.add(record.id);
		return ids;
	}

	#manifestMatches(readback: CaptureCheckpoint, expected: CaptureCheckpoint): boolean {
		if (readback.batchId !== expected.batchId) return false;
		if (readback.sessionId !== expected.sessionId) return false;
		if (readback.committedAt !== expected.committedAt) return false;
		if (readback.entries.length !== expected.entries.length) return false;
		for (let i = 0; i < readback.entries.length; i++) {
			const a = readback.entries[i];
			const b = expected.entries[i];
			if (a.id !== b.id || !sameSource(a, b)) return false;
		}
		if (readback.beats.length !== expected.beats.length) return false;
		for (let i = 0; i < readback.beats.length; i++) {
			if (readback.beats[i].id !== expected.beats[i].id) return false;
			if (readback.beats[i].file !== expected.beats[i].file) return false;
		}
		if ((readback.carry === null) !== (expected.carry === null)) return false;
		if (readback.carry && expected.carry) {
			if (readback.carry.text !== expected.carry.text) return false;
			if (readback.carry.sources.length !== expected.carry.sources.length) return false;
			for (let i = 0; i < readback.carry.sources.length; i++) {
				if (readback.carry.sources[i] !== expected.carry.sources[i]) return false;
			}
		}
		return true;
	}

	/** Read a destination checkpoint without halting; null when unreadable. */
	async #readManifest(dir: string): Promise<CaptureCheckpoint | null> {
		const file = path.join(dir, MANIFEST_FILE);
		let raw: string;
		try {
			raw = await Bun.file(file).text();
		} catch {
			return null;
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
			const record = parsed as Record<string, unknown>;
			if (record.version !== CHECKPOINT_VERSION || !isNonEmptyString(record.batchId)) return null;
			return this.#parseCheckpointLenient(record);
		} catch {
			return null;
		}
	}

	#parseCheckpointLenient(record: Record<string, unknown>): CaptureCheckpoint | null {
		if (!isNonEmptyString(record.sessionId)) return null;
		const committedAt = normalizeTimestamp(record.committedAt);
		if (!committedAt) return null;
		if (!Array.isArray(record.entries) || !Array.isArray(record.beats)) return null;
		const entries: CaptureSource[] = [];
		for (const item of record.entries) {
			if (typeof item !== "object" || item === null) return null;
			const entry = item as Record<string, unknown>;
			const timestamp = isNonEmptyString(entry.timestamp) ? entry.timestamp.trim() : null;
			if (!isNonEmptyString(entry.id) || !timestamp || !normalizeTimestamp(timestamp)) return null;
			entries.push({
				id: entry.id.trim(),
				parentId: isNonEmptyString(entry.parentId) ? entry.parentId.trim() : null,
				timestamp,
			});
		}
		const beats: { id: string; file: string }[] = [];
		for (const item of record.beats) {
			if (typeof item !== "object" || item === null) return null;
			const listed = item as Record<string, unknown>;
			if (!isNonEmptyString(listed.id) || !isSimpleBeatFilename(listed.file)) return null;
			beats.push({ id: listed.id.trim(), file: listed.file });
		}
		let carry: { sources: string[]; text: string } | null = null;
		if (record.carry !== null && record.carry !== undefined) {
			if (typeof record.carry !== "object" || Array.isArray(record.carry)) return null;
			const value = record.carry as Record<string, unknown>;
			const sources = stringArray(value.sources ?? []);
			if (!sources || !isNonEmptyString(value.text)) return null;
			carry = { sources, text: value.text };
		}
		return {
			version: CHECKPOINT_VERSION,
			batchId: (record.batchId as string).trim(),
			sessionId: record.sessionId.trim(),
			committedAt,
			entries,
			beats,
			carry,
		};
	}

	async #pathExists(target: string): Promise<boolean> {
		try {
			await fs.stat(target);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Rebuild the derived caches. A failure here is diagnostic only: committed
	 * batches stay committed and the pass is never retried because of it.
	 */
	async #refreshCaches(): Promise<void> {
		try {
			await chroniclerStoreIO.writeArtifact(path.join(this.#root, INDEX_FILE), this.#renderIndex());
		} catch (error) {
			this.#warn("Chronicler index cache could not be written", {
				error: String(error),
			});
		}
		try {
			const state = {
				version: 1,
				sessionId: this.#meta.sessionId,
				lastEntryId: this.#lastEntryId,
				beatCount: this.#records.length,
				updatedAt: new Date().toISOString(),
			};
			await chroniclerStoreIO.writeArtifact(
				path.join(this.#root, STATE_FILE),
				`${JSON.stringify(state, null, "\t")}\n`,
			);
		} catch (error) {
			this.#warn("Chronicler state cache could not be written", {
				error: String(error),
			});
		}
	}

	#renderIndex(): string {
		const rows = [...this.#records].sort((a, b) => {
			if (a.eventTime !== b.eventTime) return a.eventTime < b.eventTime ? -1 : 1;
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		});
		const lines: string[] = [
			"# Chronicler beats",
			"",
			`- Session: \`${escapeCell(this.#meta.sessionId)}\``,
			`- Project: \`${escapeCell(this.#meta.project)}\``,
			`- Committed batches: ${this.#committedBatchIds.size}`,
			`- Beats: ${rows.length}`,
			`- Covered source entries: ${this.#processed.size}`,
			`- Updated: ${new Date().toISOString()}`,
			"",
		];
		if (rows.length === 0) {
			lines.push("No committed beats yet.", "");
			return lines.join("\n");
		}
		lines.push("| Event time | Title | Kind | Sources | Topics | Beat |", "| --- | --- | --- | --- | --- | --- |");
		for (const record of rows) {
			const shown = record.sources.slice(0, MAX_INDEX_SOURCE_IDS).map(id => `\`${escapeCell(id)}\``);
			const overflow = record.sources.length - shown.length;
			const sources = `${record.sources.length} (${shown.join(", ")}${overflow > 0 ? `, +${overflow} more` : ""})`;
			const topics = record.topics.map(topic => `\`${escapeCell(topic)}\``).join(", ") || "—";
			lines.push(
				`| ${escapeCell(record.eventTime)} | ${escapeCell(record.title)} | ${escapeCell(record.kind)} | ${sources} | ${topics} | [\`${escapeCell(record.path)}\`](${encodeURI(record.path)}) |`,
			);
		}
		lines.push("");
		return lines.join("\n");
	}

	#warn(message: string, detail?: Record<string, unknown>): void {
		logger.warn(message, { root: this.#root, ...detail });
		// A host warning sink must never be able to turn a published batch into a
		// model retry, so its failures stay inside this call.
		try {
			this.#hooks.warn?.(message, detail);
		} catch (error) {
			logger.warn("Chronicler warning hook threw", { error: String(error) });
		}
	}

	#halt(reason: string, file?: string): ChroniclerCorruptionError {
		if (this.#haltReason === null) {
			this.#haltReason = reason;
			this.#records = [];
			this.#processed = new Set();
			this.#sources = new Map();
			this.#carry = null;
			this.#invalidateViews();
			this.#warn(`Chronicler capture halted: ${reason}`, file ? { file } : undefined);
		}
		return new ChroniclerCorruptionError(reason, file);
	}

	#assertNotHalted(): void {
		if (this.#haltReason !== null) throw new Error(`Chronicler store is halted: ${this.#haltReason}`);
	}

	#assertUsable(): void {
		this.#assertNotHalted();
		if (!this.#opened) throw new Error("Chronicler store is not open");
	}

	#assertOwned(batch: CaptureBatch): void {
		if (!this.#ownBatches.has(batch)) throw new Error("Chronicler batch does not belong to this store");
	}

	#assertStageable(batch: CaptureBatch): void {
		this.#assertOwned(batch);
		if (this.#committedBatches.has(batch)) throw new Error(`Chronicler batch ${batch.id} is already committed`);
		if (batch.revoked) throw new Error(`Chronicler batch ${batch.id} was revoked`);
		if (batch.finalized) throw new Error(`Chronicler batch ${batch.id} is finalized; no further beats may be staged`);
		this.#assertBatchCurrent(batch);
	}

	/**
	 * A batch reserves nothing on disk, so another batch may have committed the
	 * same source entries between `beginBatch` and this call. Only the batch's
	 * own entries are checked: beats and carry stay free to cite evidence that
	 * earlier batches already committed.
	 */
	#assertBatchCurrent(batch: CaptureBatch): void {
		for (const entry of batch.entries) {
			if (this.#processed.has(entry.id)) {
				throw new Error(
					`Chronicler batch ${batch.id} is stale: entry ${entry.id} was already committed by another batch`,
				);
			}
		}
	}
}
