export interface ParsedReplEvalInput {
	language: string;
	alias: string;
	code: string;
	excludeFromContext: boolean;
	reset: boolean;
}

const BUILTIN_PREFIXES: Readonly<Record<string, string>> = {
	p: "py",
	$: "js",
	r: "rb",
	j: "jl",
	"!": "sh",
};

const SHELL_PROMPT_COMMAND =
	/^(?:cd|pwd|ls|sudo|doas|env|export|unset|source|alias|unalias|set|exec|command|jobs|fg|bg|kill|chmod|chown|cp|mv|rm|mkdir|touch|cat|head|tail|grep|rg|find|git|make|cmake|ninja|npm|pnpm|yarn|bun|cargo|go)(?:\s|$)/;

function looksLikePastedShellPrompt(code: string): boolean {
	return SHELL_PROMPT_COMMAND.test(code) || /^(?:\.{0,2}\/|~\/)/.test(code);
}

/**
 * Parse one complete REPL line as a user eval cell. Prefixes are recognized
 * only when followed by whitespace and non-empty code; every other `$...`
 * form remains ordinary chat input.
 */
export function parseReplEvalInput(
	input: string,
	registeredAliases: Iterable<string> = [],
): ParsedReplEvalInput | undefined {
	const text = input.trimStart();
	const aliases = new Set(registeredAliases);
	let offset = 1;
	let excludeFromContext = false;
	if (!text.startsWith("$")) return undefined;
	if (text.startsWith("$~")) {
		excludeFromContext = true;
		offset = 2;
	}

	const tail = text.slice(offset);
	const whitespace = tail.search(/\s/);
	if (whitespace < 0) return undefined;
	const prefix = tail.slice(0, whitespace);
	const code = tail.slice(whitespace).trim();
	if (!code) return undefined;

	// Historical "$ code" / "$~ code" is Python, except for recognizable
	// pasted shell prompts. This keeps terminal transcript lines from executing
	// locally when pasted into the editor.
	if (prefix === "") {
		if (looksLikePastedShellPrompt(code)) return undefined;
		return { language: "py", alias: "py", code, excludeFromContext, reset: false };
	}
	const language = BUILTIN_PREFIXES[prefix] ?? (aliases.has(prefix) ? prefix : undefined);
	if (!language) return undefined;
	return { language, alias: prefix, code, excludeFromContext, reset: false };
}
