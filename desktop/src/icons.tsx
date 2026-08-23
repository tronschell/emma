/* Icons more than one view draws. Everything else stays inline where it is used. */

import type { ReactNode } from "react";
import { brandRenderData } from "./brand-data";
import type { BrandDefinition } from "./brands";

/** The long half of a panel's copy, folded behind an (i) so the page reads as one line per idea. */
export function InfoDot({ children }: { children: ReactNode }) {
  return <details className="info-dot"><summary aria-label="What this is for">i</summary><div>{children}</div></details>;
}

/** A maker's mark, or its glyph when there is no asset for it. */
export function BrandIcon({ brand, className }: { brand?: BrandDefinition; className: string }) {
  const data = brandRenderData(brand);
  return data.src ? <img className={`${className} brand-image`} src={data.src} alt="" aria-hidden="true" /> : <span className={`${className} brand-fallback`} aria-hidden="true">{data.fallback}</span>;
}

/** Opposite corners pushed apart — the same "make this bigger" mark macOS uses. */
export function ExpandIcon() {
  return <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9.5 2H14v4.5M14 2l-5.5 5.5M6.5 14H2V9.5M2 14l5.5-5.5" /></svg>;
}

/** Putting something away: the archive rail's foot button and a project's sweep. */
export function TrashIcon() {
  return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L12 4M6.6 6.8v4.4M9.4 6.8v4.4" /></svg>;
}

/** Attaching a file: the bent clip every composer draws for it. */
export function ClipIcon() {
  return <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14.29 7.37l-6.13 6.13a4 4 0 0 1-5.66-5.66l6.13-6.13a2.67 2.67 0 0 1 3.77 3.77l-6.13 6.13a1.33 1.33 0 0 1-1.89-1.89l5.66-5.65" /></svg>;
}

/** A tool call — the wrench beside a step in the transcript and a bar in the timeline. */
export function ToolIcon() {
  return <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10.4 1.9a3.6 3.6 0 0 0-4.2 4.6l-4.1 4.1a1.4 1.4 0 0 0 2 2l4.1-4.1a3.6 3.6 0 0 0 4.6-4.2L11 6.1 9.9 5 8.2 3.3z" /></svg>;
}
