/* Voice: speech in, written text out. Two stages, one engine.

   Stage one is speech-to-text. Stage two is S1-mini, which is *not* a speech
   model: it is a 0.6B text model that rewrites a raw transcript as written
   English — fillers dropped, self-corrections resolved, punctuation and numbers
   rendered properly. It reads what stage one heard, so it can only ever be the
   second half. Stage two is optional and never fatal: a cleanup that fails hands
   back the raw transcript rather than losing what was said.

   Both stages are llama.cpp. It is the maintained, Metal-accelerated GGUF engine,
   it does multimodal input through libmtmd, and its server speaks both routes the
   pipeline needs — `/v1/audio/transcriptions` for the audio and
   `/v1/chat/completions` for the text. One `brew install`, two `llama-server`
   processes, and Emma's two HTTP calls are the OpenAI-standard ones. */

/**
 * Which engine hears the recording.
 *
 * "apple" is the recognizer macOS already ships — the same on-device engine as
 * system dictation, reached through Speech.framework by the `emma-transcribe`
 * helper. Nothing to install and nothing to keep running, at the cost of a model
 * Emma does not choose. "server" is the llama.cpp route below: better words, two
 * downloads and a terminal. Either way the audio stays on this Mac — the helper
 * pins `requiresOnDeviceRecognition`, so a Mac that cannot do it locally errors
 * rather than uploading to Apple.
 */
export type TranscriptionEngine = "apple" | "server";
export const TRANSCRIPTION_ENGINES: readonly TranscriptionEngine[] = ["apple", "server"];

/** llama.cpp: one binary for both halves, and the only install voice needs. */
export const LLAMA_SITE_URL = "https://github.com/ggml-org/llama.cpp";
export const LLAMA_INSTALL = "brew install llama.cpp";

/* Stage one. Qwen3-ASR is ggml-org's own audio GGUF, small enough to sit
   resident: 0.6B, and `-hf` pulls its mmproj alongside the weights. */
export const SPEECH_MODEL = "ggml-org/Qwen3-ASR-0.6B-GGUF";
export const SPEECH_MODEL_URL = "https://huggingface.co/ggml-org/Qwen3-ASR-0.6B-GGUF";
export const SPEECH_INSTALL = "llama-server -hf ggml-org/Qwen3-ASR-0.6B-GGUF --port 8080";
export const SPEECH_ENDPOINT = "http://127.0.0.1:8080/v1/audio/transcriptions";

/* Stage two. Superwhisper's own GGUF build, Q4_K_M — 462 MB, the build its
   published 94.8% token accuracy was measured on.

   The two flags are not decoration. S1-mini was trained with Qwen3's thinking
   mode *off*, and the embedded template defaults it on; without `--jinja` plus
   the kwarg the assistant turn never opens its empty think block and the output
   is unusable. And the file's own metadata carries Qwen3-0.6B's `temp = 0.6`,
   which S1-mini was not trained for — normalization is deterministic. Emma sends
   both again on every request, so a server started without them still behaves. */
export const VOICE_MODEL = "superwhisper/s1-mini-GGUF";
export const VOICE_MODEL_URL = "https://huggingface.co/superwhisper/s1-mini-GGUF";
export const CLEANUP_ORIGIN = "http://127.0.0.1:8081";
export const CLEANUP_ENDPOINT = `${CLEANUP_ORIGIN}/v1/chat/completions`;
export const CLEANUP_INSTALL = `llama-server -hf superwhisper/s1-mini-GGUF:Q4_K_M --jinja --chat-template-kwargs '{"enable_thinking":false}' --temp 0 --port 8081`;

/** How long the space bar has to stay down before the island starts listening. */
export const HOLD_TO_TALK_MS = [200, 300, 400, 600, 800] as const;
export const DEFAULT_HOLD_TO_TALK_MS = 400;

/** One utterance's ceiling, in bytes of encoded audio — a few minutes of Opus. */
export const MAX_UTTERANCE_BYTES = 12 * 1024 * 1024;

/* Verbatim from the model card: S1-mini is not a chat model and does not follow
   general instructions. It does one job, and this is the shape it was trained on —
   the system prompt, then a control line, then one raw transcript. */
export const CLEANUP_SYSTEM = "You are a text normalizer for speech-to-text transcripts. The input begins with a control line specifying the styling, structure, and context settings; clean the transcript to match those settings and output only the cleaned text.";
export const CLEANUP_CONTROL = "[Styling: semi-formal] [Structure: prose] [Context: general]";

export function cleanupMessages(transcript: string) {
  return [
    { role: "system", content: CLEANUP_SYSTEM },
    { role: "user", content: `${CLEANUP_CONTROL}\n${transcript}` },
  ];
}

/**
 * What to keep of the cleanup pass.
 *
 * The model answers with the cleaned line and nothing else, so anything much longer
 * than what was said is it having talked *about* the transcript instead of rewriting
 * it — thinking mode left on, or a wrong model under the same name. An empty answer
 * is a real one (pure filler cleans to nothing), but only when there was little to
 * clean. A leaked think block is dropped rather than typed into the composer.
 */
