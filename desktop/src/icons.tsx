
import type { ReactElement, ReactNode } from "react";
import { brandRenderData } from "./brand-data";
import { TerminalIcon } from "./terminal";
import type { BrandDefinition } from "./brands";
import { webSearchProvider, type WebSearchProvider } from "../shared/settings";

const EMMA_OPEN = new URL("../assets/emma.webp", import.meta.url).href;
const EMMA_SHUT = new URL("../assets/emma-blink.webp", import.meta.url).href;

export function EmmaMark({ className = "" }: { className?: string }) {
  return <span className={`emma-mark ${className}`} aria-hidden="true">
    <img src={EMMA_OPEN} alt="" />
    <img className="emma-lid" src={EMMA_SHUT} alt="" />
  </span>;
}

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

const SEARCH_LOGOS = {
  tinyfish: new URL("../assets/search/tinyfish.webp", import.meta.url).href,
  fourget: new URL("../assets/search/fourget.webp", import.meta.url).href,
  searxng: new URL("../assets/search/searxng.webp", import.meta.url).href,
  brave: new URL("../assets/search/brave.webp", import.meta.url).href,
  tavily: new URL("../assets/search/tavily.webp", import.meta.url).href,
  exa: new URL("../assets/search/exa.webp", import.meta.url).href,
} satisfies Record<WebSearchProvider, string>;

export function SearchProviderMark({ provider }: { provider: WebSearchProvider }) {
  const label = webSearchProvider(provider).label;
  return <img className="search-provider-mark" src={SEARCH_LOGOS[provider]} width="16" height="16" alt={label} title={label} draggable={false} />;
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

export function SearchIcon() {
  return <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.4" /><path d="M10.4 10.4 14 14" /></svg>;
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

export function ChevronIcon({ back }: { back?: boolean }) {
  return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={back ? "M10 3.5 5.5 8l4.5 4.5" : "M6 3.5 10.5 8 6 12.5"} /></svg>;
}

export function BookIcon() {
  return <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 4.1C6.9 3.1 5.5 2.6 3.6 2.6H2v9.6h1.6c1.9 0 3.3.5 4.4 1.5 1.1-1 2.5-1.5 4.4-1.5H14V2.6h-1.6c-1.9 0-3.3.5-4.4 1.5zM8 4.1v9.6" /></svg>;
}

export function GlassIcon() {
  return <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="4.2" cy="8" r="2.6" /><circle cx="11.8" cy="8" r="2.6" /><path d="M6.8 8h2.4M1.6 8V5.6M14.4 8V5.6" /></svg>;
}



export function TreeIcon() {
  return <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M1.8 12.8V3.2h4.3l1.5 1.8h6.6v7.8z" /></svg>;
}

export function MoveIcon() {
  return <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 5.4h9.2M8.6 2.8l2.6 2.6-2.6 2.6M14 10.6H4.8M7.4 8l-2.6 2.6 2.6 2.6" /></svg>;
}

export function ReviewIcon() {
  return <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4 4.67 11.33 1.33 8" /><path d="M14.67 6.67 9.67 11.67 8.67 10.67" /></svg>;
}

export function SparkIcon() {
  return <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 1.8 9.5 6 13.7 7.5 9.5 9 8 13.2 6.5 9 2.3 7.5 6.5 6zM12.8 11.6l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" /></svg>;
}

export function ComputerIcon() {
  return <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="1.6" y="2.6" width="12.8" height="8.4" /><path d="M5.6 13.4h4.8M8 11v2.4" /></svg>;
}

export function LockIcon() {
  return <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3.2" y="7" width="9.6" height="6.4" /><path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7" /></svg>;
}

export function PencilIcon() {
  return <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11.2 2.3 13.7 4.8 5.4 13H2.9v-2.5z" /><path d="M9.7 3.8l2.5 2.5" /></svg>;
}

const TOOL_MARKS: Record<string, () => ReactElement> = {
  read_file: BookIcon, read_tool_result: BookIcon, open_file: BookIcon,
  file_info: GlassIcon, vision: GlassIcon, look_at_image: GlassIcon,
  terminal: TerminalIcon, run_command: TerminalIcon, bash: TerminalIcon,
  grep_files: SearchIcon, glob_files: SearchIcon, semantic_search: SearchIcon,
  web_search: SearchIcon, search_tools: SearchIcon, mcp_search_tools: SearchIcon,
  edit_file: PencilIcon, write_file: PencilIcon,
  list_files: TreeIcon, create_folder: TreeIcon,
  delete_file: TrashIcon, rename_file: MoveIcon, copy_file: MoveIcon,
  web_fetch: GlobeIcon, save_page: GlobeIcon, browser: GlobeIcon,
  subagent: SparkIcon, computer: ComputerIcon,
};

const KIND_MARKS: Record<string, () => ReactElement> = {
  read: BookIcon, search: SearchIcon, edit: PencilIcon,
  execute: TerminalIcon, delete: TrashIcon, move: MoveIcon, fetch: GlobeIcon,
};

export function ToolMark({ name = "", kind = "" }: { name?: string; kind?: string }) {
  const Glyph = TOOL_MARKS[name] ?? KIND_MARKS[kind] ?? ToolIcon;
  return <Glyph />;
}
