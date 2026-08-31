import { type ApiKey, type FetchImpl, withAuth } from "@oh-my-pi/pi-ai";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { USER_AGENT } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveXAIHttpCredentials } from "../lib/xai-http";

const XAI_STT_MODEL = "grok-stt";
const XAI_STT_TIMEOUT_MS = 10 * 60_000;

interface XaiSttResponse {
	text?: unknown;
}

export interface XaiSttOptions {
	modelRegistry: ModelRegistry;
	sessionId: string;
	audio: Blob;
	filename?: string;
	language?: string;
	fetchImpl?: FetchImpl;
	signal?: AbortSignal;
}

/** Transcribe one complete recording through xAI's native multipart /stt route. */
export async function transcribeXaiAudio(options: XaiSttOptions): Promise<string> {
	const creds = await resolveXAIHttpCredentials(options.modelRegistry);
	if (!creds) {
		throw new Error("No xAI credentials. Run /login → xAI Grok OAuth or set XAI_API_KEY.");
	}

	const form = new FormData();
	form.append("file", options.audio, options.filename ?? "dictation.wav");
	form.append("model", XAI_STT_MODEL);
	if (options.language?.trim()) form.append("language", options.language.trim());

	const timeoutSignal = AbortSignal.timeout(XAI_STT_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	const apiKey: ApiKey = options.modelRegistry.resolver(creds.provider, {
		sessionId: options.sessionId,
		baseUrl: creds.baseURL,
	});
	const request = options.fetchImpl ?? globalThis.fetch;

	const response = await withAuth(
		apiKey,
		async key => {
			const result = await request(`${creds.baseURL}/stt`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${key}`,
					"User-Agent": USER_AGENT,
				},
				body: form,
				signal,
			});
			if (!result.ok) {
				const detail = await result.text();
				throw new ProviderHttpError(`xAI STT failed (${result.status}): ${detail.slice(0, 300)}`, result.status, {
					headers: result.headers,
				});
			}
			return result;
		},
		{ signal },
	);

	let payload: XaiSttResponse;
	try {
		payload = (await response.json()) as XaiSttResponse;
	} catch {
		throw new Error("xAI STT returned invalid JSON.");
	}
	if (typeof payload.text !== "string") throw new Error("xAI STT response did not contain transcript text.");
	return payload.text.trim();
}
