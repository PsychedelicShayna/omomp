import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";

const WAV_HEADER_BYTES = 44;
const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

/**
 * Disk-backed mono PCM16 WAV recorder for long dictation sessions.
 *
 * AudioCapture supplies normalized Float32 samples. Quantize and append each
 * chunk immediately so a long recording uses constant memory; finalize patches
 * the RIFF sizes once capture stops.
 */
export class WavFileRecorder {
	readonly #fd: number;
	#sampleCount = 0;
	#closed = false;

	readonly path: string;

	constructor(directory: string = join(getAgentDir(), "stt-recordings")) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		this.path = join(directory, `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.wav`);
		this.#fd = openSync(this.path, "w+", 0o600);
		writeSync(this.#fd, createWavHeader(0));
	}

	append(samples: Float32Array): void {
		if (this.#closed || samples.length === 0) return;
		const pcm = Buffer.allocUnsafe(samples.length * 2);
		for (let i = 0; i < samples.length; i += 1) {
			const sample = samples[i]!;
			const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
			const quantized = clamped < 0 ? Math.round(clamped * 32_768) : Math.round(clamped * 32_767);
			pcm.writeInt16LE(quantized, i * 2);
		}
		writeSync(this.#fd, pcm);
		this.#sampleCount += samples.length;
	}

	finalize(): string {
		if (!this.#closed) {
			const dataBytes = this.#sampleCount * 2;
			writeSync(this.#fd, createWavHeader(dataBytes), 0, WAV_HEADER_BYTES, 0);
			closeSync(this.#fd);
			this.#closed = true;
		}
		return this.path;
	}

	get empty(): boolean {
		return this.#sampleCount === 0;
	}
	dispose(): void {
		if (!this.#closed) {
			closeSync(this.#fd);
			this.#closed = true;
		}
		try {
			unlinkSync(this.path);
		} catch {
			// Already removed.
		}
	}
}

function createWavHeader(dataBytes: number): Buffer {
	const header = Buffer.alloc(WAV_HEADER_BYTES);
	const bytesPerSample = BITS_PER_SAMPLE / 8;
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(WAV_HEADER_BYTES - 8 + dataBytes, 4);
	header.write("WAVE", 8, "ascii");
	header.write("fmt ", 12, "ascii");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(CHANNELS, 22);
	header.writeUInt32LE(SAMPLE_RATE, 24);
	header.writeUInt32LE(SAMPLE_RATE * CHANNELS * bytesPerSample, 28);
	header.writeUInt16LE(CHANNELS * bytesPerSample, 32);
	header.writeUInt16LE(BITS_PER_SAMPLE, 34);
	header.write("data", 36, "ascii");
	header.writeUInt32LE(dataBytes, 40);
	return header;
}
