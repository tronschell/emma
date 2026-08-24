export const MAX_VISUAL_CHARS = 96 * 1024;
export const MAX_VISUAL_TITLE_CHARS = 80;
export const MAX_VISUAL_PICK_CHARS = 8 * 1024;

export interface Visual {
  title: string;
  html: string;
}

export function parseVisual(value: unknown): Visual {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool arguments must be a JSON object.");
  const args = value as Record<string, unknown>;
  const title = typeof args.title === "string" ? args.title.trim().slice(0, MAX_VISUAL_TITLE_CHARS) : "";
  if (!title) throw new Error('"title" is required: a short name for what this shows.');
  const html = args.html;
  if (typeof html !== "string" || !html.trim()) throw new Error('"html" is required: the whole document to draw, with its own <style> and <script>.');
  if (html.length > MAX_VISUAL_CHARS) throw new Error(`"html" is at most ${MAX_VISUAL_CHARS} characters. Draw fewer panels, or make it an artifact the user keeps.`);
  return { title, html };
}

export const VISUAL_SCHEME = "emma-visual";
export const visualFrameUrl = (id: string) => `${VISUAL_SCHEME}://${id}/`;
export const VISUAL_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";

export const visualMarker = (id: string) => `[visual:${id}]`;
export const VISUAL_MARKER = /^\[visual:([a-z0-9-]+)]/;

export function visualDrawn(step: { status: string; output?: string }): string | undefined {
  if (step.status !== "completed") return undefined;
  return VISUAL_MARKER.exec((step.output ?? "").trimStart())?.[1];
}

export const VISUAL_BG = "#0e0e10";

const VISUAL_TOKENS = [
  `--bg:${VISUAL_BG}`,
  "--surface:#131316",
  "--surface-2:#17171a",
  "--border:#e8e6df26",
  "--border-strong:#e8e6df47",
  "--text:#e8e6df",
  "--text-2:#e8e6dfad",
  "--text-3:#e8e6df8c",
  "--rose:#ed7a9b",
  "--orange:#ff6a3d",
  "--lime:#c3d64b",
  "--teal:#3fd8c0",
  "--blue:#6faee6",
  "--violet:#ae78f0",
  "--accent:#ff6a3d",
  '--font:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
  '--font-mono:ui-monospace,SFMono-Regular,Menlo,monospace',
].join(";");

const VISUAL_SHELL = `:root{${VISUAL_TOKENS};color-scheme:dark}
*{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0;padding:12px;background:var(--bg);color:var(--text);font-family:var(--font);font-size:13px;line-height:1.45}
svg,canvas,img{max-width:100%;height:auto}
table{border-collapse:collapse;width:100%;font-size:12px}
th,td{border-bottom:1px solid var(--border);padding:4px 6px;text-align:left}
th{color:var(--text-3);font-weight:500}
h1,h2,h3,h4{margin:0 0 6px;font-size:13px;font-weight:600}
p{margin:0 0 8px;color:var(--text-2)}
small{color:var(--text-3);font-size:11px}
a{color:var(--accent)}
[data-emma-pick] *{cursor:crosshair}
[data-emma-lit]{outline:2px solid var(--accent);outline-offset:1px;background:#ff6a3d2e!important}`;

export const VISUAL_HEIGHT_MESSAGE = "visual-height";
export const VISUAL_PICK_MESSAGE = "visual-pick";
export const VISUAL_PICKED_MESSAGE = "visual-picked";
export const VISUAL_HEIGHT_JS = "Math.ceil(document.body.scrollHeight)";

const VISUAL_MEASURE = `<script>(()=>{
let last=0;
const tell=()=>{const h=${VISUAL_HEIGHT_JS};if(h===last)return;last=h;parent.postMessage({emma:${JSON.stringify(VISUAL_HEIGHT_MESSAGE)},height:h},"*")};
new ResizeObserver(tell).observe(document.body);addEventListener("load",tell);tell();
let lit=null,picking=false;
const light=(el)=>{if(lit===el)return;lit&&lit.removeAttribute("data-emma-lit");lit=el;lit&&lit.setAttribute("data-emma-lit","")};
const name=(el)=>el.tagName.toLowerCase()+(el.id?"#"+el.id:"")+[...el.classList].map((one)=>"."+one).join("");
const path=(el)=>{const parts=[];for(let at=el;at&&at!==document.body&&parts.length<3;at=at.parentElement)parts.unshift(name(at));return parts.join(" > ")};
addEventListener("message",(event)=>{
picking=!!event.data&&event.data.emma===${JSON.stringify(VISUAL_PICK_MESSAGE)}&&!!event.data.on;
document.documentElement.toggleAttribute("data-emma-pick",picking);
if(!picking)light(null)});
addEventListener("pointerover",(event)=>{if(picking&&event.target instanceof Element)light(event.target)},true);
addEventListener("pointerdown",(event)=>{if(picking)event.preventDefault()},true);
addEventListener("click",(event)=>{
if(!picking||!(event.target instanceof Element))return;
event.preventDefault();event.stopPropagation();
const el=event.target;light(null);
parent.postMessage({emma:${JSON.stringify(VISUAL_PICKED_MESSAGE)},label:path(el),html:el.outerHTML.slice(0,${MAX_VISUAL_PICK_CHARS})},"*");
light(el)},true);
})()</script>`;

export const visualPage = (html: string) =>
  `<!doctype html><meta charset="utf-8"><style>${VISUAL_SHELL}</style>\n${html}\n${VISUAL_MEASURE}`;