export function cleanedTranscript(raw: string, reply: string): string {
  const cleaned = reply.replace(/^\s*<think>[\s\S]*?<\/think>/, "").trim();
  if (!cleaned) return raw.trim().length > 24 ? raw : "";
  return cleaned.length > raw.length * 3 + 80 ? raw : cleaned;
}

/* Emma keeps the user's settings in the renderer, so the voice fields ride with each
   call to main rather than being read there. That makes them untrusted input twice
   over — once as settings, once as an IPC payload — so both are checked here, and
   main checks every endpoint against `localEndpoint` again before it is used. */
export type VoiceSettings = Pick<import("./settings").UserSettings, "transcriptionEngine" | "transcriptionEndpoint" | "transcriptionModel" | "voiceCleanup" | "voiceCleanupEndpoint" | "voiceCleanupModel">;

export function validateVoiceSettings(value: unknown): VoiceSettings {
  if (!value || typeof value !== "object") throw new Error("Voice settings are invalid");
  const settings = value as Record<string, unknown>;
  const strings = ["transcriptionEndpoint", "transcriptionModel", "voiceCleanupEndpoint", "voiceCleanupModel"] as const;
  if (strings.some((key) => typeof settings[key] !== "string" || !(settings[key] as string).trim() || (settings[key] as string).length > 256) || typeof settings.voiceCleanup !== "boolean") throw new Error("Voice settings are invalid");
  if (!TRANSCRIPTION_ENGINES.includes(settings.transcriptionEngine as TranscriptionEngine)) throw new Error("Voice settings are invalid");
  return {
    transcriptionEngine: settings.transcriptionEngine as TranscriptionEngine,
    transcriptionEndpoint: settings.transcriptionEndpoint as string,
    transcriptionModel: settings.transcriptionModel as string,
    voiceCleanup: settings.voiceCleanup as boolean,
    voiceCleanupEndpoint: settings.voiceCleanupEndpoint as string,
    voiceCleanupModel: settings.voiceCleanupModel as string,
  };
}

export type Utterance = { audio: ArrayBuffer; mimeType: string };

export function validateUtterance(value: unknown): Utterance {
  if (!value || typeof value !== "object") throw new Error("The recording is invalid");
  const { audio, mimeType } = value as { audio?: unknown; mimeType?: unknown };
  if (!(audio instanceof ArrayBuffer) || typeof mimeType !== "string") throw new Error("The recording is invalid");
  if (!audio.byteLength) throw new Error("Nothing was recorded — hold the key a moment longer.");
  if (audio.byteLength > MAX_UTTERANCE_BYTES) throw new Error("That recording is too long to transcribe in one go.");
  if (!/^audio\/[a-z0-9.+-]{1,32}(;[ a-z0-9.=+"-]{1,64})?$/i.test(mimeType)) throw new Error("The recording is invalid");
  return { audio, mimeType };
}

export type VoiceStatus = {
  /** macOS microphone grant: only "granted" can record. */
  microphone: "granted" | "denied" | "restricted" | "not-determined" | "unknown";
  /** The chosen speech engine can run: the server answered, or macOS is ready to listen. */
  speech: boolean;
  /** Why it cannot, when the engine knows — the macOS recognizer says which switch is off. */
  speechError: string;
  /** The cleanup server answered. */
  cleanup: boolean;
  /** The cleanup server is serving something that looks like S1-mini. */
  model: boolean;
  /** Model ids the cleanup server reports, so settings can show what it found. */
  models: string[];
};

export const unknownVoiceStatus: VoiceStatus = { microphone: "unknown", speech: false, speechError: "", cleanup: false, model: false, models: [] };

/** Whether a reported id is the cleanup model, under any of the names it may be served as. */
export function isVoiceModel(id: string): boolean {
  return /s1[-_]mini/i.test(id);
}

/**
 * Whether dictation can run right now.
 *
 * Cleanup is deliberately not part of it: S1-mini polishes a transcript, so its
 * absence costs punctuation, not speech.
 */
export function voiceReady(status: VoiceStatus, settings: { transcriptionEnabled: boolean }): boolean {
  return settings.transcriptionEnabled && status.microphone === "granted" && status.speech;
}

/** The one thing standing in the way, for the island to say before it sends the user to Settings. */
export function voiceBlocker(status: VoiceStatus, settings: { transcriptionEnabled: boolean; transcriptionEngine: TranscriptionEngine }): string {
  if (!settings.transcriptionEnabled) return "Voice is off";
  if (status.microphone !== "granted") return "Microphone access is not granted";
  if (!status.speech) return status.speechError || (settings.transcriptionEngine === "apple" ? "The macOS recognizer is not available" : "No speech-to-text server is running");
  return "";
}
