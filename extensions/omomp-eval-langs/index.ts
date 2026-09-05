// omomp-eval-langs: Ruby and Julia eval backends, restored as an extension.
//
// These two languages used to be built into the host (packages/coding-agent/
// src/eval/{rb,jl}); they now live here as ordinary extension eval backends so
// the host carries only Python and JavaScript. Self-contained extension
// directory — drag into any omp extensions dir to enable, drag out to disable.
//
// Each backend owns a persistent interpreter subprocess per cwd (see
// kernel.ts) and reaches host tool access — `tool.*`, `agent()`,
// `completion()`, internal-URL `read`/`write` — through the same loopback
// bridge the Python backend uses. Registration needs the patched build's
// api.registerEvalBackend; on a stock build both backends stay unregistered
// and the user gets one notice.
import type {
	ExtensionEvalBackend,
	ExtensionFactory,
} from "../../packages/coding-agent/src/extensibility/extensions/types";
import { createJuliaBackend } from "./julia";
import { createRubyBackend } from "./ruby";

/**
 * Backends contributed by this extension, in registration order. Built fresh
 * per factory invocation: the host rebinds a prepared extension once per
 * session, and each session's backends own their own interpreter processes.
 */
function evalLangBackends(): ExtensionEvalBackend[] {
	return [createRubyBackend(), createJuliaBackend()];
}

export const createEvalLangsExtension: ExtensionFactory = api => {
	const problems: string[] = [];

	if (typeof api.registerEvalBackend !== "function") {
		problems.push("this omp build lacks registerEvalBackend — Ruby/Julia eval backends are disabled");
	} else {
		for (const backend of evalLangBackends()) {
			try {
				api.registerEvalBackend(backend);
			} catch (error) {
				problems.push(`${backend.id}: ${error instanceof Error ? error.message : String(error)}`);
				void Promise.resolve(backend.dispose?.()).catch(() => {});
			}
		}
	}

	if (problems.length === 0) return;
	let notified = false;
	api.on("session_start", (_event, ctx) => {
		if (notified) return;
		notified = true;
		ctx.ui.notify(`omomp-eval-langs: ${problems.join("; ")}`, "warning");
	});
};

export default createEvalLangsExtension;
