import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { externalUrl, runCommandRequest, MAX_ARTIFACT_EDIT_CHARS, MAX_FETCHED_TEXT_CHARS, MAX_SCREEN_CONTEXT_CHARS, metaContent, readablePage, trustedSender, validJpegDataUrl, validateRequest } from "../main/ipc";
import { discoverImports } from "../main/imports";
import { loadUiPlugins, validatePluginCss } from "../main/plugins";
import { activityDays } from "../src/activity";
import { accelLabel, comboKeybind, holdBindings, holdKeybind, keybindLabel, keybindProblem, normalizeAccelerator, canRemoveLocalModel, defaultSettings, fontStack, forgetLocalModel, isEnvName, localEndpoint, localModelEndpoint, maskSecret, MAX_CURSOR_ORBS, MAX_FAVORITE_MODELS, migrateQuickActionDestinations, normalizeLocalModelEndpoint, printableSecret, resolveQuickActionDestination, toggleFavoriteModel, validateOverlayPreferences, validateSettings } from "../shared/settings";
import { DEFAULT_PERMISSION_MODE } from "../shared/permissions";
import { defaultPaneLayout, validatePaneLayout } from "../src/layout";
import { hotspotLayout, nearBounds, overlayGrowth, overlayLayout, parseNotchGeometry, pillLayout, popoutLayout } from "../main/overlay";
import { hasPersistedPrompt } from "../src/drafts";
import type { Snapshot } from "../src/types";
import { BoundedLines, MAX_RECORDED_TURN_BYTES, parseHostLine, recordedTurn } from "../main/ndjson";
import { brandRenderData, matchesLocalAlias } from "../src/brand-data";
import { frontApplicationNote, ScreenContextStore } from "../shared/screen-context";
import { CLEANUP_ENDPOINT, DEFAULT_HOLD_TO_TALK_MS, MAX_UTTERANCE_BYTES, SPEECH_ENDPOINT, SPEECH_MODEL, VOICE_MODEL, cleanedTranscript, isVoiceModel, unknownVoiceStatus, validateUtterance, validateVoiceSettings, voiceBlocker, voiceReady } from "../shared/voice";

test("brand matching keeps versioned local IDs bounded and render data has a neutral fallback", () => {
  assert.equal(matchesLocalAlias("qwen3:8b", "qwen"), true);
  assert.equal(matchesLocalAlias("llama3.2", "llama"), true);
  assert.equal(matchesLocalAlias("gemma3", "gemma"), true);
  assert.equal(matchesLocalAlias("ernie4.5", "ernie"), true);
  assert.equal(matchesLocalAlias("gemmatic", "gemma"), false);
  assert.deepEqual(brandRenderData(undefined), { src: undefined, fallback: "◇" });
  assert.deepEqual(brandRenderData({ fallback: "Q", asset: { src: "/qwen.svg" } }), { src: "/qwen.svg", fallback: "Q" });
});

test("a command pressed play on is bounded before it is spawned", () => {
  assert.deepEqual(runCommandRequest({ command: "  npm test\n" }), { command: "npm test" });
  assert.deepEqual(runCommandRequest({ command: "npm test", folderId: "folder-1" }), { command: "npm test", folderId: "folder-1" });
  assert.throws(() => runCommandRequest({ command: "   " }), /Command is invalid/);
  assert.throws(() => runCommandRequest({ command: "x".repeat(4097) }), /Command is invalid/);
  assert.throws(() => runCommandRequest({ command: "npm test", folderId: "" }), /Command folder is invalid/);
  assert.throws(() => runCommandRequest("npm test"), /Command is invalid/);
});

