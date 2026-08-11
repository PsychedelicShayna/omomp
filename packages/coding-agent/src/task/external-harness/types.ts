import type { AgentDefinition, AgentProgress, ParentSessionMetadata, SingleResult } from "../types";

/** Filesystem boundary prepared by OMP for an external harness invocation. */
export interface ExternalHarnessIsolationContext {
	readonly isolated: boolean;
	readonly worktree?: string;
	readonly repoRoot?: string;
}

const SAFE_ENV_KEYS = [
	"HOME",
	"PATH",
	"USER",
	"LOGNAME",
	"SHELL",
	"TMPDIR",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"LANG",
	"LC_ALL",
	"TERM",
] as const;

/** Minimal environment passed to harnesses and every command they invoke. */
export function externalHarnessEnv(extra: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of SAFE_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return { ...env, ...extra };
}

/** Complete, host-owned input for one external harness run. */
export interface ExternalHarnessInput {
	readonly agent: AgentDefinition;
	readonly agentId: string;
	readonly prompt: string;
	readonly cwd: string;
	readonly isolation: ExternalHarnessIsolationContext;
	readonly parent: ParentSessionMetadata;
	readonly signal: AbortSignal;
	/** Effective wall-clock cap for the complete run. Zero means no deadline. */
	readonly maxRuntimeMs: number;
	/** Absolute wall-clock deadline, armed by the executor before adapter startup. */
	readonly deadlineAt?: number;
	readonly onProgress: (progress: AgentProgress) => void;
}

/** Adapter seam for a non-OMP task runtime; OMP retains lifecycle and delivery ownership. */
export interface ExternalHarnessAdapter {
	execute(input: ExternalHarnessInput): Promise<SingleResult>;
}
