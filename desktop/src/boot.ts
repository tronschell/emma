import type { Snapshot } from "./types";

const OVERLAY_SURFACES = ["annotation", "hotspot", "radial", "run", "overlay", "computerCursor"];
const query = new URLSearchParams(location.search);

export const isWorkspaceWindow = !OVERLAY_SURFACES.some((key) => query.has(key));

let pending = OVERLAY_SURFACES.some((key) => query.has(key))
  ? undefined
  : window.emma.request<Snapshot>("snapshot");

void pending?.catch(() => undefined);

export function takeBootSnapshot() {
  const first = pending;
  pending = undefined;
  return first;
}
