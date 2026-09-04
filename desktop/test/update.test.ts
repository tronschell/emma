import test from "node:test";
import assert from "node:assert/strict";
import { CHECK_GAP_MS, DEFAULT_UPDATE_ORIGIN, dueForCheck, newerVersion, savedUpdate, showsUpdate, updateFeedUrl, updateOrigin } from "../shared/update";

test("newerVersion takes only a higher semver and tolerates a v prefix", () => {
  assert.equal(newerVersion("0.1.0", "0.2.0"), "0.2.0");
  assert.equal(newerVersion("0.1.0", "v0.1.1"), "0.1.1");
  assert.equal(newerVersion("0.9.0", "1.0.0"), "1.0.0");
  assert.equal(newerVersion("0.10.0", "0.9.0"), "");
  assert.equal(newerVersion("0.1.0", "0.1.0"), "");
  assert.equal(newerVersion("0.1.0", "0.0.9"), "");
});

test("newerVersion refuses anything that is not a plain version", () => {
  assert.equal(newerVersion("0.1.0", ""), "");
  assert.equal(newerVersion("0.1.0", undefined), "");
  assert.equal(newerVersion("0.1.0", { version: "9.9.9" }), "");
  assert.equal(newerVersion("0.1.0", "0.2"), "");
  assert.equal(newerVersion("0.1.0", "Emma 0.2.0"), "");
  assert.equal(newerVersion("nightly", "0.2.0"), "");
});

test("showsUpdate hides nothing downloaded and hides the dismissed version only", () => {
  assert.equal(showsUpdate("", ""), false);
  assert.equal(showsUpdate("0.2.0", ""), true);
  assert.equal(showsUpdate("0.2.0", "0.2.0"), false);
  assert.equal(showsUpdate("0.3.0", "0.2.0"), true);
});

test("updateOrigin keeps an https origin and loopback http, and discards the rest", () => {
  assert.equal(updateOrigin("https://update.electronjs.org/"), "https://update.electronjs.org");
  assert.equal(updateOrigin("http://localhost:8080"), "http://localhost:8080");
  assert.equal(updateOrigin("http://staging.example.com"), "");
  assert.equal(updateOrigin("https://update.example.com/feed"), "");
  assert.equal(updateOrigin("https://update.example.com?token=1"), "");
  assert.equal(updateOrigin(undefined), "");
  assert.equal(updateOrigin(`https://${"a".repeat(600)}.example.com`), "");
});

test("updateFeedUrl names the running build", () => {
  assert.equal(updateFeedUrl(DEFAULT_UPDATE_ORIGIN, "darwin", "arm64", "0.1.0"), "https://update.electronjs.org/tronschell/emma/darwin-arm64/0.1.0");
  assert.equal(updateFeedUrl(DEFAULT_UPDATE_ORIGIN, "win32", "x64", "0.1.0"), "https://update.electronjs.org/tronschell/emma/win32-x64/0.1.0");
});

test("dueForCheck throttles repeat checks and stops once an update is downloaded", () => {
  assert.equal(dueForCheck(0, 0, false), true);
  assert.equal(dueForCheck(CHECK_GAP_MS * 10, 0, false), true);
  assert.equal(dueForCheck(CHECK_GAP_MS - 1, 1, false), false);
  assert.equal(dueForCheck(CHECK_GAP_MS + 1, 1, false), true);
  assert.equal(dueForCheck(CHECK_GAP_MS * 10, 0, true), false);
});

test("savedUpdate restores only a newer version from a well-formed record", () => {
  assert.equal(savedUpdate({ version: "0.4.1" }, "0.2.3"), "0.4.1");
  assert.equal(savedUpdate({ version: "v0.4.1" }, "0.2.3"), "0.4.1");
  assert.equal(savedUpdate({ version: "0.2.3" }, "0.2.3"), "");
  assert.equal(savedUpdate({ version: "0.1.0" }, "0.2.3"), "");
  assert.equal(savedUpdate({ version: 41 }, "0.2.3"), "");
  assert.equal(savedUpdate({}, "0.2.3"), "");
  assert.equal(savedUpdate(["0.4.1"], "0.2.3"), "");
  assert.equal(savedUpdate(null, "0.2.3"), "");
  assert.equal(savedUpdate("0.4.1", "0.2.3"), "");
});
