export interface QuickAction {
  label: string;
  prompt: string;
  destinationKnowledgeBaseId: string;
  category: string;
  saveToKnowledge: boolean;
}

export interface UserSettings {
  quickActions: [QuickAction, QuickAction, QuickAction];
  overlayPlacement: OverlayPlacement;
  notchGap: number;
  transcriptionEnabled: boolean;
  transcriptionEndpoint: string;
  transcriptionModel: string;
}

export type OverlayPlacement = "below" | "rails";
export type OverlayPreferences = Pick<UserSettings, "overlayPlacement" | "notchGap">;

const action = (label: string, prompt: string): QuickAction => ({ label, prompt, destinationKnowledgeBaseId: "", category: "", saveToKnowledge: false });

export const defaultSettings: UserSettings = {
  quickActions: [action("Summarize", "Summarize the current idea and identify the next step."), action("Research", "Research this topic using available knowledge and explain the key findings."), action("Draft", "Turn this idea into a concise working draft.")],
  overlayPlacement: "below",
  notchGap: 180,
  transcriptionEnabled: false,
  transcriptionEndpoint: "http://127.0.0.1:8080/v1/audio/transcriptions",
  transcriptionModel: "whisper-1",
};

export function validateSettings(value: unknown): UserSettings {
  if (!value || typeof value !== "object") throw new Error("Settings are invalid");
  const settings = value as Partial<UserSettings>;
  if (!Array.isArray(settings.quickActions) || settings.quickActions.length !== 3) throw new Error("Exactly three quick actions are required");
  const quickActions = settings.quickActions.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Quick action is invalid");
    const entry = item as Partial<QuickAction>;
    for (const key of ["label", "prompt", "destinationKnowledgeBaseId", "category"] as const) if (typeof entry[key] !== "string") throw new Error("Quick action is invalid");
    if (!entry.label!.trim() || entry.label!.length > 40 || !entry.prompt!.trim() || entry.prompt!.length > 4096 || entry.category!.length > 64 || (entry.category && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.category)) || typeof entry.saveToKnowledge !== "boolean") throw new Error("Quick action is invalid");
    return { ...entry } as QuickAction;
  }) as UserSettings["quickActions"];
  const overlayPlacement = settings.overlayPlacement ?? defaultSettings.overlayPlacement;
  const notchGap = settings.notchGap ?? defaultSettings.notchGap;
  if (!["below", "rails"].includes(overlayPlacement) || !Number.isInteger(notchGap) || notchGap < 120 || notchGap > 260) throw new Error("Overlay settings are invalid");
  if (typeof settings.transcriptionEnabled !== "boolean" || typeof settings.transcriptionEndpoint !== "string" || typeof settings.transcriptionModel !== "string" || !settings.transcriptionModel.trim()) throw new Error("Transcription settings are invalid");
  if (settings.transcriptionEnabled && !localEndpoint(settings.transcriptionEndpoint)) throw new Error("Transcription endpoint must be local");
  return { quickActions, overlayPlacement, notchGap, transcriptionEnabled: settings.transcriptionEnabled, transcriptionEndpoint: settings.transcriptionEndpoint, transcriptionModel: settings.transcriptionModel };
}

export function validateOverlayPreferences(value: unknown): OverlayPreferences {
  if (!value || typeof value !== "object") throw new Error("Overlay settings are invalid");
  const preferences = value as Partial<OverlayPreferences>;
  if (!["below", "rails"].includes(preferences.overlayPlacement as string) || !Number.isInteger(preferences.notchGap) || preferences.notchGap! < 120 || preferences.notchGap! > 260) throw new Error("Overlay settings are invalid");
  return preferences as OverlayPreferences;
}

export function localEndpoint(value: string): URL | null {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ? url : null;
  } catch { return null; }
}
