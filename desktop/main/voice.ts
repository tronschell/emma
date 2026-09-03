import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { app, systemPreferences } from "electron";
import { localEndpoint } from "../shared/settings";
import { CLEANUP_ORIGIN, cleanedTranscript, cleanupMessages, isVoiceModel, type Utterance, type VoiceSettings, type VoiceStatus } from "../shared/voice";
import { isMac, isWindows } from "./platform";

export { validateUtterance, validateVoiceSettings } from "../shared/voice";
export type { Utterance, VoiceSettings } from "../shared/voice";

const PROBE_TIMEOUT = 1_500;
const TRANSCRIBE_TIMEOUT = 120_000;
const CLEANUP_TIMEOUT = 20_000;
const AUTHORIZE_TIMEOUT = 60_000;

function helperPath() {
  const filename = isWindows ? "emma-transcribe.exe" : "emma-transcribe";
  return app.isPackaged ? path.join(process.resourcesPath, filename) : path.join(app.getAppPath(), `dist-native/${filename}`);
}

function died(signal: NodeJS.Signals | null): string {
  if (signal === "SIGTERM") return "The built-in recognizer did not answer in time.";
  if (!signal) return "";
  return "The built-in speech helper stopped. Restart Emma and try again.";
}

function runHelper(args: string[], timeout: number): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(helperPath(), args, { stdio: ["ignore", "pipe", "pipe"], timeout, windowsHide: isWindows });
    let out = "";
    let err = "";
    child.stdout.on("data", (data: Buffer) => { out = (out + data).slice(0, 64_000); });
    child.stderr.on("data", (data: Buffer) => { err = (err + data).slice(0, 4_000); });
    child.once("error", () => resolve({ ok: false, out: "", err: "Emma's built-in speech helper is missing from this build." }));
    child.once("close", (code, signal) => resolve({ ok: code === 0, out, err: err.trim() || died(signal) }));
  });
}

async function builtInTranscribe(utterance: Utterance): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "emma-voice-"));
  const file = path.join(dir, "utterance.wav");
  try {
    await writeFile(file, Buffer.from(utterance.audio), { mode: 0o600 });
    const { ok, out, err } = await runHelper([file], TRANSCRIBE_TIMEOUT);
    if (!ok) throw new Error(err || "The built-in speech recognizer failed.");
    return out.trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function listening(url: URL): Promise<boolean> {
  try {
    await fetch(url.origin, { signal: AbortSignal.timeout(PROBE_TIMEOUT) });
    return true;
  } catch {
    return false;
  }
}

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

async function speechReady(settings: Pick<VoiceSettings, "transcriptionEngine" | "transcriptionEndpoint">): Promise<{ speech: boolean; speechError: string }> {
  if (settings.transcriptionEngine === "apple") {
    if (!isMac && !isWindows) return { speech: false, speechError: "The built-in recognizer needs macOS or Windows." };
    const { ok, err } = await runHelper(["--check"], AUTHORIZE_TIMEOUT);
    return { speech: ok, speechError: ok ? "" : err || "The built-in speech recognizer is not available." };
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
    microphone: isMac || isWindows ? systemPreferences.getMediaAccessStatus("microphone") : "granted",
    speech,
    speechError,
    cleanup: models.length > 0 || (cleanupEndpoint ? await listening(cleanupEndpoint) : false),
    model: models.some(isVoiceModel),
    models,
  };
}

async function polish(raw: string, settings: VoiceSettings): Promise<string> {
  const endpoint = localEndpoint(settings.voiceCleanupEndpoint);
  if (!settings.voiceCleanup || !raw.trim() || !endpoint) return raw;
  try {
    const response = await fetch(endpoint.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
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

export async function transcribe(utterance: Utterance, settings: VoiceSettings): Promise<{ text: string; raw: string }> {
  if (settings.transcriptionEngine === "apple") {
    const heard = await builtInTranscribe(utterance);
    return heard ? { text: await polish(heard, settings), raw: heard } : { text: "", raw: "" };
  }
  const endpoint = localEndpoint(settings.transcriptionEndpoint);
  if (!endpoint) throw new Error("The speech-to-text endpoint must be a local address.");
  const form = new FormData();
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
