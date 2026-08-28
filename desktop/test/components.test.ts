import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { componentCall, componentRoot, deleteComponent, listComponents, readComponent, setComponentEnabled, setComponentExpands, writeComponent } from "../main/components";
import { parseVariables, type ComponentMeta } from "../shared/components";
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
  const env = { LINEAR_API_KEY: "lin_abc", OPENROUTER_API_KEY: "sk-secret" };

  const call = componentCall(meta, { url: "https://api.linear.app/graphql", method: "post", headers: { Authorization: "Bearer {{LINEAR_API_KEY}}" }, body: '{"query":"{ viewer { id } }"}' }, env);
  assert.equal(call.method, "POST");
  assert.equal(call.headers.Authorization, "Bearer lin_abc");
  assert.equal(call.body, '{"query":"{ viewer { id } }"}');

  assert.throws(() => componentCall(meta, { url: "https://x.test/{{OPENROUTER_API_KEY}}" }, env), /did not ask for OPENROUTER_API_KEY/);
  assert.throws(() => componentCall({ ...meta, variables: ["MISSING_KEY"] }, { url: "https://x.test/{{MISSING_KEY}}" }, env), /Settings/);
  assert.throws(() => componentCall(meta, { url: "https://x.test", method: "CONNECT" }, env), /may send GET/);
  assert.throws(() => componentCall(meta, { url: "https://x.test", headers: { "bad header": "x" } }, env), /not a header name/);
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
