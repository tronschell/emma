import { SETTINGS_KEY } from "../shared/settings";
import type { ProviderProfile } from "../shared/settings";
import type { CompactSnapshot } from "./types";

const OVERLAY_SURFACES = ["annotation", "hotspot", "radial", "run", "overlay", "computerCursor"];
const query = new URLSearchParams(location.search);

export const isWorkspaceWindow = !OVERLAY_SURFACES.some((key) => query.has(key));

let pending = OVERLAY_SURFACES.some((key) => query.has(key))
  ? undefined
  : window.emma.request<CompactSnapshot>("threadSummaries");

void pending?.catch(() => undefined);

const savedProviders = (): ProviderProfile[] => {
  try { return (JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as { providers?: ProviderProfile[] } | null)?.providers ?? []; }
  catch { return []; }
};

const providersReady = isWorkspaceWindow
  ? window.emma.setProviders(savedProviders()).then(() => undefined, () => undefined)
  : Promise.resolve();

export const whenProvidersReady = () => providersReady;

export function takeBootSnapshot() {
  const first = pending;
  pending = undefined;
  return first;
}
