import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CatalogCache, type CatalogModel } from "../main/catalog";
import { freeModels } from "../shared/settings";

const model = (id: string, free = true): CatalogModel =>
  ({ id, name: id, contextLength: 1024, inputModalities: [], free });

test("the catalog caches to disk, reports what changed, and survives a dead fetch", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "emma-catalog-"));
  try {
    // A first launch has no cache, so the bundled seed is what the models page shows.
    const seeded = new CatalogCache(dir);
    const offline = await seeded.refresh(() => Promise.reject(new Error("no network")));
    assert.ok(offline.stale);
    assert.equal(offline.error, "no network");
    assert.ok(offline.models.length > 0, "the bundled seed stands in before any fetch lands");
    assert.ok(offline.models.some((entry) => !entry.free), "the seed carries paid models too");

    const first = await seeded.refresh(() => Promise.resolve({ models: [model("a/one"), model("b/two", false)] }));
    assert.equal(first.stale, false);
    assert.deepEqual(first.models.map((entry) => entry.id), ["a/one", "b/two"]);
    assert.equal(first.models[1].free, false);

    // A reload that lands on the same list has to say so rather than look inert.
    const again = await seeded.refresh(() => Promise.resolve({ models: [model("a/one"), model("b/two", false)] }));
    assert.deepEqual(again.added, []);
    assert.deepEqual(again.removed, []);

    const changed = await seeded.refresh(() => Promise.resolve({ models: [model("a/one"), model("c/three")] }));
    assert.deepEqual(changed.added, ["c/three"]);
    assert.deepEqual(changed.removed, ["b/two"]);

    // A fresh process reads the last good fetch off disk, not the seed.
    const reopened = new CatalogCache(dir);
    const cached = await reopened.refresh(() => Promise.reject(new Error("still offline")));
    assert.ok(cached.stale);
    assert.deepEqual(cached.models.map((entry) => entry.id), ["a/one", "c/three"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("free-only routing keeps the catalog's free models and whatever is already selected", () => {
  const entries = [
    { key: "fallback" },
    { key: "local:one" },
    { key: "openrouter:a/one", free: true },
    { key: "openrouter:b/two", free: false },
  ];
  const keys = (active: string) => freeModels(entries, active).map((entry) => entry.key);
  // A local profile costs nothing to run and is still not a free catalog model.
  assert.deepEqual(keys(""), ["openrouter:a/one"]);
  // The model in use never disappears from its own picker, free or not.
  assert.deepEqual(keys("openrouter:b/two"), ["openrouter:a/one", "openrouter:b/two"]);
  assert.deepEqual(keys("fallback"), ["fallback", "openrouter:a/one"]);
});
