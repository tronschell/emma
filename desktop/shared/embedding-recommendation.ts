import type { EmbeddingModel } from "./settings";

export interface MachineFacts {
  platform: string;
  arch: string;
  gpu: string;
  vramBytes: number;
  memoryBytes: number;
  cores: number;
  freeDiskBytes: number;
}

export type EmbeddingRecommendation = { id: EmbeddingModel; reason: string };

const GB = 1024 * 1024 * 1024;

export const gigabytes = (bytes: number) => Number((bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1));

export function recommendEmbeddingModel(facts: MachineFacts): EmbeddingRecommendation {
  const unified = facts.platform === "darwin" && facts.arch === "arm64";
  if (unified && facts.memoryBytes >= 16 * GB) return { id: "local/embeddinggemma-300m", reason: `${facts.gpu || "Apple silicon"} shares ${gigabytes(facts.memoryBytes)} GB of unified memory, enough for the strongest local model` };
  if (facts.vramBytes >= 6 * GB) return { id: "local/embeddinggemma-300m", reason: `${facts.gpu || "This GPU"} has ${gigabytes(facts.vramBytes)} GB of video memory, enough for the strongest local model` };
  if (facts.vramBytes >= 4 * GB || (unified && facts.memoryBytes >= 8 * GB)) return { id: "local/gte-modernbert-base", reason: `${facts.gpu || "This GPU"} has ${gigabytes(facts.vramBytes || facts.memoryBytes)} GB to work with, which suits a mid-sized model over long files` };
  if (facts.memoryBytes >= 16 * GB && facts.cores >= 8) return { id: "local/bge-small-en-v1.5", reason: `${facts.cores} cores and ${gigabytes(facts.memoryBytes)} GB of memory index quickly on the CPU` };
  return { id: "local/potion-code-16m-v2", reason: "No spare video memory was found, so the smallest CPU model keeps indexing to seconds" };
}
