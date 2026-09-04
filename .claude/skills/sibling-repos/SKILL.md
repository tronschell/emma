---
name: sibling-repos
description: Emma ships as three repositories — emma (the desktop app), emma-mobile (the iPhone client), and emma-website (the public site, docs, and roadmap). Use whenever a change in one of them needs a matching change in another, or when asked to update the site, the docs, the roadmap, or the phone client after a feature lands.
---

# The three repositories

| Repo | Path | What it is |
| --- | --- | --- |
| `emma` | `~/Documents/emma` | The macOS desktop app. Electron + Rust + the Zig harness. Source of truth for behaviour. |
| `emma-mobile` | `~/Documents/emma-mobile` | Expo/React Native iPhone client. A remote for the Mac over Wi-Fi or tailnet, and a local agent of its own. |
| `emma-website` | `~/Documents/emma-website` | Vite + React marketing site, docs, and roadmap. What the world sees. |

`emma` leads. The other two follow it; neither drives a desktop change on its own.

## When a change ripples

Work through this after the desktop change is done and verified, not before.

**New feature in `emma`**
- Website: add or update the page or tile that covers it, and the entry in
  `ROADMAP.md` — move it out of *Next* into *Have*, or add a new section.
- Website, major feature only: take screenshots of the real app and put them in
  `public/shots/`. Major means a user can see it — a new surface, a new panel, a
  new window. A flag or an internal refactor is not major.
- Mobile: if the phone should be able to do it too, or if it now shows something
  stale, change it. If the phone deliberately does not get it, say so in the
  desktop PR's release notes.

**Tools, models, permissions, protocols, or anything inherent to the app**
- Website: update the docs (`src/docs.tsx`) and `public/llms.txt` /
  `public/llms-full.txt` if the change affects what an agent needs to know.
- Mobile: the phone speaks the same protocol (`src/protocol`, `src/net`,
  `src/tools`). A wire change breaks it. Fix it in the same batch.

**Breaking change**
- Mobile is a client of the desktop's bridge. Anything renamed, removed, or
  reshaped on that boundary is a mobile change too. Do not leave it broken.

**Mobile-only or website-only change**
- Usually stops there. Check the roadmap anyway if it changes what is shipped.

## How to do the other-repo work

Spawn a subagent per repository, so it gets a clean context window and does not
carry the desktop diff around with it. One agent, one repo, one clear brief:
what changed in `emma`, which files it touched, what the other repo needs to end
up with. Read that repo's own `AGENTS.md` / `README.md` first — each repo has
its own standards, and `emma`'s no-comments rule does not automatically apply
elsewhere. Never edit `emma-mobile` or `emma-website` from the main session.

Each repo has its own remote and its own PR. Land them separately; reference the
desktop PR in the body so the pair is findable.

## What not to do

- Do not update the website for a change nobody can see.
- Do not guess at screenshots. Launch the real app, capture the real surface.
- Do not add the feature to the roadmap and to a docs page and to a tile when
  one of the three is where it actually belongs.
