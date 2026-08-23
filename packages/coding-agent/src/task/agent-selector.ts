/**
 * Model-selector interpretation for the subagent `agent` field.
 *
 * The task tool and the eval kernel's `agent()` bridge accept, besides a
 * registered agent name, a direct model selector:
 *
 *     <provider/model>[:<effort>]   e.g. openai-codex/gpt-5.6-sol:high
 *     @<role>[:<effort>]            e.g. @smol:low
 *
 * A selector spawns the generic `task` agent crewed with exactly that model
 * and thinking level; an omitted `:<effort>` leaves the model on its default
 * (`auto`) selector. Registered agent names always win: interpretation only
 * begins after agent discovery misses. Detection is shape-based — the string
 * contains a `/`, starts with `@`, or carries a trailing `:<effort>` suffix
 * that parses as a thinking level.
 *
 * Validation is deliberately loud. An unresolvable selector is a preflight
 * error naming the bad part (unknown model vs unsupported effort vs missing
 * credentials) plus the nearest valid alternatives — never a silent fallback
 * to the default crew.
 */
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelString, resolveModelOverride } from "../config/model-resolver";
import { getKnownRoleIds } from "../config/model-roles";
import type { Settings } from "../config/settings";
import {
	type ConfiguredThinkingLevel,
	concreteThinkingLevel,
	parseConfiguredThinkingLevel,
	toReasoningEffort,
} from "../thinking";

/** The registry surfaces selector validation needs; tests can stub them. */
export type AgentSelectorModelRegistry = Pick<ModelRegistry, "getAvailable" | "hasConfiguredAuth">;

/** Loud selector-validation failure; adapters wrap it into their own preflight error surface. */
export class AgentSelectorError extends Error {}

/**
 * Split a trailing `:<effort>` suffix off a selector when the token parses as
 * a configured thinking level (concrete levels, `max`, or `auto`).
 */
function parseSelectorSuffix(value: string): { base: string; level: ConfiguredThinkingLevel } | undefined {
	const colonIdx = value.lastIndexOf(":");
	if (colonIdx <= 0 || colonIdx === value.length - 1) return undefined;
	const level = parseConfiguredThinkingLevel(value.slice(colonIdx + 1));
	return level === undefined ? undefined : { base: value.slice(0, colonIdx), level };
}

/**
 * True when an `agent` value is shaped like a model selector rather than an
 * agent name. Callers MUST try registered-agent lookup first: a registered
 * name always wins over selector interpretation.
 */
export function isAgentModelSelector(value: string): boolean {
	if (value.includes("/")) return true;
	if (value.startsWith("@")) return true;
	return parseSelectorSuffix(value) !== undefined;
}

/**
 * Validate a selector-shaped `agent` value against the live model catalog.
 *
 * Resolution reuses the session model-pattern grammar (`resolveModelOverride`),
 * so globs, `@role` expansion, and the `:max`/`:auto` literal-id guards behave
 * exactly like every other model-selector surface. Throws
 * {@link AgentSelectorError} naming the failing part and the nearest valid
 * alternatives. A missing or not-yet-populated registry defers resolution to
 * the executor instead of failing a potentially valid selector on missing data.
 */
