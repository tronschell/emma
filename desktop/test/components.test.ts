import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { componentCall, componentLookup, ComponentRequests, componentRoot, deleteComponent, listComponents, readComponent, setComponentEnabled, setComponentExpands, writeComponent } from "../main/components";
import { MAX_COMPONENT_FETCH_BYTES, MAX_COMPONENT_REQUEST_BYTES, parseVariables, type ComponentMeta } from "../shared/components";
import { parseToolArgs } from "../main/tools";

const userData = () => mkdtemp(path.join(tmpdir(), "emma-components-"));

test("a component round-trips, and a rewrite counts up", async () => {
  const directory = await userData();
  try {
    const made = await writeComponent(directory, { title: "Token burn", code: "export default ({ h }) => () => h('b', null, 'hi')", sourceThreadId: "thread-1" });
    assert.equal(made.id, "token-burn");
    assert.equal(made.version, 1);
    assert.equal(await readFile(path.join(componentRoot(directory), "token-burn", "module.js"), "utf8"), made.code);

    const again = await writeComponent(directory, { id: "token-burn", title: "Token burn", code: "export default ({ h }) => () => h('b', null, 'bye')" });
    assert.equal(again.version, 2);
    assert.equal(again.createdAt, made.createdAt);
    assert.equal(again.sourceThreadId, "thread-1");
    assert.equal((await readComponent(directory, "token-burn")).code, again.code);

    const off = await setComponentEnabled(directory, "token-burn", false);
    assert.equal(off.disabled, true);
    assert.equal(off.version, 2, "switching one off is not a new version of it");
    assert.equal((await writeComponent(directory, { id: "token-burn", title: "Token burn", code: "export default () => () => null" })).disabled, true);

    await deleteComponent(directory, "token-burn");
    assert.deepEqual(await listComponents(directory), []);
    await assert.rejects(readComponent(directory, "token-burn"), /no component/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("full screen and variables survive a rewrite that does not mention them", async () => {
  const directory = await userData();
  try {
    const made = await writeComponent(directory, { title: "Issues", code: "export default () => () => null", expands: true, variables: ["LINEAR_API_KEY"] });
    assert.equal(made.expands, true);
    assert.deepEqual(made.variables, ["LINEAR_API_KEY"]);

    const again = await writeComponent(directory, { id: made.id, title: "Issues", code: "export default () => () => null" });
    assert.equal(again.expands, true, "a rewrite keeps the room it was given");
    assert.deepEqual(again.variables, ["LINEAR_API_KEY"], "a rewrite keeps the variables the user filled in");

    const flat = await setComponentExpands(directory, made.id, false);
    assert.equal(flat.expands, undefined);
    assert.equal(flat.version, again.version, "allowing full screen is not a rewrite");
    assert.equal((await readComponent(directory, made.id)).expands, undefined, "the change is on disk");

    assert.deepEqual(parseVariables(["A_KEY", "A_KEY", " B_KEY "]), ["A_KEY", "B_KEY"]);
    assert.throws(() => parseVariables(["9lives"]), /environment variable name/);
    assert.throws(() => parseVariables(Array.from({ length: 9 }, (_, index) => `K${index}`)), /at most/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a component's request may only carry the variables it declared", () => {
  const meta = { id: "issues", title: "Issues", createdAt: "", updatedAt: "", version: 1, variables: ["LINEAR_API_KEY"] } as ComponentMeta;

  const call = componentCall(meta, { url: "https://api.linear.app/graphql", method: "post", headers: { Authorization: "Bearer {{LINEAR_API_KEY}}" }, body: '{"query":"{ viewer { id } }"}' });
  assert.equal(call.method, "POST");
  assert.equal(call.headers.authorization, "Bearer {{LINEAR_API_KEY}}");
  assert.equal(call.body, '{"query":"{ viewer { id } }"}');
  assert.deepEqual(call.variables, ["LINEAR_API_KEY"]);

  assert.throws(() => componentCall(meta, { url: "https://x.test", headers: { Authorization: "{{OPENROUTER_API_KEY}}" } }), /did not ask for OPENROUTER_API_KEY/);
  assert.throws(() => componentCall(meta, { url: "http://localhost/{{LINEAR_API_KEY}}" }), /URLs cannot contain credential placeholders/);
  assert.throws(() => componentCall(meta, { url: "https://x.test", method: "CONNECT" }), /may send GET/);
  for (const request of [
    { url: "https://x.test", method: false },
    { url: "https://x.test", headers: "Authorization" },
    { url: "https://x.test", headers: { "bad header": "x" } },
    { url: "https://x.test", headers: { Host: "localhost" } },
    { url: "https://x.test", headers: { "Content-Length": "0" } },
    { url: "https://x.test", headers: { "Accept-Encoding": "gzip" } },
    { url: "https://x.test", headers: { authorization: "a", Authorization: "b" } },
    { url: "https://x.test", headers: { Authorization: "line\r\ninjection" } },
    { url: "https://x.test", headers: { Authorization: "{{ broken" } },
    { url: "https://x.test", body: "GET body" },
    { url: "https://x.test", method: "POST", body: "x".repeat(MAX_COMPONENT_REQUEST_BYTES + 1) },
    { url: "https://x.test", headers: { A: "x".repeat(MAX_COMPONENT_REQUEST_BYTES), B: "x" } },
    { url: "https://x.test", redirect: "follow" },
    { url: "https://name:password@x.test" },
    { url: "https://[::ffff:127.0.0.1]" },
    { url: "http://x.test" },
  ]) assert.throws(() => componentCall(meta, request), Error, JSON.stringify(request).slice(0, 200));
  assert.throws(() => componentCall({ ...meta, disabled: true }, { url: "https://x.test" }), /switched off/);
});

function componentServer(t: TestContext, reply: () => { status?: number; headers?: IncomingMessage["headers"]; stream?: Readable; body?: string; error?: Error } = () => ({ body: "{}" })) {
  const sent: { url: string; options: https.RequestOptions; body?: string }[] = [];
  t.mock.method(https, "request", ((url: string, options: https.RequestOptions, callback: (response: IncomingMessage) => void) => {
    const outgoing = new EventEmitter() as ClientRequest;
    outgoing.end = ((body?: string) => {
      sent.push({ url, options, body });
      queueMicrotask(() => {
        const next = reply();
        if (next.error) { outgoing.emit("error", next.error); return; }
        const response = (next.stream ?? Readable.from([Buffer.from(next.body ?? "{}")])) as IncomingMessage;
        response.statusCode = next.status ?? 200;
        response.headers = next.headers ?? {};
        callback(response);
      });
      return outgoing;
    }) as ClientRequest["end"];
    return outgoing;
  }) as typeof https.request);
  return sent;
}

test("credentials require an exact native-approved template, not a caller-selected component id", async (t) => {
  const directory = await userData();
  const sent = componentServer(t);
  try {
    await writeComponent(directory, { title: "Alpha", code: "export default () => () => null", variables: ["ALPHA_KEY"] });
    await writeComponent(directory, { title: "Beta", code: "export default () => () => null", variables: ["BETA_KEY"] });
    const env = { ALPHA_KEY: "DUMMY_ALPHA_123", BETA_KEY: "DUMMY_BETA_456" };
    const requests = new ComponentRequests();
    const template = { url: "https://api.example.com/graphql", method: "POST", headers: { Authorization: "Bearer {{ALPHA_KEY}}" }, body: '{"query":"viewer"}' };
    let approvals = 0;
    const approve = async (meta: ComponentMeta, call: ReturnType<typeof componentCall>) => {
      approvals++;
      assert.equal(JSON.stringify(call).includes("DUMMY_"), false);
      return meta.id === "alpha" && call.url === template.url;
    };
    for (const id of ["alpha", "beta"]) {
      await assert.rejects(requests.fetch(directory, id, { url: `http://localhost/{{${id.toUpperCase()}_KEY}}` }, env, approve), (error: Error) => !error.message.includes("DUMMY_") && /placeholders/.test(error.message));
    }
    assert.equal(approvals, 0);
    assert.equal(sent.length, 0);
    await assert.rejects(requests.fetch(directory, "alpha", template, {}, approve), /Settings/);
    assert.equal(approvals, 0);

    await requests.fetch(directory, "alpha", template, env, approve);
    await requests.fetch(directory, "alpha", template, env, approve);
    assert.equal(approvals, 1, "an identical approved request reuses its session grant");
    assert.equal(sent[0].options.headers && (sent[0].options.headers as Record<string, string>).authorization, "Bearer DUMMY_ALPHA_123");
    assert.equal(sent[0].options.lookup, componentLookup);
    assert.equal(sent[0].options.agent, false);
    assert.equal(sent[0].options.rejectUnauthorized, true);

    await assert.rejects(requests.fetch(directory, "alpha", { ...template, url: "https://other.example.com/collect" }, env, approve), /not approved/);
    await assert.rejects(requests.fetch(directory, "beta", { ...template, headers: { Authorization: "Bearer {{BETA_KEY}}" } }, env, approve), /not approved/);
    assert.equal(sent.length, 2, "changing an id or destination cannot borrow the earlier approval");
    assert.equal(approvals, 3);
    await assert.rejects(requests.fetch(directory, "beta", { ...template, headers: { Authorization: "Bearer {{BETA_KEY}}" } }, env, approve), /not approved/);
    assert.equal(approvals, 3, "a denied template cannot repeatedly open a prompt");

    await requests.fetch(directory, "alpha", { ...template, body: '{"query":"issues"}' }, env, approve);
    env.ALPHA_KEY = "DUMMY_ROTATED_789";
    await requests.fetch(directory, "alpha", template, env, approve);
    await writeComponent(directory, { id: "alpha", title: "Alpha", code: "export default () => () => 'new'", variables: ["ALPHA_KEY", "BETA_KEY"] });
    await requests.fetch(directory, "alpha", template, env, approve);
    assert.equal(approvals, 6, "body, credentials and component rewrites each need a new grant");
    await new ComponentRequests().fetch(directory, "alpha", template, env, approve);
    assert.equal(approvals, 7, "a new app session has no grants");
    await requests.fetch(directory, "alpha", { url: "https://api.example.com/public" }, env, approve);
    assert.equal(approvals, 7, "a keyless public request needs no credential grant");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rewrites and credential changes during approval fail closed", async (t) => {
  const directory = await userData();
  const sent = componentServer(t);
  try {
    await writeComponent(directory, { title: "Alpha", code: "export default () => () => null", variables: ["ALPHA_KEY"] });
    const env = { ALPHA_KEY: "DUMMY_ALPHA_123" };
    const template = { url: "https://api.example.com/data", headers: { Authorization: "{{ALPHA_KEY}}" } };
    const requests = new ComponentRequests();
    await assert.rejects(requests.fetch(directory, "alpha", template, env, async () => {
      await writeComponent(directory, { id: "alpha", title: "Alpha", code: "export default () => () => 'changed'" });
      return true;
    }), /changed while approval/);
    await assert.rejects(requests.fetch(directory, "alpha", template, env, async () => {
      env.ALPHA_KEY = "DUMMY_ROTATED_789";
      return true;
    }), /changed while approval/);
    await assert.rejects(requests.fetch(directory, "alpha", template, env, async () => {
      await setComponentEnabled(directory, "alpha", false);
      return true;
    }), /changed while approval/);
    assert.equal(sent.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("component DNS pins only public addresses across both IP families", async (t) => {
  let addresses = [{ address: "8.8.8.8", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }];
  t.mock.method(dns, "lookup", ((_host: string, options: dns.LookupAllOptions, callback: (error: Error | null, addresses: dns.LookupAddress[]) => void) => {
    assert.equal(options.all, true);
    callback(null, addresses);
  }) as typeof dns.lookup);
  const resolve = (options: dns.LookupOptions) => new Promise<{ address: string | dns.LookupAddress[]; family?: number }>((done, reject) => {
    componentLookup("api.example.com", options, (error, address, family) => error ? reject(error) : done({ address, family }));
  });
  assert.deepEqual((await resolve({ all: true })).address, addresses);
  assert.deepEqual(await resolve({ family: 6 }), { address: "2606:4700:4700::1111", family: 6 });
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "::1", "::ffff:7f00:1", "fe80::1", "fd00::1"]) {
    addresses = [{ address: "8.8.8.8", family: 4 }, { address, family: address.includes(":") ? 6 : 4 }];
    await assert.rejects(resolve({ all: true }), /only to public addresses/);
  }
  addresses = [];
  await assert.rejects(resolve({ all: true }), /public addresses/);
});

test("component responses reject redirects, transport leaks and credential echoes", async (t) => {
  const directory = await userData();
  let answer: { status?: number; headers?: IncomingMessage["headers"]; body?: string; error?: Error } = { status: 302, headers: { location: "http://127.0.0.1/private" } };
  const sent = componentServer(t, () => answer);
  try {
    await writeComponent(directory, { title: "Alpha", code: "export default () => () => null", variables: ["ALPHA_KEY"] });
    const requests = new ComponentRequests();
    const env = { ALPHA_KEY: "DUMMY_ALPHA_123" };
    const template = { url: "https://api.example.com/data", headers: { Authorization: "{{ALPHA_KEY}}" } };
    await assert.rejects(requests.fetch(directory, "alpha", template, env, async () => true), /redirects are not allowed/);
    assert.equal(sent.length, 1);
    answer = { error: new Error("Socket error containing DUMMY_ALPHA_123") };
    await assert.rejects(requests.fetch(directory, "alpha", template, env, async () => true), (error: Error) => error.message === "Component request failed. Check the public HTTPS endpoint." && error.cause === undefined);
    for (const body of [env.ALPHA_KEY, Buffer.from(env.ALPHA_KEY).toString("base64")]) {
      answer = { body };
      await assert.rejects(requests.fetch(directory, "alpha", template, env, async () => true), (error: Error) => /contained a credential/.test(error.message) && !error.message.includes(env.ALPHA_KEY));
    }
    answer = { headers: { "content-encoding": "gzip" } };
    await assert.rejects(requests.fetch(directory, "alpha", template, env, async () => true), /uncompressed text/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("component response limits stop streaming by bytes and accept a complete UTF-8 boundary", async (t) => {
  const directory = await userData();
  let produced = 0;
  let stream = Readable.from((function* () {
    for (let index = 0; index < 128; index++) {
      produced += 64 * 1024;
      yield Buffer.alloc(64 * 1024, 65);
    }
  })());
  componentServer(t, () => ({ stream }));
  try {
    await writeComponent(directory, { title: "Alpha", code: "export default () => () => null" });
    const requests = new ComponentRequests();
    const template = { url: "https://api.example.com/data" };
    await assert.rejects(requests.fetch(directory, "alpha", template, {}, async () => false), /at most 1 MiB/);
    assert.ok(produced < MAX_COMPONENT_FETCH_BYTES * 2, "the remainder of the oversized response was never consumed");
    assert.equal(stream.destroyed, true);
    stream = Readable.from([Buffer.from("🙂".repeat(MAX_COMPONENT_FETCH_BYTES / 4))]);
    const result = await requests.fetch(directory, "alpha", template, {}, async () => false);
    assert.equal(Buffer.byteLength(result.body), MAX_COMPONENT_FETCH_BYTES);
    assert.equal(result.ok, true);
    stream = Readable.from([Buffer.from([0xff])]);
    await assert.rejects(requests.fetch(directory, "alpha", template, {}, async () => false), /UTF-8 text/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("create and rewrite have to carry what they need", () => {
  assert.deepEqual(parseToolArgs("component", JSON.stringify({ action: "create", title: "Issues", code: "x", expand: true, variables: ["LINEAR_API_KEY"] })), {
    name: "component", action: "create", id: undefined, title: "Issues", code: "x", expand: true, variables: ["LINEAR_API_KEY"],
  });
  assert.throws(() => parseToolArgs("component", JSON.stringify({ action: "create", code: "x" })), /title/);
  assert.throws(() => parseToolArgs("component", JSON.stringify({ action: "create", title: "x" })), /code/);
  assert.throws(() => parseToolArgs("component", JSON.stringify({ action: "rewrite", code: "x" })), /id/);
  assert.throws(() => parseToolArgs("component", JSON.stringify({ action: "place", title: "x" })), /action must be one of/);
});
