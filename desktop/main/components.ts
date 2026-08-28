import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { COMPONENT_SHOT_PATH, componentSlug, MAX_COMPONENT_CHARS, MAX_COMPONENT_SHOT_BYTES, MAX_COMPONENT_TITLE_CHARS, MAX_COMPONENTS, parseVariables, validComponentId, type BuiltComponent, type ComponentMeta, type ComponentRequest } from "../shared/components";

export const componentRoot = (userData: string) => path.join(userData, "components");

export type ComponentInput = {
  id?: string;
  title: string;
  code: string;
  expands?: boolean;
  variables?: string[];
  sourceThreadId?: string;
};

function componentDirectory(userData: string, id: unknown): string {
  if (!validComponentId(id)) throw new Error(`"${String(id).slice(0, 64)}" is not a component id. List them with component {"action":"list"}.`);
  const root = path.resolve(componentRoot(userData));
  const resolved = path.resolve(root, id);
  if (path.dirname(resolved) !== root) throw new Error("That component id is outside the components folder.");
  return resolved;
}

const modulePath = (directory: string) => path.join(directory, "module.js");
const shotPath = (directory: string) => path.join(directory, COMPONENT_SHOT_PATH);

function parseMeta(id: string, value: unknown): ComponentMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Component metadata is invalid");
  const raw = value as Record<string, unknown>;
  if (typeof raw.title !== "string" || !raw.title.trim()) throw new Error("Component metadata is invalid");
  const stamp = (candidate: unknown) => typeof candidate === "string" && candidate.length <= 40 ? candidate : new Date(0).toISOString();
  const variables = (() => { try { return parseVariables(raw.variables); } catch { return []; } })();
  return {
    id,
    title: raw.title.slice(0, MAX_COMPONENT_TITLE_CHARS),
    createdAt: stamp(raw.createdAt),
    updatedAt: stamp(raw.updatedAt),
    version: typeof raw.version === "number" && Number.isSafeInteger(raw.version) && raw.version > 0 ? raw.version : 1,
    expands: raw.expands === true ? true : undefined,
    variables: variables.length ? variables : undefined,
    disabled: raw.disabled === true ? true : undefined,
    sourceThreadId: typeof raw.sourceThreadId === "string" ? raw.sourceThreadId.slice(0, 96) : undefined,
  };
}

async function readMeta(directory: string, id: string): Promise<ComponentMeta> {
  const file = path.join(directory, "meta.json");
  const information = await stat(file);
  if (!information.isFile() || information.size > 16 * 1024) throw new Error("Component metadata is invalid");
  return parseMeta(id, JSON.parse(await readFile(file, "utf8")));
}

