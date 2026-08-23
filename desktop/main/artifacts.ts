/* The artifacts folder: one directory per artifact under `<userData>/artifacts`,
 * holding `meta.json` and `content.<ext>` so the file opens in the right app when
 * the user reveals it in Finder. An `app` also keeps its own files beside those,
 * and its own `data.sqlite` — so a whole small application is one folder, and
 * removing the folder removes all of it.
 *
 * Nothing here is Electron. The tool dispatch, the IPC handlers and the tests all
 * run the same functions, which is what keeps the id checks in one place.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ARTIFACT_DB_FILE, ARTIFACT_EXTENSIONS, ARTIFACT_FILE_TYPES, ARTIFACT_KINDS, ARTIFACT_SURFACES, artifactSlug, isArtifactKind, isArtifactSurface, MAX_ARTIFACT_BYTES, MAX_ARTIFACT_DB_BYTES, MAX_ARTIFACT_FILES, MAX_ARTIFACT_ROWS, MAX_ARTIFACT_SQL_CHARS, MAX_ARTIFACT_SQL_PARAMS, MAX_ARTIFACT_TITLE_CHARS, MAX_ARTIFACTS, mountable, validArtifactFile, validArtifactId, type Artifact, type ArtifactKind, type ArtifactMeta } from "../shared/artifacts";

export function artifactRoot(userData: string): string {
  return path.join(userData, "artifacts");
}

export type ArtifactInput = {
  id?: string;
  title: string;
  kind: string;
  language?: string;
  content: string;
  /** A surface to mount into, `"none"` to take it back out, or nothing to leave it where it is. */
  surface?: string;
  sourceThreadId?: string;
  sourceJobId?: string;
};

/**
 * One artifact's directory, or a refusal.
 *
 * Two checks, as `resolveMemoryPath` has: the id shape rejects `../evil` and
 * `/etc/passwd` before any I/O, and the resolved-parent check is the belt to that
 * pair of braces — a later change to the id pattern cannot open a traversal here.
 */
function artifactDirectory(userData: string, id: unknown): string {
  if (!validArtifactId(id)) throw new Error(`"${String(id).slice(0, 64)}" is not an artifact id. Ids are lowercase letters, digits and dashes — list the artifacts to see them.`);
  const root = path.resolve(artifactRoot(userData));
  const resolved = path.resolve(root, id);
  if (path.dirname(resolved) !== root) throw new Error("That artifact id is outside the artifacts folder.");
  return resolved;
}

const contentPath = (directory: string, kind: ArtifactKind) => path.join(directory, `content.${ARTIFACT_EXTENSIONS[kind]}`);

/**
 * One file inside one artifact's folder, or a refusal.
 *
 * The same two checks the directory gets, for the same reason: the name reaches
 * here from a model's tool call and from a page's own `<script src>`, and
 * `validArtifactFile` allows no dot and no slash in the stem, so `../../` is not a
 * name at all. The resolved-parent check is the belt to that pair of braces.
 */
export function artifactFilePath(userData: string, id: string, file: unknown): string {
  const directory = artifactDirectory(userData, id);
  if (!validArtifactFile(file)) throw new Error(`"${String(file).slice(0, 64)}" is not a file an artifact can hold. Names are flat — app.js, style.css — and end in ${Object.keys(ARTIFACT_FILE_TYPES).join(", ")}.`);
  const resolved = path.resolve(directory, file);
  if (path.dirname(resolved) !== directory) throw new Error("That file is outside the artifact's folder.");
  return resolved;
}

async function readBounded(file: string, max: number) {
  const information = await stat(file);
  if (!information.isFile() || information.size > max) throw new Error(`${path.basename(file)} is too large to be an artifact.`);
  return await readFile(file, "utf8");
}

