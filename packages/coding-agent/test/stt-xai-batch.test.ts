import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { STTController } from "@oh-my-pi/pi-coding-agent/stt/stt-controller";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

describe("STTController xAI batch mode", () => {
	let state: SettingsTestState | undefined;
	let tmp = "";
	let controller: STTController | undefined;
	let onAudio: ((error: Error | null, samples: Float32Array) => void) | undefined;
	const stopCapture = vi.fn();

	function makeEditor() {
		return {
			insertText: vi.fn(),
			setVolatileText: vi.fn(),
			clearVolatileText: vi.fn(),
			commitVolatileText: vi.fn(),
			submit: vi.fn(),
			deleteBeforeCursor: vi.fn(),
		};
	}

	function makeOptions() {
		return {
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			onStateChange: vi.fn(),
			requestRender: vi.fn(),
		};
	}

	beforeEach(async () => {
		state = beginSettingsTest();
		await Settings.init({ inMemory: true });
		settings.set("stt.modelName", "xai");
		settings.set("stt.language", "en");
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-xai-stt-test-"));
		setAgentDir(tmp);
		onAudio = undefined;
		stopCapture.mockReset();
	});

	afterEach(async () => {
		controller?.dispose();
		controller = undefined;
		restoreSettingsTestState(state);
		await fs.rm(tmp, { recursive: true, force: true });
	});

	it("records until the second toggle, then inserts only the final transcript", async () => {
		const transcribe = vi.fn(async (audio: Blob, _options: { filename: string; language?: string }) => {
			const bytes = new Uint8Array(await audio.arrayBuffer());
			expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
			expect(bytes.byteLength).toBeGreaterThan(44);
			return "the final transcript";
		});
		controller = new STTController(callback => {
			onAudio = callback;
			return { stop: stopCapture };
		}, transcribe);
		const editor = makeEditor();
		const options = makeOptions();

		await controller.toggle(editor, options);
		expect(controller.state).toBe("recording");
		onAudio?.(null, new Float32Array([0, 0.5, -0.5]));
		expect(editor.setVolatileText).not.toHaveBeenCalled();
		expect(editor.insertText).not.toHaveBeenCalled();

		await controller.toggle(editor, options);

		expect(stopCapture).toHaveBeenCalledTimes(1);
		expect(transcribe).toHaveBeenCalledTimes(1);
		expect(transcribe.mock.calls[0]?.[1]).toMatchObject({ filename: "dictation.wav", language: "en" });
		expect(editor.insertText).toHaveBeenCalledWith("the final transcript");
		expect(editor.submit).not.toHaveBeenCalled();
		expect(controller.state).toBe("idle");
	});

	it("retains a failed recording and reports its durable path", async () => {
		const transcribe = vi.fn().mockRejectedValue(new Error("upstream unavailable"));
		controller = new STTController(callback => {
			onAudio = callback;
			return { stop: stopCapture };
		}, transcribe);
		const options = makeOptions();

		await controller.toggle(makeEditor(), options);
		onAudio?.(null, new Float32Array([0.25, -0.25]));
		await controller.toggle(makeEditor(), options);

		const warning = options.showWarning.mock.calls[0]?.[0] as string;
		expect(warning).toContain("upstream unavailable");
		const retainedPath = warning.match(/Recording retained at (.+)$/)?.[1];
		expect(retainedPath).toBeDefined();
		expect(await fs.stat(retainedPath!)).toBeDefined();
	});

	it("keeps only the five most recent recordings", async () => {
		const transcribe = vi.fn().mockResolvedValue("ok");
		controller = new STTController(callback => {
			onAudio = callback;
			return { stop: stopCapture };
		}, transcribe);
		const editor = makeEditor();

		for (let i = 0; i < 6; i += 1) {
			await controller.toggle(editor, makeOptions());
			onAudio?.(null, new Float32Array([i / 10]));
			await controller.toggle(editor, makeOptions());
		}

		const files = await fs.readdir(path.join(tmp, "stt-recordings"));
		expect(files).toHaveLength(5);
	});
});
