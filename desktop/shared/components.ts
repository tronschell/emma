import { isEnvName } from "./settings";

export const COMPONENT_SCHEME = "emma-component";
export const MAX_COMPONENT_CHARS = 64 * 1024;
export const MAX_COMPONENT_TITLE_CHARS = 80;
export const MAX_COMPONENTS = 64;
export const MAX_COMPONENT_SHOT_BYTES = 4 * 1024 * 1024;
export const MAX_COMPONENT_VARIABLES = 8;
export const MAX_COMPONENT_FETCH_BYTES = 1024 * 1024;
export const COMPONENT_FETCH_TIMEOUT_MS = 20_000;
export const COMPONENT_ZONE = "aside.inspector .inspector-body";
export const COMPONENT_ZONE_LABEL = "the context bar";

export interface ComponentMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  expands?: boolean;
  variables?: string[];
  disabled?: boolean;
  sourceThreadId?: string;
}

export interface BuiltComponent extends ComponentMeta {
  code: string;
}

export interface ComponentRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export const componentModuleUrl = (id: string, version: number) => `${COMPONENT_SCHEME}://${id}/module.js?v=${version}`;
export const COMPONENT_MODULE_PATH = "module.js";
export const COMPONENT_SHOT_PATH = "shot.png";
export const componentShotUrl = (id: string, version: number) => `${COMPONENT_SCHEME}://${id}/${COMPONENT_SHOT_PATH}?v=${version}`;

export function validComponentId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value);
}

export function componentSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug || "component";
}

export function parseVariables(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : undefined;
  if (!list) throw new Error('"variables" is a list of environment variable names the user fills in Settings → Built by Emma, like ["LINEAR_API_KEY"].');
  const names = [...new Set(list.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean))];
  if (names.length > MAX_COMPONENT_VARIABLES) throw new Error(`A component asks for at most ${MAX_COMPONENT_VARIABLES} variables.`);
  for (const name of names) {
    if (!isEnvName(name)) throw new Error(`"${name.slice(0, 40)}" is not an environment variable name: letters, digits and underscores, never starting with a digit.`);
  }
  return names;
}
