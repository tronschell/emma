import test from "node:test";
import assert from "node:assert/strict";

// The clip module reaches for Electron's fetch and image decoder; stub them before the
// module loads so the ordering and encoding rules can be exercised outside Electron.
const png = { isEmpty: () => false, getSize: () => ({ width: 32, height: 32 }), toPNG: () => Buffer.from("icon"), toJPEG: () => Buffer.from("jpeg"), resize: () => png };
const photo = { isEmpty: () => false, getSize: () => ({ width: 1200, height: 800 }), toPNG: () => Buffer.alloc(4096), toJPEG: () => Buffer.from("jpeg"), resize: () => photo };
const electron = { net: { fetch: async () => { throw new Error("not used"); } }, nativeImage: { createFromBuffer: (bytes: Buffer) => (String(bytes) === "broken" ? { isEmpty: () => true } : String(bytes) === "photo" ? photo : png) } };
const electronPath = require.resolve("electron");
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electron } as unknown as NodeModule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { boundedText, browserScript, clipImageUrls, encodeClipImage, firstBrowser }: typeof import("../main/clip") = require("../main/clip");
import { autoFileStatus, AUTO_FILE_EXAMPLES } from "../src/context";
import type { KnowledgePage } from "../src/types";

test("only whitelisted browsers are asked for their front tab", () => {
  assert.match(browserScript("Safari") ?? "", /URL of front document/);
  assert.match(browserScript("Arc") ?? "", /active tab of front window/);
  assert.equal(browserScript("Terminal"), null);
  assert.equal(browserScript('Safari" to do shell script "rm -rf /'), null);
});

test("asked from Emma's own window, the page is the browser behind it", () => {
  // System Events lists processes front to back, so the first browser is the one
  // the user was last looking at — Emma itself is never a candidate.
  assert.equal(firstBrowser(["Emma", " Safari", "Google Chrome"]), "Safari");
  assert.equal(firstBrowser(["Emma", "Terminal"]), undefined);
  assert.equal(firstBrowser([]), undefined);
});

test("the favicon leads the clip, then the pictures the page leads with", () => {
  const html = `<html><head>
    <link rel="shortcut icon" href="/small.png">
    <link rel="apple-touch-icon" href="//cdn.example.com/touch.png">
    <meta property="og:image" content="https://example.com/hero.jpg">
    </head><body><img src='photo.jpg' alt="x"><img src="data:image/gif;base64,AAA"><img src="photo.jpg"></body></html>`;
  assert.deepEqual(clipImageUrls(html, "https://example.com/article/one"), [
    "https://cdn.example.com/touch.png",
    "https://example.com/small.png",
    "https://example.com/favicon.ico",
    "https://example.com/hero.jpg",
    "https://example.com/article/photo.jpg",
  ]);
});

test("a page with no pictures still offers the site's default favicon", () => {
  assert.deepEqual(clipImageUrls("<html><body>text</body></html>", "https://example.com/deep/page"), ["https://example.com/favicon.ico"]);
});

test("marks keep transparency, photographs shrink, undecodable bytes are skipped", () => {
  assert.match(encodeClipImage(Buffer.from("icon"), 4096) ?? "", /^data:image\/png;base64,/);
  assert.match(encodeClipImage(Buffer.from("photo"), 4096) ?? "", /^data:image\/jpeg;base64,/);
  assert.equal(encodeClipImage(Buffer.from("broken"), 4096), null);
  // A budget nothing fits under refuses rather than blowing the host request ceiling.
  assert.equal(encodeClipImage(Buffer.from("icon"), 8), null);
});

test("clipped text is trimmed by bytes, not characters", () => {
  assert.equal(boundedText("ascii", 32), "ascii");
  const japanese = "日".repeat(100);
  const trimmed = boundedText(japanese, 30);
  assert.ok(Buffer.byteLength(trimmed) <= 30 && trimmed.length === 10);
  assert.equal(boundedText("", 0), "");
});

const page = (category: string, knowledgeBaseId = "base-1") => ({ category, knowledgeBaseId }) as KnowledgePage;

test("Emma files captures itself only once a category has enough examples", () => {
  const examples = Array.from({ length: AUTO_FILE_EXAMPLES }, () => page("research"));
  assert.deepEqual(autoFileStatus([...examples.slice(1), page("unfiled")], "base-1"), { ready: false, category: "research", examples: AUTO_FILE_EXAMPLES - 1 });
  assert.deepEqual(autoFileStatus(examples, "base-1"), { ready: true, category: "research", examples: AUTO_FILE_EXAMPLES });
  // Examples belonging to another base teach this one nothing.
  assert.deepEqual(autoFileStatus(examples.map(() => page("research", "base-2")), "base-1"), { ready: false, category: "", examples: 0 });
});