test("IPC accepts only exact allowlisted payloads", () => {
  assert.deepEqual(validateRequest({ method: "sendMessage", params: { threadId: "thread-123456789", content: "hello" } }), {
    method: "sendMessage",
    params: { threadId: "thread-123456789", content: "hello" },
  });
  assert.equal(validateRequest({ method: "sendMessage", params: { threadId: "thread-123456789", content: "hello", screenContextId: "context-1" } }).params.screenContextId, "context-1");
  assert.equal(validateRequest({ method: "sendMessage", params: { threadId: "thread-123456789", content: "hello", skillAttachmentId: "skill:codex:0:review" } }).params.skillAttachmentId, "skill:codex:0:review");
  assert.throws(() => validateRequest({ method: "sendMessage", params: { threadId: "thread-123456789", content: "hello", screenContext: "data:image/jpeg;base64,/9j/" } }), /Invalid parameters/);
  assert.throws(() => validateRequest({ method: "shell", params: {} }), /not allowed/);
  // Only main writes assistant turns: a renderer that could call these would be
  // able to forge an answer into a thread or submit tool output nobody ran.
  assert.throws(() => validateRequest({ method: "recordTurn", params: { threadId: "thread-123456789", prompt: "p", response: "r" } }), /not allowed/);
  assert.throws(() => validateRequest({ method: "submitToolResult", params: { threadId: "thread-123456789", results: "[]" } }), /not allowed/);
  assert.throws(() => validateRequest({ method: "snapshot", params: { extra: "x" } }), /Invalid parameters/);
  assert.throws(() => validateRequest({ method: "sendMessage", params: { threadId: "x" } }), /Invalid parameters/);
  assert.deepEqual(validateRequest({ method: "selectLocalModel", params: { baseUrl: "http://127.0.0.1:1234/v1", modelId: "qwen3:8b", credentialEnv: "" } }).params, { baseUrl: "http://127.0.0.1:1234/v1", modelId: "qwen3:8b", credentialEnv: "" });
  // The picker sends a blank effort to mean "the model's own default", not "no field".
  assert.deepEqual(validateRequest({ method: "selectOpenRouterModel", params: { modelId: "google/gemma-4-26b-a4b-it:free", effort: "" } }).params, { modelId: "google/gemma-4-26b-a4b-it:free", effort: "" });
  assert.equal(validateRequest({ method: "selectOpenRouterModel", params: { modelId: "x/y" } }).params.modelId, "x/y");
  // Quick Ask sends a blank model to unpin the thread it pinned, which is a value too.
  assert.equal(validateRequest({ method: "setThreadModel", params: { threadId: "thread-123456789", modelId: "" } }).params.modelId, "");
  assert.throws(() => validateRequest({ method: "setThreadModel", params: { threadId: "", modelId: "x/y" } }), /Invalid parameters/);
  assert.deepEqual(validateRequest({ method: "saveScheduledJob", params: { title: "Weekly", schedule: "0 9 * * 1", prompt: "Find reading", sourceDomains: "[]", permissionMode: "ask" } }).method, "saveScheduledJob");
  // A rewrite names the job and carries its graph; a blank one of either is not a value.
  assert.equal(validateRequest({ method: "saveScheduledJob", params: { jobId: "job-123456789012", title: "Weekly", schedule: "manual", prompt: "Find reading", nodes: "[]", sourceDomains: "[]", permissionMode: "ask" } }).params.jobId, "job-123456789012");
  assert.throws(() => validateRequest({ method: "saveScheduledJob", params: { jobId: "", title: "Weekly", schedule: "manual", prompt: "Find reading", sourceDomains: "[]", permissionMode: "ask" } }), /Invalid parameters/);
  assert.throws(() => validateRequest({ method: "setScheduledJobEnabled", params: { jobId: "job-123456789012", enabled: true } }), /Invalid parameters/);
  assert.equal(validateRequest({ method: "updatePage", params: { pageId: "p", title: "x", category: "c", summary: "x", body: "" } }).params.body, "");
  assert.throws(() => validateRequest({ method: "updatePage", params: { pageId: "p", title: "x".repeat(65_536), category: "c", summary: "x".repeat(65_536), body: "x".repeat(65_536) } }), /too large/);
  const artifacts = JSON.stringify([{ id: "summary", type: "rich-text", version: 1, source: {}, payload: { markdown: "Summary" }, fallback: "Summary" }]);
  assert.equal(validateRequest({ method: "updatePageDocument", params: { pageId: "p", title: "x", category: "c", summary: "Summary", body: "Body", artifacts } }).method, "updatePageDocument");
  assert.throws(() => validateRequest({ method: "updatePageDocument", params: { pageId: "p", title: "x", category: "c", summary: "x", body: "x", artifacts: "x".repeat(MAX_ARTIFACT_EDIT_CHARS + 1) } }), /Invalid parameters/);
});

test("knowledge capture and document methods stay inside the host request budget", () => {
  const capture = { knowledgeBaseId: "base-1", category: "research", title: "Paper", text: "Body" };
  assert.equal(validateRequest({ method: "captureToKnowledge", params: capture }).method, "captureToKnowledge");
  assert.equal(validateRequest({ method: "captureToKnowledge", params: { ...capture, sourceUrl: "https://example.com", image: "data:image/jpeg;base64,/9j/" } }).params.image, "data:image/jpeg;base64,/9j/");
  assert.throws(() => validateRequest({ method: "captureToKnowledge", params: { ...capture, image: "x".repeat(MAX_SCREEN_CONTEXT_CHARS + 1) } }), /Invalid parameters/);
  // An image at the field ceiling plus a full text body still has to fit one host request.
  assert.throws(() => validateRequest({ method: "captureToKnowledge", params: { ...capture, text: "x".repeat(60_000), image: `data:image/jpeg;base64,${"A".repeat(MAX_SCREEN_CONTEXT_CHARS - 24)}` } }), /too large/);
  assert.throws(() => validateRequest({ method: "captureToKnowledge", params: { ...capture, unexpected: "x" } }), /Invalid parameters/);
  assert.equal(validateRequest({ method: "listPageVersions", params: { pageId: "p" } }).method, "listPageVersions");
  assert.equal(validateRequest({ method: "restorePageVersion", params: { pageId: "p", name: "0000000001-000000000" } }).method, "restorePageVersion");
  assert.equal(validateRequest({ method: "analyzePage", params: { pageId: "p" } }).method, "analyzePage");
  assert.equal(validateRequest({ method: "chatAboutPage", params: { pageId: "p", content: "What changed?" } }).method, "chatAboutPage");
  assert.equal(validateRequest({ method: "revisePageDocument", params: { pageId: "p", instruction: "Add a chart" } }).method, "revisePageDocument");
  assert.equal(validateRequest({ method: "readPageAsset", params: { name: "asset-1.jpeg" } }).method, "readPageAsset");
  assert.throws(() => validateRequest({ method: "readPageAsset", params: { name: "" } }), /Invalid parameters/);
});

