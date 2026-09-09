import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import chronicleDescription from "../prompts/chronicler/chronicle-tool.md" with { type: "text" };
import finishDescription from "../prompts/chronicler/finish-tool.md" with { type: "text" };
import readDescription from "../prompts/chronicler/read-tool.md" with { type: "text" };
import { ToolError } from "../tools/tool-errors";
import {
	type BeatRecord,
	type CaptureBatch,
	type CaptureSource,
	CHRONICLER_BEAT_KINDS,
	type ChroniclerStore,
} from "./store";

const chronicleSchema = type({
	title: "string",
	kind: type.enumerated(...CHRONICLER_BEAT_KINDS),
	body: "string",
	topics: "string[]",
	sources: "string[]",
	"event_time?": "string",
	"related?": "string[]",
	"supersedes?": "string",
	"uncertainty?": "string",
});
const finishSchema = type({ carry: type({ sources: "string[]", text: "string" }).or("null") });
const readSchema = type({
	"id?": "string",
	"offset?": type("number.integer >= 0").describe("Metadata page offset; omit id to list beats."),
	"limit?": type("1 <= number.integer <= 100").describe("Metadata page size; default 50."),
});

const chronicleDefinition = {
	name: "chronicle",
	description: chronicleDescription,
	parameters: chronicleSchema,
} as const;
const finishDefinition = {
	name: "finish_chronicle",
	description: finishDescription,
	parameters: finishSchema,
} as const;
const readDefinition = { name: "read_chronicle", description: readDescription, parameters: readSchema } as const;

/** Budget the actual tool surfaces without constructing an executable capture batch. */
export const CHRONICLER_TOOL_SCHEMAS = [chronicleDefinition, finishDefinition, readDefinition] as const;

export interface ChronicleDetails {
	id: string;
	path: string;
}
export interface FinishChronicleDetails {
	carry: CaptureBatch["carry"];
}
export type ReadChronicleDetails =
	| { id: string; sources: string[] }
	| { offset: number; nextOffset: number | null; total: number };

function assertMutable(batch: CaptureBatch, signal?: AbortSignal): void {
	if (signal?.aborted || batch.revoked) throw new ToolError("This capture pass was revoked.");
	if (batch.finalized)
		throw new ToolError("This capture pass is already finalized; no further mutations are allowed.");
}

function validateSources(sources: string[], known: ReadonlyMap<string, CaptureSource>): void {
	if (!sources.length) throw new ToolError("Cite at least one supplied or committed source entry ID.");
	for (const id of sources) {
		if (!known.has(id)) throw new ToolError(`Unknown source entry ID: ${id}`);
	}
}

export class ChronicleTool implements AgentTool<typeof chronicleSchema, ChronicleDetails> {
	readonly name = chronicleDefinition.name;
	readonly label = "Chronicle";
	readonly description = chronicleDefinition.description;
	readonly parameters = chronicleDefinition.parameters;
	readonly intent = "omit" as const;

	constructor(
		private readonly store: ChroniclerStore,
		private readonly batch: CaptureBatch,
		private readonly knownSources: ReadonlyMap<string, CaptureSource>,
	) {}

	async execute(
		_id: string,
		args: typeof chronicleSchema.infer,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ChronicleDetails>> {
		assertMutable(this.batch, signal);
		if (!args.title.trim() || !args.body.trim())
			throw new ToolError("A beat needs a nonblank title and standalone body.");
		validateSources(args.sources, this.knownSources);
		let eventTime = args.event_time;
		if (eventTime !== undefined && !Number.isFinite(Date.parse(eventTime)))
			throw new ToolError("event_time must be a valid timestamp.");
		if (eventTime === undefined) {
			for (const id of args.sources) {
				const timestamp = this.knownSources.get(id)!.timestamp;
				if (eventTime === undefined || Date.parse(timestamp) > Date.parse(eventTime)) eventTime = timestamp;
			}
		}
		const relations = [...(args.related ?? []), ...(args.supersedes ? [args.supersedes] : [])];
		for (const id of relations) {
			if (!this.store.beats.some(beat => beat.id === id) && !this.batch.beats.some(beat => beat.id === id)) {
				throw new ToolError(`Unknown related beat ID: ${id}`);
			}
		}
		let beat: BeatRecord;
		try {
			beat = this.store.stageBeat(this.batch, {
				title: args.title,
				kind: args.kind,
				body: args.body,
				topics: args.topics,
				sources: args.sources,
				eventTime: eventTime!,
				related: args.related ?? [],
				supersedes: args.supersedes,
				uncertainty: args.uncertainty,
			});
		} catch (error) {
			throw new ToolError(error instanceof Error ? error.message : String(error));
		}
		return {
			content: [
				{ type: "text", text: `Staged beat ${beat.id}; publication awaits completion of this capture pass.` },
			],
			details: { id: beat.id, path: beat.path },
		};
	}
}

export class FinishChronicleTool implements AgentTool<typeof finishSchema, FinishChronicleDetails> {
	readonly name = finishDefinition.name;
	readonly label = "Finish Chronicle";
	readonly description = finishDefinition.description;
	readonly parameters = finishDefinition.parameters;
	readonly intent = "omit" as const;

