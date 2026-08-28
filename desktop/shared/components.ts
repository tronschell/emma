export const COMPONENT_SCHEME = "emma-component";
export const MAX_COMPONENT_CHARS = 64 * 1024;
export const MAX_COMPONENT_TITLE_CHARS = 80;
export const MAX_COMPONENT_LABEL_CHARS = 80;
export const MAX_COMPONENT_SELECTOR_CHARS = 512;
export const MAX_COMPONENTS = 64;
export const MAX_COMPONENT_SHOT_BYTES = 4 * 1024 * 1024;
export const PLACE_TIMEOUT_MS = 180_000;

export interface ComponentAnchor {
  selector: string;
  label: string;
}

export interface ComponentMeta {
  id: string;
  title: string;
  anchor: ComponentAnchor;
  createdAt: string;
  updatedAt: string;
  version: number;
  disabled?: boolean;
  sourceThreadId?: string;
}

export interface BuiltComponent extends ComponentMeta {
  code: string;
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

export function parseAnchor(value: unknown): ComponentAnchor {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A component's anchor is where the user pointed: { selector, label }.");
  const raw = value as Record<string, unknown>;
  const selector = typeof raw.selector === "string" ? raw.selector.trim() : "";
  if (!selector || selector.length > MAX_COMPONENT_SELECTOR_CHARS || /[<{}\n]/.test(selector)) {
    throw new Error('That is not a place in Emma\'s interface. Ask the user to point at one with component {"action":"place"}.');
  }
  const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : selector;
  return { selector, label: label.slice(0, MAX_COMPONENT_LABEL_CHARS) };
}
