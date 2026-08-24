# Icon sources

Every vendor mark Emma ships, and the terms it came under. Files live in
`desktop/assets/brands/`; the registry that pins each one is
[`desktop/src/brands.ts`](../desktop/src/brands.ts). Nothing is fetched at
runtime and no icon package is installed. Retrieved 2026-08-20.

A CC0 or MIT icon package licenses the packaging, not the trademark. Marks are
normalised onto a 24-unit grid and recoloured `#fff` (or kept at the brand
colour where the mark has one); do not redraw, distort, or combine them with
Emma branding, and keep the accessible product label beside every image.

## Official brand kits

| File | Source | Terms |
| --- | --- | --- |
| `openai.svg` | [OpenAI 2025 Blossom asset](https://images.ctfassets.net/kftzwdyauwt9/3hUGLn3ypllZ0oa01qOYVq/28e8188e6f11b84c3e876569d492734f/Blossom_Light.svg?q=90&w=3840), from the [OpenAI brand page](https://openai.com/brand/) | Official; blossom lifted from the construction sheet, recoloured `#fff` |
| `antigravity.png` | [Google Antigravity press assets](https://www.antigravity.google/press) | Official press asset; identifies the product only |
| `gemini.png` | [Google Press Corner Spark icon](https://storage.googleapis.com/gweb-uniblog-publish-prod/images/Gemini_SparkIcon_4C.original.png) | Official; identifies Gemini only |
| `pi.svg` | [Pi favicon](https://pi.dev/favicon.svg), via the [Pi press kit](https://pi.dev/press-kit) | Official badge; tile dropped, glyph kept white |
| `openrouter.svg` | [OpenRouter v2 brand asset](https://openrouter.ai/brand/v2/openrouter-dark.svg) | Official; glyph lifted from the lockup, brand `#C8FF00` kept |

## Simple Icons — CC0 1.0

[simple-icons/simple-icons](https://github.com/simple-icons/simple-icons), each
pinned to a commit. Full hashes are in `desktop/src/brands.ts`; the raw URL is
`raw.githubusercontent.com/simple-icons/simple-icons/<commit>/icons/<file>.svg`.

| File | Commit | | File | Commit |
| --- | --- | --- | --- | --- |
| `anthropic.svg` | `ec4aa60` | | `naver.svg` | `77f4c6a` |
| `meta.svg` | `a25b159` | | `obsidian.svg` | `c956d67` |
| `cursor.svg` | `be23679` | | `github.svg` | `c956d67` |
| `windsurf.svg` | `513d314` | | `gitlab.svg` | `c956d67` |
| `opencode.svg` | `3237c86` | | `jira.svg` | `c956d67` |
| `mistralai.svg` | `2a0db0d` | | `todoist.svg` | `c956d67` |
| `deepseek.svg` | `8f56a0b` | | `xiaomi.svg` | `34c2250` |
| `qwen.svg` | `6e41e4e` | | `kimi.svg` | `c53db56` |
| `nvidia.svg` | `521c96f` | | | |

`anthropic.svg` is also the Claude importer's mark.

## Lobe Icons — MIT

[lobehub/lobe-icons](https://github.com/lobehub/lobe-icons), for providers with
no reusable official kit. Source URL is
`raw.githubusercontent.com/lobehub/lobe-icons/master/packages/static-svg/icons/<file>.svg`.

| File | Owner |
| --- | --- |
| `xai.svg` | xAI |
| `zai.svg` | Z.ai |
| `minimax.svg` | MiniMax |
| `cohere.svg` | Cohere |
| `liquid.svg` | Liquid AI |
| `poolside.svg` | poolside |
| `bytedance.svg` | ByteDance |

## Elsewhere in the UI

| Where | Source | Terms |
| --- | --- | --- |
| `desktop/assets/filetypes/*.svg` | Simple Icons where a language owns a mark; otherwise drawn on the same 24-unit grid | CC0 1.0 / original |
| Nav footer gear | Lucide's [`settings`](https://lucide.dev/icons/settings) path, copied into `NavIcon`; no package installed | ISC |
| `emma.webp`, `emma-blink.webp` | Emma's own art | — |

## No mark bundled

These use Emma's neutral monogram fallback because no clearly reusable public
product-icon kit was found: Devin (Cognition), Thinking Machines, ERNIE
(Baidu), Hunyuan (Tencent), Sakana AI. Keep the fallback until the owner
supplies an official asset.

Wider licensing is in [credits.md](credits.md).
