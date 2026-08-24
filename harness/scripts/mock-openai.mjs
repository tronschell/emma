#!/usr/bin/env node
// A stand-in OpenAI-compatible Chat Completions endpoint, so emma-cli's
// transport can be proven end to end without a credential or a network call.
//
// It asserts the request shape Emma's provider is supposed to emit, then drives
// one real tool round trip: the first turn asks for a `bash` call, the second
// answers with text. Run it, point EMMA_PROVIDER_CHAT_URL at it, and any
// mismatch shows up as a non-zero exit.

import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8099);
const problems = [];
let turn = 0;

const check = (ok, label) => {
  if (!ok) problems.push(label);
};

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    turn += 1;
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      problems.push("request body was not JSON");
      res.writeHead(400).end("{}");
      return;
    }

    if (turn === 1) {
      // OpenAI vocabulary, not Vercel AI SDK vocabulary.
      check(Array.isArray(body.messages), "messages[] missing");
      check(body.prompt === undefined, "AI SDK 'prompt' leaked into the body");
      check(body.toolChoice === undefined, "AI SDK 'toolChoice' leaked into the body");
      check(typeof body.model === "string" && body.model.length > 0, "model missing");
      check(Array.isArray(body.tools) && body.tools.length > 0, "tools[] missing");
      const tool = body.tools?.[0];
      check(tool?.type === "function", "tool is not type=function");
      check(typeof tool?.function?.name === "string", "tool.function.name missing");
      check(tool?.function?.parameters !== undefined, "tool.function.parameters missing");
      check(tool?.inputSchema === undefined, "AI SDK 'inputSchema' leaked into a tool");
      check(req.headers.authorization?.startsWith("Bearer "), "Authorization header missing");

      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "bash", arguments: JSON.stringify({ command: "echo emma" }) },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 5 },
        }),
      );
      return;
    }

    // The second turn must carry the assistant's call and its paired result.
    const roles = (body.messages ?? []).map((message) => message.role);
    check(roles.includes("assistant"), "assistant turn was not replayed");
    check(roles.includes("tool"), "tool result was not replayed");
    const toolMessage = (body.messages ?? []).find((message) => message.role === "tool");
    check(toolMessage?.tool_call_id === "call_1", "tool result lost its tool_call_id");

    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        choices: [{ message: { content: "Tool loop reached the model twice." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 8 },
      }),
    );
  });
});

process.on("SIGTERM", () => finish());
process.on("SIGINT", () => finish());

function finish() {
  server.close();
  // A run that never reached the endpoint asserted nothing, so silence is a
  // failure here rather than a pass with an empty checklist.
  if (turn < 2) problems.push(`expected 2 requests, got ${turn}`);
  if (problems.length) {
    console.error(`FAIL (${turn} requests):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`OK: ${turn} requests, request shape and tool round trip verified`);
  process.exit(0);
}

server.listen(port, "127.0.0.1", () => console.log(`mock listening on ${port}`));
