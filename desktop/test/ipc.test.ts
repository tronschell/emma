import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { externalUrl, trustedSender, validJpegDataUrl, validateRequest } from "../main/ipc";
import { discoverImports } from "../main/imports";
import { loadUiPlugins, validatePluginCss } from "../main/plugins";
import { activityDays } from "../src/activity";
import { deriveAgentInsights } from "../src/agent-insights";
import { canRemoveLocalModel, defaultSettings, localEndpoint, localModelEndpoint, normalizeLocalModelEndpoint, validateOverlayPreferences, validateSettings } from "../shared/settings";
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
  assert.deepEqual(validateRequest({ method: "selectLocalModel", params: { baseUrl: "http://127.0.0.1:1234/v1", modelId: "qwen3:8b", credentialEnv: "" } }).params, { baseUrl: "http://127.0.0.1:1234/v1", modelId: "qwen3:8b", credentialEnv: "" });
  assert.deepEqual(validateRequest({ method: "createScheduledJob", params: { title: "Weekly", schedule: "0 9 * * 1", prompt: "Find reading", sourceDomains: "[]" } }).method, "createScheduledJob");
  assert.throws(() => validateRequest({ method: "setScheduledJobEnabled", params: { jobId: "job-123456789012", enabled: true } }), /Invalid parameters/);
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

test("agent insights deterministically derive domain and category evidence from the last 60 days", () => {
  const page = (title: string, addedAt: string, url: string, category = "research") => ({ id: title.padEnd(16, "x"), knowledgeBaseId: "default", title, category, context: { text: title, sourceUrl: url }, analysis: { summary: title, body: title }, sources: [{ title: "source", url }], addedAt, analyzedAt: addedAt, telemetry: { model: "local", inputTokens: 1, outputTokens: 1, subagentCount: 0 } });
  const snapshot: Snapshot = { threads: [], knowledgeBases: [{ id: "default", name: "Default", createdAt: "1970-01-01T00:00:00Z", categories: [] }], pages: [page("recent-b", "2026-08-19T00:00:00Z", "https://www.example.com/b"), page("recent-a", "2026-08-18T00:00:00Z", "https://example.com/a"), page("old", "2026-01-01T00:00:00Z", "https://old.test")], scheduledJobs: [], warnings: [] };
  const insights = deriveAgentInsights(snapshot, new Date("2026-08-20T00:00:00Z"));
  assert.deepEqual(insights.domains[0], { domain: "example.com", count: 2, titles: ["recent-b", "recent-a"] });
  assert.deepEqual(insights.categories[0], { category: "research", base: "Default", count: 2, titles: ["recent-b", "recent-a"] });
  assert.equal(insights.domains.some((item) => item.domain === "old.test"), false);
});

test("settings require three actions and local-only transcription", () => {
  assert.equal(validateSettings(defaultSettings).quickActions.length, 3);
  assert.equal(localEndpoint("http://127.0.0.1:8080/v1/audio/transcriptions")?.hostname, "127.0.0.1");
  assert.equal(localEndpoint("https://api.openai.com/v1/audio/transcriptions"), null);
  assert.throws(() => validateSettings({ ...defaultSettings, quickActions: [] }), /three/);
});

test("local model profiles stay loopback-only and support keyless servers", () => {
  assert.equal(localModelEndpoint("HTTP://LOCALHOST:1234/v1")?.hostname, "localhost");
  assert.equal(normalizeLocalModelEndpoint("HTTP://LOCALHOST:1234/v1/"), "http://localhost:1234/v1");
  const settings = validateSettings({ ...defaultSettings, localModels: [{ id: "local-qwen", name: "Qwen local", modelId: "qwen3:8b", baseUrl: "HTTP://LOCALHOST:1234/v1/", credentialEnv: "" }], selectedModel: "local:local-qwen" });
  assert.equal(settings.localModels[0].baseUrl, "http://localhost:1234/v1");
  assert.equal(settings.localModels[0].credentialEnv, "");
  assert.equal(canRemoveLocalModel(settings, "local-qwen"), false);
  assert.equal(canRemoveLocalModel(settings, "other"), true);
  assert.equal(localModelEndpoint("http://localhost.evil/v1"), null);
  assert.throws(() => validateSettings({ ...defaultSettings, localModels: [{ id: "local-bad", name: "Bad", modelId: "bad", baseUrl: "https://api.example.test/v1", credentialEnv: "" }] }), /profile/);
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
  const snapshot: Snapshot = { threads: [{ id: "thread-1", title: "Draft test", knowledgeBaseId: "default", sourceKnowledgeBaseIds: ["default"], createdAt: "2026-08-20T00:00:00Z", updatedAt: "2026-08-20T00:00:02Z", messages: [{ role: "user", content: "old", timestamp: "2026-08-20T00:00:01Z" }, { role: "user", content: "retry", timestamp: "2026-08-20T00:00:02Z" }] }], knowledgeBases: [], pages: [], scheduledJobs: [], warnings: [] };
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
