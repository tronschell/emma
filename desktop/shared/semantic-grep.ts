export type SemanticGrepFolder = { path: string; model: string; state: "indexing" | "ready" | "failed"; detail: string; done: number; total: number; left: number };
export type SemanticGrepStatus = { available: boolean; enabled: boolean; model: string; folders: SemanticGrepFolder[] };

export function indexProgress(text: string): { done: number; total: number } | undefined {
  const hits = text.match(/Indexing files: (\d+)\/(\d+)/g);
  const last = hits?.[hits.length - 1]?.match(/(\d+)\/(\d+)/);
  return last ? { done: Number(last[1]), total: Number(last[2]) } : undefined;
}

export function timeLeft(seconds: number): string {
  if (seconds <= 0) return "";
  if (seconds < 60) return "under a minute left";
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `about ${minutes} min left` : `about ${Number((minutes / 60).toFixed(1))} h left`;
}

export function progressLabel(folder: SemanticGrepFolder): string {
  if (folder.state === "failed") return folder.detail || "failed";
  if (folder.state === "ready") return folder.total ? `${folder.total.toLocaleString()} files` : "ready";
  if (!folder.total) return folder.detail || "scanning files";
  return [`${folder.done.toLocaleString()} / ${folder.total.toLocaleString()}`, timeLeft(folder.left)].filter(Boolean).join(" · ");
}
