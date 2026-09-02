import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { clipboard, nativeImage, net } from "electron";
import { attribute, externalUrl, MAX_FETCHED_PAGE_BYTES, readablePage } from "./ipc";
import { isWindows } from "./platform";
import { windowsFrontContext } from "./windows-front";

export const MAX_CLIP_TEXT_BYTES = 32 * 1024;
export const MAX_CLIP_IMAGES_CHARS = 56 * 1024;
const MAX_CLIP_IMAGES = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_FETCHES = 6;
const MAX_HELPER_OUTPUT = 4096;

export type FrontPage = { application: string; url: string; title?: string };
export type PageClip = FrontPage & { title: string; text: string; images: string[] };

const CHROMIUM = ["Google Chrome", "Google Chrome Beta", "Google Chrome Canary", "Chromium", "Brave Browser", "Brave Browser Beta", "Microsoft Edge", "Arc", "Dia", "Vivaldi", "Opera", "Comet"];
const SAFARI = ["Safari", "Safari Technology Preview"];

export function browserScript(application: string): string | null {
  if (SAFARI.includes(application)) return `tell application "${application}" to return (URL of front document) & linefeed & (name of front document)`;
  return CHROMIUM.includes(application) ? `tell application "${application}" to return (URL of active tab of front window) & linefeed & (title of active tab of front window)` : null;
}

function scriptFailure(stderr: string): string {
  if (stderr.includes("-1743") || stderr.includes("Not authorized to send Apple events")) {
    return "macOS has not allowed Emma to read your browser — grant it in System Settings → Privacy & Security → Automation → Emma.";
  }
  return stderr || "Emma could not read the front window";
}

function osascript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let failure = "";
    child.stdout.on("data", (data: Buffer) => { output += data; if (output.length > MAX_HELPER_OUTPUT) child.kill(); });
    child.stderr.on("data", (data: Buffer) => { failure = `${failure}${data}`.slice(0, 512); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(scriptFailure(failure.trim()))));
  });
}

export function firstBrowser(names: string[]): string | undefined {
  return names.map((name) => name.trim()).find((name) => browserScript(name));
}

export async function frontmostPage(): Promise<FrontPage> {
  if (isWindows) {
    const context = await windowsFrontContext();
    const page = context.front.url ? context.front : context.browsers.find((browser) => browser.url);
    if (!page?.url || !externalUrl(page.url)) throw new Error(`${context.front.application || "That app"} has no web page in front. Put a Chrome or Edge window in front and try again.`);
    return { application: page.application, url: page.url, title: page.title.trim().slice(0, 256) };
  }
  if (process.platform !== "darwin") throw new Error("Clipping the front page is unavailable on this platform");
  const front = await osascript('tell application "System Events" to return name of first application process whose frontmost is true');
  const application = browserScript(front)
    ? front
    : firstBrowser((await osascript('tell application "System Events" to return name of every application process whose visible is true')).split(","));
  const script = application ? browserScript(application) : null;
  if (!application || !script) throw new Error(`${front || "That app"} is not a browser Emma can read, and no browser window is open behind it. Put a browser window in front and try again.`);
  const [url = "", title = ""] = (await osascript(script)).split("\n");
  if (!externalUrl(url)) throw new Error(`${application} has no web page in front`);
  return { application, url, title: title.trim().slice(0, 256) };
}

export async function frontmostTab(application: string): Promise<{ url: string; title: string } | undefined> {
  if (isWindows) {
    if (!browserScript(application)) return undefined;
    const context = await windowsFrontContext();
    const page = context.front.application === application ? context.front : context.browsers.find((browser) => browser.application === application);
    return page?.url && externalUrl(page.url) ? { url: page.url, title: page.title.trim().slice(0, 256) } : undefined;
  }
  const script = process.platform === "darwin" ? browserScript(application) : null;
  if (!script) return undefined;
  const [url = "", title = ""] = (await osascript(script)).split("\n");
  return externalUrl(url) ? { url, title: title.trim().slice(0, 256) } : undefined;
}

export async function frontmostApplication(): Promise<{ application: string; window: string }> {
  if (isWindows) {
    const context = await windowsFrontContext();
    return { application: context.front.application.trim().slice(0, 120), window: context.front.window.trim().slice(0, 200) };
  }
  if (process.platform !== "darwin") throw new Error("Reading the front application is unavailable on this platform");
  const output = await osascript([
    'tell application "System Events"',
    "set frontApp to first application process whose frontmost is true",
    'set frontTitle to ""',
    "try",
    "set frontTitle to name of front window of frontApp",
    "end try",
    "return name of frontApp & linefeed & frontTitle",
    "end tell",
  ].join("\n"));
  const [application = "", window = ""] = output.split("\n");
  return { application: application.trim().slice(0, 120), window: window.trim().slice(0, 200) };
}

const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 20_000;

