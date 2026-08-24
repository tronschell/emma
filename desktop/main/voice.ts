/* The dictation pipeline, main-side.
 *
 * The renderer records; main is what reaches the engine. Not because it is tidier —
 * because a sandboxed `file://` renderer cannot fetch localhost or spawn a helper,
 * and because "it stays on this Mac" is a rule that has to be enforced somewhere the
 * page cannot reach. Every endpoint is validated here, every time, against the same
 * `localEndpoint` the settings form is validated with.
 *
 * Stage one is either the macOS recognizer, through the `emma-transcribe` helper, or
 * a local llama.cpp server. Stage two — the S1-mini cleanup — is the same either way.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { app, systemPreferences } from "electron";
import { localEndpoint } from "../shared/settings";
import { CLEANUP_ORIGIN, cleanedTranscript, cleanupMessages, isVoiceModel, type Utterance, type VoiceSettings, type VoiceStatus } from "../shared/voice";

/* The validators live in shared/voice.ts with the rest of the vocabulary — they are
   pure, and keeping them out of this file is what lets the tests import them without
   dragging in Electron. */
export { validateUtterance, validateVoiceSettings } from "../shared/voice";
export type { Utterance, VoiceSettings } from "../shared/voice";

/** A probe is a liveness check, not a request worth waiting for. */
const PROBE_TIMEOUT = 1_500;
/** Whisper on a laptop is not instant, and a long utterance is worth waiting out. */
const TRANSCRIBE_TIMEOUT = 120_000;
/** S1-mini is 0.6B and answers in a sentence; longer than this and it is not worth the delay. */
const CLEANUP_TIMEOUT = 20_000;

/**
 * The macOS recognizer, out of process.
 *
 * `emma-transcribe` is the Speech.framework helper; Node cannot call it directly and
 * a native module for one framework call is not worth the build. Its contract is a
 * line of text on stdout, or a sentence on stderr and a non-zero exit — the sentence
 * is written to be shown to the user as-is, because it names the switch that is off.
 *
 * TCC reads the *responsible* process's Info.plist, not the helper's, so the
 * `NSSpeechRecognitionUsageDescription` that keeps this from being killed on sight
 * lives in Emma.app's plist (`--extend-info` in `package:mac`).
 */
function helperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "emma-transcribe")
    : path.join(app.getAppPath(), "dist-native/emma-transcribe");
}

/**
 * A helper that said nothing before dying, explained.
 *
 * TCC does not refuse a process that touches speech recognition without a usage
 * string — it aborts it. The string it looks for is the responsible process's, which
 * for this helper is whatever launched Emma: the packaged app carries it, the
 * development Electron does not, so this is what `npm run dev` sees.
 */
function died(signal: NodeJS.Signals | null): string {
  if (signal === "SIGTERM") return "The macOS recognizer did not answer in time.";
  if (!signal) return "";
  return "macOS stopped Emma's speech helper. The built-in recognizer needs the packaged Emma.app — `npm run package:mac`.";
}

function runHelper(args: string[], timeout: number): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(helperPath(), args, { stdio: ["ignore", "pipe", "pipe"], timeout });
    let out = "";
    let err = "";
    // Bounded because both streams are one line by contract, and neither is trusted to be.
    child.stdout.on("data", (data: Buffer) => { out = (out + data).slice(0, 64_000); });
    child.stderr.on("data", (data: Buffer) => { err = (err + data).slice(0, 4_000); });
    child.once("error", () => resolve({ ok: false, out: "", err: "Emma's macOS speech helper is missing from this build." }));
    child.once("close", (code, signal) => resolve({ ok: code === 0, out, err: err.trim() || died(signal) }));
  });
}

/** The first run raises the Speech Recognition prompt, and only the user can answer it. */
const AUTHORIZE_TIMEOUT = 60_000;

