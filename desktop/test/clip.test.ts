import test from "node:test";
import assert from "node:assert/strict";

const png = { isEmpty: () => false, getSize: () => ({ width: 32, height: 32 }), toPNG: () => Buffer.from("icon"), toJPEG: () => Buffer.from("jpeg"), resize: () => png };
const photo = { isEmpty: () => false, getSize: () => ({ width: 1200, height: 800 }), toPNG: () => Buffer.alloc(4096), toJPEG: () => Buffer.from("jpeg"), resize: () => photo };
const electron = { net: { fetch: async () => { throw new Error("not used"); } }, nativeImage: { createFromBuffer: (bytes: Buffer) => (String(bytes) === "broken" ? { isEmpty: () => true } : String(bytes) === "photo" ? photo : png) } };
const electronPath = require.resolve("electron");
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electron } as unknown as NodeModule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { boundedText, browserScript, clipImageUrls, encodeClipImage, firstBrowser }: typeof import("../main/clip") = require("../main/clip");

test("only whitelisted browsers are asked for their front tab", () => {
  assert.match(browserScript("Safari") ?? "", /URL of front document/);
  assert.match(browserScript("Arc") ?? "", /active tab of front window/);
  assert.equal(browserScript("Terminal"), null);
  assert.equal(browserScript('Safari" to do shell script "rm -rf /'), null);
});

test("asked from Emma's own window, the page is the browser behind it", () => {
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
  assert.equal(encodeClipImage(Buffer.from("icon"), 8), null);
});

test("clipped text is trimmed by bytes, not characters", () => {
  assert.equal(boundedText("ascii", 32), "ascii");
  const japanese = "日".repeat(100);
  const trimmed = boundedText(japanese, 30);
  assert.ok(Buffer.byteLength(trimmed) <= 30 && trimmed.length === 10);
  assert.equal(boundedText("", 0), "");
});

test("every picture in a clip is fetched under the same timeout as the page", async () => {
  const signals: (AbortSignal | undefined | null)[] = [];
  const page = `<html><head><title>Piece</title></head><body><p>${"word ".repeat(120)}</p><img src="/hero.png"></body></html>`;
  electron.net.fetch = (async (url: string, init: RequestInit) => {
    signals.push(init.signal);
    const image = /\.(?:png|ico)$/.test(new URL(url).pathname);
    return {
      status: 200,
      ok: true,
      headers: new Headers({ "content-type": image ? "image/png" : "text/html" }),
      arrayBuffer: async () => (image ? Buffer.from("icon") : Buffer.from(page)),
    };
  }) as unknown as typeof electron.net.fetch;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { clipPage }: typeof import("../main/clip") = require("../main/clip");
  const clip = await clipPage({ application: "Safari", url: "https://example.com/piece" });
  assert.equal(clip.images.length > 0, true);
  assert.equal(signals.length, 3);
  assert.equal(signals.every((signal) => signal instanceof AbortSignal), true, "a stalled image host cannot hold the clip open");
});