export function validateAgentModelSelector(
	selector: string,
	modelRegistry: AgentSelectorModelRegistry | undefined,
	settings: Settings,
): void {
	if (!modelRegistry) return;
	const available = modelRegistry.getAvailable();
	if (available.length === 0) return;

	// Check the REQUESTED suffix from our own parse: the pattern grammar clamps
	// an out-of-range level to the model's nearest supported one and drops an
	// unparseable token with only a warning — both are silent fallbacks the
	// selector contract forbids.
	const suffix = parseSelectorSuffix(selector);
	const colonIdx = selector.lastIndexOf(":");
	const rawToken = colonIdx > 0 && colonIdx < selector.length - 1 ? selector.slice(colonIdx + 1) : undefined;

	const resolved = resolveModelOverride([selector], modelRegistry, settings);
	if (resolved.model) {
		if (suffix !== undefined) {
			assertEffortSupported(selector, resolved.model, suffix.level);
		} else if (resolved.warning !== undefined && rawToken !== undefined && !rawToken.includes("/")) {
			// Resolved only because the grammar discarded an invalid trailing
			// token (literal ids containing ":" match exactly and warn-free).
			throw new AgentSelectorError(
				`Unsupported effort ":${rawToken}" in agent selector "${selector}". ${supportedEffortsText(resolved.model)}`,
			);
		}
		if (!modelRegistry.hasConfiguredAuth(resolved.model)) {
			const authed = nearestModels(
				selector,
				available.filter(candidate => modelRegistry.hasConfiguredAuth(candidate)),
			);
			throw new AgentSelectorError(
				`Model "${formatModelString(resolved.model)}" from agent selector "${selector}" has no configured credentials.${
					authed.length > 0 ? ` Authenticated alternatives: ${authed.join(", ")}.` : ""
				}`,
			);
		}
		return;
	}

	// Unresolved: decompose to name the failing part. A trailing token that is
	// not a recognized effort, on a base that DOES resolve, is a bad effort.
	if (suffix === undefined && rawToken !== undefined) {
		const base = selector.slice(0, colonIdx);
		const token = selector.slice(colonIdx + 1);
		const baseResolved = resolveModelOverride([base], modelRegistry, settings);
		if (baseResolved.model) {
			throw new AgentSelectorError(
				`Unsupported effort ":${token}" in agent selector "${selector}". ${supportedEffortsText(baseResolved.model)}`,
			);
		}
	}
	const base = suffix?.base ?? selector;
	if (base.startsWith("@")) {
		const roles = getKnownRoleIds(settings)
			.map(role => `@${role}`)
			.join(", ");
		throw new AgentSelectorError(
			`Unknown model role "${base}" in agent selector "${selector}". Known roles: ${roles}.`,
		);
	}
	const nearest = nearestModels(base, available);
	throw new AgentSelectorError(
		`Unknown model "${base}" in agent selector "${selector}".${
			nearest.length > 0 ? ` Nearest available: ${nearest.join(", ")}.` : ""
		}`,
	);
}

/**
 * Reject a concrete explicit level the resolved model cannot honor. The
 * `auto`, `max`, and `off` sentinels always pass: they map onto whatever the
 * model actually supports instead of requesting a fixed level.
 */
function assertEffortSupported(
	selector: string,
	model: Model<Api>,
	level: ConfiguredThinkingLevel | undefined,
): void {
	const concrete = concreteThinkingLevel(level);
	if (concrete === undefined || concrete === ThinkingLevel.Off || concrete === ThinkingLevel.Max) return;
	const effort = toReasoningEffort(concrete);
	if (effort === undefined) return;
	if (getSupportedEfforts(model).includes(effort)) return;
	throw new AgentSelectorError(
		`Unsupported effort ":${concrete}" in agent selector "${selector}". ${supportedEffortsText(model)}`,
	);
}

function supportedEffortsText(model: Model<Api>): string {
	const supported = getSupportedEfforts(model);
	if (supported.length === 0) {
		return `${formatModelString(model)} has no controllable thinking effort; omit the ":<effort>" suffix or use ":auto".`;
	}
	return `${formatModelString(model)} supports: ${supported.join(", ")} (plus "auto", "max", "off").`;
}

/** Up to `limit` catalog entries closest to `input` by edit distance over `provider/id` and bare `id`. */
function nearestModels(input: string, available: readonly Model<Api>[], limit = 3): string[] {
	const needle = input.toLowerCase();
	const scored = available.map(model => {
		const full = formatModelString(model);
		const score = Math.min(editDistance(needle, full.toLowerCase()), editDistance(needle, model.id.toLowerCase()));
		return { full, score };
	});
	scored.sort((a, b) => a.score - b.score || a.full.localeCompare(b.full));
	// A ceiling keeps absurd suggestions out when nothing is remotely close.
	const ceiling = Math.max(needle.length, 8);
	return scored
		.filter(entry => entry.score <= ceiling)
		.slice(0, limit)
		.map(entry => entry.full);
}

/** Iterative two-row Levenshtein distance. */
function editDistance(a: string, b: string): number {
	if (a === b) return 0;
	const prev: number[] = new Array(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		let diag = prev[0]!;
		prev[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = prev[j]!;
			prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
			diag = tmp;
		}
	}
	return prev[b.length]!;
}
