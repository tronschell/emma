export type ScreenContextAttachment = Readonly<{ id: string; image: string; source?: FrontApplication }>;

/** The app the user had in front when the screen was captured, as the agent is told it. */
export type FrontApplication = Readonly<{ application: string; window: string }>;

export function frontApplicationNote(source: FrontApplication | undefined) {
  if (!source?.application) return "";
  const window = source.window && source.window !== source.application ? `, window “${source.window}”` : "";
  return `The attached screen capture is the user's own screen. The app they had in front was “${source.application}”${window}.`;
}

export function validScreenContextId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[a-z0-9-]+$/.test(value);
}

export class ScreenContextStore {
  private attachment: ScreenContextAttachment | undefined;
  private claimedId: string | undefined;

  put(attachment: ScreenContextAttachment) {
    if (!validScreenContextId(attachment.id)) throw new Error("Screen context ID is invalid");
    this.attachment = attachment;
    this.claimedId = undefined;
  }

  /** The overlay shows what is attached, so the image travels with the id. */
  status() {
    if (!this.attachment) return null;
    const { id, image, source } = this.attachment;
    return { id, image, ...(source ? { source } : {}) };
  }

  claim(id: string) {
    if (!validScreenContextId(id) || this.claimedId || this.attachment?.id !== id) throw new Error("Screen context is unavailable");
    this.claimedId = id;
    return this.attachment;
  }

  finish(id: string, delivered: boolean) {
    if (this.claimedId !== id) throw new Error("Screen context delivery is invalid");
    this.claimedId = undefined;
    if (delivered && this.attachment?.id === id) this.attachment = undefined;
  }

  clear(id: string) {
    if (this.claimedId === id) throw new Error("Screen context is being sent");
    if (this.attachment?.id === id) this.attachment = undefined;
  }

  clearAll() {
    this.attachment = undefined;
    this.claimedId = undefined;
  }
}
