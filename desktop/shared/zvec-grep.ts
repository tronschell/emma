export const ZVEC_GREP_VERSION = "0.2.1";
export const ZVEC_GREP_ENTRY = "node_modules/@zvec/zvec-grep/dist/cli/index.js";
export const ZVEC_GREP_REPOSITORY = "tronschell/emma";
export const ZVEC_GREP_TAG = `zvec-grep-v${ZVEC_GREP_VERSION}`;
export const DEFAULT_TOOLS_ORIGIN = "https://github.com";

export type ZvecGrepPhase = "missing" | "downloading" | "verifying" | "extracting" | "ready" | "failed";
export type ZvecGrepStatus = { phase: ZvecGrepPhase; version: string; bytes: number; total: number; detail: string };

export function zvecGrepAsset(platform: string, arch: string): string {
  return `zvec-grep-${ZVEC_GREP_VERSION}-${platform}-${arch}.tar.gz`;
}

export function zvecGrepUrl(origin: string, platform: string, arch: string): string {
  return `${origin}/${ZVEC_GREP_REPOSITORY}/releases/download/${ZVEC_GREP_TAG}/${zvecGrepAsset(platform, arch)}`;
}

const DOWNLOAD_BYTES: Record<string, number> = { win32: 440 * 1024 * 1024, darwin: 180 * 1024 * 1024 };

export function zvecGrepDownloadBytes(platform: string): number {
  return DOWNLOAD_BYTES[platform] ?? DOWNLOAD_BYTES.win32;
}

export function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${Number((bytes / 1024 / 1024 / 1024).toFixed(1))} GB`;
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

export const zvecGrepPhaseLabel: Record<ZvecGrepPhase, string> = {
  missing: "Not downloaded",
  downloading: "Downloading",
  verifying: "Checking the download",
  extracting: "Unpacking",
  ready: "Installed",
  failed: "Failed",
};

export function zvecGrepProgressLabel(status: ZvecGrepStatus): string {
  if (status.phase === "ready") return `Installed · v${status.version}`;
  if (status.phase === "failed") return status.detail || "failed";
  if (status.phase !== "downloading") return zvecGrepPhaseLabel[status.phase];
  return status.total ? `${sizeLabel(status.bytes)} of ${sizeLabel(status.total)}` : sizeLabel(status.bytes);
}

export function zvecGrepPercent(status: ZvecGrepStatus): number {
  if (status.phase === "ready") return 100;
  if (status.phase !== "downloading" || !status.total) return 0;
  return Math.min(100, (status.bytes / status.total) * 100);
}
