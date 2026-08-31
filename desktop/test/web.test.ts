import test from "node:test";
import assert from "node:assert/strict";
import { publicAddress, publicUrl } from "../main/ipc";
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
    "https://[::ffff:127.0.0.1]/",
    "https://[::ffff:10.0.0.1]/",
    "https://[64:ff9b::7f00:1]/",
    "https://[2002:7f00:1::]/",
    "https://localhost./",
    "https://ollama.localhost./",
    "https://name:password@example.com/",
    "https://224.0.0.1/",
    "https://255.255.255.255/",
    "http://printer.local/",
    "http://metadata.internal/",
    "file:///etc/passwd",
  ]) {
    assert.equal(publicUrl(attempt), null, attempt);
  }
  for (const allowed of ["https://example.com/a", "http://172.32.0.1/", "http://11.0.0.1/", "http://192.169.0.1/", "http://169.253.0.1/", "https://[2606:4700:4700::1111]/"]) {
    assert.ok(publicUrl(allowed), allowed);
  }
  assert.equal(publicAddress("not-an-address"), false);
  assert.equal(publicAddress("192.0.2.1"), false);
  assert.equal(publicAddress("2001:db8::1"), false);
  assert.equal(publicAddress("8.8.8.8"), true);
});

test("the search provider round-trips, and picks up its own default endpoint", () => {
  assert.deepEqual(validateWebSearch(undefined), defaultWebSearch);
  assert.deepEqual(defaultWebSearch.providers.map((item) => item.provider), ["tinyfish", "fourget"]);
  assert.deepEqual(validateWebSearch({}), defaultWebSearch);
  assert.equal(validateWebSearch({ provider: "searxng", endpoint: "" }).providers[0].endpoint, "http://127.0.0.1:8888");
  assert.equal(validateWebSearch({ provider: "exa", credentialEnv: "EXA_API_KEY" }).providers[0].credentialEnv, "EXA_API_KEY");
  assert.deepEqual(validateWebSearch({ provider: "askjeeves" }), defaultWebSearch);
  assert.throws(() => validateWebSearch({ providers: [{ provider: "searxng", endpoint: "http://searx.example.com" }] }), /https, or http on this Mac/);
  assert.throws(() => validateWebSearch({ providers: [{ provider: "tinyfish", endpoint: "not a url" }] }), /must be a URL/);
  assert.throws(() => validateWebSearch({ providers: [{ provider: "tinyfish", credentialEnv: "not a name" }] }), /environment variable name/);
  assert.throws(() => validateWebSearch({ providers: [] }), /fallback list/);
  assert.throws(() => validateWebSearch({ providers: [defaultWebSearch.providers[0], defaultWebSearch.providers[0]] }), /only appear once/);
  for (const provider of WEB_SEARCH_PROVIDERS) assert.ok(provider.keyless || provider.endpoint.startsWith("https://"), provider.id);
});

test("the web tools take the arguments they advertise", () => {
  assert.deepEqual(parseToolArgs("web_search", JSON.stringify({ query: "zig comptime" })), { name: "web_search", query: "zig comptime", limit: 8 });
  assert.deepEqual(parseToolArgs("web_search", JSON.stringify({ query: "a", limit: 99 })), { name: "web_search", query: "a", limit: 20 });
  assert.throws(() => parseToolArgs("web_search", JSON.stringify({})), /query/);
});
