/* The four regions of Emma's interface Emma can write herself.

   A region is a real component in this tree, not a page in a frame: the module is
   imported into this realm, handed React and the same props the built-in region
   was given, and rendered in its place. It styles itself with the app's own
   stylesheet because it *is* the app — `className="sidebar-nav"` is the sidebar's
   nav, not a copy of it.

   The reload is the folder's. Every artifact write broadcasts, this re-reads, and
   the module URL carries the artifact's version — a module is cached by specifier,
   so without the version the second import of a rewritten region hands back the
   first one's exports and the hot reload silently does nothing.

   Nothing here trusts the module to work. It is a model-written component that the
   user did not read, so it renders inside a boundary: a module that throws while
   rendering, or a file that will not import, gives the region straight back to the
   built-in and says so — a broken navbar must never be a window with no way out. */

import { Component, createElement, Fragment, useCallback, useEffect, useMemo, useRef, useState, type FunctionComponent, type ReactNode } from "react";
import { artifactModuleUrl, mountable, type ArtifactSurface } from "../shared/artifacts";
import { reasonText } from "./errors";

/** What a region's module is handed. React, because it cannot import it — there is
    no bundler on the other side of that URL — and Emma's bridge, because a region
    that cannot ask for a thread is a picture of a sidebar rather than a sidebar. */
export const runtime = { h: createElement, Fragment, useState, useEffect, useMemo, useRef, useCallback, emma: window.emma };

type Loaded = { key: string; title: string; Component: FunctionComponent<Record<string, unknown>> };

/**
 * The module mounted as this region, or nothing.
 *
 * `default` is a factory rather than the component itself so the module has
 * somewhere to receive React: it is called once per version, and what it returns is
 * kept in state — rebuilding the component every render would remount it, and the
 * region would lose its own state on every keystroke elsewhere in the app.
 */
function useRegionModule(name: ArtifactSurface, onError: (why: string) => void) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    let active = true;
    const load = async () => {
      const found = (await window.emma.listArtifacts()).find((item) => item.surface === name && mountable(item.kind));
      if (!active) return;
      if (!found) { setLoaded(null); return; }
      const key = `${found.id}:${found.version}`;
      // Vite must not try to resolve this at build time: the specifier is a
      // scheme main serves, and there is nothing in the bundle to point it at.
      const module = await import(/* @vite-ignore */ artifactModuleUrl(found.id, found.version)) as { default?: unknown };
      if (!active) return;
      if (typeof module.default !== "function") throw new Error("A region module has to `export default` a function: it is handed { h, useState, emma } and returns the component.");
      const Component = (module.default as (api: typeof runtime) => unknown)(runtime);
      if (typeof Component !== "function") throw new Error("The default export returned " + typeof Component + ". It has to return a component — a function of props that returns h(...).");
      setLoaded({ key, title: found.title, Component: Component as FunctionComponent<Record<string, unknown>> });
    };
    const run = () => void load().catch((error: unknown) => {
      if (!active) return;
      // The built-in comes back and the reason is said out loud. A region that
      // fails to load and leaves no trace is the one failure mode worth refusing.
      setLoaded(null);
      onError(reasonText(error));
    });
    run();
    const stop = window.emma.onArtifactsChanged(() => { onError(""); run(); });
    return () => { active = false; stop(); };
  }, [name, onError]);
  return loaded;
}

/**
 * One region: Emma's, or the one shipped with the app.
 *
 * `children` is the built-in, so the call site reads as what it is — the region as
 * written, wrapped in the possibility that Emma has rewritten it.
 */
export function Region({ name, props, children }: { name: ArtifactSurface; props: Record<string, unknown>; children: ReactNode }) {
  const [error, setError] = useState("");
  // Stable, so the effect below is not a subscribe/unsubscribe loop.
  const report = useCallback((why: string) => setError(why), []);
  const loaded = useRegionModule(name, report);
  return <>
    {error && <p className="region-error" role="status">Emma’s {name} could not run, so the built-in is back · {error}</p>}
    {loaded
      // Keyed by version: a rewritten region is a new component, and a boundary
      // that already caught has to be given the chance to try again.
      ? <RegionBoundary key={loaded.key} fallback={children} onError={report}>
        <loaded.Component {...props} />
      </RegionBoundary>
      : children}
  </>;
}

export class RegionBoundary extends Component<{ fallback: ReactNode; onError: (why: string) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { this.props.onError(reasonText(error)); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
