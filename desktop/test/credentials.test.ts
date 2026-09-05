import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { unreadableKeyNotice } from "../shared/platform-copy";

const SEAL = "keychain:";
let available = true;
let roundTrip = true;
let rejected = new Set<string>();
const electron = {
  safeStorage: {
    isEncryptionAvailable: () => available,
    encryptString: (value: string) => Buffer.from(`${SEAL}${value}`, "utf8"),
    decryptString: (value: Buffer) => {
      const text = value.toString("utf8");
      if (!roundTrip && text === `${SEAL}emma`) throw new Error("the profile key is not the one that sealed this");
      if (!text.startsWith(SEAL)) throw new Error("this ciphertext is not ours");
      const secret = text.slice(SEAL.length);
      if (rejected.has(secret)) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
      return secret;
    },
  },
};
const electronPath = require.resolve("electron");
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electron } as unknown as NodeModule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CredentialStore, secureStoreWorks }: typeof import("../main/credentials") = require("../main/credentials");

const userData = () => mkdtempSync(path.join(tmpdir(), "emma-credentials-"));
const stored = (root: string) => JSON.parse(readFileSync(path.join(root, "credentials.json"), "utf8")) as Record<string, string>;
const seal = (secret: string) => Buffer.from(`${SEAL}${secret}`, "utf8").toString("base64");

test.beforeEach(() => { available = true; roundTrip = true; rejected = new Set(); });

test("a key that will not decrypt is kept on disk, reported unreadable, and never costs the readable ones", () => {
  const root = userData();
  writeFileSync(path.join(root, "credentials.json"), JSON.stringify({ OPENROUTER_API_KEY: seal("sk-or-v1-readable"), ZAI_API_KEY: seal("zai-lost-on-first-run") }));
  rejected.add("zai-lost-on-first-run");

  const store = new CredentialStore(root);
  assert.deepEqual(store.list(), [
    { env: "OPENROUTER_API_KEY", masked: "sk-or-••••••••••able", readable: true },
    { env: "ZAI_API_KEY", masked: "", readable: false },
  ]);

  const environment: NodeJS.ProcessEnv = {};
  store.applyToEnv(environment);
  assert.equal(environment.OPENROUTER_API_KEY, "sk-or-v1-readable");
  assert.equal(environment.ZAI_API_KEY, undefined, "an unreadable slot must not reach the agent as an empty key");

  store.set("DEEPSEEK_API_KEY", "sk-deepseek-new");
  const file = stored(root);
  assert.equal(file.ZAI_API_KEY, seal("zai-lost-on-first-run"), "the ciphertext nobody can read is preserved verbatim across a save");
  assert.deepEqual(Object.keys(file).sort(), ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "ZAI_API_KEY"]);
  assert.equal(new CredentialStore(root).list().find((item) => item.env === "ZAI_API_KEY")?.readable, false);
});

test("replacing or removing an unreadable slot is what finally clears it", () => {
  const root = userData();
  writeFileSync(path.join(root, "credentials.json"), JSON.stringify({ ZAI_API_KEY: seal("zai-lost"), MISTRAL_API_KEY: seal("mistral-lost") }));
  rejected.add("zai-lost").add("mistral-lost");

  const store = new CredentialStore(root);
  assert.deepEqual(store.list().map((item) => item.readable), [false, false]);
  store.set("ZAI_API_KEY", "zai-pasted-again");
  store.remove("MISTRAL_API_KEY");

  assert.deepEqual(store.list(), [{ env: "ZAI_API_KEY", masked: "zai-pa••••••••••gain", readable: true }]);
  assert.deepEqual(Object.keys(stored(root)), ["ZAI_API_KEY"]);
});

test("a store that cannot round-trip refuses to save, and reads back every entry as unreadable", () => {
  const root = userData();
  writeFileSync(path.join(root, "credentials.json"), JSON.stringify({ OPENROUTER_API_KEY: seal("sk-or-v1-readable") }));

  roundTrip = false;
  assert.equal(secureStoreWorks(), false);
  const broken = new CredentialStore(root);
  assert.deepEqual(broken.list(), [{ env: "OPENROUTER_API_KEY", masked: "", readable: false }]);
  assert.throws(() => broken.set("OPENROUTER_API_KEY", "sk-or-v1-fresh"), /will not save a key it could never read back/);
  assert.equal(stored(root).OPENROUTER_API_KEY, seal("sk-or-v1-readable"), "a refused save leaves the file exactly as it was");

  available = false;
  roundTrip = true;
  assert.equal(secureStoreWorks(), false);
  assert.throws(() => new CredentialStore(root).set("OPENROUTER_API_KEY", "sk-or-v1-fresh"), /secure credential store is unavailable/);
});

test("the notice names the key and the computer it could not be read on", () => {
  assert.equal(unreadableKeyNotice("OpenRouter", "win32"), "Your saved OpenRouter key could not be read on this PC. Paste it again.");
  assert.equal(unreadableKeyNotice("Z.ai", "darwin"), "Your saved Z.ai key could not be read on this Mac. Paste it again.");
  assert.equal(unreadableKeyNotice("ZAI_API_KEY", "win32"), "Your saved ZAI_API_KEY could not be read on this PC. Paste it again.");
});
