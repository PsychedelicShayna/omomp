import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { STTController } from "@oh-my-pi/pi-coding-agent/stt/stt-controller";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

/** The space-hold push-to-talk gesture and the `app.stt.toggle` chord drive the same controller.
 *  The gesture has explicit start and release edges, so it must own the capture it starts and keep
 *  its hands off one it did not: a hold recognized a beat after the chord started dictation used to
 *  finalize that dictation early and hand its audio to the wrong route. */
describe("STTController push-to-talk hold ownership", () => {
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
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stt-hold-test-"));
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

	function makeController(transcribe: ReturnType<typeof vi.fn>) {
		controller = new STTController(callback => {
			onAudio = callback;
			return { stop: stopCapture };
		}, transcribe);
		return controller;
	}

	it("leaves a chord-started recording alone across a full hold gesture", async () => {
		const transcribe = vi.fn(async () => "chord dictation");
		const stt = makeController(transcribe);
		const editor = makeEditor();
		const options = makeOptions();

		await stt.toggle(editor, options);
		expect(stt.state).toBe("recording");
		onAudio?.(null, new Float32Array([0, 0.25, -0.25]));

		// Space bar held while the chord's capture is live: both edges are inert.
		await stt.holdStart(editor, options);
		expect(stt.state).toBe("recording");
		await stt.holdEnd(editor, options);
		expect(stt.state).toBe("recording");
		expect(stopCapture).not.toHaveBeenCalled();
		expect(transcribe).not.toHaveBeenCalled();

		// The chord still finalizes its own capture, exactly once.
		await stt.toggle(editor, options);
		expect(stt.state).toBe("idle");
		expect(stopCapture).toHaveBeenCalledTimes(1);
		expect(transcribe).toHaveBeenCalledTimes(1);
		expect(editor.insertText).toHaveBeenCalledWith("chord dictation");
	});

	it("records and transcribes a hold it started itself", async () => {
		const transcribe = vi.fn(async () => "held dictation");
		const stt = makeController(transcribe);
		const editor = makeEditor();
		const options = makeOptions();

		await stt.holdStart(editor, options);
		expect(stt.state).toBe("recording");
		onAudio?.(null, new Float32Array([0, 0.5, -0.5]));

		await stt.holdEnd(editor, options);
		expect(stt.state).toBe("idle");
		expect(stopCapture).toHaveBeenCalledTimes(1);
		expect(transcribe).toHaveBeenCalledTimes(1);
		expect(editor.insertText).toHaveBeenCalledWith("held dictation");
	});

	it("ignores a release after the chord already stopped the held capture", async () => {
		const transcribe = vi.fn(async () => "held dictation");
		const stt = makeController(transcribe);
		const editor = makeEditor();
		const options = makeOptions();

		await stt.holdStart(editor, options);
		onAudio?.(null, new Float32Array([0, 0.5, -0.5]));
		await stt.toggle(editor, options);
		expect(stt.state).toBe("idle");

		await stt.holdEnd(editor, options);
		expect(stopCapture).toHaveBeenCalledTimes(1);
		expect(transcribe).toHaveBeenCalledTimes(1);
	});

	it("stays inert when a transcription is still settling", async () => {
		let release: ((text: string) => void) | undefined;
		const transcribe = vi.fn(() => new Promise<string>(resolve => (release = resolve)));
		const stt = makeController(transcribe);
		const editor = makeEditor();
		const options = makeOptions();

		await stt.holdStart(editor, options);
		onAudio?.(null, new Float32Array([0, 0.5, -0.5]));
		const pending = stt.holdEnd(editor, options);
		expect(stt.state).toBe("transcribing");

		await stt.holdStart(editor, options);
		expect(stt.state).toBe("transcribing");
		expect(transcribe).toHaveBeenCalledTimes(1);

		release?.("held dictation");
		await pending;
		expect(stt.state).toBe("idle");
	});
});