export async function listComponents(userData: string): Promise<ComponentMeta[]> {
  let entries: string[];
  try { entries = (await readdir(componentRoot(userData))).slice(0, MAX_COMPONENTS); } catch { return []; }
  const found: ComponentMeta[] = [];
  for (const id of entries) {
    try { found.push(await readMeta(componentDirectory(userData, id), id)); } catch { /* not a component */ }
  }
  return found.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function readComponent(userData: string, id: string): Promise<BuiltComponent> {
  const directory = componentDirectory(userData, id);
  const meta = await readMeta(directory, id).catch(() => undefined);
  if (!meta) throw new Error(`There is no component called "${id}". List them with component {"action":"list"}.`);
  return { ...meta, code: await readFile(modulePath(directory), "utf8") };
}

export async function writeComponent(userData: string, input: ComponentInput): Promise<BuiltComponent> {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title || title.length > MAX_COMPONENT_TITLE_CHARS) throw new Error(`A component needs a title of 1 to ${MAX_COMPONENT_TITLE_CHARS} characters — what the user would call it.`);
  if (typeof input.code !== "string" || !input.code.trim()) throw new Error('"code" is the module: export default (api) => Component.');
  if (Buffer.byteLength(input.code, "utf8") > MAX_COMPONENT_CHARS) throw new Error(`A component is at most ${Math.round(MAX_COMPONENT_CHARS / 1024)}K of source. Split what it does, or make it an artifact instead.`);
  const root = componentRoot(userData);
  let taken: string[] = [];
  try { taken = (await readdir(root)).slice(0, MAX_COMPONENTS + 1); } catch { /* the first component makes the folder */ }
  const id = input.id ?? unique(componentSlug(title), taken);
  const directory = componentDirectory(userData, id);
  if (!taken.includes(id) && taken.length >= MAX_COMPONENTS) throw new Error(`Emma already holds the maximum of ${MAX_COMPONENTS} components. The user deletes one from its ⋯ menu.`);
  const previous = await readMeta(directory, id).catch(() => undefined);
  const variables = input.variables === undefined ? previous?.variables : parseVariables(input.variables);
  const meta: ComponentMeta = {
    id,
    title,
    createdAt: previous?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: (previous?.version ?? 0) + 1,
    expands: (input.expands ?? previous?.expands) === true ? true : undefined,
    variables: variables?.length ? variables : undefined,
    disabled: previous?.disabled,
    sourceThreadId: input.sourceThreadId ?? previous?.sourceThreadId,
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeAtomic(modulePath(directory), input.code);
  await writeAtomic(path.join(directory, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  return { ...meta, code: input.code };
}

export async function setComponentEnabled(userData: string, id: string, enabled: boolean): Promise<ComponentMeta> {
  const directory = componentDirectory(userData, id);
  const meta = await readMeta(directory, id).catch(() => undefined);
  if (!meta) throw new Error(`There is no component called "${id}".`);
  const next: ComponentMeta = { ...meta, disabled: enabled ? undefined : true };
  await writeAtomic(path.join(directory, "meta.json"), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export async function setComponentExpands(userData: string, id: string, expands: boolean): Promise<ComponentMeta> {
  const directory = componentDirectory(userData, id);
  const meta = await readMeta(directory, id).catch(() => undefined);
  if (!meta) throw new Error(`There is no component called "${id}".`);
  const next: ComponentMeta = { ...meta, expands: expands ? true : undefined, updatedAt: new Date().toISOString() };
  await writeAtomic(path.join(directory, "meta.json"), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export async function readComponentShot(userData: string, id: string): Promise<Buffer> {
  const file = shotPath(componentDirectory(userData, id));
  const information = await stat(file);
  if (!information.isFile() || information.size > MAX_COMPONENT_SHOT_BYTES) throw new Error("That component has no picture.");
  return await readFile(file);
}

export async function writeComponentShot(userData: string, id: string, png: Buffer): Promise<void> {
  const directory = componentDirectory(userData, id);
  if (!await stat(directory).catch(() => undefined)) throw new Error(`There is no component called "${id}".`);
  if (png.byteLength > MAX_COMPONENT_SHOT_BYTES) throw new Error("That picture is too large to keep.");
  const temporary = path.join(directory, `.${COMPONENT_SHOT_PATH}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, png, { mode: 0o600 });
    await rename(temporary, shotPath(directory));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function deleteComponent(userData: string, id: string): Promise<ComponentMeta> {
  const directory = componentDirectory(userData, id);
  const meta = await readMeta(directory, id).catch(() => undefined);
  if (!meta) throw new Error(`There is no component called "${id}".`);
  await rm(directory, { recursive: true, force: true });
  return meta;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export function componentCall(meta: ComponentMeta, request: unknown, secrets: NodeJS.ProcessEnv): { url: string; method: string; headers: Record<string, string>; body?: string } {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("A component request is { url, method, headers, body }.");
  const raw = request as ComponentRequest;
  const declared = meta.variables ?? [];
  const fill = (value: string, where: string) => value.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,63})\s*}}/g, (_, name: string) => {
    if (!declared.includes(name)) throw new Error(`${meta.title} did not ask for ${name}. A component may only use the variables it declared: ${declared.join(", ") || "none"}.`);
    const secret = secrets[name];
    if (!secret) throw new Error(`${name} is not set. Open Settings → Built by Emma, find ${meta.title}, and fill it in — until then ${where} cannot be sent.`);
    return secret;
  });
  const method = typeof raw.method === "string" ? raw.method.toUpperCase() : "GET";
  if (!METHODS.includes(method)) throw new Error(`A component may send ${METHODS.join(", ")}, not ${method.slice(0, 12)}.`);
  if (typeof raw.url !== "string" || !raw.url.trim()) throw new Error("A component request needs a url.");
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw.headers ?? {})) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || typeof value !== "string") throw new Error(`"${name.slice(0, 24)}" is not a header name.`);
    headers[name] = fill(value, "that header");
  }
  const body = typeof raw.body === "string" ? fill(raw.body, "that body") : undefined;
  return { url: fill(raw.url.trim(), "that url"), method, headers, ...(body === undefined ? {} : { body }) };
}

function unique(slug: string, taken: readonly string[]) {
  if (!taken.includes(slug)) return slug;
  const stem = slug.slice(0, 43).replace(/-+$/, "");
  for (let suffix = 2; suffix <= MAX_COMPONENTS; suffix += 1) {
    if (!taken.includes(`${stem}-${suffix}`)) return `${stem}-${suffix}`;
  }
  throw new Error(`Emma already holds too many components called "${slug}". Rewrite one of them instead.`);
}

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
