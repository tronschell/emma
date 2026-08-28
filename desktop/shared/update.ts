export const UPDATE_REPOSITORY = "tronschell/emma";
export const DEFAULT_UPDATE_ORIGIN = "https://update.electronjs.org";

const MAX_UPDATE_ORIGIN_CHARS = 512;
const SEMVER = /^\d+\.\d+\.\d+$/;

export function updateOrigin(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed || trimmed.length > MAX_UPDATE_ORIGIN_CHARS) return "";
  if (/^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i.test(trimmed)) return trimmed;
  if (/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/i.test(trimmed)) return trimmed;
  return "";
}

export function updateFeedUrl(origin: string, platform: string, arch: string, version: string) {
  return `${origin}/${UPDATE_REPOSITORY}/${platform}-${arch}/${version}`;
}

export function newerVersion(current: string, downloaded: unknown): string {
  if (typeof downloaded !== "string") return "";
  const next = downloaded.trim().replace(/^v/i, "");
  if (!SEMVER.test(next) || !SEMVER.test(current)) return "";
  const to = next.split(".").map(Number);
  const from = current.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (to[index] !== from[index]) return to[index] > from[index] ? next : "";
  }
  return "";
}

export function showsUpdate(ready: string, dismissed: string) {
  return !!ready && ready !== dismissed;
}
