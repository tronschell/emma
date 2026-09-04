import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { validateHeaderValue } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import path from "node:path";
import { COMPONENT_FETCH_TIMEOUT_MS, COMPONENT_SHOT_PATH, componentSlug, MAX_COMPONENT_CHARS, MAX_COMPONENT_FETCH_BYTES, MAX_COMPONENT_REQUEST_BYTES, MAX_COMPONENT_SHOT_BYTES, MAX_COMPONENT_TITLE_CHARS, MAX_COMPONENTS, parseVariables, validComponentId, type BuiltComponent, type ComponentMeta } from "../shared/components";
import { publicAddress, publicUrl } from "./ipc";
import { writeAtomic } from "./write-atomic";

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
    try { found.push(await readMeta(componentDirectory(userData, id), id)); } catch { continue; }
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
  const taken = (await readdir(root).catch(() => [])).slice(0, MAX_COMPONENTS + 1);
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
  const next: ComponentMeta = { ...meta, disabled: enabled ? undefined : true, updatedAt: new Date().toISOString() };
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
const COMPONENT_VARIABLE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,63})\s*}}/g;
const NETWORK_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "accept-encoding", "proxy-authorization", "proxy-connection", "upgrade", "te", "trailer"]);
type ComponentCall = { url: string; method: string; headers: Record<string, string>; body?: string; variables: string[] };
type ComponentResponse = { status: number; ok: boolean; body: string };

export function componentCall(meta: ComponentMeta, request: unknown): ComponentCall {
  if (meta.disabled) throw new Error("This component is switched off.");
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("A component request is { url, method, headers, body }.");
  const raw = request as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["url", "method", "headers", "body"].includes(key))) throw new Error("Unexpected component request field.");
  if (typeof raw.url !== "string" || !raw.url.trim() || Buffer.byteLength(raw.url) > 2048) throw new Error("A component request needs a bounded URL.");
  if (raw.url.includes("{{")) throw new Error("Component URLs cannot contain credential placeholders; use headers or the body.");
  const url = publicUrl(raw.url.trim());
  if (!url || url.protocol !== "https:") throw new Error("A component reaches public HTTPS addresses without URL credentials only.");
  url.hash = "";
  if (raw.method !== undefined && typeof raw.method !== "string") throw new Error("A component method must be a string.");
  const method = typeof raw.method === "string" ? raw.method.toUpperCase() : "GET";
  if (!METHODS.includes(method)) throw new Error(`A component may send ${METHODS.join(", ")}.`);
  const declared = meta.variables ?? [];
  const variables = new Set<string>();
  const checkVariables = (value: string) => {
    const remainder = value.replace(COMPONENT_VARIABLE, (_, name: string) => {
      if (!declared.includes(name)) throw new Error(`This component did not ask for ${name}.`);
      variables.add(name);
      return "";
    });
    if (remainder.includes("{{")) throw new Error("Component variables must use {{NAME}} placeholders.");
  };
  if (raw.headers !== undefined && (!raw.headers || typeof raw.headers !== "object" || Array.isArray(raw.headers))) throw new Error("Component headers must be an object.");
  const entries = Object.entries(raw.headers ?? {});
  if (entries.length > 32) throw new Error("A component request has too many headers.");
  const headers: Record<string, string> = {};
  for (const [name, value] of entries.sort(([left], [right]) => left.toLowerCase().localeCompare(right.toLowerCase()))) {
    const lower = name.toLowerCase();
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || NETWORK_HEADERS.has(lower) || Object.hasOwn(headers, lower) || typeof value !== "string" || Buffer.byteLength(value) > MAX_COMPONENT_REQUEST_BYTES) throw new Error("A component header is invalid or reserved for the network client.");
    try { validateHeaderValue(name, value); } catch { throw new Error("A component header value is invalid."); }
    checkVariables(value);
    headers[lower] = value;
  }
  if (raw.body !== undefined && (typeof raw.body !== "string" || method === "GET" || Buffer.byteLength(raw.body) > MAX_COMPONENT_REQUEST_BYTES)) throw new Error("A component body must be bounded text on a non-GET request.");
  const body = raw.body as string | undefined;
  if (body !== undefined) checkVariables(body);
  const call = { url: url.href, method, headers, ...(body === undefined ? {} : { body }), variables: [...variables].sort() };
  if (Buffer.byteLength(JSON.stringify(call)) > MAX_COMPONENT_REQUEST_BYTES) throw new Error("A component request is at most 8 KiB.");
  return call;
}

export const componentLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true }, (error, addresses) => {
    if (error || !addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
      callback(new Error("Component destination must resolve only to public addresses."), "");
      return;
    }
    const family = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
    const usable = addresses.filter((address) => !family || address.family === family);
    if (!usable.length) { callback(new Error("Component destination has no usable public address."), ""); return; }
    if (options.all) callback(null, usable);
    else callback(null, usable[0].address, usable[0].family);
  });
};

