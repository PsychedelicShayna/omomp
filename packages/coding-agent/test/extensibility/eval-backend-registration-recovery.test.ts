import { describe, expect, it } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionEvalBackend } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

// Eval backends registered at extension factory time are queued on the runtime
// and flushed inside ExtensionRunner's constructor, where the registering
// extension can no longer catch a rejection. A colliding token used to throw
// out of the constructor and abort session creation for every extension.

function backend(id: string, aliases: string[]): ExtensionEvalBackend {
	return {
		id,
		aliases,
		label: id,
		highlightLang: id,
		modelVisible: true,
		isAvailable: () => true,
		execute: async () => ({
			output: id,
			exitCode: 0,
			cancelled: false,
			truncated: false,
			artifactId: undefined,
			totalLines: 1,
			totalBytes: id.length,
			outputLines: 1,
			outputBytes: id.length,
			displayOutputs: [],
		}),
	};
}

describe("queued eval backend registration recovery", () => {
	it("skips a colliding backend and keeps the session, the original owner, and later backends", async () => {
		const tempDir = TempDir.createSync("@eval-backend-recovery-");
		const projectDir = tempDir.join("project");
		const runtime = new ExtensionRuntime();
		const first = backend("rb", ["ruby"]);
		const collider = backend("rb2", ["ruby"]);
		const later = backend("jl", ["julia"]);
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.registerEvalBackend(first);
				pi.registerEvalBackend(collider);
				pi.registerEvalBackend(later);
			},
			projectDir,
			new EventBus(),
			runtime,
		);
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		try {
			const runner = new ExtensionRunner(
				[extension],
				runtime,
				projectDir,
				SessionManager.inMemory(projectDir),
				new ModelRegistry(authStorage),
			);
			expect(runner.getEvalBackend("ruby")).toBe(first);
			expect(runner.getEvalBackend("rb2")).toBeUndefined();
			expect(runner.getEvalBackend("julia")).toBe(later);
			expect(runtime.pendingEvalBackendRegistrations).toEqual([]);
		} finally {
			authStorage.close();
		}
	});
});
