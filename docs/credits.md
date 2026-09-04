# Credits

Emma stands on other people's work. This is the whole list, assembled from
`desktop/package.json`, `Cargo.toml`, `Cargo.lock`, `harness/build.zig.zon`,
[`harness/FORK.md`](../harness/FORK.md),
[`harness/THIRD_PARTY_NOTICES.md`](../harness/THIRD_PARTY_NOTICES.md),
`desktop/scripts/vendor-ripgrep.mjs`, and `desktop/assets/`.

## The fork

Emma's agent harness is not Emma's work. `emma-cli` is a fork of **fx**, a
coding agent harness written in Zig by Vercel.

| | |
| --- | --- |
| Upstream | [vercel-labs/fx](https://github.com/vercel-labs/fx) |
| Copyright | Vercel, Inc. and fx contributors |
| License | Apache License 2.0 — [`harness/LICENSE`](../harness/LICENSE) |
| Forked at | [`580a0c5`](https://github.com/vercel-labs/fx/tree/580a0c5da9386317251968c09c1cee69e763487a) |
| Upstream version | 0.0.4 |
| Provenance | [`harness/FORK.md`](../harness/FORK.md) |
| Upstream notices | [`harness/THIRD_PARTY_NOTICES.md`](../harness/THIRD_PARTY_NOTICES.md) |

The agent loop, permission model, hooks, skills, subagents, tool registry, MCP
client, and ACP server are fx's. Apache-2.0 §4 obligations survive the rename:
the license text, the notices file, and every copyright header stay.

Two projects reach Emma through the fork, listed in
[`harness/THIRD_PARTY_NOTICES.md`](../harness/THIRD_PARTY_NOTICES.md):

| Project | Used for | License |
| --- | --- | --- |
| [cuelume](https://github.com/Danilaa1/cuelume) (Daniel Belyi) | The embedded interface sounds derive from its sound recipes | MIT |
| [Unicode](https://home.unicode.org) | Generated Unicode lookup tables | Unicode License v3 |

## Vendored binaries

| Project | Used for | License | Link |
| --- | --- | --- | --- |
| ripgrep 15.2.0 (Andrew Gallant) | The harness's file search. Downloaded by `desktop/scripts/vendor-ripgrep.mjs` to `desktop/vendor/rg`, pinned by version and by the SHA-256 the release publishes, then bundled | MIT / Unlicense | [BurntSushi/ripgrep](https://github.com/BurntSushi/ripgrep) |

## Desktop

Everything in `desktop/package.json`. Vite bundles the renderer, so runtime and
build dependencies live in the same list.

| Project | Used for | License | Link |
| --- | --- | --- | --- |
| Electron 43.4.0 | Windows, the sandboxed renderer, the app shell | MIT | [electron/electron](https://github.com/electron/electron) |
| React 19.2.8 / react-dom | Every view in `desktop/src` | MIT | [facebook/react](https://github.com/facebook/react) |
| TypeScript 6.0.3 | Main, preload, shared, and renderer sources | Apache-2.0 | [microsoft/TypeScript](https://github.com/microsoft/TypeScript) |
| Vite 8.2.2 | Renderer dev server and build | MIT | [vitejs/vite](https://github.com/vitejs/vite) |
| @vitejs/plugin-react 6.1.0 | React fast refresh under Vite | MIT | [vitejs/vite-plugin-react](https://github.com/vitejs/vite-plugin-react) |
| Tailwind CSS 4.3.3 + @tailwindcss/vite | Utility layer over the design tokens | MIT | [tailwindlabs/tailwindcss](https://github.com/tailwindlabs/tailwindcss) |
| xterm.js 6.0.0 (@xterm/xterm, addon-fit, addon-web-links) | Draws the terminal panel. Its pty is a clang-built helper, not node-pty | MIT | [xtermjs/xterm.js](https://github.com/xtermjs/xterm.js) |
| Mermaid 11.17.0 | Diagrams in answers and artifacts | MIT | [mermaid-js/mermaid](https://github.com/mermaid-js/mermaid) |
| @dnd-kit/core 6.3.1, /sortable 10.0.0, /utilities 3.2.2 | Drag-and-drop reordering in the UI | MIT | [clauderic/dnd-kit](https://github.com/clauderic/dnd-kit) |
| ESLint 10.0.1 + @eslint/js, typescript-eslint 8.67.0, eslint-plugin-react-hooks, globals | `npm run lint` | MIT | [eslint/eslint](https://github.com/eslint/eslint) |
| @electron/packager 20.0.4 | `npm run package:mac` and `npm run package:win` | BSD-2-Clause | [electron/packager](https://github.com/electron/packager) |
| @types/node, @types/react, @types/react-dom | Type definitions (DefinitelyTyped) | MIT | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| Node.js 24+ | Build scripts and `node --test`, which is the whole test runner | MIT | [nodejs/node](https://github.com/nodejs/node) |

## Rust

`crates/core` and `crates/host` depend on two crates; the rest of `Cargo.lock`
is their transitive closure.

| Crate | Used for | License | Link |
| --- | --- | --- | --- |
| serde 1 (+ `derive`, `rc`) | Thread and record types, NDJSON framing | MIT OR Apache-2.0 | [serde-rs/serde](https://github.com/serde-rs/serde) |
| serde_json 1 | The NDJSON wire format on the host boundary | MIT OR Apache-2.0 | [serde-rs/json](https://github.com/serde-rs/json) |
| Transitive: itoa, proc-macro2, quote, serde_core, serde_derive, syn | Pulled in by the two above | MIT OR Apache-2.0 | [Cargo.lock](../Cargo.lock) |
| Transitive: memchr (BurntSushi) | Pulled in by serde_json | Unlicense OR MIT | [BurntSushi/memchr](https://github.com/BurntSushi/memchr) |
| Transitive: unicode-ident | Pulled in by syn | (MIT OR Apache-2.0) AND Unicode-3.0 | [dtolnay/unicode-ident](https://github.com/dtolnay/unicode-ident) |
| Transitive: zmij | Float-to-string conversion for serde_json | MIT | [dtolnay/zmij](https://github.com/dtolnay/zmij) |

## Toolchains

| Project | Used for | License | Link |
| --- | --- | --- | --- |
| Rust 1.97.1 (`rust-toolchain.toml`) | Builds `emma-host` | MIT OR Apache-2.0 | [rust-lang/rust](https://github.com/rust-lang/rust) |
| Zig 0.16.0 (`harness/build.zig.zon` `minimum_zig_version`) | Builds `emma-cli`. The harness declares no Zig package dependencies | MIT | [ziglang/zig](https://github.com/ziglang/zig) |
| clang (Xcode) | `emma-option-tap`, `emma-transcribe`, `emma-pty` | Apache-2.0 with LLVM exception | [llvm/llvm-project](https://github.com/llvm/llvm-project) |

## Protocols

No code vendored; Emma speaks these.

| Protocol | Used for | Link |
| --- | --- | --- |
| Agent Client Protocol | Newline-delimited JSON-RPC over stdio between `desktop/main/harness.ts` and `emma-cli`. The server side is fx's own `harness/src/acp/` | [agentclientprotocol.com](https://agentclientprotocol.com) |
| Model Context Protocol | Emma speaks no MCP herself; configured servers are handed to the harness, whose client is fx's `harness/src/core/mcp/` | [modelcontextprotocol.io](https://modelcontextprotocol.io) |
| OpenAI Chat Completions | Every remote model route, OpenRouter by default | [OpenAI API](https://platform.openai.com/docs/api-reference/chat) |

## Fonts

| Font | Used for | License | Link |
| --- | --- | --- | --- |
| Departure Mono (Helena Zhang) | The interface face, bundled as `desktop/assets/DepartureMono-Regular.woff2` rather than fetched from a CDN | SIL Open Font License 1.1 — [`DepartureMono-LICENSE.txt`](../desktop/assets/DepartureMono-LICENSE.txt) | [departuremono.com](https://departuremono.com) |

## Icons and marks

Per-mark provenance is in [icon-sources.md](icon-sources.md) and
[`desktop/assets/BRANDS-NOTICES.md`](../desktop/assets/BRANDS-NOTICES.md). No
runtime icon CDN and no icon package is installed; every file is bundled.

| Source | Used for | License | Link |
| --- | --- | --- | --- |
| Simple Icons | 17 provider and connection marks in `desktop/assets/brands/`, plus most of `desktop/assets/filetypes/`. Each pinned to a commit in `desktop/src/brands.ts` | CC0 1.0 (packaging only) | [simple-icons/simple-icons](https://github.com/simple-icons/simple-icons) |
| Lobe Icons | 7 provider marks with no reusable official kit | MIT (packaging only) | [lobehub/lobe-icons](https://github.com/lobehub/lobe-icons) |
| Lucide | The nav footer gear — the `settings` path copied into `NavIcon`; no package installed | ISC | [lucide-icons/lucide](https://github.com/lucide-icons/lucide) |
| Official brand kits | OpenAI, Google Antigravity, Gemini, Pi, OpenRouter | Vendor brand terms | [icon-sources.md](icon-sources.md) |

Every mark stays its owner's trademark. A CC0 or MIT icon package licenses the
packaging, never the trademark.

## Prior art

| Project | What Emma took | Link |
| --- | --- | --- |

## Emma's own licensing

The root [`LICENSE`](../LICENSE) records the MIT terms stated in the README.
The harness retains its Apache-2.0 license and notices, and the Rust workspace
declares Apache-2.0. Fonts and brand assets retain their own terms.

Packaged apps include these notices under `Contents/Resources/notices/`.
Vite generates the bundled renderer's license list, Cargo metadata locates
the Rust dependency license texts, and the pinned ripgrep archive supplies
its original license files. Electron's own notices remain in its bundle.
