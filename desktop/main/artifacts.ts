import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { ARTIFACT_DB_FILE, ARTIFACT_EXTENSIONS, ARTIFACT_FILE_TYPES, ARTIFACT_KINDS, ARTIFACT_SURFACES, artifactSlug, isArtifactKind, isArtifactSurface, MAX_ARTIFACT_BYTES, MAX_ARTIFACT_DB_BYTES, MAX_ARTIFACT_FILES, MAX_ARTIFACT_ROWS, MAX_ARTIFACT_SQL_CHARS, MAX_ARTIFACT_SQL_PARAMS, MAX_ARTIFACT_TITLE_CHARS, MAX_ARTIFACTS, mountable, validArtifactFile, validArtifactId, type Artifact, type ArtifactKind, type ArtifactMeta } from "../shared/artifacts";
import { writeAtomic } from "./write-atomic";

export function artifactRoot(userData: string): string {
  return path.join(userData, "artifacts");
}

export type ArtifactInput = {
  id?: string;
  title: string;
  kind: string;
  language?: string;
  content: string;

  surface?: string;
  sourceThreadId?: string;
  sourceJobId?: string;
};

function artifactDirectory(userData: string, id: unknown): string {
  if (!validArtifactId(id)) throw new Error(`"${String(id).slice(0, 64)}" is not an artifact id. Ids are lowercase letters, digits and dashes — list the artifacts to see them.`);
  const root = path.resolve(artifactRoot(userData));
  const resolved = path.resolve(root, id);
  if (path.dirname(resolved) !== root) throw new Error("That artifact id is outside the artifacts folder.");
  return resolved;
}

const contentPath = (directory: string, kind: ArtifactKind) => path.join(directory, `content.${ARTIFACT_EXTENSIONS[kind]}`);

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

    surface: isArtifactSurface(raw.surface) && mountable(raw.kind) ? raw.surface : undefined,
    sourceThreadId: typeof raw.sourceThreadId === "string" ? raw.sourceThreadId.slice(0, 96) : undefined,
    sourceJobId: typeof raw.sourceJobId === "string" ? raw.sourceJobId.slice(0, 96) : undefined,
  };
}

const readMeta = async (directory: string, id: string) => parseMeta(id, JSON.parse(await readBounded(path.join(directory, "meta.json"), 16 * 1024)));

