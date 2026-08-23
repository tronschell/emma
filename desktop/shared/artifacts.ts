/* An artifact is a piece of work the conversation produced that outlives it: a
   document, a snippet, a page, a drawing, a diagram. The contract both sides
   read — main owns the folder on disk, the renderer owns the picture of it.

   Deliberately not a knowledge page and not an `ArtifactBlock`: a page is
   something Emma analysed, a block is one region inside one page. This is a
   standalone file the user keeps, edits, and hands to a scheduled task. */

export const ARTIFACT_KINDS = ["markdown", "code", "html", "app", "svg", "mermaid", "react"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** What each kind is written as on disk, so the file opens in the right app. */
export const ARTIFACT_EXTENSIONS: Record<ArtifactKind, string> = {
  markdown: "md",
  code: "txt",
  html: "html",
  app: "html",
  svg: "svg",
  mermaid: "mmd",
  react: "jsx",
};

export const ARTIFACT_LABELS: Record<ArtifactKind, string> = {
  markdown: "Document",
  code: "Code",
  html: "Web page",
  app: "App",
  svg: "Drawing",
  mermaid: "Diagram",
  react: "React component",
};

/**
 * The four regions of Emma's own interface Emma can write herself.
 *
 * A surface is not a slot a page is framed into — it is the region. A `code`
 * artifact that names one is loaded as a real module into the renderer and takes
 * that region's place in the tree: same React, same stylesheet, same props the
 * built-in was given. The built-in is what shows when there is no module, and what
 * comes back when one throws.
 *
 * It is a field on an ordinary artifact rather than a new kind of thing, so the
 * source is on the Artifacts page like everything else — the user can read what is
 * running, and delete it, without knowing any of the above.
 */
export const ARTIFACT_SURFACES = ["navbar", "chat", "notch", "context"] as const;
export type ArtifactSurface = (typeof ARTIFACT_SURFACES)[number];

export const SURFACE_LABELS: Record<ArtifactSurface, string> = {
  navbar: "Sidebar",
  chat: "Thread",
  notch: "Notch",
  context: "Context bar",
};

export function isArtifactSurface(value: unknown): value is ArtifactSurface {
  return typeof value === "string" && (ARTIFACT_SURFACES as readonly string[]).includes(value);
}

/**
 * A region is one module, not a stack of them: two components both claiming to be
 * the navbar have no order that means anything. `code` is the only kind that can
 * be one — the others are things to look at, and this is something that runs.
 */
export const mountable = (kind: ArtifactKind) => kind === "code";

/**
 * Where the renderer imports a region's module from.
 *
 * Served off the artifacts scheme rather than a second one of its own: it is the
 * same folder, read the same way, and `/module.js` is the only path on it that is
 * JavaScript. The version is in the URL because a module is cached by specifier —
 * without it the second import of a rewritten region returns the first one's
 * exports, which is a hot reload that silently does nothing.
 */
export const artifactModuleUrl = (id: string, version: number) => `${ARTIFACT_SCHEME}://${id}/module.js?v=${version}`;
export const MODULE_PATH = "module.js";

/**
 * Per source file — the entry document, and each file an `app` holds beside it.
 * Past this it is a dataset, not something to read in a card.
 *
 * It is deliberately not a cap on an app's *data*: source is written once and read,
 * state accumulates every time the app is used, and one number cannot mean both.
 * `MAX_ARTIFACT_DB_BYTES` is the other half.
 */
export const MAX_ARTIFACT_BYTES = 512 * 1024;
/** Across the folder, so a runaway loop cannot fill the disk. */
export const MAX_ARTIFACTS = 512;
export const MAX_ARTIFACT_TITLE_CHARS = 200;

/**
 * An `app`'s own database, beside its source in its own folder — so it is real
 * SQLite the user can open, and deleting the artifact deletes it with everything
 * else in there. Not the knowledge store, not shared with another artifact.
 */
export const ARTIFACT_DB_FILE = "data.sqlite";
/**
 * What an app's data may grow to. SQLite is left to enforce it through
 * `max_page_count`, so the write that would cross it fails loudly rather than the
 * file growing until the disk notices.
 */
export const MAX_ARTIFACT_DB_BYTES = 16 * 1024 * 1024;
export const MAX_ARTIFACT_SQL_CHARS = 8 * 1024;
export const MAX_ARTIFACT_SQL_PARAMS = 64;
/** One screen of an app's own data. Past this the query wanted a LIMIT, and is told so. */
export const MAX_ARTIFACT_ROWS = 2000;
/** Beside the entry document. Past this it is a project, not an artifact. */
export const MAX_ARTIFACT_FILES = 16;

/**
 * What an app may hold beside its entry document, and what each is served as.
 * The map is the allowlist: an extension that is not in here is not a file an
 * artifact can have. Nothing executable by the OS, and nothing binary.
 */
export const ARTIFACT_FILE_TYPES: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  html: "text/html; charset=utf-8",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
};

