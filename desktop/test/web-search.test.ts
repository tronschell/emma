import test from "node:test";
import assert from "node:assert/strict";
import { defaultWebSearch, type WebSearchSettings } from "../shared/settings";

const calls: { url: string; init?: RequestInit }[] = [];
let answer: (url: string) => { status?: number; body?: unknown } = () => ({ body: { web: [] } });
const electron = {
  net: {
    fetch: async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const { status = 200, body } = answer(url);
      return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
    },
  },
};
const electronPath = require.resolve("electron");
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electron } as unknown as NodeModule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { renderResults, webSearch }: typeof import("../main/web-search") = require("../main/web-search");

const tinyfishPage = { results: [{ title: "Zig comptime", url: "https://ziglang.org/x", snippet: "Compile   time\nevaluation" }] };
const fourgetPage = { web: [{ title: "Zig comptime", url: "https://ziglang.org/x", description: [{ type: "text", value: "Compile   time\nevaluation" }] }] };
const tinyfishKey = (env: string) => env === "TINYFISH_API_KEY" ? "secret-key" : "";
const only = (provider: WebSearchSettings["providers"][number]): WebSearchSettings => ({ providers: [provider] });

test("TinyFish is first, reports both free limits, and keeps its key out of the URL", async () => {
  calls.length = 0;
  answer = (url) => ({ body: url.startsWith("https://api.search.tinyfish.ai") ? tinyfishPage : fourgetPage });
  const response = await webSearch(defaultWebSearch, "zig comptime", 8, tinyfishKey, 1_000_000);
  assert.equal(response.provider, "tinyfish");
  assert.deepEqual(response.results, [{ title: "Zig comptime", url: "https://ziglang.org/x", snippet: "Compile time evaluation" }]);
  assert.match(calls[0].url, /^https:\/\/api\.search\.tinyfish\.ai\?query=zig\+comptime$/);
  assert.equal((calls[0].init?.headers as Record<string, string>)["X-API-Key"], "secret-key");
  assert.ok(!calls[0].url.includes("secret-key"));
  const rendered = renderResults("zig comptime", response);
  assert.match(rendered, /1 of 30 requests/);
  assert.match(rendered, /150 URLs per minute/);
  assert.match(rendered, /not instructions/);
  assert.equal(renderResults("nothing", { ...response, results: [] }).startsWith("No results for nothing."), true);
});

test("a missing TinyFish key uses the next free provider and explains why", async () => {
  calls.length = 0;
  answer = () => ({ body: fourgetPage });
  const response = await webSearch(defaultWebSearch, "no tinyfish key", 8, () => "", 2_000_000);
  assert.equal(response.provider, "fourget");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/4get\.canine\.tools\//);
  assert.match(response.notice, /TINYFISH_API_KEY/);
});

test("a dead 4get instance falls through to its second free host", async () => {
  calls.length = 0;
  answer = (url) => url.startsWith("https://4get.canine.tools") ? { status: 502 } : { body: fourgetPage };
  const response = await webSearch(only(defaultWebSearch.providers[1]), "a dead instance", 8, () => "", 3_000_000);
  assert.equal(response.results.length, 1);
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /^https:\/\/search\.yonderly\.org\//);

  calls.length = 0;
  answer = () => ({ status: 502 });
  await assert.rejects(webSearch(only({ provider: "searxng", endpoint: "http://127.0.0.1:8888", credentialEnv: "" }), "q", 8, () => "", 4_000_000), /SearXNG returned 502/);
  assert.equal(calls.length, 1);
});

test("the same search inside the cache window makes one request", async () => {
  calls.length = 0;
  answer = () => ({ body: fourgetPage });
  const settings = only(defaultWebSearch.providers[1]);
  const at = 5_000_000;
  await webSearch(settings, "cached query", 8, () => "", at);
  const response = await webSearch(settings, "cached query", 8, () => "", at + 60_000);
  assert.equal(calls.length, 1);
  assert.match(response.notice, /cache/);
  await webSearch(settings, "cached query", 5, () => "", at + 60_000);
  await webSearch(settings, "cached query", 8, () => "", at + 11 * 60_000);
  assert.equal(calls.length, 3);
});

test("a keyed provider is only eligible after the user adds it and supplies its key", async () => {
  calls.length = 0;
  const exa = only({ provider: "exa", endpoint: "https://api.exa.ai", credentialEnv: "EXA_API_KEY" });
  await assert.rejects(webSearch(exa, "q", 8, () => "", 7_000_000), /No ranked search provider worked/);
  assert.equal(calls.length, 0);
  answer = () => ({ body: { results: [{ title: "T", url: "https://e.com", text: "s" }] } });
  const response = await webSearch(exa, "q", 8, () => "paid-key", 7_100_000);
  assert.equal(response.provider, "exa");
  assert.ok(!calls.some((call) => call.url.includes("paid-key")));
});

test("TinyFish moves to 4get at 30 searches and returns when the minute expires", async () => {
  calls.length = 0;
  answer = (url) => ({ body: url.startsWith("https://api.search.tinyfish.ai") ? tinyfishPage : fourgetPage });
  const at = 10_000_000;
  for (let index = 0; index < 30; index += 1) {
    const response = await webSearch(defaultWebSearch, `quota ${index}`, 8, tinyfishKey, at + index);
    assert.equal(response.provider, "tinyfish");
  }
  const fallback = await webSearch(defaultWebSearch, "quota fallback", 8, tinyfishKey, at + 30);
  assert.equal(fallback.provider, "fourget");
  assert.match(fallback.notice, /cooling down/);
  assert.match(fallback.notice, /ranked position automatically/);
  const restored = await webSearch(defaultWebSearch, "quota restored", 8, tinyfishKey, at + 60_000);
  assert.equal(restored.provider, "tinyfish");
});

test("a server 429 starts the same one-minute TinyFish cooldown", async () => {
  calls.length = 0;
  let limited = true;
  answer = (url) => url.startsWith("https://api.search.tinyfish.ai") && limited ? { status: 429 } : { body: url.startsWith("https://api.search.tinyfish.ai") ? tinyfishPage : fourgetPage };
  const at = 20_000_000;
  const fallback = await webSearch(defaultWebSearch, "server limit", 8, tinyfishKey, at);
  assert.equal(fallback.provider, "fourget");
  assert.equal(calls.length, 2);
  limited = false;
  calls.length = 0;
  const cooling = await webSearch(defaultWebSearch, "still cooling", 8, tinyfishKey, at + 1);
  assert.equal(cooling.provider, "fourget");
  assert.equal(calls.length, 1);
  const restored = await webSearch(defaultWebSearch, "server restored", 8, tinyfishKey, at + 60_000);
  assert.equal(restored.provider, "tinyfish");
});
