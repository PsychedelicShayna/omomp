import type { ExtensionCommandContext } from "/home/shayna/omp/packages/coding-agent/src/extensibility/extensions/types.ts";

export function words(args: string): string[] { return args.trim().split(/\s+/).filter(Boolean); }
export function output(ctx: ExtensionCommandContext, text: string, error = false): void { ctx.ui.notify(text, error ? "error" : "info"); }
export async function report(ctx: ExtensionCommandContext, operation: () => Promise<string>): Promise<void> {
	try { output(ctx, await operation()); } catch (error) { output(ctx, error instanceof Error ? error.message : String(error), true); }
}