test("host response lines are framed and bounded before JSON parsing", () => {
  const lines = new BoundedLines(8);
  assert.deepEqual(lines.push(Buffer.from("{\"a\":")), []);
  assert.deepEqual(lines.push(Buffer.from("1}\n{}\n")), ["{\"a\":1}", "{}"]);
  lines.end();
  assert.throws(() => new BoundedLines(4).push(Buffer.from("12345")), /too large/);
  const split = new BoundedLines(64);
  assert.deepEqual(split.push(Buffer.from("{\"a\":\"xx")), []);
  assert.deepEqual(split.push(Buffer.from("yy")), []);
  assert.deepEqual(split.push(Buffer.from("zz\"}\n")), ["{\"a\":\"xxyyzz\"}"]);
  split.end();
  const capped = new BoundedLines(6);
  assert.deepEqual(capped.push(Buffer.from("1234")), []);
  assert.throws(() => capped.push(Buffer.from("567")), /too large/);
  assert.deepEqual(parseHostLine('{"id":"1","ok":true,"result":null}'), { id: "1", ok: true, result: null });
  assert.throws(() => parseHostLine('{"id":"1","ok":true}'), /envelope/);
  assert.throws(() => parseHostLine('{"id":"1","ok":false,"error":null}'), /envelope/);
  // The host pushes due jobs and nothing else; a line that resolves no request and is
  // not a job is a protocol the two sides no longer share.
  assert.throws(() => parseHostLine('{"threadId":"t","delta":"hi"}'), /Invalid host response/);
  assert.deepEqual(parseHostLine('{"dueJob":{"jobId":"j","threadId":"t","title":"T","prompt":"p","nodes":"","variables":"{}","permissionMode":"full","depth":0}}'), { dueJob: { jobId: "j", threadId: "t", title: "T", prompt: "p", nodes: "", variables: "{}", permissionMode: "full", depth: 0 } });
  assert.throws(() => parseHostLine('{"dueJob":{"jobId":"j","threadId":"t","title":"T","prompt":"p"}}'), /due job envelope/);
  // The graph, its starting variables and how deep the trigger chain is are part of
  // the envelope: a run missing them would silently become a bare one-step run.
  assert.throws(() => parseHostLine('{"dueJob":{"jobId":"j","threadId":"t","title":"T","prompt":"p","nodes":"","variables":"{}","permissionMode":"full"}}'), /due job envelope/);
});

test("a recorded turn is cut to fit the host's request line", () => {
  const telemetry = { threadId: "t", durationMilliseconds: "1", outputTokens: "0", inputTokens: "0", model: "m" };
  const small = recordedTurn({ ...telemetry, prompt: "hi", thinking: "weighing it up", answer: "done" });
  assert.deepEqual(small, { ...telemetry, prompt: "hi", response: "<think>weighing it up</think>\ndone" });
  const huge = recordedTurn({ ...telemetry, prompt: "hi", thinking: "thought\n".repeat(50_000), answer: "answer\n".repeat(50_000) });
  assert.ok(Buffer.byteLength(JSON.stringify(huge)) <= MAX_RECORDED_TURN_BYTES);
  // Both tags survive the cut, or `splitThinking` reads the whole turn as an
  // unfinished scratchpad and the answer disappears from the transcript.
  assert.match(huge.response, /^<think>thought/);
  assert.match(huge.response, /<\/think>\nanswer/);
  assert.match(huge.response, /characters elided/);
  // One long line loses its middle rather than the whole answer, and the cut
  // never lands between the halves of a surrogate pair.
  const unbroken = recordedTurn({ ...telemetry, prompt: "hi", answer: `x${"🙂".repeat(200_000)}done` });
  assert.ok(Buffer.byteLength(JSON.stringify(unbroken)) <= MAX_RECORDED_TURN_BYTES);
  assert.ok(unbroken.response.startsWith("x🙂"));
  assert.ok(unbroken.response.endsWith("🙂done"));
  assert.equal(Buffer.from(unbroken.response, "utf8").toString("utf8"), unbroken.response);
});

test("screen context accepts only bounded JPEG data URLs", () => {
  assert.equal(validJpegDataUrl("data:image/jpeg;base64,/9j/"), true);
  assert.equal(validJpegDataUrl("data:image/png;base64,iVBORw0="), false);
  assert.equal(validJpegDataUrl("data:image/jpeg;base64,not base64"), false);
});

test("screen context delivery stays one-shot", () => {
  const store = new ScreenContextStore();
  store.put({ id: "context-1", image: "data:image/jpeg;base64,/9j/" });
  assert.deepEqual(store.status(), { id: "context-1", image: "data:image/jpeg;base64,/9j/" });
  assert.equal(store.claim("context-1").image, "data:image/jpeg;base64,/9j/");
  assert.throws(() => store.claim("context-1"), /unavailable/);
  store.finish("context-1", false);
  assert.deepEqual(store.status(), { id: "context-1", image: "data:image/jpeg;base64,/9j/" });
  store.claim("context-1");
  store.finish("context-1", true);
  assert.equal(store.status(), null);
});

