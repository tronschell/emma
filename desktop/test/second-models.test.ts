import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { advise } from "../main/advisor";
import { readSecret } from "../main/secret";
import { nameThread } from "../main/thread-namer";
import { tagNote } from "../main/vault-tags";
import { describeScreen, look } from "../main/vision";
import { chatCompletion } from "../main/verifier";
import { defaultAdvisorSystem, defaultSecretSystem, defaultVerifierSystem, defaultVisionSystem } from "../shared/settings";

type Call = { path: string; authorization: string; model: string; models?: string[]; messages: { role: string; content: unknown }[] };

async function withGateway(run: (base: string, calls: Call[]) => Promise<void>) {
  const calls: Call[] = [];
  const answers: Record<string, string> = {
    "/advisor": "Read the failing test first, then the fixture it loads.",
    "/secret": "OPENROUTER_API_KEY is set, 73 characters, prefix sk-o.",
    "/vision": "A dialog reading Save changes?, with two buttons.",
    "/screen": "A pull request page for emma, the Files changed tab open.",
    "/namer": '{"title":"Vision route"}',
    "/tagger": '{"title":"Release notes","tags":["release","emma"]}',
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const sent = JSON.parse(body) as { model: string; models?: string[]; messages: Call["messages"] };
      const path = request.url ?? "";
      calls.push({ path, authorization: request.headers.authorization ?? "", model: sent.model, models: sent.models, messages: sent.messages });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: answers[path] ?? "" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(base, calls);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const route = (base: string, path: string, model: string, credentialEnv: string, system: string) =>
  ({ model, endpoint: `${base}${path}`, credentialEnv, system });

test("every second model reaches its own endpoint with its own key and its own model", async () => {
  await withGateway(async (base, calls) => {
    process.env.EMMA_TEST_ADVISOR_KEY = "advisor-key";
    process.env.EMMA_TEST_SECRET_KEY = "secret-key";
    process.env.EMMA_TEST_VISION_KEY = "vision-key";
    process.env.EMMA_TEST_TAGGER_KEY = "tagger-key";
    try {
      const advice = await advise(route(base, "/advisor", "vendor/advisor", "EMMA_TEST_ADVISOR_KEY", defaultAdvisorSystem), "the transcript so far");
      assert.match(advice.text, /failing test/);
      assert.equal(advice.error, undefined);

      const secret = await readSecret(route(base, "/secret", "vendor/secret", "EMMA_TEST_SECRET_KEY", defaultSecretSystem), "env | grep KEY", "OPENROUTER_API_KEY=sk-or-v1-abc", "is the key set?");
      assert.match(secret, /73 characters/);

      const vision = route(base, "/vision", "vendor/eyes:free,vendor/spare-eyes:free", "EMMA_TEST_VISION_KEY", defaultVisionSystem);
      const seen = await look(vision, "data:image/png;base64,iVBOR", "What does this dialog say?");
      assert.match(seen, /Save changes\?/);

      const screen = await describeScreen({ ...vision, endpoint: `${base}/screen` }, "data:image/png;base64,iVBOR", { application: "Safari", window: "emma" });
      assert.match(screen, /Files changed/);

      const named = await nameThread("why does vision never answer?", route(base, "/namer", "vendor/namer", "", defaultVerifierSystem));
      assert.equal(named, "Vision route");

      const tagged = await tagNote({ id: "n1", title: "", tags: [], at: 0 } as never, "the release notes", route(base, "/tagger", "vendor/tagger", "EMMA_TEST_TAGGER_KEY", defaultVerifierSystem));
      assert.deepEqual(tagged, { title: "Release notes", tags: ["release", "emma"] });

      assert.deepEqual(calls.map((call) => call.path), ["/advisor", "/secret", "/vision", "/screen", "/namer", "/tagger"]);
      assert.deepEqual(calls.map((call) => call.authorization), [
        "Bearer advisor-key",
        "Bearer secret-key",
        "Bearer vision-key",
        "Bearer vision-key",
        "",
        "Bearer tagger-key",
      ]);
      assert.deepEqual(calls.map((call) => call.model), [
        "vendor/advisor",
        "vendor/secret",
        "vendor/eyes:free",
        "vendor/eyes:free",
        "vendor/namer",
        "vendor/tagger",
      ]);
      assert.deepEqual(calls[2].models, ["vendor/eyes:free", "vendor/spare-eyes:free"]);
      assert.deepEqual(calls[2].messages[1].content, [
        { type: "text", text: (calls[2].messages[1].content as { text: string }[])[0].text },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBOR" } },
      ]);
    } finally {
      delete process.env.EMMA_TEST_ADVISOR_KEY;
      delete process.env.EMMA_TEST_SECRET_KEY;
      delete process.env.EMMA_TEST_VISION_KEY;
      delete process.env.EMMA_TEST_TAGGER_KEY;
    }
  });
});

test("a second model that answers with an error status is reported, not silently taken as an answer", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(502, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
  try {
    const settings = { model: "vendor/advisor", endpoint, credentialEnv: "", system: defaultAdvisorSystem };
    await assert.rejects(
      chatCompletion(settings, [{ role: "user", content: "hi" }], "", { maxTokens: 16, timeoutMs: 5_000, label: "advisor" }),
      /answered 502/,
    );
    const advice = await advise(settings, "the transcript so far");
    assert.match(advice.text, /could not be reached/);
    assert.equal(advice.error, "The advisor endpoint answered 502.");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("chain of thought is not an answer, so a reply with only reasoning comes back empty", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "", reasoning: "The user wants a commit message. The diff shows" } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
  try {
    const settings = { model: "vendor/thinker", endpoint, credentialEnv: "", system: defaultAdvisorSystem };
    assert.equal(await chatCompletion(settings, [{ role: "user", content: "hi" }], "", { maxTokens: 16, timeoutMs: 5_000, label: "advisor" }), "");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
