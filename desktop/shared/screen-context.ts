export type ScreenPoint = { x: number; y: number };
export type ScreenStroke = ScreenPoint[];
export type ScreenContextAttachment = Readonly<{ id: string; image: string }>;

export const MAX_SCREEN_STROKES = 64;
export const MAX_SCREEN_POINTS = 4096;

export function validateScreenStrokes(value: unknown, width: number, height: number): ScreenStroke[] {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || !Array.isArray(value) || value.length < 1 || value.length > MAX_SCREEN_STROKES) {
    throw new Error("Screen annotation strokes are invalid");
  }
  let points = 0;
  return value.map((stroke) => {
    if (!Array.isArray(stroke) || stroke.length < 2 || stroke.length > MAX_SCREEN_POINTS) throw new Error("Screen annotation stroke is invalid");
    points += stroke.length;
    if (points > MAX_SCREEN_POINTS) throw new Error("Screen annotation is too detailed");
    return stroke.map((point) => {
      if (!point || typeof point !== "object" || Array.isArray(point)) throw new Error("Screen annotation point is invalid");
      const candidate = point as Record<string, unknown>;
      if (Object.keys(candidate).length !== 2 || typeof candidate.x !== "number" || typeof candidate.y !== "number" || !Number.isFinite(candidate.x) || !Number.isFinite(candidate.y) || candidate.x < 0 || candidate.x > width || candidate.y < 0 || candidate.y > height) {
        throw new Error("Screen annotation point is invalid");
      }
      return { x: candidate.x, y: candidate.y };
    });
  });
}

export function validScreenContextId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[a-z0-9-]+$/.test(value);
}

export function authorizedScreenContextId(value: unknown, authorized: boolean): string | undefined {
  return authorized && validScreenContextId(value) ? value : undefined;
}

export class ScreenContextStore {
  private attachment: ScreenContextAttachment | undefined;
  private claimedId: string | undefined;

  put(attachment: ScreenContextAttachment) {
    if (!validScreenContextId(attachment.id)) throw new Error("Screen context ID is invalid");
    this.attachment = attachment;
    this.claimedId = undefined;
  }

  status() {
    return this.attachment ? { id: this.attachment.id } : null;
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