/// Every field is re-checked on the way back in: this folder is on the user's disk
/// and they are invited to edit what is in it, so a hand-mangled meta.json is a
/// case, not a crash.
function parseMeta(id: string, value: unknown): ArtifactMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Artifact metadata is invalid");
  const raw = value as Record<string, unknown>;
  if (typeof raw.title !== "string" || !raw.title.trim() || !isArtifactKind(raw.kind)) throw new Error("Artifact metadata is invalid");
  const stamp = (candidate: unknown) => typeof candidate === "string" && candidate.length <= 40 ? candidate : new Date(0).toISOString();
  return {
    id,
    title: raw.title.slice(0, MAX_ARTIFACT_TITLE_CHARS),
    kind: raw.kind,
    language: typeof raw.language === "string" ? raw.language.slice(0, 64) : "",
    createdAt: stamp(raw.createdAt),
    updatedAt: stamp(raw.updatedAt),
    version: typeof raw.version === "number" && Number.isSafeInteger(raw.version) && raw.version > 0 ? raw.version : 1,
    // A surface that is not one of Emma's regions is no surface: a hand-edited
    // meta.json cannot mount a page somewhere the renderer has no slot for.
    surface: isArtifactSurface(raw.surface) && mountable(raw.kind) ? raw.surface : undefined,
    sourceThreadId: typeof raw.sourceThreadId === "string" ? raw.sourceThreadId.slice(0, 96) : undefined,
    sourceJobId: typeof raw.sourceJobId === "string" ? raw.sourceJobId.slice(0, 96) : undefined,
  };
}

const readMeta = async (directory: string, id: string) => parseMeta(id, JSON.parse(await readBounded(path.join(directory, "meta.json"), 16 * 1024)));

