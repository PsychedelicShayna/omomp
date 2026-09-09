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
const readSchema = type({ id: "string" });

export interface ChronicleDetails {
	id: string;
	path: string;
}
export interface FinishChronicleDetails {
	carry: CaptureBatch["carry"];
}
export interface ReadChronicleDetails {
	id: string;
	sources: string[];
}

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
	readonly name = "chronicle";
	readonly label = "Chronicle";
	readonly description = chronicleDescription;
	readonly parameters = chronicleSchema;
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
	readonly name = "finish_chronicle";
	readonly label = "Finish Chronicle";
	readonly description = finishDescription;
	readonly parameters = finishSchema;
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
	readonly name = "read_chronicle";
	readonly label = "Read Chronicle";
	readonly description = readDescription;
	readonly parameters = readSchema;
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
		const beat =
			this.store.beats.find(beat => beat.id === args.id) ?? this.batch.beats.find(beat => beat.id === args.id);
		if (!beat) throw new ToolError(`Unknown beat ID: ${args.id}`);
		const { body, ...metadata } = beat;
		const text = `${JSON.stringify(metadata, null, 2)}

# ${beat.title}

${body}`;
		return {
			content: [{ type: "text", text: this.obfuscator?.obfuscate(text) ?? text }],
			details: { id: beat.id, sources: [...beat.sources] },
		};
	}
}