async function appleTranscribe(utterance: Utterance): Promise<string> {
  // Speech.framework reads a URL, so the recording has to touch disk; it goes to a
  // private temp directory and is deleted whether or not the recognizer succeeds.
  const dir = await mkdtemp(path.join(tmpdir(), "emma-voice-"));
  const file = path.join(dir, "utterance.wav");
  try {
    await writeFile(file, Buffer.from(utterance.audio), { mode: 0o600 });
    const { ok, out, err } = await runHelper([file], TRANSCRIBE_TIMEOUT);
    if (!ok) throw new Error(err || "The macOS speech recognizer failed.");
    return out.trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Whether anything at all is listening on that origin — a 404 still means a server. */
async function listening(url: URL): Promise<boolean> {
  try {
    await fetch(url.origin, { signal: AbortSignal.timeout(PROBE_TIMEOUT) });
    return true;
  } catch {
    return false;
  }
}

/** What oMLX is serving, or an empty list when it is not running. */
async function servedModels(origin: string): Promise<string[]> {
  try {
    const response = await fetch(`${origin}/v1/models`, { signal: AbortSignal.timeout(PROBE_TIMEOUT) });
    if (!response.ok) return [];
    const body = await response.json() as { data?: { id?: unknown }[] };
    return (body.data ?? []).map((item) => typeof item.id === "string" ? item.id : "").filter(Boolean).slice(0, 64);
  } catch {
    return [];
  }
}

/** Whichever engine is selected, answering the one question: can it hear right now? */
async function speechReady(settings: Pick<VoiceSettings, "transcriptionEngine" | "transcriptionEndpoint">): Promise<{ speech: boolean; speechError: string }> {
  if (settings.transcriptionEngine === "apple") {
    if (process.platform !== "darwin") return { speech: false, speechError: "The macOS recognizer needs macOS." };
    const { ok, err } = await runHelper(["--check"], AUTHORIZE_TIMEOUT);
    return { speech: ok, speechError: ok ? "" : err || "The macOS speech recognizer is not available." };
  }
  const endpoint = localEndpoint(settings.transcriptionEndpoint);
  const speech = endpoint ? await listening(endpoint) : false;
  return { speech, speechError: speech ? "" : "No speech-to-text server is running" };
}

export async function voiceStatus(settings: Pick<VoiceSettings, "transcriptionEngine" | "transcriptionEndpoint" | "voiceCleanupEndpoint">): Promise<VoiceStatus> {
  const cleanupEndpoint = localEndpoint(settings.voiceCleanupEndpoint);
  const [{ speech, speechError }, models] = await Promise.all([
    speechReady(settings),
    servedModels(cleanupEndpoint ? cleanupEndpoint.origin : CLEANUP_ORIGIN),
  ]);
  return {
    microphone: process.platform === "darwin" ? systemPreferences.getMediaAccessStatus("microphone") : "granted",
    speech,
    speechError,
    cleanup: models.length > 0 || (cleanupEndpoint ? await listening(cleanupEndpoint) : false),
    model: models.some(isVoiceModel),
    models,
  };
}

/**
 * Stage two. Never throws: a cleanup that fails, times out, or answers with
 * nonsense hands back exactly what was heard, because a rough transcript is worth
 * far more than an error where the words should be.
 */
async function polish(raw: string, settings: VoiceSettings): Promise<string> {
  const endpoint = localEndpoint(settings.voiceCleanupEndpoint);
  if (!settings.voiceCleanup || !raw.trim() || !endpoint) return raw;
  try {
    const response = await fetch(endpoint.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Thinking off and greedy decoding are what S1-mini was trained for, and the
      // GGUF's inherited metadata says otherwise — so say it here, every time.
      body: JSON.stringify({ model: settings.voiceCleanupModel, messages: cleanupMessages(raw), temperature: 0, top_p: 1, max_tokens: 512, stream: false, chat_template_kwargs: { enable_thinking: false } }),
      signal: AbortSignal.timeout(CLEANUP_TIMEOUT),
    });
    if (!response.ok) return raw;
    const body = await response.json() as { choices?: { message?: { content?: unknown } }[] };
    const reply = body.choices?.[0]?.message?.content;
    return typeof reply === "string" ? cleanedTranscript(raw, reply) : raw;
  } catch {
    return raw;
  }
}

/** Stage one, then stage two. Throws only when the speech engine itself fails. */
export async function transcribe(utterance: Utterance, settings: VoiceSettings): Promise<{ text: string; raw: string }> {
  if (settings.transcriptionEngine === "apple") {
    const heard = await appleTranscribe(utterance);
    return heard ? { text: await polish(heard, settings), raw: heard } : { text: "", raw: "" };
  }
  const endpoint = localEndpoint(settings.transcriptionEndpoint);
  if (!endpoint) throw new Error("The speech-to-text endpoint must be a local address.");
  const form = new FormData();
  // llama.cpp sniffs the container by magic bytes, so the extension only has to be plausible.
  form.append("file", new Blob([utterance.audio], { type: utterance.mimeType }), `utterance.${utterance.mimeType.includes("wav") ? "wav" : "bin"}`);
  form.append("model", settings.transcriptionModel);
  form.append("response_format", "json");
  let response: Response;
  try {
    response = await fetch(endpoint.toString(), { method: "POST", body: form, signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT) });
  } catch {
    throw new Error(`No speech-to-text server answered at ${endpoint.origin}. Start one in Settings → Voice.`);
  }
  if (!response.ok) throw new Error(`The speech-to-text server answered ${response.status}. Check the model name in Settings → Voice.`);
  const body = await response.json().catch(() => ({})) as { text?: unknown };
  const raw = typeof body.text === "string" ? body.text.trim() : "";
  if (!raw) return { text: "", raw: "" };
  return { text: await polish(raw, settings), raw };
}
