import test from "node:test";
import assert from "node:assert/strict";
import { authorKnowledgePage, authorPage, authorPageFromThread, chooseCategory, pageTurnContext, proposePageRevision, readBlocks, revisePage, titleFrom } from "../main/knowledge-author";

const route = { endpoint: "https://provider.test/v1/chat/completions", model: "vendor/model", key: "k" };

/** Serves one chat completion and hands back the request body it was sent. */
function serve(content: unknown, usage?: Record<string, number>) {
  const original = globalThis.fetch;
  const sent: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body) as Record<string, unknown>);
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = original; } };
}

test("a page is authored from the model's JSON, and a mangled block costs its block not the page", async () => {
  const page = {
    title: "  Retrieval augmented generation  ",
    category: "research",
    summary: "What RAG is and when it helps.",
    interesting_points: ["Grounding cuts hallucination.", "", 42],
    counterarguments: ["Retrieval quality caps the answer."],
    blocks: [
      { id: "summary", type: "rich-text", payload: { markdown: "## RAG" }, fallback: "## RAG" },
      // Dropped: no payload object.
      { id: "broken", type: "list", fallback: "x" },
      // Dropped: no fallback, so nothing renders it in plain Markdown.
      { id: "no-fallback", type: "table", payload: { headers: [] } },
      { id: "how-to-apply", type: "list", payload: { items: ["Try it"], ordered: false }, fallback: "- Try it" },
    ],
  };
  // The model wrapped its object in a code fence, which is common enough not to trust the body.
  const { sent, restore } = serve("Here you go:\n```json\n" + JSON.stringify(page) + "\n```", { prompt_tokens: 120, completion_tokens: 340 });
  try {
    const authored = await authorPage("A paper about retrieval.", ["research", "technology"], route);
    assert.equal(authored.title, "Retrieval augmented generation");
    assert.equal(authored.category, "research");
    assert.deepEqual(authored.interesting_points, ["Grounding cuts hallucination."]);
    assert.deepEqual(authored.blocks.map((block) => block.id), ["summary", "how-to-apply"]);
    assert.equal(authored.model, "vendor/model");
    assert.equal(authored.input_tokens, 120);
    assert.equal(authored.output_tokens, 340);
    // The user's own taxonomy has to reach the prompt, or the page lands in a new category.
    assert.match(sent[0].messages ? JSON.stringify(sent[0].messages) : "", /categories the user already keeps/);
  } finally { restore(); }
});

test("a page with no model configured is the deterministic local scaffold", async () => {
  const page = await authorPage("Bug in the parser. It drops the last token.", ["Engineering"]);
  assert.equal(page.model, "local-fallback");
  assert.equal(page.title, "Bug in the parser");
  // The base's own taxonomy wins over the keyword guess ("technology"), which it does not keep.
  assert.equal(page.category, "Engineering");
  assert.deepEqual(page.blocks, []);
});

test("model output that is not a JSON page is refused rather than filed as an empty one", async () => {
  const { restore } = serve("I could not do that.");
  try {
    await assert.rejects(authorPage("text", [], route), /did not return a JSON page/);
  } finally { restore(); }
});

test("a revision returns the whole page, and needs a model because there is no local rewriter", async () => {
  const current = [{ id: "summary", type: "rich-text", payload: { markdown: "old" }, fallback: "old" }];
  const { sent, restore } = serve(JSON.stringify({
    blocks: [{ id: "summary", type: "rich-text", payload: { markdown: "new" }, fallback: "new" }],
  }));
  try {
    const blocks = await revisePage("Tighten the summary.", current, route);
    assert.deepEqual(blocks, [{ id: "summary", type: "rich-text", payload: { markdown: "new" }, fallback: "new" }]);
    // The current page and the instruction both have to reach the model or it edits blind.
    const prompt = JSON.stringify(sent[0].messages);
    assert.match(prompt, /Current page:/);
    assert.match(prompt, /Tighten the summary\./);
  } finally { restore(); }

  await assert.rejects(revisePage("x", current, { ...route, model: "" }), /needs a model/);
});

test("the local title and category rules are unchanged, so pages keep filing the same way", () => {
  assert.equal(titleFrom("   "), "Untitled page");
  assert.equal(titleFrom("A".repeat(200)), "A".repeat(120));
  assert.equal(titleFrom("First line\nSecond line"), "First line");
  // With no categories kept yet, the keyword rules stand in.
  assert.equal(chooseCategory([], "the market moved on finance news"), "finance");
  assert.equal(chooseCategory([], "nothing in particular"), "general");
  // A category named in the text wins over the first one kept.
  assert.equal(chooseCategory(["Recipes", "Health"], "a health checkup"), "Health");
});

