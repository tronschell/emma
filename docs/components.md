# Components

A component is a widget Emma writes into her own interface. It is a real module
in the running React tree — the app's stylesheet, the app's bridge, no build step
and no frame — and it reloads in place every time she rewrites it.

Where a component *goes* is not a choice. It goes in the context bar, under the
built-in widgets and inside their chrome (`COMPONENT_ZONE` in
[`desktop/shared/components.ts`](../desktop/shared/components.ts)). Every other
part of the window is off limits, which is the whole point: the column owns the
padding, the header row and the reveal, so a model-written widget cannot push the
transcript sideways or leave a hole in the composer.

## The module

```
export default (api) => Component
```

`api` is `{ h, Fragment, useState, useEffect, useMemo, useRef, useCallback, emma, fetch, variables }`.
`h` is `React.createElement` — no JSX, nothing to import. The component is handed
one prop, `expanded`.

| | |
| --- | --- |
| `emma` | The same bridge the app uses: `emma.request("snapshot", {})` for threads and jobs, `emma.threadTraces(id)`, `emma.machineSample()`, and the rest. Everything the app knows, a component knows |
| `fetch(url, init)` | One request through the main process. `init` is `{ method, headers, body }`; the answer is `{ status, ok, body }`, `body` capped at 1 MiB. Public https only — `publicUrl` refuses localhost and every private range — and 20 seconds |
| `variables` | The environment variable names this component declared, as names. Never the values |

## Variables

Anything secret — an API key, a workspace id, a private base url — is declared by
name when the component is created:

```
component {"action":"create","title":"Linear issues","code":"…","expand":true,"variables":["LINEAR_API_KEY"]}
```

The user fills them in **Settings → Built by Emma**, where each component lists
what it asked for. Values go through the existing `CredentialStore` — encrypted
by `safeStorage`, mirrored into main's environment, never returned to the
renderer.

The module writes `{{LINEAR_API_KEY}}` into a url, a header value or a body and
main substitutes it on the way out. A name the component did not declare is
refused, and an unset one is refused with the setting to open. So the module —
which nobody read — never holds the key, and cannot read a key belonging to
something else.

## Full screen

288px is not enough for a table or a board. `expand: true` gives the widget a ⤢
in its header that opens it over the whole window, and hands the component
`expanded` so it can draw both readings — the dense one in the column, the full
one in the sheet. The user turns it on or off themselves from the ⋯ menu or from
Settings; the agent sets it when the thing it is building plainly needs the room.

A component without `expand` has no ⤢ and never opens, so nothing gains a
full-screen mode by accident.

## The reveal

A new version wipes in behind a left-to-right ASCII reveal (`built.css`), drawn
in `--accent-2` — the accent rotated 150° in OKLCH, so it is always a second hue
against whatever accent is set, custom hex included. Both the wipe and the
clip-path fade under it stop at `prefers-reduced-motion`.

## A worked example

Both halves of the contract in one widget: app data through `emma`, outside data
through `fetch` with a declared variable, and two readings of the same list.

```js
export default ({ h, useState, useEffect, emma, fetch }) => ({ expanded }) => {
  const [issues, setIssues] = useState([]);
  const [threads, setThreads] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    void emma.request("snapshot", {}).then((snap) => setThreads(snap.threads.length)).catch(() => setThreads(0));
    void fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "{{LINEAR_API_KEY}}" },
      body: JSON.stringify({ query: "{ issues(first: 20) { nodes { identifier title state { name } } } }" }),
    })
      .then((answer) => {
        if (!answer.ok) throw new Error(`Linear answered ${answer.status}`);
        setIssues(JSON.parse(answer.body).data.issues.nodes);
      })
      .catch((reason) => setError(String(reason.message ?? reason)));
  }, []);

  if (error) return h("p", { className: "bar-empty" }, error);
  return h("div", { className: "agent-metrics" },
    h("span", null, h("b", null, String(issues.length)), " open · ", String(threads), " threads"),
    ...issues.slice(0, expanded ? 20 : 5).map((issue) =>
      h("span", { key: issue.identifier }, h("b", null, issue.identifier), " ", issue.title)));
};
```

## Ceilings

| Constant | Value |
| --- | --- |
| `MAX_COMPONENTS` | 64 |
| `MAX_COMPONENT_CHARS` | 64 KiB of module source |
| `MAX_COMPONENT_TITLE_CHARS` | 80 |
| `MAX_COMPONENT_VARIABLES` | 8 declared names |
| `MAX_COMPONENT_FETCH_BYTES` | 1 MiB of response body |
| `COMPONENT_FETCH_TIMEOUT_MS` | 20 000 ms |
| `MAX_COMPONENT_SHOT_BYTES` | 4 MiB for the Settings thumbnail |

All in [`desktop/shared/components.ts`](../desktop/shared/components.ts).

## See also

- [concepts.md](concepts.md) — component, context bar, artifact
- [context-bar.md](context-bar.md) — the column a component lands in
- [tools.md](tools.md) — the `component` tool's actions and ceilings
- [design-system.md](design-system.md) — the tokens a component styles itself from