	constructor(
		_store: ChroniclerStore,
		private readonly batch: CaptureBatch,
		private readonly knownSources: ReadonlyMap<string, CaptureSource>,
	) {}

	async execute(
		_id: string,
		args: typeof finishSchema.infer,
		signal?: AbortSignal,
	): Promise<AgentToolResult<FinishChronicleDetails>> {
		assertMutable(this.batch, signal);
		let carry: CaptureBatch["carry"] = null;
		if (args.carry) {
			if (args.carry.text.length > 8000) throw new ToolError("Pending carry may not exceed 8,000 characters.");
			const text = args.carry.text.trim();
			if (text) {
				validateSources(args.carry.sources, this.knownSources);
				carry = { sources: [...new Set(args.carry.sources)], text };
			}
		}
		this.batch.carry = carry;
		this.batch.finalized = true;
		return {
			content: [{ type: "text", text: "Capture pass prepared; publication follows successful completion." }],
			details: { carry },
		};
	}
}

export class ReadChronicleTool implements AgentTool<typeof readSchema, ReadChronicleDetails> {
	readonly name = readDefinition.name;
	readonly label = "Read Chronicle";
	readonly description = readDefinition.description;
	readonly parameters = readDefinition.parameters;
	readonly intent = "omit" as const;

	constructor(
		private readonly store: ChroniclerStore,
		private readonly batch: CaptureBatch,
		private readonly obfuscator?: { obfuscate(text: string): string },
	) {}

	async execute(
		_id: string,
		args: typeof readSchema.infer,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ReadChronicleDetails>> {
		if (signal?.aborted || this.batch.revoked) throw new ToolError("This capture pass was revoked.");
		let text: string;
		let details: ReadChronicleDetails;
		if (args.id !== undefined) {
			if (args.offset !== undefined || args.limit !== undefined)
				throw new ToolError("Supply id alone to read a beat; omit id to list metadata.");
			const beat =
				this.store.beats.find(beat => beat.id === args.id) ?? this.batch.beats.find(beat => beat.id === args.id);
			if (!beat) throw new ToolError(`Unknown beat ID: ${args.id}`);
			const { body, ...metadata } = beat;
			text = `${JSON.stringify(metadata, null, 2)}\n\n# ${beat.title}\n\n${body}`;
			details = { id: beat.id, sources: [...beat.sources] };
		} else {
			const offset = args.offset ?? 0;
			const limit = args.limit ?? 50;
			if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
				throw new ToolError("offset must be a nonnegative integer; limit must be an integer from 1 through 100.");
			}
			const committed = this.store.beats;
			const beats: Pick<BeatRecord, "id" | "title" | "kind" | "eventTime">[] = [];
			const end = Math.min(committed.length, offset + limit);
			for (let index = offset; index < end; index++) {
				const beat = committed[committed.length - 1 - index];
				// Redact before clipping, then redact the full page for cross-field secrets.
				const title = this.obfuscator?.obfuscate(beat.title) ?? beat.title;
				beats.push({
					id: beat.id,
					title: title.length > 240 ? `${title.slice(0, 239)}…` : title,
					kind: beat.kind,
					eventTime: beat.eventTime,
				});
			}
			details = { offset, nextOffset: end < committed.length ? end : null, total: committed.length };
			text = JSON.stringify({ ...details, beats }, null, 2);
		}
		return {
			content: [{ type: "text", text: this.obfuscator?.obfuscate(text) ?? text }],
			details,
		};
	}
}
