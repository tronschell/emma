import { useCallback, useEffect, useRef, useState } from "react";
import type { UserSettings } from "../shared/settings";
import { unknownVoiceStatus, voiceBlocker, voiceReady, type VoiceStatus } from "../shared/voice";
import type { VoiceSettings } from "./types";
import { reasonText } from "./errors";

export function voiceSettings(settings: UserSettings): VoiceSettings {
  return {
    transcriptionEngine: settings.transcriptionEngine,
    transcriptionEndpoint: settings.transcriptionEndpoint,
    transcriptionModel: settings.transcriptionModel,
    voiceCleanup: settings.voiceCleanup,
    voiceCleanupEndpoint: settings.voiceCleanupEndpoint,
    voiceCleanupModel: settings.voiceCleanupModel,
  };
}

const SAMPLE_RATE = 16_000;

function mono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const mixed = Float32Array.from(buffer.getChannelData(0));
  for (let channel = 1; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < mixed.length; index += 1) mixed[index] += data[index];
  }
  return mixed.map((sample) => sample / buffer.numberOfChannels);
}

function wav(samples: Float32Array): ArrayBuffer {
  const bytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + bytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => { for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index)); };
  ascii(0, "RIFF"); view.setUint32(4, 36 + bytes, true); ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true); view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, "data"); view.setUint32(40, bytes, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return buffer;
}

async function toWav(encoded: ArrayBuffer): Promise<ArrayBuffer> {
  const decoded = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(encoded);
  return wav(mono(decoded));
}

type Recording = { stop: () => Promise<{ audio: ArrayBuffer; mimeType: string }>; cancel: () => void };

async function record(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
  recorder.start();
  const release = () => stream.getTracks().forEach((track) => track.stop());
  return {
    cancel: () => { if (recorder.state !== "inactive") recorder.stop(); release(); },
    stop: () => new Promise((resolve, reject) => {
      recorder.onerror = () => { release(); reject(new Error("The microphone stopped unexpectedly.")); };
      recorder.onstop = () => {
        release();
        new Blob(chunks).arrayBuffer()
          .then(toWav)
          .then((audio) => resolve({ audio, mimeType: "audio/wav" }))
          .catch(() => reject(new Error("Emma could not read the recording.")));
      };
      if (recorder.state === "inactive") recorder.onstop?.(new Event("stop"));
      else recorder.stop();
    }),
  };
}

export type Dictation = ReturnType<typeof useDictation>;

export function useDictation(settings: UserSettings, onText: (text: string) => void) {
  const [status, setStatus] = useState<VoiceStatus>(unknownVoiceStatus);
  const [listening, setListening] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const recording = useRef<Recording | null>(null);
  const refresh = useCallback(() => window.emma.voiceStatus(voiceSettings(settings))
    .catch(() => unknownVoiceStatus)
    .then((next) => { setStatus(next); return next; }), [settings]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => () => recording.current?.cancel(), []);
  const start = useCallback(async () => {
    if (recording.current || working) return false;
    setError("");
    try {
      recording.current = await record();
      setListening(true);
      return true;
    } catch {
      recording.current = null;
      setError("Emma could not open the microphone. Grant it in Settings → Voice.");
      void refresh();
      return false;
    }
  }, [refresh, working]);
  const stop = useCallback(async () => {
    const active = recording.current;
    if (!active) return;
    recording.current = null;
    setListening(false);
    setWorking(true);
    try {
      const utterance = await active.stop();
      const { text } = await window.emma.transcribe({ ...utterance, settings: voiceSettings(settings) });
      if (text) onText(text);
      else setError("Nothing was heard.");
    } catch (reason) {
      setError(reasonText(reason));
    } finally {
      setWorking(false);
    }
  }, [onText, settings]);
  const cancel = useCallback(() => { recording.current?.cancel(); recording.current = null; setListening(false); }, []);
  return {
    status, listening, working, error, setError, refresh, start, stop, cancel,
    ready: voiceReady(status, settings),
    blocker: voiceBlocker(status, settings, window.emma.platform),
  };
}

export function useSpaceHold(holdMs: number, armed: boolean, dictation: Pick<Dictation, "start" | "stop" | "cancel" | "listening">) {
  const held = useRef<number | null>(null);
  const { start, stop, cancel, listening } = dictation;
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat || event.metaKey || event.ctrlKey || event.altKey || !armed) return;
      if (held.current !== null) return;
      event.preventDefault();
      held.current = window.setTimeout(() => { held.current = null; void start(); }, holdMs);
    };
    const up = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      if (held.current !== null) { clearTimeout(held.current); held.current = null; return; }
      if (listening) { event.preventDefault(); void stop(); }
    };
    const blur = () => { if (held.current !== null) { clearTimeout(held.current); held.current = null; } if (listening) cancel(); };
    addEventListener("keydown", down);
    addEventListener("keyup", up);
    addEventListener("blur", blur);
    return () => {
      removeEventListener("keydown", down);
      removeEventListener("keyup", up);
      removeEventListener("blur", blur);
      if (held.current !== null) { clearTimeout(held.current); held.current = null; }
    };
  }, [armed, cancel, holdMs, listening, start, stop]);
}
