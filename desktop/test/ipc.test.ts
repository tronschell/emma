import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { externalUrl, trustedSender, validJpegDataUrl, validateRequest } from "../main/ipc";
import { discoverImports } from "../main/imports";
import { loadUiPlugins, validatePluginCss } from "../main/plugins";
import { activityDays } from "../src/activity";
import { defaultSettings, localEndpoint, validateOverlayPreferences, validateSettings } from "../shared/settings";
import { defaultPaneLayout, validatePaneLayout } from "../src/layout";
import { overlayBounds } from "../main/overlay";
import { hasPersistedPrompt } from "../src/drafts";
import type { Snapshot } from "../src/types";
import { BoundedLines, parseHostResponse } from "../main/ndjson";

test("IPC accepts only exact allowlisted payloads", () => {
  assert.deepEqual(validateRequest({ method: "sendMessage", params: { threadId: "thread-123456789", content: "hello" } }), {
    method: "sendMessage",
    params: { threadId: "thread-123456789", content: "hello" },
  });
  assert.throws(() => validateRequest({ method: "shell", params: {} }), /not allowed/);
  assert.throws(() => validateRequest({ method: "snapshot", params: { extra: "x" } }), /Invalid parameters/);
  assert.throws(() => validateRequest({ method: "sendMessage", params: { threadId: "x" } }), /Invalid parameters/);
  assert.equal(validateRequest({ method: "updatePage", params: { pageId: "p", title: "x", category: "c", summary: "x", body: "" } }).params.body, "");
  assert.throws(() => validateRequest({ method: "updatePage", params: { pageId: "p", title: "x".repeat(65_536), category: "c", summary: "x".repeat(65_536), body: "x".repeat(65_536) } }), /too large/);
});

test("host response lines are framed and bounded before JSON parsing", () => {
  const lines = new BoundedLines(8);
  assert.deepEqual(lines.push(Buffer.from("{\"a\":")), []);
  assert.deepEqual(lines.push(Buffer.from("1}\n{}\n")), ["{\"a\":1}", "{}"]);
  lines.end();
  assert.throws(() => new BoundedLines(4).push(Buffer.from("12345")), /too large/);
  assert.deepEqual(parseHostResponse('{"id":"1","ok":true,"result":null}'), { id: "1", ok: true, result: null });
  assert.throws(() => parseHostResponse('{"id":"1","ok":true}'), /envelope/);
  assert.throws(() => parseHostResponse('{"id":"1","ok":false,"error":null}'), /envelope/);
});

test("screen context accepts only bounded JPEG data URLs", () => {
  assert.equal(validJpegDataUrl("data:image/jpeg;base64,/9j/"), true);
  assert.equal(validJpegDataUrl("data:image/png;base64,iVBORw0="), false);
  assert.equal(validJpegDataUrl("data:image/jpeg;base64,not base64"), false);
});