test("a capture tells the agent whose screen it is", () => {
  assert.equal(frontApplicationNote(undefined), "");
  assert.equal(frontApplicationNote({ application: "", window: "Untitled" }), "");
  assert.match(frontApplicationNote({ application: "Figma", window: "Figma" }), /“Figma”\.$/);
  assert.match(frontApplicationNote({ application: "Figma", window: "Board" }), /“Figma”, window “Board”\.$/);
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

test("activity covers the current week only", () => {
  const days = activityDays(["2026-08-17T10:00:00Z", "2026-08-17T11:00:00Z", "2026-01-02T10:00:00Z"], new Date("2026-08-20T00:00:00Z"));
  assert.equal(days.length, 7);
  assert.equal(days[0].date, "2026-08-16");
  assert.equal(days[1].count, 2);
  assert.equal(days.at(-1)?.date, "2026-08-22");
});

test("settings require three actions and local-only transcription", () => {
  assert.equal(validateSettings(defaultSettings).quickActions.length, 3);
  assert.equal(localEndpoint("http://127.0.0.1:8080/v1/audio/transcriptions")?.hostname, "127.0.0.1");
  assert.equal(localEndpoint("https://api.openai.com/v1/audio/transcriptions"), null);
  assert.throws(() => validateSettings({ ...defaultSettings, quickActions: [] }), /three/);
});

test("the default permission mode round-trips, and a store that predates it opens on Ask", () => {
  assert.equal(validateSettings({ ...defaultSettings, defaultPermissionMode: "acceptEdits" }).defaultPermissionMode, "acceptEdits");
  const legacy = { ...defaultSettings } as Record<string, unknown>;
  delete legacy.defaultPermissionMode;
  assert.equal(validateSettings(legacy).defaultPermissionMode, DEFAULT_PERMISSION_MODE);
  // A rung nobody ships is not a reason to lose the rest of the settings.
  assert.equal(validateSettings({ ...defaultSettings, defaultPermissionMode: "root" }).defaultPermissionMode, DEFAULT_PERMISSION_MODE);
});

test("voice settings stay local and survive stores that predate them", () => {
  // The whole point of the cleanup stage is that it is another local server, not a cloud one.
  assert.throws(() => validateSettings({ ...defaultSettings, voiceCleanupEndpoint: "https://api.openai.com/v1/chat/completions" }), /local/);
  assert.throws(() => validateSettings({ ...defaultSettings, voiceHoldMs: 5 }), /Voice/);
  assert.throws(() => validateSettings({ ...defaultSettings, voiceCleanupModel: "" }), /Voice/);
  assert.equal(validateSettings({ ...defaultSettings, voiceHoldMs: 800 }).voiceHoldMs, 800);
  const legacy = { ...defaultSettings } as Record<string, unknown>;
  delete legacy.voiceHoldMs; delete legacy.voiceCleanup; delete legacy.voiceCleanupEndpoint; delete legacy.voiceCleanupModel;
  assert.equal(validateSettings(legacy).voiceHoldMs, DEFAULT_HOLD_TO_TALK_MS);
  assert.equal(validateSettings(legacy).voiceCleanupModel, VOICE_MODEL);
});

test("main re-checks the voice payload the renderer sends it", () => {
  const settings = { transcriptionEngine: "server" as const, transcriptionEndpoint: SPEECH_ENDPOINT, transcriptionModel: SPEECH_MODEL, voiceCleanup: true, voiceCleanupEndpoint: CLEANUP_ENDPOINT, voiceCleanupModel: VOICE_MODEL };
  assert.deepEqual(validateVoiceSettings(settings), settings);
  assert.throws(() => validateVoiceSettings({ ...settings, voiceCleanup: "yes" }), /invalid/);
  assert.throws(() => validateVoiceSettings({ ...settings, transcriptionEngine: "sphinx" }), /invalid/);
  assert.throws(() => validateVoiceSettings({ ...settings, transcriptionModel: " " }), /invalid/);
  assert.throws(() => validateVoiceSettings(null), /invalid/);
  const audio = new ArrayBuffer(16);
  assert.equal(validateUtterance({ audio, mimeType: "audio/wav" }).mimeType, "audio/wav");
  assert.throws(() => validateUtterance({ audio: new ArrayBuffer(0), mimeType: "audio/wav" }), /Nothing was recorded/);
  assert.throws(() => validateUtterance({ audio: new ArrayBuffer(MAX_UTTERANCE_BYTES + 1), mimeType: "audio/wav" }), /too long/);
  assert.throws(() => validateUtterance({ audio, mimeType: "text/html" }), /invalid/);
  assert.throws(() => validateUtterance({ audio: "not a buffer", mimeType: "audio/webm" }), /invalid/);
});

test("cleanup can improve a transcript but never replace it with something else", () => {
  assert.equal(cleanedTranscript("um so i think we should ship it", "So I think we should ship it."), "So I think we should ship it.");
  // A wrong model under the same name answers *about* the transcript; keep what was heard.
  assert.equal(cleanedTranscript("ship it", "Certainly! Here is an analysis of the transcript you provided, along with several suggestions for how it might be improved."), "ship it");
  assert.equal(cleanedTranscript("um", ""), "");
  assert.equal(cleanedTranscript("a real sentence that was definitely spoken", ""), "a real sentence that was definitely spoken");
  // Thinking mode left on is the model card's named failure: strip the block, keep the answer.
  assert.equal(cleanedTranscript("ship it friday", "<think>\nThe user said friday.\n</think>\n\nShip it Friday."), "Ship it Friday.");
  assert.ok(isVoiceModel("s1-mini-q4_k_m.gguf") && isVoiceModel("superwhisper/s1-mini-GGUF") && !isVoiceModel("Qwen3-ASR-0.6B"));
});

test("the island names the one thing blocking dictation", () => {
  const on = { transcriptionEnabled: true, transcriptionEngine: "server" as const };
  const live = { ...unknownVoiceStatus, microphone: "granted" as const, speech: true };
  assert.equal(voiceReady(live, on), true);
  assert.equal(voiceBlocker(live, on), "");
  // Cleanup being absent costs punctuation, not speech — it must not block.
  assert.equal(voiceReady({ ...live, cleanup: false, model: false }, on), true);
  assert.match(voiceBlocker(live, { ...on, transcriptionEnabled: false }), /off/);
  assert.match(voiceBlocker({ ...live, microphone: "denied" }, on), /Microphone/);
  assert.match(voiceBlocker({ ...live, speech: false }, on), /speech-to-text/);
  // The macOS engine knows why it cannot hear, and that sentence is what the island shows.
  const apple = { ...on, transcriptionEngine: "apple" as const };
  assert.match(voiceBlocker({ ...live, speech: false, speechError: "Dictation is off." }, apple), /Dictation is off/);
  assert.match(voiceBlocker({ ...live, speech: false }, apple), /macOS recognizer/);
});

test("the macOS engine needs no endpoint, and the server engine still does", () => {
  assert.equal(validateSettings({ ...defaultSettings, transcriptionEnabled: true }).transcriptionEngine, "apple");
  // The endpoint is meaningless to the macOS recognizer, so a broken one must not block a save.
  assert.equal(validateSettings({ ...defaultSettings, transcriptionEnabled: true, transcriptionEndpoint: "https://example.com/v1/audio/transcriptions" }).transcriptionEngine, "apple");
  assert.throws(() => validateSettings({ ...defaultSettings, transcriptionEnabled: true, transcriptionEngine: "server", transcriptionEndpoint: "https://example.com/v1/audio/transcriptions" }), /local/);
  assert.throws(() => validateSettings({ ...defaultSettings, transcriptionEngine: "sphinx" }), /Transcription/);
  // Settings saved before the engine existed configured the server one, and keep it.
  const legacy = { ...defaultSettings } as Record<string, unknown>;
  delete legacy.transcriptionEngine;
  assert.equal(validateSettings(legacy).transcriptionEngine, "server");
});

test("font choices survive a round trip and reject anything unlisted", () => {
  const settings = validateSettings({ ...defaultSettings, interfaceFont: "serif", agentFont: "mono" });
  assert.equal(settings.interfaceFont, "serif");
  assert.match(fontStack(settings.agentFont), /ui-monospace/);
  // Older stored settings predate the fields and must still load.
  const legacy = { ...defaultSettings } as Record<string, unknown>;
  delete legacy.interfaceFont; delete legacy.agentFont;
  assert.equal(validateSettings(legacy).interfaceFont, defaultSettings.interfaceFont);
  assert.throws(() => validateSettings({ ...defaultSettings, agentFont: "comic-sans" }), /Font/);
});

test("quick action destinations use base IDs and migrate legacy names", () => {
  const bases = [{ id: "kb-research-opaque", name: "Research" }, { id: "kb-writing-opaque", name: "Writing" }];
  const legacy = validateSettings({ ...defaultSettings, quickActions: defaultSettings.quickActions.map((action, index) => index === 0 ? { ...action, destinationKnowledgeBaseId: "Research" } : action) });
  const migrated = migrateQuickActionDestinations(legacy, bases);
  assert.equal(migrated.quickActions[0].destinationKnowledgeBaseId, "kb-research-opaque");
  assert.equal(resolveQuickActionDestination("kb-writing-opaque", bases), "kb-writing-opaque");
  assert.equal(resolveQuickActionDestination("removed-base", bases), undefined);
  assert.equal(migrated.quickActions[0].prompt, legacy.quickActions[0].prompt);
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

test("provider keys mask their middle and never leak their length", () => {
  const key = "sk-or-v1-0123456789abcdef0123456789abcdef";
  const masked = maskSecret(key);
  assert.equal(masked, "sk-or-••••••••••cdef");
  assert.equal(masked.includes(key.slice(6, -4)), false);
  assert.equal(maskSecret(`${key}${key}`).length, masked.length);
  assert.equal(maskSecret("short"), "••••••••");
  assert.ok(isEnvName("OPENROUTER_API_KEY") && !isEnvName("9KEY") && !isEnvName("MY KEY"));
  assert.ok(printableSecret(key) && !printableSecret("sk or") && !printableSecret("sk\nor"));
});

test("starred models cap at six and drop with their local profile", () => {
  const base = validateSettings({ ...defaultSettings, favoriteModels: [], localModels: [{ id: "local-qwen", name: "Qwen local", modelId: "qwen3:8b", baseUrl: "http://127.0.0.1:1234/v1", credentialEnv: "" }] });
  const full = ["a", "b", "c", "d", "e", "f"].reduce((settings, id) => toggleFavoriteModel(settings, `openrouter:vendor/${id}:free`), base);
  assert.equal(validateSettings(full).favoriteModels.length, MAX_FAVORITE_MODELS);
  assert.throws(() => toggleFavoriteModel(full, "local:local-qwen"), /unstar one/);
  assert.equal(toggleFavoriteModel(full, "openrouter:vendor/a:free").favoriteModels.length, 5);
  assert.equal(toggleFavoriteModel(full, "openrouter:vendor/a:free").favoriteModels[0], "openrouter:vendor/f:free");
  const starred = toggleFavoriteModel(base, "local:local-qwen");
  assert.deepEqual(forgetLocalModel(starred, "local-qwen"), { ...base, localModels: [] });
  assert.throws(() => validateSettings({ ...base, favoriteModels: ["fallback", "fallback"] }), /invalid/);
});

test("overlay settings migrate old values and keep calibration bounded", () => {
  const legacy = { quickActions: defaultSettings.quickActions, transcriptionEnabled: defaultSettings.transcriptionEnabled, transcriptionEndpoint: defaultSettings.transcriptionEndpoint, transcriptionModel: defaultSettings.transcriptionModel };
  assert.deepEqual(validateSettings(legacy).notchGap, defaultSettings.notchGap);
  // Old stores predate the cursor ring; it comes back with its defaults rather than failing.
  assert.deepEqual(validateSettings(legacy).cursorOrbs, defaultSettings.cursorOrbs);
  assert.equal(validateSettings(legacy).cursorOrbsEnabled, true);
  // An older renderer sends no notch behaviour; it comes back on the default rather than failing.
  assert.deepEqual(validateOverlayPreferences({ notchGap: 196, cursorOrbsEnabled: false }), { notchGap: 196, cursorOrbsEnabled: false, notchConcurrency: "separate" });
  assert.equal(validateOverlayPreferences({ notchGap: 196, cursorOrbsEnabled: false, notchConcurrency: "continue" }).notchConcurrency, "continue");
  assert.equal(validateOverlayPreferences({ notchGap: 196, cursorOrbsEnabled: false, notchConcurrency: "both" }).notchConcurrency, "separate");
  assert.throws(() => validateOverlayPreferences({ notchGap: 261, cursorOrbsEnabled: true }), /invalid/);
  assert.throws(() => validateOverlayPreferences({ notchGap: 196 }), /invalid/);
  // The ring holds 1 to MAX_CURSOR_ORBS known commands, in any order, duplicates allowed.
  assert.deepEqual(validateSettings({ ...defaultSettings, cursorOrbs: ["draw", "draw", "workspace"] }).cursorOrbs, ["draw", "draw", "workspace"]);
  assert.throws(() => validateSettings({ ...defaultSettings, cursorOrbs: [] }), /cursor orbs/);
  assert.throws(() => validateSettings({ ...defaultSettings, cursorOrbs: Array(MAX_CURSOR_ORBS + 1).fill("screen") }), /cursor orbs/);
  assert.throws(() => validateSettings({ ...defaultSettings, cursorOrbs: ["rm -rf"] }), /cursor orbs/);
  // The notch defaults to the workspace's model and to a task of its own; only an
  // OpenRouter route can be pinned to a thread, so nothing else may be saved as one.
  assert.equal(validateSettings(legacy).notchModel, "");
  assert.equal(validateSettings(legacy).notchConcurrency, "separate");
  assert.equal(validateSettings({ ...defaultSettings, notchModel: "openrouter:vendor/model" }).notchModel, "openrouter:vendor/model");
  assert.throws(() => validateSettings({ ...defaultSettings, notchModel: "local:profile-1" }), /Quick Ask model/);
  assert.throws(() => validateSettings({ ...defaultSettings, notchModel: "fallback" }), /Quick Ask model/);
  assert.throws(() => validateSettings({ ...defaultSettings, notchConcurrency: "queue" as never }), /Quick Ask behaviour/);
});

test("overlay geometry hangs off the reported camera housing and falls back to the calibrated gap", () => {
  const notched = { bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 38, width: 1512, height: 944 } };
  const housing = { id: 1, x: 663, width: 185, height: 38 };
  // The island covers the menu bar and centres on the housing.
  const island = overlayLayout(notched, { notchGap: 180 }, housing);
  assert.deepEqual(island.bounds, { x: 446, y: 0, width: 620, height: 261 });
  assert.deepEqual(island.notch, { left: 217, width: 185, height: 38 });
  // No housing: a virtual notch of the calibrated gap, centred on the display.
  const external = { bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, workArea: { x: -1920, y: 25, width: 1920, height: 1055 } };
  const plain = overlayLayout(external, { notchGap: 180 });
  assert.deepEqual(plain.bounds, { x: -1270, y: 0, width: 620, height: 248 });
  assert.deepEqual(plain.notch, { left: 220, width: 180, height: 25 });
  // The idle hover target is the housing plus a small margin, hanging just below the menu bar.
  const target = hotspotLayout(notched, housing);
  assert.deepEqual(target, { bounds: { x: 649, y: 0, width: 213, height: 82 }, notch: { left: 14, width: 185, height: 38 } });
  // The sliver only exists while the cursor is near it, so the hover radius and the wider
  // radius that builds the window ahead of the cursor both have to hold at their edges.
  assert.equal(nearBounds(target.bounds, { x: 700, y: 20 }), true);
  assert.equal(nearBounds(target.bounds, { x: 649, y: 82 }), true);
  assert.equal(nearBounds(target.bounds, { x: 648, y: 20 }), false);
  assert.equal(nearBounds(target.bounds, { x: 700, y: 83 }), false);
  assert.equal(nearBounds(target.bounds, { x: 500, y: 250 }, 220), true);
  assert.equal(nearBounds(target.bounds, { x: 428, y: 20 }, 220), false);
  assert.equal(nearBounds(target.bounds, { x: 700, y: 303 }, 220), false);
  // The island stays inside the display when the housing sits near an edge.
  const edge = overlayLayout(notched, { notchGap: 180 }, { ...housing, x: 1300 });
  assert.deepEqual(edge.bounds.x, 892);
  // The quick thread may extend the island, bounded, and only through a finite number.
  assert.equal(overlayGrowth(120.4), 120);
  assert.equal(overlayGrowth(9999), 260);
  assert.equal(overlayGrowth(-5), 0);
  assert.equal(overlayGrowth("120"), 0);
  assert.equal(overlayGrowth(Number.NaN), 0);
  assert.deepEqual(parseNotchGeometry('[{"id":1,"x":663.0,"width":185.5,"height":38}]'), [{ id: 1, x: 663, width: 186, height: 38 }]);
  assert.deepEqual(parseNotchGeometry("[]"), []);
  assert.throws(() => parseNotchGeometry('[{"id":1,"x":663,"width":8,"height":38}]'), /invalid/);
  assert.throws(() => parseNotchGeometry('[{"id":1,"x":663,"width":185}]'), /invalid/);
});

test("the status chip parks inside the work area and the island opens beside it", () => {
  const display = { bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 38, width: 1512, height: 944 } };
  // Nothing dragged yet: the top right corner, under the menu bar rather than through it.
  assert.deepEqual(pillLayout(display), { x: 1452, y: 54, width: 44, height: 44 });
  // Dragged: where the user put it, and never past an edge it could not be grabbed back from.
  assert.deepEqual(pillLayout(display, { x: 300, y: 500 }), { x: 300, y: 500, width: 44, height: 44 });
  assert.deepEqual(pillLayout(display, { x: 4000, y: 4000 }), { x: 1468, y: 938, width: 44, height: 44 });
  assert.deepEqual(pillLayout(display, { x: -40, y: -40 }), { x: 0, y: 38, width: 44, height: 44 });
  // The island hangs off the chip: its own inset to the left of it, and as tall as the
  // thread it collapsed with.
  const beside = popoutLayout(display, { x: 300, y: 500 }, 120);
  assert.deepEqual(beside, { bounds: { x: 280, y: 500, width: 620, height: 245 }, base: 125 });
  // A chip parked in the corner pulls the island back onto the display rather than off it.
  assert.deepEqual(popoutLayout(display, { x: 1452, y: 938 }).bounds, { x: 892, y: 857, width: 620, height: 125 });
  // Growth arrives from the renderer, so the same bound applies here as to the island.
  assert.equal(popoutLayout(display, { x: 300, y: 500 }, 9999).bounds.height, 385);
  assert.equal(popoutLayout(display, { x: 300, y: 500 }, "120").bounds.height, 125);
});

test("draft reconciliation checks only messages persisted by the attempted turn", () => {
  const snapshot: Snapshot = { threads: [{ id: "thread-1", title: "Draft test", knowledgeBaseId: "default", sourceKnowledgeBaseIds: ["default"], createdAt: "2026-08-20T00:00:00Z", updatedAt: "2026-08-20T00:00:02Z", messages: [{ role: "user", content: "old", timestamp: "2026-08-20T00:00:01Z" }, { role: "user", content: "retry", timestamp: "2026-08-20T00:00:02Z" }] }], knowledgeBases: [], pages: [], scheduledJobs: [], researchJobs: [], warnings: [] };
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
  assert.deepEqual(validatePaneLayout({ sidebarWidth: 10, inspectorWidth: 301.6, sidebarCollapsed: true }), {
    ...defaultPaneLayout,
    sidebarWidth: 200,
    inspectorWidth: 302,
    sidebarCollapsed: true,
  });
  const fitted = validatePaneLayout({ sidebarWidth: 340, inspectorWidth: 360 }, 900);
  assert.deepEqual([fitted.sidebarWidth, fitted.inspectorWidth], [270, 310]);
  assert.ok(900 - fitted.sidebarWidth - fitted.inspectorWidth >= 320);
  // An unpainted window reports 0 — it must not be read as "no room", or the widths
  // shrink to their minimums and the caller persists that over the user's own.
  const saved = { sidebarWidth: 340, inspectorWidth: 360 };
  assert.deepEqual(validatePaneLayout(saved, 0), validatePaneLayout(saved));
});

test("a fetched page becomes plain captured text", () => {
  const page = readablePage(`<html><head><title>Grid  &amp; Flex</title><style>p{color:red}</style></head>
    <body><script>alert("no")</script><h1>Heading</h1><p>First &lt;line&gt;.</p><ul><li>One</li><li>Two</li></ul>
    <p>Caf&#233; &nbsp; break<br>next</p></body></html>`);
  assert.equal(page.title, "Grid & Flex");
  assert.match(page.text, /^Heading/);
  assert.match(page.text, /First <line>\./);
  assert.match(page.text, /One\n\nTwo/);
  assert.match(page.text, /Caf\u00e9 break\nnext/);
  assert.doesNotMatch(page.text, /alert|color:red|<\/?(p|h1|li|ul)>/);
  assert.equal(readablePage(`<p>${"x".repeat(MAX_FETCHED_TEXT_CHARS * 2)}</p>`).text.length, MAX_FETCHED_TEXT_CHARS);
});

test("a clipped page keeps the article and drops the site's furniture", () => {
  const page = readablePage(`<html><head><title>Repo · GitHub</title>
    <meta property="og:title" content="NousResearch/hermes-agent"></head>
    <body><header><nav><a href="/pricing">Solutions BY COMPANY SIZE Enterprises</a><a href="/copilot">Platform AI CODE CREATION</a></nav></header>
      <main><h1>hermes-agent</h1><p>${"The agent that grows with you. ".repeat(20)}</p><nav>On this page</nav></main>
      <footer>© GitHub</footer></body></html>`);
  // og:title over <title>: the page's own name for itself, without the site's suffix.
  assert.equal(page.title, "NousResearch/hermes-agent");
  assert.match(page.text, /^hermes-agent/);
  assert.doesNotMatch(page.text, /COMPANY SIZE|CODE CREATION|On this page|© GitHub/);
});

test("a page built by script is captured as its own description", () => {
  // A video page: the body is a script and a mount point, so stripping tags leaves
  // nothing worth filing. The description is what the page would have shown.
  const page = readablePage(`<html><head><title>Some talk - YouTube</title>
    <meta property="og:description" content="A talk about agents that grow with you.">
    <meta property="og:image" content="https://i.ytimg.com/vi/x/hq.jpg"></head>
    <body><div id="app"></div><script>boot()</script></body></html>`);
  assert.equal(page.text, "A talk about agents that grow with you.");
});

test("a meta name ends where it ends", () => {
  const html = `<meta property="og:image:width" content="1280"><meta content='https://i.ytimg.com/vi/x/hq.jpg' property="og:image">`;
  assert.equal(metaContent(html, "og:image"), "https://i.ytimg.com/vi/x/hq.jpg");
  assert.equal(metaContent(html, "og:audio"), "");
});

test("keybinds refuse what macOS and app menus already own", () => {
  assert.equal(keybindProblem("Command+Alt+E"), "");
  assert.equal(keybindProblem("Control+Shift+Space"), "");
  // No ⌘/⌃/⌥ means it fires mid-sentence; ⌘ plus one key is menu-bar territory.
  assert.match(keybindProblem("Shift+K"), /Add ⌘/);
  assert.match(keybindProblem("Command+S"), /app menus/);
  assert.notEqual(keybindProblem("Command+Space"), "");
  assert.match(keybindProblem("Command+Shift+4"), /macOS already/);
  assert.match(keybindProblem("Control+Up"), /macOS already/);
  assert.match(keybindProblem("Command+Alt+Sleep"), /normal key/);
  // Modifier order never changes which shortcut this is.
  assert.equal(normalizeAccelerator("Shift+Alt+Command+K"), "Command+Alt+Shift+K");
  assert.equal(accelLabel("Alt+Command+Space"), "⌘⌥␣");
  assert.deepEqual(validateSettings({ ...defaultSettings, keybinds: { toggle: comboKeybind("Alt+Shift+Command+E"), draw: comboKeybind("") } }).keybinds, { toggle: comboKeybind("Command+Alt+Shift+E") });
  // Old stores have no keybinds at all, and one combination cannot run two actions.
  assert.deepEqual(validateSettings({ ...defaultSettings, keybinds: undefined }).keybinds, {});
  assert.throws(() => validateSettings({ ...defaultSettings, keybinds: { toggle: comboKeybind("Control+Alt+E"), draw: comboKeybind("Alt+Control+E") } }), /bound twice/);
  assert.throws(() => validateSettings({ ...defaultSettings, keybinds: { nope: comboKeybind("Control+Alt+E") } }), /invalid/);
});

test("holds are modifiers only, and reach the native listener as key codes", () => {
  const held = validateSettings({ ...defaultSettings, keybinds: { voice: holdKeybind("AltLeft", 500) } }).keybinds;
  assert.deepEqual(held, { voice: holdKeybind("AltLeft", 500) });
  assert.equal(keybindLabel(held.voice!), "Hold ⌥ left · 500ms");
  // Only what the listener needs: which physical key, and for how long.
  assert.deepEqual(holdBindings({ voice: holdKeybind("AltRight", 750), toggle: comboKeybind("Control+Alt+E") }), [{ id: "voice", keyCode: 61, ms: 750 }]);
  // A held letter would autorepeat into whatever is in front, so it is not bindable.
  assert.throws(() => validateSettings({ ...defaultSettings, keybinds: { voice: holdKeybind("KeyE", 500) } }), /modifier key/);
  assert.throws(() => validateSettings({ ...defaultSettings, keybinds: { voice: holdKeybind("AltLeft", 5000) } }), /too short or too long/);
  // The same modifier cannot run two actions, whatever each one's duration is.
  assert.throws(() => validateSettings({ ...defaultSettings, keybinds: { voice: holdKeybind("AltLeft", 500), draw: holdKeybind("AltLeft", 1000) } }), /bound twice/);
  assert.throws(() => validateSettings({ ...defaultSettings, keybinds: { voice: { accelerator: "Control+Alt+E", hold: "AltLeft", ms: 500 } } }), /invalid/);
});

test("readablePage does not spill a data-props JSON blob into the text", () => {
  const props = '{&quot;template&quot;:&quot;<role>SYSTEM</role>&quot;,&quot;cls_token&quot;:&quot;[CLS]&quot;}';
  const page = readablePage(`<html><body><main><div data-props="${props}"><p>Model card body.</p></div></main></body></html>`);
  assert.equal(page.text, "Model card body.");
});