export async function listArtifacts(userData: string): Promise<ArtifactMeta[]> {
  const root = artifactRoot(userData);
  let entries: string[];
  try { entries = (await readdir(root)).slice(0, MAX_ARTIFACTS); } catch { return []; }
  const found: ArtifactMeta[] = [];
  for (const id of entries) {
    try { found.push(await readMeta(artifactDirectory(userData, id), id)); } catch { continue; }
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

export async function writeArtifact(userData: string, input: ArtifactInput): Promise<Artifact> {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title || title.length > MAX_ARTIFACT_TITLE_CHARS) throw new Error(`An artifact needs a title of 1 to ${MAX_ARTIFACT_TITLE_CHARS} characters.`);
  if (!isArtifactKind(input.kind)) throw new Error(`"${String(input.kind).slice(0, 32)}" is not an artifact kind. Use one of ${ARTIFACT_KINDS.join(", ")}.`);
  if (typeof input.content !== "string") throw new Error("An artifact's content must be a string.");
  if (Buffer.byteLength(input.content, "utf8") > MAX_ARTIFACT_BYTES) throw new Error(`That is larger than ${Math.round(MAX_ARTIFACT_BYTES / 1024)}K — past this it is a dataset rather than something to read. Write it into a file in the project instead.`);
  const root = artifactRoot(userData);
  const taken = (await readdir(root).catch(() => [])).slice(0, MAX_ARTIFACTS + 1);
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

  if (previous && previous.kind !== meta.kind) await rm(contentPath(directory, previous.kind), { force: true });
  const file = contentPath(directory, meta.kind);
  await writeAtomic(file, input.content);
  await writeAtomic(path.join(directory, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  return { ...meta, content: input.content, path: file };
}

async function surfaceFor(userData: string, id: string, input: ArtifactInput, previous?: ArtifactMeta) {
  const kind = input.kind as ArtifactKind;
  const asked = input.surface;
  if (asked === undefined) return mountable(kind) ? previous?.surface : undefined;
  if (asked === "none" || asked === "") return undefined;
  if (!isArtifactSurface(asked)) throw new Error(`"${String(asked).slice(0, 32)}" is not a region of Emma's interface. Use one of ${ARTIFACT_SURFACES.join(", ")}, or "none" to hand the region back to the built-in.`);
  if (!mountable(kind)) throw new Error(`A ${kind} artifact does not run, so it cannot be a region. A region is kind "code", language "js": one module that default-exports the factory.`);
  if (asked === previous?.surface) return asked;

  const held = (await listArtifacts(userData)).find((item) => item.surface === asked && item.id !== id);
  if (held) throw new Error(`The ${asked} is already "${held.title}" (${held.id}). Rewrite that one, or take it out with surface "none" before mounting this.`);
  return asked;
}

export async function updateArtifact(userData: string, id: string, oldStr: string, newStr: string): Promise<Artifact> {
  const artifact = await readArtifact(userData, id);
  const content = replaceOnce(artifact.content, oldStr, newStr, id);
  return await writeArtifact(userData, { id, title: artifact.title, kind: artifact.kind, language: artifact.language, content });
}

export async function updateArtifactFile(userData: string, id: string, file: string, oldStr: string, newStr: string): Promise<Artifact> {
  const before = await readArtifactFile(userData, id, file);
  return await writeArtifactFile(userData, id, file, replaceOnce(before, oldStr, newStr, `${file} in ${id}`));
}

function replaceOnce(content: string, oldStr: string, newStr: string, where: string): string {
  if (typeof oldStr !== "string" || !oldStr) throw new Error('The "old_str" argument must be the exact text to replace.');
  if (typeof newStr !== "string") throw new Error('The "new_str" argument must be a string.');
  const at: number[] = [];

  for (let found = content.indexOf(oldStr); found >= 0 && at.length < 16; found = content.indexOf(oldStr, found + 1)) at.push(found);
  if (!at.length) throw new Error(`No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${where}.`);
  if (at.length > 1) {
    const lines = at.map((index) => content.slice(0, index).split("\n").length);
    throw new Error(`No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines: ${lines.join(", ")}. Please ensure it is unique`);
  }
  return content.slice(0, at[0]) + newStr + content.slice(at[0] + oldStr.length);
}

export async function artifactFiles(userData: string, id: string): Promise<string[]> {
  const entries = await readdir(artifactDirectory(userData, id)).catch(() => []);
  return entries.filter((name) => validArtifactFile(name)).sort().slice(0, MAX_ARTIFACT_FILES);
}

export async function readArtifactFile(userData: string, id: string, file: string): Promise<string> {
  const found = artifactFilePath(userData, id, file);
  if (!await stat(found).catch(() => undefined)) throw new Error(`${id} has no file called "${file}".`);
  return await readBounded(found, MAX_ARTIFACT_BYTES);
}

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

export async function queryArtifact(userData: string, id: string, sql: unknown, params: unknown): Promise<Record<string, unknown>[]> {
  const artifact = await readArtifact(userData, id);
  if (artifact.kind !== "app") throw new Error(`${id} is a ${artifact.kind} artifact, so it has no database.`);
  if (typeof sql !== "string" || !sql.trim()) throw new Error("A query is one SQL statement.");
  if (sql.length > MAX_ARTIFACT_SQL_CHARS) throw new Error(`A statement is at most ${MAX_ARTIFACT_SQL_CHARS} characters.`);
  const bound = bindable(params);
  const database = new DatabaseSync(path.join(artifactDirectory(userData, id), ARTIFACT_DB_FILE));
  try {
    const pageSize = Number((database.prepare("pragma page_size").get() as { page_size?: number } | undefined)?.page_size) || 4096;
    database.prepare(`pragma max_page_count = ${Math.floor(MAX_ARTIFACT_DB_BYTES / pageSize)}`).run();
    database.setAuthorizer((action) => action === constants.SQLITE_ATTACH || action === constants.SQLITE_DETACH ? constants.SQLITE_DENY : constants.SQLITE_OK);
    const rows: Record<string, unknown>[] = [];
    for (const row of database.prepare(sql).iterate(...bound)) {
      if (rows.length >= MAX_ARTIFACT_ROWS) throw new Error(`That returned more than ${MAX_ARTIFACT_ROWS} rows. Add a LIMIT, or count in SQL rather than in the page.`);
      rows.push({ ...(row as Record<string, unknown>) });
    }
    return rows;
  } finally {
    database.close();
  }
}

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

export async function deleteArtifact(userData: string, id: string): Promise<void> {
  const directory = artifactDirectory(userData, id);
  if (!await stat(directory).catch(() => undefined)) throw new Error(`There is no artifact called "${id}". List them with artifact {"action":"list"}.`);
  await rm(directory, { recursive: true, force: true });
}

function unique(slug: string, taken: readonly string[]) {
  if (!taken.includes(slug)) return slug;
  const stem = slug.slice(0, 59).replace(/-+$/, "");
  for (let suffix = 2; suffix <= MAX_ARTIFACTS; suffix += 1) {
    if (!taken.includes(`${stem}-${suffix}`)) return `${stem}-${suffix}`;
  }
  throw new Error(`Emma already holds too many artifacts called "${slug}". Rewrite one of them instead.`);
}