test("agent import discovery returns metadata without reading config contents", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "emma-imports-"));
  try {
    await mkdir(path.join(home, ".codex", "skills", "review"), { recursive: true });
    await writeFile(path.join(home, ".codex", "skills", "review", "SKILL.md"), "secret instructions");
    await writeFile(path.join(home, ".codex", "config.toml"), "secret = true");
    const codex = (await discoverImports(home)).find((source) => source.id === "codex");
    assert.deepEqual({ skills: codex?.skills, mcpConfigs: codex?.mcpConfigs }, { skills: 1, mcpConfigs: 1 });
    assert.equal(JSON.stringify(codex).includes("secret"), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("UI plugins are local CSS-only manifests with remote resources blocked", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "emma-plugins-"));
  try {
    const plugin = path.join(userData, "plugins", "dense-theme");
    await mkdir(plugin, { recursive: true });
    await writeFile(path.join(plugin, "plugin.json"), JSON.stringify({ id: "dense-theme", name: "Dense theme", version: "1.0.0", uiStylesheet: "theme.css" }));
    await writeFile(path.join(plugin, "theme.css"), ":root { --green: #ff0; }");
    assert.deepEqual((await loadUiPlugins(userData)).map(({ id, name }) => ({ id, name })), [{ id: "dense-theme", name: "Dense theme" }]);
    assert.throws(() => validatePluginCss("body { background: url(https://evil.test/x); }"), /blocked/);
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test("activity spans the first recorded day through the current week", () => {
  const days = activityDays(["2026-08-17T10:00:00Z", "2026-08-17T11:00:00Z"], new Date("2026-08-20T00:00:00Z"));
  assert.equal(days.length, 7);
  assert.equal(days[1].count, 2);
});

test("settings require three actions and local-only transcription", () => {
  assert.equal(validateSettings(defaultSettings).quickActions.length, 3);
  assert.equal(localEndpoint("http://127.0.0.1:8080/v1/audio/transcriptions")?.hostname, "127.0.0.1");
  assert.equal(localEndpoint("https://api.openai.com/v1/audio/transcriptions"), null);
  assert.throws(() => validateSettings({ ...defaultSettings, quickActions: [] }), /three/);
});

test("overlay settings migrate old values and keep calibration bounded", () => {
  const legacy = { quickActions: defaultSettings.quickActions, transcriptionEnabled: defaultSettings.transcriptionEnabled, transcriptionEndpoint: defaultSettings.transcriptionEndpoint, transcriptionModel: defaultSettings.transcriptionModel };
  assert.deepEqual(validateSettings(legacy).overlayPlacement, "below");
  assert.deepEqual(validateOverlayPreferences({ overlayPlacement: "rails", notchGap: 196 }), { overlayPlacement: "rails", notchGap: 196 });
  assert.throws(() => validateOverlayPreferences({ overlayPlacement: "rails", notchGap: 261 }), /invalid/);
});

test("overlay geometry centers below the active display with mode-specific bounds", () => {
  const display = { bounds: { x: -1440, y: 0, width: 1440, height: 900 }, workArea: { x: -1440, y: 25, width: 1440, height: 850 } };
  assert.deepEqual(overlayBounds(display, { overlayPlacement: "below", notchGap: 180 }), { x: -990, y: 33, width: 540, height: 228 });
  assert.deepEqual(overlayBounds(display, { overlayPlacement: "rails", notchGap: 196 }), { x: -1130, y: 0, width: 820, height: 170 });
  const docked = { bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 80, y: 25, width: 1360, height: 875 } };
  assert.deepEqual(overlayBounds(docked, { overlayPlacement: "rails", notchGap: 196 }), { x: 310, y: 0, width: 820, height: 170 });
});

test("draft reconciliation checks only messages persisted by the attempted turn", () => {
  const snapshot: Snapshot = { threads: [{ id: "thread-1", title: "Draft test", knowledgeBaseId: "default", sourceKnowledgeBaseIds: ["default"], createdAt: "2026-08-20T00:00:00Z", updatedAt: "2026-08-20T00:00:02Z", messages: [{ role: "user", content: "old", timestamp: "2026-08-20T00:00:01Z" }, { role: "user", content: "retry", timestamp: "2026-08-20T00:00:02Z" }] }], knowledgeBases: [], pages: [], warnings: [] };
  assert.equal(hasPersistedPrompt(snapshot, "thread-1", 1, "retry"), true);
  assert.equal(hasPersistedPrompt(snapshot, "thread-1", 2, "retry"), false);
});

test("external navigation is limited to HTTP(S)", () => {
  assert.equal(externalUrl("file:///etc/passwd"), null);
  assert.equal(externalUrl("javascript:alert(1)"), null);
  assert.equal(externalUrl("https://openrouter.ai/settings/privacy")?.hostname, "openrouter.ai");
});

test("IPC sender is limited to the local renderer location", () => {
  assert.equal(trustedSender("file:///Applications/Emma/dist-renderer/index.html", "/Applications/Emma"), true);
  assert.equal(trustedSender("file:///tmp/untrusted.html", "/Applications/Emma"), false);
  assert.equal(trustedSender("https://evil.test/", "/Applications/Emma", "http://127.0.0.1:5173"), false);
  assert.equal(trustedSender("http://127.0.0.1:5173/?overlay=1", "/Applications/Emma", "http://127.0.0.1:5173"), true);
});

test("pane layout restores only bounded persisted values", () => {
  assert.deepEqual(validatePaneLayout(null), defaultPaneLayout);
  assert.deepEqual(validatePaneLayout({ navWidth: 10, listWidth: 999, inspectorWidth: 241.4, navCollapsed: true }), {
    ...defaultPaneLayout,
    navWidth: 156,
    listWidth: 380,
    inspectorWidth: 241,
    navCollapsed: true,
  });
});
