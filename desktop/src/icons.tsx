
import type { ReactNode } from "react";
import { brandRenderData } from "./brand-data";
import type { BrandDefinition } from "./brands";

const EMMA_OPEN = new URL("../assets/emma.webp", import.meta.url).href;
const EMMA_SHUT = new URL("../assets/emma-blink.webp", import.meta.url).href;

export function EmmaMark({ className = "" }: { className?: string }) {
  return <span className={`emma-mark ${className}`} aria-hidden="true">
    <img src={EMMA_OPEN} alt="" />
    <img className="emma-lid" src={EMMA_SHUT} alt="" />
  </span>;
}

/* The mark: a bow drawn on a 16x16 pixel grid, rows 3..13. `#` is ribbon, `o` the
   knot — the same colour held at half opacity, which is the only shading it gets.
   The tile is one hue deep and takes `currentColor`, so a context tints the bow by
   setting `color`; state lives in the colour, never in a second glyph. */
const BOW = [
  ".####......####.",
  ".######..######.",
  ".##..##oo##..##.",
  ".##..##oo##..##.",
  ".##..##oo##..##.",
  ".######oo######.",
  ".####..oo..####.",
  "......####......",
  ".....##..##.....",
  "....###..###....",
  "....##....##....",
];
const BOW_PIXELS = BOW.flatMap((row, index) => [...row].map((ink, x) => ({ ink, x, y: index + 3 })).filter((pixel) => pixel.ink !== "."));

export function Mark({ className = "" }: { className?: string }) {
  return <span className={`mark ${className}`} aria-hidden="true">
    <svg viewBox="0 0 16 16" fill="currentColor" shapeRendering="crispEdges">
      {BOW_PIXELS.map(({ ink, x, y }) => <rect key={`${x},${y}`} x={x} y={y} width="1" height="1" opacity={ink === "o" ? 0.5 : undefined} />)}
    </svg>
  </span>;
}

export function InfoDot({ children }: { children: ReactNode }) {
  return <details className="info-dot"><summary aria-label="What this is for">i</summary><div>{children}</div></details>;
}

export function BrandIcon({ brand, className }: { brand?: BrandDefinition; className: string }) {
  const data = brandRenderData(brand);
  return data.src ? <img className={`${className} brand-image`} draggable={false} src={data.src} alt="" aria-hidden="true" /> : <span className={`${className} brand-fallback`} aria-hidden="true">{data.fallback}</span>;
}

export function ExpandIcon() {
  return <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9.5 2H14v4.5M14 2l-5.5 5.5M6.5 14H2V9.5M2 14l5.5-5.5" /></svg>;
}

export function CaretIcon() {
  return <svg className="caret" viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" /></svg>;
}

export function TrashIcon() {
  return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L12 4M6.6 6.8v4.4M9.4 6.8v4.4" /></svg>;
}

export function ClipIcon() {
  return <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14.29 7.37l-6.13 6.13a4 4 0 0 1-5.66-5.66l6.13-6.13a2.67 2.67 0 0 1 3.77 3.77l-6.13 6.13a1.33 1.33 0 0 1-1.89-1.89l5.66-5.65" /></svg>;
}

export function GlobeIcon() {
  return <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2" /><path d="M1.8 8h12.4M8 1.8c1.7 1.8 2.6 3.9 2.6 6.2S9.7 12.4 8 14.2C6.3 12.4 5.4 10.3 5.4 8s.9-4.4 2.6-6.2z" /></svg>;
}

export function ToolIcon() {
  return <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10.4 1.9a3.6 3.6 0 0 0-4.2 4.6l-4.1 4.1a1.4 1.4 0 0 0 2 2l4.1-4.1a3.6 3.6 0 0 0 4.6-4.2L11 6.1 9.9 5 8.2 3.3z" /></svg>;
}

export function TabIcon() {
  return <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M1.6 5.4h12.8v8.2H1.6zM1.6 5.4V2.9h5.6v2.5" /></svg>;
}

export function StopIcon() {
  return <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1" fill="currentColor" /></svg>;
}

export function FoldIcon() {
  return <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5.6 3.6L10 8l-4.4 4.4M13.2 2.6v10.8" /></svg>;
}

export function DockIcon() {
  return <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 2v6.6M5.4 6.2L8 8.8l2.6-2.6M2.4 12.4h11.2" /></svg>;
}

export function CloseIcon() {
  return <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true"><path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2" /></svg>;
}

export function GearIcon() {
  return <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="2.2" /><path d="M8 1.6l.9 1.6 1.8-.3.6 1.7 1.7.6-.3 1.8L14.4 8l-1.7.9.3 1.8-1.7.6-.6 1.7-1.8-.3L8 14.4l-.9-1.7-1.8.3-.6-1.7-1.7-.6.3-1.8L1.6 8l1.7-.9-.3-1.8 1.7-.6.6-1.7 1.8.3z" /></svg>;
}

export function MoreIcon() {
  return <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><circle cx="3.4" cy="8" r="1.2" fill="currentColor" /><circle cx="8" cy="8" r="1.2" fill="currentColor" /><circle cx="12.6" cy="8" r="1.2" fill="currentColor" /></svg>;
}

export function TextIcon() {
  return <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true"><path d="M2.6 3.6h10.8M2.6 6.8h10.8M2.6 10h7.6M2.6 13.2h5.4" /></svg>;
}

export function SidebarIcon() {
  return <svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true"><rect x="0.65" y="0.65" width="12.7" height="12.7" rx="2.6" /><path d="M4.9 0.65v12.7" /></svg>;
}

export function BranchIcon() {
  return <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="4.6" cy="3.3" r="1.8" /><circle cx="4.6" cy="12.7" r="1.8" /><circle cx="11.4" cy="5.6" r="1.8" /><path d="M4.6 5.1v5.8M11.4 7.4a3.6 3.6 0 0 1-3.6 3.6H4.6" /></svg>;
}

export function PinIcon({ filled }: { filled?: boolean }) {
  return <svg viewBox="0 0 16 16" width="12" height="12" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5.6 1.9h4.8M6.4 1.9l-.5 4-2 1.7v1.3h8.2V7.6l-2-1.7-.5-4M8 8.9V14.1" /></svg>;
}

export function ChevronIcon({ back }: { back?: boolean }) {
  return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={back ? "M10 3.5 5.5 8l4.5 4.5" : "M6 3.5 10.5 8 6 12.5"} /></svg>;
}