/** Newest first, which is the order the page shows and the order the model reads. */
export async function listArtifacts(userData: string): Promise<ArtifactMeta[]> {
  const root = artifactRoot(userData);
  let entries: string[];
  try { entries = (await readdir(root)).slice(0, MAX_ARTIFACTS); } catch { return []; }
  const found: ArtifactMeta[] = [];
  for (const id of entries) {
    // A directory that is half-written or not an artifact at all is skipped: one
    // bad folder must not take the whole page down with it.
    try { found.push(await readMeta(artifactDirectory(userData, id), id)); } catch { /* not an artifact */ }
  }
  return found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readArtifact(userData: string, id: string): Promise<Artifact> {
  const directory = artifactDirectory(userData, id);
  const meta = await readMeta(directory, id).catch(() => undefined);
  if (!meta) throw new Error(`There is no artifact called "${id}". List them with artifact {"action":"list"}.`);
  const file = contentPath(directory, meta.kind);
  return { ...meta, content: await readBounded(file, MAX_ARTIFACT_BYTES), path: file };
}

/**
 * Creates an artifact, or rewrites one whole. `createdAt` survives a rewrite and
 * `version` counts them, so a card can say how many times it has been revised.
 */
export async function writeArtifact(userData: string, input: ArtifactInput): Promise<Artifact> {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title || title.length > MAX_ARTIFACT_TITLE_CHARS) throw new Error(`An artifact needs a title of 1 to ${MAX_ARTIFACT_TITLE_CHARS} characters.`);
  if (!isArtifactKind(input.kind)) throw new Error(`"${String(input.kind).slice(0, 32)}" is not an artifact kind. Use one of ${ARTIFACT_KINDS.join(", ")}.`);
  if (typeof input.content !== "string") throw new Error("An artifact's content must be a string.");
  if (Buffer.byteLength(input.content, "utf8") > MAX_ARTIFACT_BYTES) throw new Error(`That is larger than ${Math.round(MAX_ARTIFACT_BYTES / 1024)}K — past this it is a dataset rather than something to read. Write it into a file in the project instead.`);
  const root = artifactRoot(userData);
  let taken: string[] = [];
  try { taken = (await readdir(root)).slice(0, MAX_ARTIFACTS + 1); } catch { /* the first artifact makes the folder */ }
  const id = input.id ?? unique(artifactSlug(title), taken);
  const directory = artifactDirectory(userData, id);
  if (!taken.includes(id) && taken.length >= MAX_ARTIFACTS) throw new Error(`Emma already holds the maximum of ${MAX_ARTIFACTS} artifacts. Delete one before making another.`);
  const previous = await readMeta(directory, id).catch(() => undefined);
  const meta: ArtifactMeta = {
    id,
    title,
    kind: input.kind,
    language: input.language?.slice(0, 64) ?? previous?.language ?? "",
    createdAt: previous?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: (previous?.version ?? 0) + 1,
    surface: await surfaceFor(userData, id, input, previous),
    sourceThreadId: input.sourceThreadId ?? previous?.sourceThreadId,
    sourceJobId: input.sourceJobId ?? previous?.sourceJobId,
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // The extension follows the kind, so a rewrite that changes the kind would leave
  // the old file behind and Finder would open the stale one.
  if (previous && previous.kind !== meta.kind) await rm(contentPath(directory, previous.kind), { force: true });
  const file = contentPath(directory, meta.kind);
  await writeAtomic(file, input.content);
  await writeAtomic(path.join(directory, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  return { ...meta, content: input.content, path: file };
}

/**
 * Which region of Emma this write leaves the artifact running as.
 *
 * Sticky, so the rewrite that edits a live region does not silently unmount it —
 * `surface` is left out of every ordinary edit, and a navbar that fell back to the
 * built-in on its first fix would be a bug nobody could see the cause of. Saying
 * `"none"` is how it comes out, and turning the module into any other kind takes it
 * out too, because there is nothing left to run.
 */
async function surfaceFor(userData: string, id: string, input: ArtifactInput, previous?: ArtifactMeta) {
  const kind = input.kind as ArtifactKind;
  const asked = input.surface;
  if (asked === undefined) return mountable(kind) ? previous?.surface : undefined;
  if (asked === "none" || asked === "") return undefined;
  if (!isArtifactSurface(asked)) throw new Error(`"${String(asked).slice(0, 32)}" is not a region of Emma's interface. Use one of ${ARTIFACT_SURFACES.join(", ")}, or "none" to hand the region back to the built-in.`);
  if (!mountable(kind)) throw new Error(`A ${kind} artifact does not run, so it cannot be a region. A region is kind "code", language "js": one module that default-exports the factory.`);
  if (asked === previous?.surface) return asked;
  // One module per region, so the answer to "what is the navbar" is a single file.
  // Named rather than counted: the refusal has to say which artifact to rewrite.
  const held = (await listArtifacts(userData)).find((item) => item.surface === asked && item.id !== id);
  if (held) throw new Error(`The ${asked} is already "${held.title}" (${held.id}). Rewrite that one, or take it out with surface "none" before mounting this.`);
  return asked;
}

/**
 * One targeted replacement, the same contract `str_replace` has in `memory.ts`.
 *
 * Loud on both failures on purpose: a silent no-op leaves the model believing an
 * edit landed and carrying on from a version of the artifact that never existed.
 */
export async function updateArtifact(userData: string, id: string, oldStr: string, newStr: string): Promise<Artifact> {
  const artifact = await readArtifact(userData, id);
  const content = replaceOnce(artifact.content, oldStr, newStr, id);
  return await writeArtifact(userData, { id, title: artifact.title, kind: artifact.kind, language: artifact.language, content });
}

/** The same one replacement, against one of an app's own files. */
export async function updateArtifactFile(userData: string, id: string, file: string, oldStr: string, newStr: string): Promise<Artifact> {
  const before = await readArtifactFile(userData, id, file);
  return await writeArtifactFile(userData, id, file, replaceOnce(before, oldStr, newStr, `${file} in ${id}`));
}

/** The replacement itself, so the entry document and an app's files cannot drift
    into two ideas of what a failed edit says. */
function replaceOnce(content: string, oldStr: string, newStr: string, where: string): string {
  if (typeof oldStr !== "string" || !oldStr) throw new Error('The "old_str" argument must be the exact text to replace.');
  if (typeof newStr !== "string") throw new Error('The "new_str" argument must be a string.');
  const at: number[] = [];
  // Capped: a one-character old_str against half a megabyte has nothing useful to
  // report past the first handful of line numbers.
  for (let found = content.indexOf(oldStr); found >= 0 && at.length < 16; found = content.indexOf(oldStr, found + 1)) at.push(found);
  if (!at.length) throw new Error(`No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${where}.`);
  if (at.length > 1) {
    const lines = at.map((index) => content.slice(0, index).split("\n").length);
    throw new Error(`No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines: ${lines.join(", ")}. Please ensure it is unique`);
  }
  return content.slice(0, at[0]) + newStr + content.slice(at[0] + oldStr.length);
}

/** The files an app keeps beside its entry document. `validArtifactFile` is the
    filter, so `meta.json`, the entry, the database and any temp file are out by
    the same rule that refuses to write them. */
export async function artifactFiles(userData: string, id: string): Promise<string[]> {
  const entries = await readdir(artifactDirectory(userData, id)).catch(() => []);
  return entries.filter((name) => validArtifactFile(name)).sort().slice(0, MAX_ARTIFACT_FILES);
}

export async function readArtifactFile(userData: string, id: string, file: string): Promise<string> {
  const found = artifactFilePath(userData, id, file);
  if (!await stat(found).catch(() => undefined)) throw new Error(`${id} has no file called "${file}".`);
  return await readBounded(found, MAX_ARTIFACT_BYTES);
}

/**
 * A file beside the entry document — an app is several of them.
 *
 * The artifact has to exist first: a file with no artifact to belong to is an
 * orphan the folder would never clean up. The version is bumped by rewriting the
 * entry through `writeArtifact`, because the frame's URL is keyed on it — a
 * changed `app.js` under an unchanged version is served from the frame's cache.
 */
export async function writeArtifactFile(userData: string, id: string, file: string, content: string): Promise<Artifact> {
  const artifact = await readArtifact(userData, id);
  if (artifact.kind !== "app") throw new Error(`${id} is a ${artifact.kind} artifact, which is one file. Only an app holds files beside it.`);
  const found = artifactFilePath(userData, id, file);
  if (typeof content !== "string") throw new Error("An artifact file's content must be a string.");
  if (Buffer.byteLength(content, "utf8") > MAX_ARTIFACT_BYTES) throw new Error(`That is larger than ${Math.round(MAX_ARTIFACT_BYTES / 1024)}K — split it, or keep the data in the app's database rather than its source.`);
  const held = await artifactFiles(userData, id);
  if (!held.includes(file) && held.length >= MAX_ARTIFACT_FILES) throw new Error(`${id} already holds ${MAX_ARTIFACT_FILES} files. Rewrite one of them instead.`);
  await writeAtomic(found, content);
  return await writeArtifact(userData, { id, title: artifact.title, kind: artifact.kind, language: artifact.language, content: artifact.content });
}

/**
 * One statement against one app's own database, and the whole of what a page can
 * reach out and do.
 *
 * This is the trust boundary: the artifact's code is model-written and runs in a
 * sandboxed frame with no network, so the id arrives from the renderer's own
 * component and is checked here as every other id is, the file is fixed at
 * `data.sqlite` inside that one folder, and the kind has to be `app` — no other
 * artifact grows a database behind the user's back. The statement itself is the
 * app's business: it owns every row in there and nobody else's.
 *
 * ponytail: opened per query and closed after, so there is no handle to leak and
 * none held open across a delete. Keep one open per artifact if a chart of ten
 * thousand rows ever feels slow.
 */
export async function queryArtifact(userData: string, id: string, sql: unknown, params: unknown): Promise<Record<string, unknown>[]> {
  const artifact = await readArtifact(userData, id);
  if (artifact.kind !== "app") throw new Error(`${id} is a ${artifact.kind} artifact, so it has no database.`);
  if (typeof sql !== "string" || !sql.trim()) throw new Error("A query is one SQL statement.");
  if (sql.length > MAX_ARTIFACT_SQL_CHARS) throw new Error(`A statement is at most ${MAX_ARTIFACT_SQL_CHARS} characters.`);
  const bound = bindable(params);
  const database = new DatabaseSync(path.join(artifactDirectory(userData, id), ARTIFACT_DB_FILE));
  try {
    // SQLite's own ceiling, in its own pages, so the write that would cross it comes
    // back as "database or disk is full" instead of the file quietly growing.
    const pageSize = Number((database.prepare("pragma page_size").get() as { page_size?: number } | undefined)?.page_size) || 4096;
    database.prepare(`pragma max_page_count = ${Math.floor(MAX_ARTIFACT_DB_BYTES / pageSize)}`).run();
    const rows: Record<string, unknown>[] = [];
    // Iterated rather than collected: `all()` would build the whole result in memory
    // before there was anything to refuse, which is the case the cap is here for.
    for (const row of database.prepare(sql).iterate(...bound)) {
      if (rows.length >= MAX_ARTIFACT_ROWS) throw new Error(`That returned more than ${MAX_ARTIFACT_ROWS} rows. Add a LIMIT, or count in SQL rather than in the page.`);
      // Copied onto an ordinary object: node:sqlite hands back null-prototype rows,
      // and the structured clone that carries them to the frame would not, so main
      // and the page would otherwise be looking at two different shapes.
      rows.push({ ...(row as Record<string, unknown>) });
    }
    return rows;
  } finally {
    database.close();
  }
}

/** What SQLite can be handed. A boolean is the one coercion: an app writes `true`,
    and SQLite has no boolean, so it stores what SQL means by one. */
function bindable(value: unknown): (null | number | string)[] {
  if (value !== undefined && !Array.isArray(value)) throw new Error("A query's parameters are an array.");
  const params = (value ?? []) as unknown[];
  if (params.length > MAX_ARTIFACT_SQL_PARAMS) throw new Error(`A statement takes at most ${MAX_ARTIFACT_SQL_PARAMS} parameters.`);
  return params.map((param, at) => {
    if (param === null || param === undefined) return null;
    if (typeof param === "boolean") return param ? 1 : 0;
    if (typeof param === "number" && Number.isFinite(param)) return param;
    if (typeof param === "string" && Buffer.byteLength(param, "utf8") <= MAX_ARTIFACT_BYTES) return param;
    throw new Error(`Parameter ${at + 1} is not something SQLite stores. Pass a string, a number, a boolean or null.`);
  });
}

/** The folder goes, so the database goes with it. An app's data outlives every
    conversation that touched it and nothing else — there is no orphan to sweep. */
export async function deleteArtifact(userData: string, id: string): Promise<void> {
  const directory = artifactDirectory(userData, id);
  if (!await stat(directory).catch(() => undefined)) throw new Error(`There is no artifact called "${id}". List them with artifact {"action":"list"}.`);
  await rm(directory, { recursive: true, force: true });
}

/** `flight-tracker`, then `flight-tracker-2`: the id is read by people, so it stays a slug. */
function unique(slug: string, taken: readonly string[]) {
  if (!taken.includes(slug)) return slug;
  const stem = slug.slice(0, 59).replace(/-+$/, "");
  for (let suffix = 2; suffix <= MAX_ARTIFACTS; suffix += 1) {
    if (!taken.includes(`${stem}-${suffix}`)) return `${stem}-${suffix}`;
  }
  throw new Error(`Emma already holds too many artifacts called "${slug}". Rewrite one of them instead.`);
}

/// Rename rather than write in place: an artifact being rewritten while the page
/// has it open must not become half a document mid-read.
async function writeAtomic(file: string, content: string) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