export async function fetchReadablePage(value: string, guard: (value: string) => URL | null = externalUrl) {
  const first = guard(value);
  if (!first) throw new Error("Only http and https links to public pages can be read");
  let url: URL = first;
  let response: Response | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    response = await net.fetch(url.toString(), { redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (response.status < 300 || response.status > 399) break;
    const location = response.headers.get("location");
    const next = location ? guard(new URL(location, url).toString()) : null;
    if (!next) throw new Error("That link redirects somewhere Emma will not follow");
    url = next;
    response = undefined;
  }
  if (!response) throw new Error("That link redirects too many times");
  if (!response.ok) throw new Error(`That link returned ${response.status}`);
  const type = response.headers.get("content-type") ?? "";
  if (!/^\s*(text\/|application\/(xhtml|xml|json))/i.test(type)) throw new Error("That link is not a text page");
  if (Number(response.headers.get("content-length") ?? 0) > MAX_FETCHED_PAGE_BYTES) throw new Error("That page is too large to read");
  const html = Buffer.from(await response.arrayBuffer()).subarray(0, MAX_FETCHED_PAGE_BYTES).toString("utf8");
  const page = readablePage(html);
  if (!page.text) throw new Error("Nothing readable came back from that link");
  return { ...page, html, url: url.toString() };
}

export function clipImageUrls(html: string, base: string): string[] {
  const tags = (name: string) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map((match) => match[0]);
  const icons = tags("link").filter((tag) => /\brel\s*=\s*["']?[^"'>]*\bicon\b/i.test(tag));
  const social = tags("meta").filter((tag) => /\b(?:property|name)\s*=\s*["']?(?:og:image|twitter:image)/i.test(tag));
  const candidates = [
    ...icons.filter((tag) => /apple-touch-icon/i.test(tag)).map((tag) => attribute(tag, "href")),
    ...icons.map((tag) => attribute(tag, "href")),
    "/favicon.ico",
    ...social.map((tag) => attribute(tag, "content")),
    ...tags("img").map((tag) => attribute(tag, "src")),
  ];
  const urls: string[] = [];
  for (const candidate of candidates) {
    if (!candidate?.trim()) continue;
    let absolute: URL;
    try { absolute = new URL(candidate.trim(), base); } catch { continue; }
    const href = absolute.toString();
    if (!["http:", "https:"].includes(absolute.protocol) || urls.includes(href)) continue;
    urls.push(href);
  }
  return urls;
}

export function encodeClipImage(bytes: Buffer, budget: number): string | null {
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) return null;
  const size = image.getSize();
  if (size.width <= 128 && size.height <= 128) {
    const png = `data:image/png;base64,${image.toPNG().toString("base64")}`;
    if (png.length <= budget) return png;
  }
  for (const width of [Math.min(size.width, 640), 480, 320, 160]) {
    for (const quality of [70, 55, 40]) {
      const jpeg = `data:image/jpeg;base64,${image.resize({ width, quality: "good" }).toJPEG(quality).toString("base64")}`;
      if (jpeg.length <= budget) return jpeg;
    }
  }
  return null;
}

export function boundedText(text: string, limit: number) {
  let value = text;
  while (Buffer.byteLength(value) > limit) value = value.slice(0, Math.floor(value.length * (limit / Buffer.byteLength(value))));
  return value;
}

async function fetchImage(url: string) {
  const response = await net.fetch(url, { redirect: "follow", credentials: "omit", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok || !/^\s*image\//i.test(response.headers.get("content-type") ?? "")) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  return bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES ? bytes : null;
}

export async function clipPage(front: FrontPage): Promise<PageClip> {
  const page = await fetchReadablePage(front.url);
  const candidates = clipImageUrls(page.html, page.url).slice(0, MAX_IMAGE_FETCHES);
  const fetched = await Promise.all(candidates.map((url) => fetchImage(url).catch(() => null)));
  const images: string[] = [];
  let budget = MAX_CLIP_IMAGES_CHARS;
  for (const bytes of fetched) {
    if (images.length >= MAX_CLIP_IMAGES || budget < 2048) break;
    const encoded = bytes && encodeClipImage(bytes, budget);
    if (!encoded) continue;
    images.push(encoded);
    budget -= encoded.length;
  }
  return { ...front, title: page.title || front.title || front.url, text: boundedText(page.text, MAX_CLIP_TEXT_BYTES), images };
}

const MAX_CLIPS = 20;
const MAX_CLIP_CHARS = 4096;
const CONCEALED = ["org.nspasteboard.ConcealedType", "org.nspasteboard.TransientType", "org.nspasteboard.AutoGeneratedType"];
const clips: string[] = [];

export function rememberClip() {
  if (CONCEALED.some((type) => clipboard.has(type))) return;
  const text = clipboard.readText().trim();
  if (!text || text === clips[0]) return;
  clips.unshift(text.slice(0, MAX_CLIP_CHARS));
  clips.splice(MAX_CLIPS);
}

export function recentClips(): string[] {
  return [...clips];
}

export function restoreClip(index: number): string | undefined {
  const text = clips[index];
  if (text === undefined) return undefined;
  clips.splice(index, 1);
  clips.unshift(text);
  clipboard.writeText(text);
  return text;
}