/**
 * True for a name an app may keep beside its entry document. The stem carries no
 * dot and no slash, so there is no `..` and no path to walk out of the folder, and
 * the three names the folder already owns are refused outright.
 *
 * It doubles as the filter that lists an app's files, so a temp file, `meta.json`
 * and the database are excluded by the same rule that refuses to write them.
 */
export function validArtifactFile(value: unknown): value is string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}\.[a-z0-9]{1,8}$/.test(value)) return false;
  if (value === ARTIFACT_DB_FILE || value === "meta.json" || value.startsWith("content.")) return false;
  return Object.hasOwn(ARTIFACT_FILE_TYPES, value.slice(value.indexOf(".") + 1));
}

export const artifactFileType = (file: string) => ARTIFACT_FILE_TYPES[file.slice(file.indexOf(".") + 1)] ?? "text/plain; charset=utf-8";

export interface ArtifactMeta {
  id: string;
  title: string;
  kind: ArtifactKind;
  /** Highlighting hint for `code`, and the fence language when it is quoted. Empty otherwise. */
  language: string;
  createdAt: string;
  updatedAt: string;
  /** Bumped on every write, so the card can say how many times it has been revised. */
  version: number;
  /** Where it is mounted inside Emma, when it is. Only a page can be. */
  surface?: ArtifactSurface;
  /** The thread that made it, so "open where this came from" is one click. */
  sourceThreadId?: string;
  /** The scheduled task that last wrote it, when a task did. */
  sourceJobId?: string;
}

export interface Artifact extends ArtifactMeta {
  content: string;
  /** Absolute path of the content file, for Reveal in Finder. */
  path: string;
}

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === "string" && (ARTIFACT_KINDS as readonly string[]).includes(value);
}

/**
 * The id an artifact is addressed by, everywhere: the model names one in a tool
 * call, the folder is named after it, the renderer keys off it. A slug of the
 * title so the folder is readable, uniqueness settled by the caller.
 */
export function artifactSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return slug || "artifact";
}

/** True for an id that may name a directory. Anything else is refused before any I/O. */
export function validArtifactId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value);
}

/**
 * The scheme an `html` or `app` artifact is framed from, and why it is not `srcDoc`.
 *
 * A srcdoc document inherits the embedder's content policy, and the workspace's
 * is `script-src 'self'` — so an interactive page would render and quietly never
 * run. A real response carries its own policy instead: main serves the artifact
 * with inline script allowed and no network at all, and the frame is still
 * sandboxed to an opaque origin on the renderer's side.
 *
 * An `app` keeps that posture exactly. It gets two things a page does not, and
 * neither is a way out: its own files, served from its own folder under its own
 * host — `emma-artifact://<id>` is named in its policy, so it may load its own
 * `app.js` and no other artifact's — and `emma.sql`, which is `postMessage` to
 * Emma and back, never a socket. Still `default-src 'none'`, still no network.
 * A self-contained app stays self-contained.
 */
/**
 * How a tool result says which artifact it just wrote. Every mutating action ends
 * its first line with this and the transcript reads it back off the step to draw
 * the card — on a create the id is chosen in main, so there is no other way for
 * the renderer to learn it. Both halves are here so the two cannot drift apart.
 */
export const artifactMarker = (id: string) => `[artifact:${id}]`;
/**
 * Anchored to the start, and the result string leads with it, because the
 * harness reports only the first 200 bytes of a tool's output — a marker at the
 * end of the sentence falls off the cut behind a long title, and titles run to
 * `MAX_ARTIFACT_TITLE_CHARS`. First is the one position that always survives.
 */
export const ARTIFACT_MARKER = /^\[artifact:([a-z0-9-]+)]/;

/**
 * The artifact a finished tool call wrote, read back off the step.
 *
 * The marker is the whole test. `kind` is deliberately not consulted: on the
 * harness it is ACP's nine-value category, so an `artifact` call arrives as
 * `other` and a check for the tool's name there drew no card at all. The output
 * is the one channel both loops carry — which is what this token is for.
 */
export function artifactWritten(step: { status: string; output?: string }): string | undefined {
  if (step.status !== "completed") return undefined;
  return ARTIFACT_MARKER.exec((step.output ?? "").trimStart())?.[1];
}

export const ARTIFACT_SCHEME = "emma-artifact";
/** The version is in the URL only so a rewrite cannot be served from the frame's cache. */
export const artifactFrameUrl = (id: string, version: number) => `${ARTIFACT_SCHEME}://${id}/?v=${version}`;