test("blocks are read defensively, since they are model output", () => {
  assert.deepEqual(readBlocks(undefined), []);
  assert.deepEqual(readBlocks("not an array"), []);
  // An array payload is not an object payload: the store expects keys.
  assert.deepEqual(readBlocks([{ id: "a", type: "list", payload: [], fallback: "x" }]), []);
  const many = Array.from({ length: 80 }, (_, index) => ({
    id: `block-${index}`, type: "rich-text", payload: { markdown: "x" }, fallback: "x",
  }));
  assert.equal(readBlocks(many).length, 64);
});

/** Records every store call in order, and answers the read halves. */
function store(context: Record<string, unknown> = {}) {
  const calls: { method: string; params: Record<string, string> }[] = [];
  const call = async (method: string, params: Record<string, string>) => {
    calls.push({ method, params });
    if (method === "pageAuthoringContext" || method === "threadAuthoringContext") {
      return { threadId: "thread-123456789", text: "A paper about retrieval.", categories: ["research"], title: "RAG", summary: "What RAG is.", artifacts: [], ...context };
    }
    return { ok: true };
  };
  return { calls, call };
}

test("each page flow reads the store, calls the model, then writes back what came out", async () => {
  const { calls, call } = store();
  // No route: the local scaffold stands in for the provider call, so this needs no network.
  await authorKnowledgePage(call, { pageId: "page-1", keepCategory: "true" });
  assert.deepEqual(calls.map((entry) => entry.method), ["pageAuthoringContext", "analyzePage"]);
  // The whole authored page rides the write, and `keepCategory` survives the round trip.
  assert.equal(calls[1].params.keepCategory, "true");
  const document = JSON.parse(calls[1].params.document) as { category: string; model: string };
  assert.equal(document.category, "research");
  assert.equal(document.model, "local-fallback");

  const thread = store();
  await authorPageFromThread(thread.call, "thread-123456789");
  assert.deepEqual(thread.calls.map((entry) => entry.method), ["threadAuthoringContext", "saveToKnowledge"]);
  assert.equal(thread.calls[1].params.threadId, "thread-123456789");
});

test("a revision refuses without a model before it touches the store, and posts the whole page after", async () => {
  const refused = store();
  await assert.rejects(proposePageRevision(refused.call, { pageId: "page-1", instruction: "x" }), /needs a model/);
  // Reading the page creates its conversation thread, so a refusal must not get that far.
  assert.deepEqual(refused.calls, []);

  const current = [{ id: "summary", type: "rich-text", payload: { markdown: "old" }, fallback: "old" }];
  const { calls, call } = store({ artifacts: current.map((block) => ({ ...block, version: 1, source: {} })) });
  const { sent, restore } = serve(JSON.stringify({
    blocks: [{ id: "summary", type: "rich-text", payload: { markdown: "new" }, fallback: "new" }],
  }));
  try {
    await proposePageRevision(call, { pageId: "page-1", instruction: "Tighten it." }, route);
    assert.deepEqual(calls.map((entry) => entry.method), ["pageAuthoringContext", "revisePageDocument"]);
    // The page reaches the model without the durable fields the store keeps around it.
    const prompt = (sent[0].messages as { content: string }[]).map((message) => message.content).join("\n");
    assert.match(prompt, /\{"id":"summary","type":"rich-text","payload":\{"markdown":"old"\},"fallback":"old"\}/);
    assert.ok(!prompt.includes('"version"'), "the store's own fields do not belong in the prompt");
    assert.deepEqual(JSON.parse(calls[1].params.blocks), [{ id: "summary", type: "rich-text", payload: { markdown: "new" }, fallback: "new" }]);
  } finally { restore(); }
});

test("a page chat becomes one turn with the whole document attached", async () => {
  const { calls, call } = store({ artifacts: [{ id: "how-to-apply", type: "list", payload: { items: ["Try it"] }, fallback: "- Try it" }] });
  const turn = await pageTurnContext(call, "page-1");
  assert.deepEqual(calls.map((entry) => entry.method), ["pageAuthoringContext"]);
  // The page's own thread, so every door onto the document lands in one history.
  assert.equal(turn.threadId, "thread-123456789");
  assert.match(turn.skillContext, /Title: RAG/);
  assert.match(turn.skillContext, /\[how-to-apply · list\]\n- Try it/);
});
