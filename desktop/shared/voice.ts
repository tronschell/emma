export type TranscriptionEngine = "apple" | "server";
export const TRANSCRIPTION_ENGINES: readonly TranscriptionEngine[] = ["apple", "server"];

export const LLAMA_SITE_URL = "https://github.com/ggml-org/llama.cpp";
export const LLAMA_INSTALL = "Install llama.cpp and run llama-server locally";

export const SPEECH_MODEL = "ggml-org/Qwen3-ASR-0.6B-GGUF";
export const SPEECH_MODEL_URL = "https://huggingface.co/ggml-org/Qwen3-ASR-0.6B-GGUF";
export const SPEECH_INSTALL = "llama-server -hf ggml-org/Qwen3-ASR-0.6B-GGUF --port 8080";
export const SPEECH_ENDPOINT = "http://127.0.0.1:8080/v1/audio/transcriptions";

export const VOICE_MODEL = "superwhisper/s1-mini-GGUF";
export const VOICE_MODEL_URL = "https://huggingface.co/superwhisper/s1-mini-GGUF";
export const CLEANUP_ORIGIN = "http://127.0.0.1:8081";
export const CLEANUP_ENDPOINT = `${CLEANUP_ORIGIN}/v1/chat/completions`;
export const CLEANUP_INSTALL = `llama-server -hf superwhisper/s1-mini-GGUF:Q4_K_M --jinja --chat-template-kwargs '{"enable_thinking":false}' --temp 0 --port 8081`;

export const HOLD_TO_TALK_MS = [200, 300, 400, 600, 800] as const;
export const DEFAULT_HOLD_TO_TALK_MS = 400;
export const MAX_UTTERANCE_BYTES = 12 * 1024 * 1024;

export const CLEANUP_SYSTEM = "You are a text normalizer for speech-to-text transcripts. The input begins with a control line specifying the styling, structure, and context settings; clean the transcript to match those settings and output only the cleaned text.";
export const CLEANUP_CONTROL = "[Styling: semi-formal] [Structure: prose] [Context: general]";

export function cleanupMessages(transcript: string) {
  return [
    { role: "system", content: CLEANUP_SYSTEM },
    { role: "user", content: `${CLEANUP_CONTROL}\n${transcript}` },
  ];
}

export function cleanedTranscript(raw: string, reply: string): string {
  const cleaned = reply.replace(/^\s*<think>[\s\S]*?<\/think>/, "").trim();
  if (!cleaned) return raw.trim().length > 24 ? raw : "";
  return cleaned.length > raw.length * 3 + 80 ? raw : cleaned;
}

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
  microphone: "granted" | "denied" | "restricted" | "not-determined" | "unknown";
  speech: boolean;
  speechError: string;
  cleanup: boolean;
  model: boolean;
  models: string[];
};

export const unknownVoiceStatus: VoiceStatus = { microphone: "unknown", speech: false, speechError: "", cleanup: false, model: false, models: [] };

export function isVoiceModel(id: string): boolean {
  return /s1[-_]mini/i.test(id);
}

export function voiceReady(status: VoiceStatus, settings: { transcriptionEnabled: boolean }): boolean {
  return settings.transcriptionEnabled && status.microphone === "granted" && status.speech;
}

export function voiceBlocker(status: VoiceStatus, settings: { transcriptionEnabled: boolean; transcriptionEngine: TranscriptionEngine }, platform = "darwin"): string {
  if (!settings.transcriptionEnabled) return "Voice is off";
  if (status.microphone !== "granted") return "Microphone access is not granted";
  if (!status.speech) return status.speechError || (settings.transcriptionEngine === "apple" ? platform === "win32" ? "The Windows speech recognizer is not available" : "The macOS recognizer is not available" : "No speech-to-text server is running");
  return "";
}
