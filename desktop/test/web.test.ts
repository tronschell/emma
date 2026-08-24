import test from "node:test";
import assert from "node:assert/strict";
import { publicUrl } from "../main/ipc";
import { parseToolArgs } from "../main/tools";
import { defaultWebSearch, validateWebSearch, WEB_SEARCH_PROVIDERS } from "../shared/settings";

test("a URL the model chose cannot reach anything on this network", () => {
  for (const attempt of [
    "http://127.0.0.1:8080/admin",
    "http://localhost:11434/api/tags",
    "http://ollama.localhost/api/tags",
    "http://169.254.169.254/latest/meta-data/",
    "http://192.168.1.1/",
    "http://10.0.0.5/",
    "http://172.16.4.4/",
    "http://172.31.255.255/",
    "http://100.64.0.1/",
    "http://0.0.0.0:5000/",
    "http://[::1]:9200/",
    "http://[fe80::1]/",
    "http://[fd00::1]/",
    "http://printer.local/",
    "http://metadata.internal/",
    "file:///etc/passwd",
  ]) {
    assert.equal(publicUrl(attempt), null, attempt);
  }
  // Addresses next door to a blocked range are ordinary public addresses.
  for (const allowed of ["https://example.com/a", "http://172.32.0.1/", "http://11.0.0.1/", "http://192.169.0.1/", "http://169.253.0.1/"]) {
    assert.ok(publicUrl(allowed), allowed);
  }
});

test("the search provider round-trips, and picks up its own default endpoint", () => {
  assert.deepEqual(validateWebSearch(undefined), defaultWebSearch);
  assert.equal(validateWebSearch({}).provider, "fourget");
  // Switching provider with the endpoint left blank fills in that provider's own.
  assert.equal(validateWebSearch({ provider: "searxng", endpoint: "" }).endpoint, "http://127.0.0.1:8888");
  assert.equal(validateWebSearch({ provider: "exa", credentialEnv: "EXA_API_KEY" }).credentialEnv, "EXA_API_KEY");
  // An unknown provider falls back rather than throwing: a stale settings file
  // should not stop Emma launching.
  assert.equal(validateWebSearch({ provider: "askjeeves" }).provider, "fourget");
  assert.throws(() => validateWebSearch({ endpoint: "http://searx.example.com" }), /https, or http on this Mac/);
  assert.throws(() => validateWebSearch({ endpoint: "not a url" }), /must be a URL/);
  assert.throws(() => validateWebSearch({ credentialEnv: "not a name" }), /environment variable name/);
  // Every keyed provider names the variable its key is stored under.
  for (const provider of WEB_SEARCH_PROVIDERS) assert.ok(provider.keyless || provider.endpoint.startsWith("https://"), provider.id);
});

test("the web tools take the arguments they advertise", () => {
  assert.deepEqual(parseToolArgs("web_search", JSON.stringify({ query: "zig comptime" })), { name: "web_search", query: "zig comptime", limit: 8 });
  assert.deepEqual(parseToolArgs("web_search", JSON.stringify({ query: "a", limit: 99 })), { name: "web_search", query: "a", limit: 20 });
  assert.throws(() => parseToolArgs("web_search", JSON.stringify({})), /query/);
});