function componentCredentials(call: ComponentCall, secrets: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(call.variables.map((name) => {
    const value = Object.hasOwn(secrets, name) ? secrets[name] : undefined;
    if (typeof value !== "string" || !value || Buffer.byteLength(value) > MAX_COMPONENT_REQUEST_BYTES) throw new Error(`${name} is missing or too large. Open Settings → Built by Emma to set it.`);
    return [name, value];
  }));
}

function componentGrant(userData: string, meta: BuiltComponent, call: ComponentCall, credentials: Record<string, string>): string {
  return createHash("sha256").update(JSON.stringify([userData, meta, call, credentials])).digest("hex");
}

export class ComponentRequests {
  private grants = new Map<string, boolean>();

  async fetch(userData: string, id: string, request: unknown, secrets: NodeJS.ProcessEnv, approve: (meta: ComponentMeta, call: ComponentCall) => Promise<boolean>): Promise<ComponentResponse> {
    const meta = await readComponent(userData, id);
    const template = componentCall(meta, request);
    const credentials = componentCredentials(template, secrets);
    const fill = (value: string) => value.replace(COMPONENT_VARIABLE, (_, name: string) => credentials[name]);
    const headers = Object.fromEntries(Object.entries(template.headers).map(([name, value]) => [name, fill(value)]));
    const call = { ...template, headers, ...(template.body === undefined ? {} : { body: fill(template.body) }) };
    try { for (const [name, value] of Object.entries(headers)) validateHeaderValue(name, value); }
    catch { throw new Error("A component credential cannot be sent in that header."); }
    if (Buffer.byteLength(JSON.stringify(call)) > MAX_COMPONENT_REQUEST_BYTES) throw new Error("The expanded component request exceeds 8 KiB.");
    if (template.variables.length) {
      const key = componentGrant(userData, meta, template, credentials);
      let granted = this.grants.get(key);
      if (granted === undefined) {
        granted = await Promise.resolve().then(() => approve(meta, template)).catch(() => false);
        if (this.grants.size >= 256) this.grants.delete(this.grants.keys().next().value!);
        this.grants.set(key, granted);
      }
      if (!granted) throw new Error("This credential-bearing component request was not approved.");
      const current = await readComponent(userData, id);
      if (current.disabled || componentGrant(userData, current, template, componentCredentials(template, secrets)) !== key) throw new Error("The component or credentials changed while approval was pending. Request again for a new approval.");
    }
    return await sendComponentRequest(call, Object.values(credentials));
  }
}

function sendComponentRequest(call: ComponentCall, credentials: string[]): Promise<ComponentResponse> {
  return new Promise((resolve, reject) => {
    const failed = () => reject(new Error("Component request failed. Check the public HTTPS endpoint."));
    try {
      const outgoing = httpsRequest(call.url, {
        method: call.method,
        headers: { ...call.headers, "accept-encoding": "identity" },
        lookup: componentLookup,
        agent: false,
        rejectUnauthorized: true,
        signal: AbortSignal.timeout(COMPONENT_FETCH_TIMEOUT_MS),
      }, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.destroy();
          reject(new Error("Component redirects are not allowed. Use the final public HTTPS URL."));
          return;
        }
        if ((response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") || Number(response.headers["content-length"] ?? 0) > MAX_COMPONENT_FETCH_BYTES) {
          response.destroy();
          reject(new Error("Component responses must be uncompressed text of at most 1 MiB."));
          return;
        }
        void (async () => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of response) {
            bytes += chunk.length;
            if (bytes > MAX_COMPONENT_FETCH_BYTES) throw new Error("Component response is too large.");
            chunks.push(chunk);
          }
          const body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
          if (credentials.some((secret) => [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), Buffer.from(secret).toString("base64")].some((value) => body.includes(value)))) {
            reject(new Error("The component response contained a credential and was blocked."));
            return;
          }
          resolve({ status, ok: status >= 200 && status < 300, body });
        })().catch(() => {
          response.destroy();
          reject(new Error("Component response must be UTF-8 text of at most 1 MiB."));
        });
      });
      outgoing.once("error", failed);
      outgoing.end(call.body);
    } catch { failed(); }
  });
}

function unique(slug: string, taken: readonly string[]) {
  if (!taken.includes(slug)) return slug;
  const stem = slug.slice(0, 43).replace(/-+$/, "");
  for (let suffix = 2; suffix <= MAX_COMPONENTS; suffix += 1) {
    if (!taken.includes(`${stem}-${suffix}`)) return `${stem}-${suffix}`;
  }
  throw new Error(`Emma already holds too many components called "${slug}". Rewrite one of them instead.`);
}
