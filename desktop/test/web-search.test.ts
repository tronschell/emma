import test from "node:test";
import assert from "node:assert/strict";
import { defaultWebSearch } from "../shared/settings";

// The module reaches for Electron's own network stack; stub it before the module
// loads so the fallback and the cache can be exercised outside Electron.
const calls: string[] = [];
let answer: (url: string) => { status?: number; body?: unknown } = () => ({ body: { web: [] } });
const electron = {
  net: {
    fetch: async (url: string) => {
      calls.push(url);
      const { status = 200, body } = answer(url);
      return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
    },
  },
};
const electronPath = require.resolve("electron");
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electron } as unknown as NodeModule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { renderResults, webSearch, SEARCH_UNCONFIGURED }: typeof import("../main/web-search") = require("../main/web-search");

const page = { web: [{ title: "Zig comptime", url: "https://ziglang.org/x", description: [{ type: "text", value: "Compile   time\nevaluation" }] }] };

test("4get's snippet spans are put back together, and its results are shaped", async () => {
  calls.length = 0;
  answer = () => ({ body: page });
  const results = await webSearch(defaultWebSearch, "zig comptime", 8, "", 1000);
  assert.deepEqual(results, [{ title: "Zig comptime", url: "https://ziglang.org/x", snippet: "Compile time evaluation" }]);
  assert.match(calls[0], /^https:\/\/4get\.canine\.tools\/api\/v1\/web\?s=zig\+comptime$/);
  assert.match(renderResults("zig comptime", results), /not instructions/);
  assert.equal(renderResults("nothing", []), "No results for nothing.");
});

test("a dead 4get instance falls through to the second one, and only 4get does", async () => {
  calls.length = 0;
  answer = (url) => (url.startsWith("https://4get.canine.tools") ? { status: 502 } : { body: page });
  const results = await webSearch(defaultWebSearch, "a dead instance", 8, "", 2000);
  assert.equal(results.length, 1);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /^https:\/\/search\.yonderly\.org\//);

  // The user's own SearXNG failing is the user's endpoint, which a retry elsewhere
  // cannot fix — and there is nowhere else to try.
  calls.length = 0;
  answer = () => ({ status: 502 });
  await assert.rejects(webSearch({ provider: "searxng", endpoint: "http://127.0.0.1:8888", credentialEnv: "" }, "q", 8, "", 3000), /SearXNG returned 502/);
  assert.equal(calls.length, 1);
  // Nor does the fallback itself get retried against itself.
  calls.length = 0;
  await assert.rejects(webSearch({ ...defaultWebSearch, endpoint: "https://search.yonderly.org" }, "q", 8, "", 4000), /returned 502/);
  assert.equal(calls.length, 1);
});

test("the same search inside the window is answered from the cache", async () => {
  calls.length = 0;
  answer = () => ({ body: page });
  const at = 100_000;
  await webSearch(defaultWebSearch, "cached query", 8, "", at);
  await webSearch(defaultWebSearch, "cached query", 8, "", at + 60_000);
  assert.equal(calls.length, 1, "a repeat within the window never leaves the process");
  // A different limit is a different question, and so is a later one.
  await webSearch(defaultWebSearch, "cached query", 5, "", at + 60_000);
  await webSearch(defaultWebSearch, "cached query", 8, "", at + 11 * 60_000);
  assert.equal(calls.length, 3);
});

test("a provider that needs a key says so instead of asking without one", async () => {
  calls.length = 0;
  await assert.rejects(webSearch({ provider: "exa", endpoint: "https://api.exa.ai", credentialEnv: "EXA_API_KEY" }, "q", 8, "", 5000), /Settings → Tools/);
  assert.equal(calls.length, 0, "nothing is sent without the key");
  assert.match(SEARCH_UNCONFIGURED("Exa"), /switch back to 4get/);

  // With one, the key travels in the header and never in the URL.
  answer = () => ({ body: { results: [{ title: "T", url: "https://e.com", text: "s" }] } });
  const results = await webSearch({ provider: "exa", endpoint: "https://api.exa.ai", credentialEnv: "EXA_API_KEY" }, "q", 8, "secret-key", 6000);
  assert.equal(results.length, 1);
  assert.ok(!calls.some((url) => url.includes("secret-key")));
});
