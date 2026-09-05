import assert from "node:assert/strict";
import { test } from "node:test";
import { type MachineFacts, recommendEmbeddingModel } from "../shared/embedding-recommendation";

const GB = 1024 * 1024 * 1024;
const facts = (over: Partial<MachineFacts>): MachineFacts => ({ platform: "win32", arch: "x64", gpu: "", vramBytes: 0, memoryBytes: 8 * GB, cores: 4, freeDiskBytes: 200 * GB, ...over });

test("a roomy discrete GPU earns the strongest local model", () => {
  const advice = recommendEmbeddingModel(facts({ gpu: "NVIDIA GeForce RTX 5080", vramBytes: 16 * GB, memoryBytes: 64 * GB, cores: 24 }));
  assert.equal(advice.id, "local/embeddinggemma-300m");
  assert.match(advice.reason, /NVIDIA GeForce RTX 5080/);
  assert.match(advice.reason, /16 GB of video memory/);
});

test("Apple silicon is judged on unified memory rather than a VRAM figure", () => {
  const advice = recommendEmbeddingModel(facts({ platform: "darwin", arch: "arm64", gpu: "Apple M3 Max", vramBytes: 0, memoryBytes: 36 * GB, cores: 14 }));
  assert.equal(advice.id, "local/embeddinggemma-300m");
  assert.match(advice.reason, /unified memory/);
});

test("a mid-sized GPU takes the mid-sized model", () => {
  assert.equal(recommendEmbeddingModel(facts({ gpu: "NVIDIA GeForce GTX 1650", vramBytes: 4 * GB, memoryBytes: 16 * GB, cores: 8 })).id, "local/gte-modernbert-base");
});

test("a machine with no video memory but plenty of cores indexes on the CPU", () => {
  assert.equal(recommendEmbeddingModel(facts({ gpu: "Intel UHD Graphics", memoryBytes: 32 * GB, cores: 16 })).id, "local/bge-small-en-v1.5");
});

test("a small machine falls back to the smallest model", () => {
  const advice = recommendEmbeddingModel(facts({ gpu: "Intel UHD Graphics", memoryBytes: 8 * GB, cores: 4 }));
  assert.equal(advice.id, "local/potion-code-16m-v2");
  assert.match(advice.reason, /smallest CPU model/);
});
