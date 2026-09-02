import test from "node:test";
import assert from "node:assert/strict";
import { OPENROUTER_CHAT_ENDPOINT, SECOND_MODELS, SECOND_MODEL_IDS, defaultSettings, validateSettings, verifierFromKey, verifierKey, type UserSettings } from "../shared/settings";

const pick = (settings: UserSettings, id: (typeof SECOND_MODEL_IDS)[number], key: string) => {
  const spec = SECOND_MODELS[id];
  return spec.write(settings, verifierFromKey(key, settings.providers, spec.read(settings).system, settings.routers));
};

test("every role reads and writes its own slice and leaves the others alone", () => {
  let settings = defaultSettings;
  for (const id of SECOND_MODEL_IDS) settings = pick(settings, id, `openrouter:vendor/${id}`);
  for (const id of SECOND_MODEL_IDS) {
    const draft = SECOND_MODELS[id].read(settings);
    assert.equal(draft.model, `vendor/${id}`);
    assert.equal(draft.endpoint, OPENROUTER_CHAT_ENDPOINT);
    assert.equal(verifierKey(draft, settings.providers, settings.routers), `openrouter:vendor/${id}`);
  }
  assert.equal(settings.verifier.model, "vendor/verifier");
  assert.equal(settings.tagger.model, "vendor/tagger");
  assert.deepEqual([settings.tools.advisor.model, settings.tools.vision.model, settings.tools.secret.model], ["vendor/advisor", "vendor/vision", "vendor/secret"]);
  assert.deepEqual(validateSettings(settings), settings);
});

test("a role keeps its own rules when its model changes, and the off row clears only that model", () => {
  const settings = pick(defaultSettings, "vision", "openrouter:vendor/eyes");
  assert.equal(settings.tools.vision.system, defaultSettings.tools.vision.system);
  assert.notEqual(settings.tools.vision.system, settings.verifier.system);
  const off = pick(settings, "vision", "");
  assert.equal(off.tools.vision.model, "");
  assert.equal(off.tools.vision.system, defaultSettings.tools.vision.system);
  assert.equal(off.verifier.model, defaultSettings.verifier.model);
});
