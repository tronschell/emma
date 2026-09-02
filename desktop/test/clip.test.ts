import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const png = { isEmpty: () => false, getSize: () => ({ width: 32, height: 32 }), toPNG: () => Buffer.from("icon"), toJPEG: () => Buffer.from("jpeg"), resize: () => png };
const photo = { isEmpty: () => false, getSize: () => ({ width: 1200, height: 800 }), toPNG: () => Buffer.alloc(4096), toJPEG: () => Buffer.from("jpeg"), resize: () => photo };
type Route = { status: number; type?: string; body?: string; location?: string; stall?: boolean };
const routes: Record<string, Route> = {};
const requested: string[] = [];

function fakeRequest({ url: start }: { url: string }) {
  const request = new EventEmitter() as EventEmitter & { end: () => void; abort: () => void; followRedirect: () => void };
  let url = start;
  let aborted = false;
  let followed = false;
  const step = () => {
    if (aborted) return;
    requested.push(url);
    const route = routes[url];
    if (!route) { request.emit("error", new Error(`no route for ${url}`)); return; }
    if (route.stall) return;
    if (route.location) {
      followed = false;
      request.emit("redirect", route.status, "GET", route.location);
      if (!followed || aborted) return;
      url = route.location;
      setImmediate(step);
      return;
    }
    const response = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string> };
    response.statusCode = route.status;
    response.headers = { "content-type": route.type ?? "text/html" };
    request.emit("response", response);
    setImmediate(() => { response.emit("data", Buffer.from(route.body ?? "")); response.emit("end"); });
  };
  request.end = () => { setImmediate(step); };
  request.abort = () => { aborted = true; };
  request.followRedirect = () => { followed = true; };
  return request;
}

const electron = { net: { fetch: async () => { throw new Error("not used"); }, request: fakeRequest }, nativeImage: { createFromBuffer: (bytes: Buffer) => (String(bytes) === "broken" ? { isEmpty: () => true } : String(bytes) === "photo" ? photo : png) } };
const electronPath = require.resolve("electron");
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electron } as unknown as NodeModule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { boundedText, browserScript, clipImageUrls, clipPage, encodeClipImage, fetchReadablePage, firstBrowser }: typeof import("../main/clip") = require("../main/clip");

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

test("a redirect is followed, and every hop is held to the public-address guard", async () => {
  const page = "<html><head><title>Landed</title></head><body><p>The page that was asked for, with enough words to read.</p></body></html>";
  Object.assign(routes, {
    "https://example.com/start": { status: 301, location: "https://example.com/moved" },
    "https://example.com/moved": { status: 302, location: "https://www.example.com/final" },
    "https://www.example.com/final": { status: 200, body: page },
    "https://example.com/inward": { status: 302, location: "http://127.0.0.1:8080/secret" },
    "http://127.0.0.1:8080/secret": { status: 200, body: "<html><body><p>INTERNAL SECRET</p></body></html>" },
    "https://example.com/looping": { status: 302, location: "https://example.com/looping" },
  });
  requested.length = 0;

  const landed = await fetchReadablePage("https://example.com/start");
  assert.equal(landed.title, "Landed");
  assert.equal(landed.url, "https://www.example.com/final");
  assert.match(landed.text, /asked for/);
  assert.deepEqual(requested, ["https://example.com/start", "https://example.com/moved", "https://www.example.com/final"]);

  requested.length = 0;
  await assert.rejects(fetchReadablePage("https://example.com/inward"), /redirects somewhere Emma will not follow/);
  assert.deepEqual(requested, ["https://example.com/inward"]);

  await assert.rejects(fetchReadablePage("https://example.com/looping"), /redirects too many times/);
});

test("a link into this machine is refused before anything is asked for", async () => {
  requested.length = 0;
  for (const attempt of ["http://127.0.0.1:8080/secret", "http://169.254.169.254/latest/meta-data/", "http://192.168.1.1/", "http://localhost:3000/", "http://printer.local/", "file:///etc/passwd"]) {
    await assert.rejects(fetchReadablePage(attempt), /Only http and https links to public pages can be read/, attempt);
  }
  assert.deepEqual(requested, []);
});

test("a clipped page's picture is held to the public-address guard on every hop", async () => {
  const page = `<html><head><title>Shop</title></head><body><p>A page with pictures and enough words to read.</p>
    <img src="https://cdn.example.com/safe.png"><img src="https://cdn.example.com/inward.png"></body></html>`;
  Object.assign(routes, {
    "https://shop.example.com/item": { status: 200, body: page },
    "https://cdn.example.com/safe.png": { status: 302, location: "https://images.example.com/safe.png" },
    "https://images.example.com/safe.png": { status: 200, type: "image/png", body: "icon" },
    "https://cdn.example.com/inward.png": { status: 302, location: "http://169.254.169.254/latest/meta-data/" },
    "http://169.254.169.254/latest/meta-data/": { status: 200, type: "image/png", body: "CREDENTIALS" },
    "https://shop.example.com/favicon.ico": { status: 404 },
  });
  requested.length = 0;

  const clip = await clipPage({ application: "Safari", url: "https://shop.example.com/item", title: "Shop" });
  assert.deepEqual(clip.images, ["data:image/png;base64,aWNvbg=="]);
  assert.ok(requested.includes("https://images.example.com/safe.png"));
  assert.ok(!requested.includes("http://169.254.169.254/latest/meta-data/"), "followed a redirect into link-local");
});

test("a picture whose first hop is already inside this machine is never asked for", async () => {
  Object.assign(routes, {
    "https://shop.example.com/local": { status: 200, body: `<html><head><title>L</title></head><body><p>Words enough to read here.</p><img src="http://127.0.0.1:9000/secret.png"></body></html>` },
    "http://127.0.0.1:9000/secret.png": { status: 200, type: "image/png", body: "icon" },
    "https://shop.example.com/favicon.ico": { status: 404 },
  });
  requested.length = 0;
  const clip = await clipPage({ application: "Safari", url: "https://shop.example.com/local", title: "L" });
  assert.deepEqual(clip.images, []);
  assert.deepEqual(requested.filter((url) => url.includes("127.0.0.1")), []);
});

test("every picture in a clip is fetched under the same timeout as the page", async (t) => {
  Object.assign(routes, {
    "https://example.com/piece": { status: 200, body: `<html><head><title>Piece</title></head><body><p>${"word ".repeat(120)}</p><img src="/hero.png"></body></html>` },
    "https://example.com/hero.png": { status: 200, type: "image/png", stall: true },
    "https://example.com/favicon.ico": { status: 404 },
  });
  requested.length = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clipped = clipPage({ application: "Safari", url: "https://example.com/piece" });
  for (let step = 0; step < 25; step += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1_000);
  }
  const clip = await clipped;
  assert.deepEqual(clip.images, [], "a stalled image host cannot hold the clip open");
  assert.ok(requested.includes("https://example.com/hero.png"));
  assert.match(clip.text, /word/);
});
