import * as path from "node:path";
import updatePrompt from "../prompts/omomp-update.md" with { type: "text" };

const OMOMP_EXECUTABLE_NAMES = new Set(["omomp", "omomp.exe"]);

/** Route the fork executable's exact `update` command into a normal prompted agent session. */
export function resolveOmompUpdateArgv(argv: string[], executablePath: string): string[] {
	if (argv.length !== 1 || argv[0] !== "update") return argv;
	const executableName = path.basename(executablePath.replaceAll("\\", "/")).toLowerCase();
	if (!OMOMP_EXECUTABLE_NAMES.has(executableName)) return argv;
	return ["launch", updatePrompt.trim()];
}
