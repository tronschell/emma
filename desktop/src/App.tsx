import { Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import type { AgentImportSource, Connection, CredentialSummary, HeldAttachment, ImportedMcpServer, ImportedSkill, ToolTarget, Message, ModelModality, OpenRouterCatalog, OverlaySurface, ScheduledJob, Snapshot, Thread } from "./types";
import { describeRun, describeTrigger, parseVariables, parseWorkflow, runWorkflow, triggerProblem } from "../shared/workflow";
import { PluginsView } from "./plugins";
import { PromptField, TriggerPicker, useTaskCommands, WorkflowGraph } from "./schedule";
import { plural } from "./plural";
import { zoned } from "./dates";
import { nested, threadDepth, threadLabel } from "./threads";
import { comboKeybind, DEFAULT_HOLD_MS, holdKeybind, HOLD_DURATIONS, HOLD_KEYS, keybindLabel, keybindProblem, KEYBIND_ACTIONS, normalizeAccelerator, type Keybind, type KeybindAction, type Keybinds } from "../shared/settings";
import { ACCENT_CHOICES, MIN_UI_SCALE, MAX_UI_SCALE, canRemoveLocalModel, tagName, thinkingStops, type ThinkingLevel, type NotchConcurrency, CURSOR_COMMANDS, FREE_ROUTER_KEY, FREE_ROUTER_MODELS, freeRouterChain, MAX_EXPERIMENT_STEPS, type HarnessExperiments, FONT_CHOICES, fontStack, cursorCommandGlyphs, cursorCommandNames, defaultSettings, forgetLocalModel, freeModels, isEnvName, MAX_CURSOR_ORBS, MAX_FAVORITE_MODELS, MAX_SECRET_CHARS, MAX_SYSTEM_PROMPT_CHARS, MAX_VERIFIER_SYSTEM_CHARS, defaultAdvisorSystem, defaultVisionSystem, defaultVerifierSystem, verifierFromKey, verifierKey, OPENROUTER_CHAT_ENDPOINT, providerCredentials, toggleFavoriteModel, validateSettings, WEB_SEARCH_PROVIDERS, webSearchCredentials, webSearchProvider, type AccentChoice, type CursorCommand, type FontChoice, type LocalModelProfile, type ToolSettings, type UserSettings, type VerifierSettings, type WebSearchProvider, type WebSearchSettings } from "../shared/settings";
import { TOOL_CATALOG } from "../shared/permissions";
import { defaultPaneLayout, MIN_BROWSER_WIDTH, NAV_VIEWS, ordered, validatePaneLayout, WIDE_BROWSER_WIDTH, type PaneLayout } from "./layout";
import { DndContext, MeasuringStrategy, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { hasPersistedPrompt } from "./drafts";
import { arrived, dropQueued, groupBlocks, pairBlocks, sendTurn, takeDraft, thinkingOf, useRun, withoutThinking, wrote, type Block } from "./runs";
import { splitThinking } from "../shared/thinking";
import { brandForConnection, brandForImporter, brandForModel, brandForProvider, providerBrands, type BrandDefinition } from "./brands";
import { DEFAULT_SYSTEM_PROMPT, forkPreset, MAX_PROMPTS, MAX_PROMPT_NAME_CHARS, MODEL_FAMILIES, newPresetId, promptApplies, promptSegments, PROMPT_VARIABLES, type PromptPreset } from "../shared/prompts";
import { validScreenContextId } from "../shared/screen-context";
import { highlightSegments, insertCommand, KIND_LABELS, matchCommands, mentions, MENU_MAX, slashQuery, type SlashCommand } from "../shared/slash";
import { pickKey, type ContextPick, type FolderFile, type FolderGrant } from "../shared/folders";
import { charLabel, CHARS_PER_TOKEN, type ContextUse } from "../shared/usage";
import { formatDuration } from "../shared/trace";
import { ContextBarSettings, ContextWidgets, readContextPage, useContextLedger, useThreadCalls, writeContextPage } from "./context-bar";
import { MAX_CONTEXT_PAGES, type ContextPage } from "../shared/context-bar";
import { Markdown } from "./markdown";
import { RunContext } from "./run-block";
import { openPreview, PreviewHost } from "./preview";
import { ArtifactCard, ArtifactsView } from "./artifacts";
import { Visual } from "./visual";
import { Region } from "./regions";
import { ARTIFACT_LABELS, artifactWritten, type Artifact, type ArtifactMeta } from "../shared/artifacts";
import { atCommands, buildAttachedContext, cachedBlocks, clearedAt, contextCommands, handTags, markCleared, overlayMode, pickLabel, recordUses, rememberBlocks, rememberTurnAttachments, setOverlayMode, setThreadFolders, setThreadMode, setThreadTag, threadBreakdown, threadExperiments, threadFolderMap, threadFolders, threadMode, threadTags, threadUses, toolCommands, turnAttachments, type TurnAttachment } from "./context";
import { AgentPanel, AgentRail, BackgroundRail, ChangeCount, ChangesPanel, ModeMenu, ModePicker, ModeTrigger, PermissionPrompt, TabStrip, ThreadCard, useAgents, type AgentTab } from "./agents";
import { FileMark, GitPanel, useGit } from "./git";
import { OpenIn } from "./editors";
import { worktreeName, type GitSnapshot } from "../shared/git";
import { BrandIcon, ClipIcon, EmmaMark, GlobeIcon, InfoDot, ToolIcon } from "./icons";
import { BrowserPane } from "./browser";
import { PaneSwitch } from "./pane-switch";
import { closeTerminals, TerminalIcon, TerminalPanel } from "./terminal";
import { MAX_TERMINAL_HEIGHT, MIN_TERMINAL_HEIGHT } from "../shared/terminal";
import { syncImprovements } from "./improvements";
import { CliDock, CliPanel, useCliRuns, useTailScroll } from "./cli";
import { cliHarness } from "../shared/cli";
import { diffStat, sentByThread, spawnedThread, type AgentStatus, type FileChange, type LiveAgent, type ThreadStep } from "../shared/agents";
import { DEFAULT_PERMISSION_MODE, type PermissionMode } from "../shared/permissions";
import { SETUP_PERMISSIONS, type SetupPermission, type SetupStatus } from "../shared/setup";
import { ATTACHMENT_FOLDER, DEFAULT_VAULT_FOLDER, keepKindLabel, noteFolder, validVaultFolder, type KeptNote, type VaultChoice } from "../shared/vault";
import { CLEANUP_INSTALL, HOLD_TO_TALK_MS, LLAMA_INSTALL, LLAMA_SITE_URL, SPEECH_INSTALL, SPEECH_MODEL, SPEECH_MODEL_URL, VOICE_MODEL, VOICE_MODEL_URL, voiceReady, type TranscriptionEngine } from "../shared/voice";
import { useDictation, useSpaceHold } from "./voice";
import { reasonText } from "./errors";
import { isWorkspaceWindow, takeBootSnapshot } from "./boot";

const empty: Snapshot = { threads: [], scheduledJobs: [], researchJobs: [], warnings: [] };
const SNAPSHOT_REFRESH_MS = 60_000;
const AgentView = lazy(() => import("./AgentView"));
const ResearchView = lazy(() => import("./research"));
const dateFormat = zoned({ month: "short", day: "numeric", year: "numeric" });
const timeFormat = zoned({ hour: "numeric", minute: "2-digit" });
const date = (value: string) => dateFormat(new Date(value));
const time = (value: string) => timeFormat(new Date(value));

function Mark() {
  return <span className="mark" aria-hidden="true">◇</span>;
}

const STATUS_TITLES: Record<string, string> = { running: "Running", waiting: "Waiting for you", failed: "Something went wrong", idle: "Idle" };

function ThreadStatus({ status }: { status?: AgentStatus }) {
  const state = status === "running" || status === "waiting" || status === "failed" ? status : "idle";
  return <span className={`thread-status ${state}`} title={STATUS_TITLES[state]} role="img" aria-label={STATUS_TITLES[state]} />;
}

function Body({ content }: { content: string }) {
  return <div className="message-body"><Markdown text={content} /></div>;
}

const clock = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)}s` : formatDuration(ms);

function Thought({ text, ms, tokens, live }: { text: string; ms: number; tokens: number; live?: string }) {
  if (!text.trim() && !live) return null;
  return <details className="thinking" data-live={live ? "true" : undefined}>
    <summary>{live
      ? `${clock(ms)} · ${charLabel(tokens)} tokens · ${live}`
      : ms > 0 ? `Thought for ${clock(ms)} · ${charLabel(tokens)} tokens` : `Thought · ${charLabel(tokens)} tokens`}</summary>
    <p>{text}</p>
  </details>;
}

const thoughtTokens = (text: string) => Math.round(text.length / CHARS_PER_TOKEN);

function CopyTurn({ text, label = "Copy message" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);
  return <button type="button" className="message-copy" aria-label={copied ? "Copied" : label} title={copied ? "Copied" : label} onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(() => undefined)}>
    {copied
      ? <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 8.5 6 12l7.5-8" /></svg>
      : <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" /><path d="M10.5 3.5v-1h-8v8h1" /></svg>}
  </button>;
}

function TranscriptRail({ messages, scroller }: { messages: Message[]; scroller: React.RefObject<HTMLDivElement | null> }) {
  const [peek, setPeek] = useState<number>();
  const marks = messages.flatMap((item, index) => item.role === "user" ? [{ item, index }] : []);
  if (marks.length < 2) return null;
  return <nav
    className="rail"
    aria-label="Jump to a message"
    style={{ "--rail-gap": `${Math.max(2, Math.min(7, 360 / marks.length))}px` } as React.CSSProperties}
    onMouseLeave={() => setPeek(undefined)}
  >
    {marks.map(({ item, index }, at) => {
      const [head, ...rest] = sentByThread(item.content).body.trim().split("\n");
      return <button
        key={index}
        type="button"
        className="rail-mark"
        aria-label={`Jump to: ${head.slice(0, 80)}`}
        onMouseEnter={() => setPeek(at)}
        onFocus={() => setPeek(at)}
        onBlur={() => setPeek(undefined)}
        onClick={() => scroller.current?.querySelector(`[data-turn="${index}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
      >
        {peek === at && <span className="rail-peek" aria-hidden="true">
          <b>{head}</b>
          {rest.join(" ").trim() && <i>{rest.join(" ")}</i>}
          <time dateTime={item.timestamp}>{time(item.timestamp)}</time>
        </span>}
      </button>;
    })}
  </nav>;
}

function ContextCut() {
  return <p className="context-cut" role="separator" aria-label="Context cleared">Context cleared</p>;
}

function Turn({ item, blocks, index, attached }: { item: Message; blocks?: Block[]; index?: number; attached?: TurnAttachment[] }) {
  const model = item.generation?.model ?? "";
  const { from, body } = sentByThread(item.content);
  const thought = item.role !== "assistant" ? "" : blocks?.length ? thinkingOf(blocks) : splitThinking(body).thinking;
  return <article className={`message ${item.role}`} data-turn={index}>
    {thought && <Thought text={thought} ms={item.generation?.durationMilliseconds ?? 0} tokens={thoughtTokens(thought)} />}
    {!!attached?.length && <div className="message-tray">{attached.map((file) => <button
      type="button" className="composer-tile" key={file.path} title={file.name} aria-label={`Open ${file.name}`}
      onClick={() => openPreview(file.path, file.name)}>
      {file.thumbnail ? <img src={file.thumbnail} alt="" /> : <><FileMark path={file.name} /><small>{file.name}</small></>}
    </button>)}</div>}
    {blocks?.length ? <Blocks blocks={blocks} /> : <Body content={item.role === "assistant" ? splitThinking(body).answer : body} />}
    <footer className="message-meta"><span>{item.role === "user" ? from ? `thread ${from} messaged:` : "You" : "Emma"}</span><CopyTurn text={item.role === "assistant" ? splitThinking(item.content).answer : body} />{model && <span className="message-model" title={`Answered by ${model}`}><BrandIcon brand={brandForModel(model)} className="message-model-mark" /><span>{model}</span></span>}<time dateTime={item.timestamp}>{time(item.timestamp)}</time>{item.generation && <span className="generation-rate" title={`${item.generation.outputTokens} output tokens in ${item.generation.durationMilliseconds} ms`}>{Math.round(item.generation.outputTokens / item.generation.durationMilliseconds * 1000).toLocaleString()} tok/s</span>}</footer>
  </article>;
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return <>{groupBlocks(withoutThinking(blocks), STEPS_SHOWN).map((block, index) => block.kind === "steps"
    ? <Steps key={index} steps={block.steps} shown={block.keep} />
    : block.kind === "visual"
      ? <Visual key={index} id={block.id} onKept={openArtifactsPage} onPicked={pickIntoComposer} />
      : block.kind === "notice"
        ? <ContextNotice key={index} text={block.text} />
        : <Body key={index} content={block.text} />)}</>;
}

function ContextNotice({ text }: { text: string }) {
  return <p className="context-notice">
    <span>{text}</span>
    <button type="button" onClick={() => openSettingsPage("harness")}>Change in settings</button>
  </p>;
}

function stepLabel(step: ThreadStep): string {
  if (step.edit) return `Edited ${step.edit.path.split("/").pop() ?? step.edit.path}`;
  return step.title || step.kind;
}

const STEPS_SHOWN = 0;

function Steps({ steps, shown: keep = STEPS_SHOWN }: { steps: ThreadStep[]; shown?: number }) {
  if (!steps.length) return null;
  const folded = steps.length > keep + 1;
  const shown = folded ? steps.slice(0, keep) : steps;
  const rest = steps.slice(shown.length);
  const latest = rest.at(-1);
  return <>
    {shown.length > 0 && <ol className="steps">{shown.map((step) => <Step key={step.toolCallId} step={step} />)}</ol>}
    {latest && <details className="steps-more">
      <summary><CaretIcon /><span key={latest.toolCallId} className="steps-latest">{stepLabel(latest)}</span><span className="steps-count">{rest.length} more</span></summary>
      <ol className="steps">{rest.map((step) => <Step key={step.toolCallId} step={step} />)}</ol>
    </details>}
  </>;
}

function Step({ step }: { step: ThreadStep }) {
  const made = artifactWritten(step);
  const started = spawnedThread(step.output);
  return <li className={`step ${step.status}`}>
    {step.kind === "verifier" ? <Review step={step} />
      : step.edit ? <>
        <PencilIcon />
        <span className="step-title">{stepLabel(step)}</span>
        <span className="step-diff"><b>+{step.edit.added}</b><i>-{step.edit.removed}</i></span>
        <button type="button" className="step-open" title={`${step.edit.path} — open the diff`} aria-label={`Open the diff for ${step.edit.path}`} onClick={openChangesPanel}><CaretIcon /></button>
      </> : <>
        <ToolIcon />
        <span className="step-title">{stepLabel(step)}</span>
        {step.output && !made && !started && <span className="step-output">{step.output.replace(/\s+/g, " ").slice(0, 120)}</span>}
      </>}
    {made && <ArtifactCard id={made} onOpen={openArtifactsPage} />}
    {started && <ThreadCard id={started.id} title={started.title} onOpen={openThreadPage} />}
  </li>;
}

function CaretIcon() {
  return <svg className="caret" viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" /></svg>;
}

function PencilIcon() {
  return <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11.2 2.3 13.7 4.8 5.4 13H2.9v-2.5z" /><path d="M9.7 3.8l2.5 2.5" /></svg>;
}

const OPEN_CHANGES_EVENT = "emma:open-changes";
const openChangesPanel = () => dispatchEvent(new Event(OPEN_CHANGES_EVENT));

const OPEN_ARTIFACTS_EVENT = "emma:open-artifacts";
const openArtifactsPage = (id: string) => dispatchEvent(new CustomEvent(OPEN_ARTIFACTS_EVENT, { detail: id }));

const PICK_CONTEXT_EVENT = "emma:pick-context";
const pickIntoComposer = (pick: ContextPick) => dispatchEvent(new CustomEvent(PICK_CONTEXT_EVENT, { detail: pick }));

const OPEN_THREAD_EVENT = "emma:open-thread";
const openThreadPage = (id: string) => dispatchEvent(new CustomEvent(OPEN_THREAD_EVENT, { detail: id }));

const OPEN_SETTINGS_EVENT = "emma:open-settings-page";
const openSettingsPage = (page: SettingsPage) => dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: page }));

function Review({ step }: { step: ThreadStep }) {
  return <details className="step-review">
    <summary><ToolIcon /><span className="step-title">{step.title}</span><span className="step-output">{(step.output ?? "").replace(/\s+/g, " ").slice(0, 120)}</span></summary>
    <b>Context sent to the verifier</b>
    <pre>{step.input || "(nothing)"}</pre>
    <b>What the verifier answered</b>
    <pre>{step.output || "(nothing)"}</pre>
  </details>;
}

function Streaming({ blocks, threadId }: { blocks: Block[]; threadId: string }) {
  const agent = useAgents().find((item) => item.threadId === threadId);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <article className="message assistant streaming">
    <Blocks blocks={blocks} />
    {agent && <Thought text={thinkingOf(blocks)} ms={now - agent.startedAt} tokens={agent.outputTokens} live={agent.activity || "thinking"} />}
    <footer className="message-meta"><span>Emma</span>{!agent && <span className="pending-note">Streaming…</span>}</footer>
  </article>;
}

function AgentTranscript({ threadId, thread }: { threadId: string; thread?: Thread }) {
  const run = useRun(threadId);
  if (thread?.messages.length) return <>{thread.messages.map((item, index) => <Turn key={`${item.timestamp}-${index}`} item={item} />)}</>;
  if (run.blocks.length) return <Streaming blocks={run.blocks} threadId={threadId} />;
  return <p className="waiting" role="status"><Mark /> Waiting for this agent's first turn…</p>;
}

function SendIcon() {
  return <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true"><path d="M14.5 1.5 1.8 6.3l5.1 2 2 5.1z" /><path d="M14.5 1.5 6.9 8.3" /></svg>;
}

let composerSeed = { threadId: "", text: "" };
const seedComposer = (threadId: string, text: string) => { composerSeed = { threadId, text }; };
const takeComposerSeed = (threadId: string) => composerSeed.threadId === threadId ? composerSeed.text : "";

function useArtifactCount() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const read = () => void window.emma.listArtifacts().then((list) => setCount(list.length)).catch(() => undefined);
    read();
    return window.emma.onArtifactsChanged(read);
  }, []);
  return count;
}

function useNotes() {
  const [notes, setNotes] = useState<KeptNote[]>([]);
  const read = useCallback(() => void window.emma.listNotes().then(setNotes).catch(() => setNotes([])), []);
  useEffect(() => {
    read();
    return window.emma.onNotesChanged(read);
  }, [read]);
  return { notes, reloadNotes: read };
}

const LAYOUT_KEY = "emma.layout.v2";
const IMPORTS_SEEN_KEY = "emma.importsSeen.v1";
const SETUP_SEEN_KEY = "emma.setupSeen.v1";
const readLayout = () => {
  try { return validatePaneLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null"), window.innerWidth); }
  catch { return defaultPaneLayout; }
};

function ResizeHandle({ label, value, min, max, direction = 1, axis = "x", onChange }: { label: string; value: number; min: number; max: number; direction?: 1 | -1; axis?: "x" | "y"; onChange: (value: number) => void }) {
  const drag = useRef<{ at: number; value: number } | undefined>(undefined);
  const clamp = (next: number) => Math.min(max, Math.max(min, Math.round(next)));
  const along = (event: { clientX: number; clientY: number }) => axis === "x" ? event.clientX : event.clientY;
  const [less, more] = axis === "x" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
  const key = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== less && event.key !== more) return;
    event.preventDefault();
    onChange(clamp(value + (event.key === more ? 8 : -8) * direction));
  };
  return <button type="button" className="resize-handle" role="separator" aria-label={label} aria-orientation={axis === "x" ? "vertical" : "horizontal"} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} onKeyDown={key} onPointerDown={(event: ReactPointerEvent<HTMLButtonElement>) => { drag.current = { at: along(event), value }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (drag.current) onChange(clamp(drag.current.value + (along(event) - drag.current.at) * direction)); }} onPointerUp={() => { drag.current = undefined; }} />;
}

function App() {
  useEffect(() => {
    const styles: HTMLStyleElement[] = [];
    void window.emma.loadUiPlugins().then((plugins) => {
      for (const plugin of plugins) {
        const style = document.createElement("style");
        style.dataset.emmaPlugin = plugin.id;
        style.textContent = plugin.css;
        document.head.append(style);
        styles.push(style);
      }
    });
    return () => styles.forEach((style) => style.remove());
  }, []);
  const query = new URLSearchParams(location.search);
  if (query.has("annotation")) return <ScreenAnnotation />;
  if (query.has("hotspot")) return <NotchHotspot />;
  if (query.has("radial")) return <RadialCommands />;
  if (query.has("run")) return <ComputerRunBanner task={query.get("task") ?? ""} maxSteps={Number(query.get("maxSteps")) || 0} />;
  return query.has("overlay") ? <Overlay /> : <Workspace />;
}

function ComputerRunBanner({ task, maxSteps }: { task: string; maxSteps: number }) {
  const [progress, setProgress] = useState({ step: 0, action: "starting", actions: 0 });
  useEffect(() => window.emma.onComputerRunProgress(setProgress), []);
  return <div className="run-banner" role="status">
    <span className="run-banner-pulse" aria-hidden="true" />
    <div className="run-banner-body">
      <strong>Emma is using this Mac · {progress.action}</strong>
      <small>Step {progress.step}/{maxSteps} · {progress.actions} action{progress.actions === 1 ? "" : "s"} · {task}</small>
    </div>
    <button type="button" onClick={() => window.emma.stopComputerRun()}>Stop · esc</button>
  </div>;
}

function ScreenAnnotation() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [drawn, setDrawn] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") void window.emma.cancelScreenAnnotation(); };
    addEventListener("keydown", cancel);
    const target = canvas.current;
    if (target) {
      target.width = Math.round(innerWidth * devicePixelRatio);
      target.height = Math.round(innerHeight * devicePixelRatio);
    }
    return () => removeEventListener("keydown", cancel);
  }, []);
  const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * target.width / rect.width, y: (event.clientY - rect.top) * target.height / rect.height, scale: target.width / rect.width };
  };
  const begin = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const context = event.currentTarget.getContext("2d");
    if (!context) return;
    const { x, y, scale } = point(event);
    drawing.current = true;
    clearTimeout(settle.current);
    event.currentTarget.setPointerCapture(event.pointerId);
    context.beginPath(); context.moveTo(x, y);
    context.lineCap = "round"; context.lineJoin = "round"; context.lineWidth = 5 * scale;
    context.strokeStyle = "#ffe84f"; context.shadowColor = "#fff46b"; context.shadowBlur = 14 * scale;
  };
  const draw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const context = event.currentTarget.getContext("2d");
    if (!context) return;
    const { x, y } = point(event);
    context.lineTo(x, y); context.stroke();
    setDrawn(true);
  };
  const endStroke = () => {
    if (!drawing.current) return;
    drawing.current = false;
    clearTimeout(settle.current);
    settle.current = setTimeout(() => void finish(), SETTLE_MS);
  };
  const finish = async () => {
    const target = canvas.current;
    if (!drawn || !target) return;
    try {
      const frame = await window.emma.getScreenAnnotationFrame();
      const source = new Image();
      source.src = frame.image;
      await source.decode();
      const composite = document.createElement("canvas");
      composite.width = frame.width;
      composite.height = frame.height;
      const context = composite.getContext("2d");
      if (!context) { setError("Emma could not composite the annotated screen"); return; }
      context.drawImage(source, 0, 0, frame.width, frame.height);
      context.drawImage(target, 0, 0, frame.width, frame.height);
      await window.emma.finishScreenAnnotation(composite.toDataURL("image/jpeg", 0.8));
    } catch (reason) { setError(reasonText(reason)); }
  };
  return <main className="screen-annotation"><canvas ref={canvas} aria-label="Draw yellow screen highlights" onPointerDown={begin} onPointerMove={draw} onPointerUp={endStroke} onPointerCancel={endStroke} /><div className="annotation-toolbar"><div><strong>Yellow highlight</strong><span>Draw on your live screen · attaches when you stop · Esc cancels</span></div><button type="button" onClick={() => void window.emma.cancelScreenAnnotation()}>Cancel</button></div>{error && <p className="annotation-error" role="alert">{error}</p>}</main>;
}

function useSnapshot(onLoad?: (snapshot: Snapshot) => void) {
  const [snapshot, setSnapshot] = useState(empty);
  const [error, setError] = useState("");
  const booted = useRef(takeBootSnapshot());
  const skipped = useRef(false);
  const load = useCallback(async () => {
    try {
      const inFlight = booted.current;
      booted.current = undefined;
      const next = await (inFlight ?? window.emma.request<Snapshot>("snapshot"));
      setSnapshot(next);
      onLoad?.(next);
      setError("");
    } catch (reason) {
      setError(reasonText(reason));
    }
  }, [onLoad]);
  useEffect(() => {
    queueMicrotask(() => void load());
    const refresh = () => { skipped.current = false; void load(); };
    const refreshVisible = () => { if (document.visibilityState === "visible") refresh(); else skipped.current = true; };
    const listener = window.emma.onChanged(refreshVisible);
    const shown = () => { if (document.visibilityState === "visible" && skipped.current) refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", shown);
    const interval = window.setInterval(refreshVisible, SNAPSHOT_REFRESH_MS);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", shown);
      window.emma.offChanged(listener);
    };
  }, [load]);
  return { snapshot, load, error, setError };
}

function Workspace() {
  const [threadId, setThreadId] = useState("");
  const pinSelections = useCallback((next: Snapshot) => {
    const live = next.threads.filter((item) => !item.archivedAt && !item.parentThreadId);
    setThreadId((current) => live.some((item) => item.id === current) ? current : (live[0]?.id ?? ""));
  }, []);
  const { snapshot, load, error, setError } = useSnapshot(pinSelections);
  const [view, setView] = useState<"threads" | "knowledge" | "artifacts" | "agent" | "scheduled" | "plugins" | "research" | "archive" | "settings">("threads");
  const [threadMenu, setThreadMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [projectMenu, setProjectMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [threadQuery, setThreadQuery] = useState("");
  const [threadLimits, setThreadLimits] = useState<Record<string, number>>({});
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const anchor = useRef("");
  const [grants, setGrants] = useState<FolderGrant[]>([]);
  const [tags, setTags] = useState(threadTags);
  const [filedFolders, setFiledFolders] = useState(threadFolderMap);
  useEffect(() => {
    const reload = () => { void window.emma.listFolders().then(setGrants).catch(() => undefined); setTags(threadTags()); setFiledFolders(threadFolderMap()); };
    reload();
    addEventListener("emma-thread-folders-changed", reload);
    addEventListener("emma-thread-tags-changed", reload);
    return () => { removeEventListener("emma-thread-folders-changed", reload); removeEventListener("emma-thread-tags-changed", reload); };
  }, []);
  const [setupOpen, setSetupOpen] = useState(() => !localStorage.getItem(SETUP_SEEN_KEY));
  const [importsOpen, setImportsOpen] = useState(() => !localStorage.getItem(IMPORTS_SEEN_KEY));
  const [layout, setLayout] = useState<PaneLayout>(readLayout);
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("keybinds");
  const [settings, setSettings] = useState(readSettings);
  const [interactionLocked, setInteractionLocked] = useState(false);
  const agents = useAgents();
  const artifactCount = useArtifactCount();
  const { notes, reloadNotes } = useNotes();
  const [artifactPick, setArtifactPick] = useState({ id: "", at: 0 });
  useEffect(() => {
    const open = (event: Event) => { setArtifactPick((current) => ({ id: (event as CustomEvent<string>).detail, at: current.at + 1 })); setView("artifacts"); };
    addEventListener(OPEN_ARTIFACTS_EVENT, open);
    return () => removeEventListener(OPEN_ARTIFACTS_EVENT, open);
  }, []);
  useEffect(() => {
    const open = (requested: string) => {
      if (!settingsPages.some((item) => item.id === requested)) return;
      setSettingsPage(requested as SettingsPage);
      setView("settings");
    };
    const fromTranscript = (event: Event) => open((event as CustomEvent<string>).detail);
    addEventListener(OPEN_SETTINGS_EVENT, fromTranscript);
    const stop = window.emma.onOpenSettings(open);
    return () => { removeEventListener(OPEN_SETTINGS_EVENT, fromTranscript); stop(); };
  }, []);
  const [tab, setTab] = useState("thread");
  const actionInFlight = useRef(false);
  const restoredModel = useRef(false);
  const liveThreads = useMemo(() => snapshot.threads.filter((item) => !item.archivedAt && item.kind !== "subagent"), [snapshot.threads]);
  const archivedThreads = useMemo(() => snapshot.threads.filter((item) => item.archivedAt && item.kind !== "subagent"), [snapshot.threads]);
  const thread = liveThreads.find((item) => item.id === threadId) ?? liveThreads[0];
  const uiBusy = busy || interactionLocked;
  const threadStatus = useMemo(() => {
    const rank: Record<string, number> = { running: 1, waiting: 2, failed: 3 };
    const map = new Map<string, AgentStatus>(agents.filter((agent) => !agent.parentThreadId).map((agent) => [agent.threadId, agent.status]));
    for (const agent of agents) {
      const parent = agent.parentThreadId;
      if (parent && (rank[agent.status] ?? 0) > (rank[map.get(parent) ?? ""] ?? 0)) map.set(parent, agent.status);
    }
    return map;
  }, [agents]);
  const modelLabel = useMemo(() => selectedModelLabel(settings), [settings]);
  const modelTag = useMemo(() => modelKeyTag(settings.selectedModel), [settings]);
  const modelBrand = useMemo(() => selectedModelBrand(settings), [settings]);
  const { contextTokens } = useSelectedModel(settings.selectedModel);
  useEffect(() => { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); }, [layout]);
  useEffect(() => { syncMainPreferences(readSettings()); }, []);
  useEffect(() => {
    const reload = () => setSettings(readSettings());
    addEventListener("storage", reload);
    addEventListener("emma-settings-changed", reload);
    return () => { removeEventListener("storage", reload); removeEventListener("emma-settings-changed", reload); };
  }, []);
  useEffect(() => {
    let asked = 0;
    const resync = () => {
      if (document.hidden || window.innerWidth <= window.outerWidth || Date.now() - asked < 2_000) return;
      asked = Date.now();
      window.emma.resyncWindow();
    };
    const fit = () => { setLayout((current) => validatePaneLayout(current, window.innerWidth)); resync(); };
    resync();
    addEventListener("resize", fit);
    addEventListener("focus", resync);
    document.addEventListener("visibilitychange", resync);
    return () => { removeEventListener("resize", fit); removeEventListener("focus", resync); document.removeEventListener("visibilitychange", resync); };
  }, []);
  const pane = (change: Partial<PaneLayout>) => setLayout((current) => validatePaneLayout({ ...current, ...change }, window.innerWidth));
  const inspectorBefore = useRef<boolean | null>(null);
  const showBrowser = (open: boolean) => {
    if (open) {
      inspectorBefore.current ??= layout.inspectorCollapsed;
      pane({ browserOpen: true, inspectorCollapsed: true });
      return;
    }
    const before = inspectorBefore.current;
    inspectorBefore.current = null;
    pane({ browserOpen: false, ...(before === false ? { inspectorCollapsed: false } : {}) });
  };
  const shellStyle = {
    "--sidebar-width": `${layout.sidebarCollapsed ? 46 : layout.sidebarWidth}px`,
    "--inspector-width": `${layout.inspectorCollapsed ? 30 : layout.inspectorWidth}px`,
    "--browser-width": `${layout.browserOpen ? layout.browserWidth : 0}px`,
    "--terminal-height": `${layout.terminalOpen ? layout.terminalHeight : 0}px`,
  } as CSSProperties;
  const filedThreads = useMemo(() => liveThreads.filter((item) => !item.scheduledJobId), [liveThreads]);
  const scheduledThreads = useMemo(() => liveThreads.filter((item) => item.scheduledJobId), [liveThreads]);
  const projectOf = useCallback((item: Thread) => {
    let at: Thread | undefined = item;
    for (let hop = 0; at && hop < 8; hop += 1) {
      const grant = grants.find((folder) => folder.id === filedFolders[at!.id]?.[0]);
      if (grant) return grant.id;
      at = liveThreads.find((owner) => owner.id === at!.parentThreadId);
    }
    return "";
  }, [filedFolders, grants, liveThreads]);
  const projects = useMemo(() => {
    const filedTo = new Map(filedThreads.map((item) => [item.id, projectOf(item)]));
    return ordered([
      ...grants.map((grant) => ({ id: grant.id, name: grant.name, threads: nested(filedThreads.filter((item) => filedTo.get(item.id) === grant.id)) })),
      { id: "unfiled", name: "Unfiled", threads: nested(filedThreads.filter((item) => !filedTo.get(item.id))) },
    ].filter((group) => group.threads.length || group.id !== "unfiled"), layout.projectOrder);
  }, [filedThreads, grants, layout.projectOrder, projectOf]);
  const search = threadQuery.trim().toLowerCase();
  const visibleProjects = search
    ? projects.map((group) => group.name.toLowerCase().includes(search) ? group : { ...group, threads: group.threads.filter((item) => threadLabel(item).toLowerCase().includes(search) || (tags[item.id]?.tag ?? "").includes(search)) }).filter((group) => group.threads.length)
    : projects;
  const openThread = (id: string) => { setThreadId(id); setView("threads"); };
  useEffect(() => {
    const open = (event: Event) => { openThread((event as CustomEvent<string>).detail); void load(); };
    addEventListener(OPEN_THREAD_EVENT, open);
    return () => removeEventListener(OPEN_THREAD_EVENT, open);
  }, [load]);
  const forgetProject = (id: string) => {
    const group = projects.find((item) => item.id === id);
    setProjectMenu(null);
    if (!group) return;
    if (group.threads.length && !confirm(`Remove ${group.name} from the sidebar? Its ${group.threads.length} thread(s) move to Unfiled.`)) return;
    setError("");
    void window.emma.forgetFolder(group.id).then(setGrants).catch((reason: unknown) => setError(reasonText(reason)));
  };
  const setArchived = async (id: string, archived: boolean) => {
    setThreadMenu(null);
    if (await act("setThreadArchived", { threadId: id, archived: String(archived) }) !== undefined) await load();
  };
  const clickThread = (event: ReactMouseEvent, group: { threads: Thread[] }, id: string) => {
    if (event.shiftKey) {
      const from = group.threads.findIndex((item) => item.id === anchor.current);
      const to = group.threads.findIndex((item) => item.id === id);
      const span = from < 0 ? [id] : group.threads.slice(Math.min(from, to), Math.max(from, to) + 1).map((item) => item.id);
      setSelection((current) => [...new Set([...current, ...span])]);
      return;
    }
    anchor.current = id;
    if (event.metaKey || event.ctrlKey) { setSelection((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]); return; }
    setSelection([]);
    openThread(id);
  };
  const renameThread = async (id: string, title: string) => {
    setRenaming(null);
    const named = title.trim();
    if (!named || named === liveThreads.find((item) => item.id === id)?.title) return;
    if (await act("renameThread", { threadId: id, title: named }) !== undefined) await load();
  };
  const archiveThreads = async (ids: string[]) => {
    setThreadMenu(null);
    for (const id of ids) if (await act("setThreadArchived", { threadId: id, archived: "true" }) === undefined) break;
    setSelection([]);
    await load();
  };

  const act = async (method: string, params: Record<string, string> = {}) => {
    if (actionInFlight.current) { setError("Wait for the current action to finish, then try again."); return undefined; }
    actionInFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await window.emma.request<unknown>(method, params);
      return result;
    } catch (reason) {
      await load();
      setError(reasonText(reason));
    } finally {
      actionInFlight.current = false;
      setBusy(false);
    }
  };

  useEffect(() => {
    if (restoredModel.current) return;
    restoredModel.current = true;
    void (async () => {
      await window.emma.setZeroRetention(settings.requireZeroRetention).catch((reason: unknown) => setError(reasonText(reason)));
      if (settings.selectedModel === "fallback") {
        try {
          if ((JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<UserSettings> | null)?.selectedModel !== "fallback") return;
        } catch { return; }
        await window.emma.request("selectFallbackModel").catch((reason) => setError(reasonText(reason)));
        return;
      }
      try {
        if (settings.selectedModel === FREE_ROUTER_KEY) {
          await selectModelKey(settings, FREE_ROUTER_KEY, (method, params) => window.emma.request(method, params));
          return;
        }
        if (settings.selectedModel.startsWith("local:")) {
          const profile = settings.localModels.find((item) => item.id === settings.selectedModel.slice("local:".length));
          if (!profile) throw new Error("The saved local model profile is missing");
          await window.emma.request("selectLocalModel", { baseUrl: profile.baseUrl, modelId: profile.modelId, credentialEnv: profile.credentialEnv });
          return;
        }
        if (settings.selectedModel.startsWith("openrouter:")) {
          const modelId = settings.selectedModel.slice("openrouter:".length);
          const catalog = await window.emma.request<OpenRouterCatalog>("listOpenRouterModels");
          if (!catalog.models.some((model) => model.id === modelId)) throw new Error("The saved OpenRouter model is no longer in the catalog");
          await window.emma.request("selectOpenRouterModel", { modelId, effort: settings.thinkingLevel });
          return;
        }
        throw new Error("The saved model selection is invalid");
      } catch (reason) {
        const message = reasonText(reason);
        let resetFailure = "";
        await window.emma.request("selectFallbackModel").catch((resetReason) => {
          resetFailure = reasonText(resetReason);
        });
        setError(`Saved model unavailable; Emma sends no model until you pick one. ${message}${resetFailure ? ` Runtime reset failed: ${resetFailure}` : ""}`);
        const next = persistSettings({ ...settings, selectedModel: "fallback" });
        setSettings(next);
      }
    })();
  }, [settings, setError]);

  const createThread = async (folderId?: string, seed?: string) => {
    const folder = folderId ?? (thread ? projectOf(thread) : "");
    const created = await act("createThread") as Thread | undefined;
    if (!created) return;
    if (folder) setThreadFolders(created.id, [folder]);
    if (seed) seedComposer(created.id, seed);
    setThreadId(created.id);
    setView("threads");
    await load();
  };
  const editArtifact = (artifact: Artifact) => createThread(undefined, [
    `Edit the artifact "${artifact.title}" (${ARTIFACT_LABELS[artifact.kind].toLowerCase()}, id \`${artifact.id}\`, v${artifact.version}).`,
    "",
    "Read it first with `artifact {\"action\":\"get\",\"id\":\"" + artifact.id + "\"}`, then write the change back with `update` for a small edit or `rewrite` when most of it changes.",
    "",
    "What I want changed: ",
  ].join("\n"));

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [draggingProject, setDraggingProject] = useState(false);
  const [navMore, setNavMore] = useState(false);
  const navCounts: Record<string, number> = { threads: snapshot.threads.length, knowledge: notes.length, artifacts: artifactCount, agent: 0, scheduled: snapshot.scheduledJobs.length, plugins: 0, research: snapshot.researchJobs.length };
  const navLabels: Record<string, string> = { threads: "Threads", knowledge: "Knowledge base", artifacts: "Artifacts", agent: "Agent", scheduled: "Scheduled", plugins: "Plugins", research: "Autoresearch" };
  const navPages = ordered(NAV_VIEWS.map((id) => ({ id })), layout.navOrder);
  const navShown = navMore ? navPages : navPages.filter((item, at) => at < NAV_PINNED || item.id === view);
  const dropped = (all: { id: string }[], write: (order: string[]) => void) => ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const ids = all.map((item) => item.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    write(arrayMove(ids, from, to));
  };

  return (
    <div className="app-shell" style={shellStyle}>
      <a className="skip-link" href="#content">Skip to content</a>
      <Region name="navbar" props={{
        view, setView, busy: uiBusy,
        threads: liveThreads, projects: visibleProjects, agents,
        counts: { threads: snapshot.threads.length, notes: notes.length, artifacts: artifactCount, scheduled: snapshot.scheduledJobs.length, research: snapshot.researchJobs.length },
        threadId: thread?.id, openThread, newThread: () => { setError(""); void createThread(); },
        collapsed: layout.sidebarCollapsed, setCollapsed: (sidebarCollapsed: boolean) => pane({ sidebarCollapsed }),
      }}>
      <aside className={`sidebar ${layout.sidebarCollapsed ? "collapsed" : ""} ${layout.navIcons ? "nav-icons" : ""}`} aria-label="Workspace navigation">
        <div className="drag-region" />
        <div className="brand"><EmmaMark className="blinks" /><strong>Emma</strong>
          <div className={`sidebar-search ${searchOpen ? "open" : ""}`}>
            <button type="button" className="search-toggle" aria-label="Search threads" aria-expanded={searchOpen} onClick={() => { if (searchOpen) { setThreadQuery(""); setSearchOpen(false); } else { setSearchOpen(true); searchInput.current?.focus(); } }}>
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" strokeLinecap="round" /></svg>
            </button>
            <label className="sr-only" htmlFor="thread-search">Search threads</label>
            <input ref={searchInput} id="thread-search" type="search" tabIndex={searchOpen ? 0 : -1} value={threadQuery} onChange={(event) => setThreadQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setThreadQuery(""); setSearchOpen(false); } }} placeholder="Search threads" />
          </div>
          <button type="button" className="rail-toggle" aria-label={layout.sidebarCollapsed ? "Expand navigation" : "Collapse navigation"} aria-expanded={!layout.sidebarCollapsed} onClick={() => pane({ sidebarCollapsed: !layout.sidebarCollapsed })}>{layout.sidebarCollapsed ? "›" : "‹"}</button></div>
        <button className="new-thread" title="New thread" onClick={() => { setError(""); void createThread(); }} disabled={uiBusy}><span>＋</span><span className="nav-label">New thread</span></button>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dropped(navPages, (navOrder) => pane({ navOrder }))}>
          <SortableContext items={navShown.map((item) => item.id)}>
            <nav className="sidebar-nav">
              {navShown.map((item) => <Sortable key={item.id} id={item.id} className="nav-sort">{(handle) =>
                <button {...handle} data-view={item.id} title={navLabels[item.id]} disabled={uiBusy} className={view === item.id ? "active" : ""} onClick={() => { if (item.id === "artifacts") setArtifactPick({ id: "", at: 0 }); setView(item.id); }}><span><NavIcon view={item.id} /></span><span className="nav-label">{navLabels[item.id]}</span>{navCounts[item.id] > 0 && <b>{navCounts[item.id]}</b>}</button>}
              </Sortable>)}
              {navPages.length > navShown.length || navMore
                ? <button type="button" className="nav-more" title={navMore ? "Show fewer sections" : "Show every section"} aria-expanded={navMore} onClick={() => setNavMore(!navMore)}><span><NavIcon view="more" /></span><span className="nav-label">{navMore ? "Less" : "More"}</span></button>
                : null}
            </nav>
          </SortableContext>
        </DndContext>
        <AgentRail agents={agents} active={view === "threads" ? tab : undefined} onPick={(agent) => {
          setView("threads");
          if (agent.parentThreadId) { setThreadId(agent.parentThreadId); setTab(agent.threadId); }
          else { setThreadId(agent.threadId); setTab("thread"); }
        }} />
        <BackgroundRail />
        <DndContext sensors={sensors} collisionDetection={closestCenter} measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
          onDragStart={() => setDraggingProject(true)}
          onDragCancel={() => setDraggingProject(false)}
          onDragEnd={(event) => { setDraggingProject(false); dropped(projects, (projectOrder) => pane({ projectOrder }))(event); }}>
        <SortableContext items={visibleProjects.map((group) => group.id)} strategy={verticalListSortingStrategy}>
        <div className="sidebar-projects" data-dragging={draggingProject || undefined}>
          <span className="sidebar-label">Projects<button type="button" className="project-new" disabled={uiBusy} aria-label="Connect a folder" title="Connect a folder" onClick={() => { setError(""); void window.emma.pickFolder().then(setGrants).catch((reason: unknown) => setError(reasonText(reason))); }}>＋</button></span>
          {selection.length > 0 && <div className="thread-selection"><span className="nav-label">{selection.length} selected</span><button type="button" disabled={uiBusy} onClick={() => void archiveThreads(selection)}>Archive</button><button type="button" onClick={() => setSelection([])} aria-label="Clear selection">×</button></div>}
          {visibleProjects.map((group) => { const limit = threadLimits[group.id] ?? THREAD_PAGE; return <Sortable key={group.id} id={group.id} className="project-sort">{(handle) => <details className="project-group" open><summary {...handle} onContextMenu={(event) => { event.preventDefault(); setProjectMenu({ id: group.id, x: event.clientX, y: event.clientY }); }}><FolderIcon /><span className="nav-label">{group.name}</span>{group.id !== "unfiled" && <button type="button" className="project-new" disabled={uiBusy} aria-label={`New thread in ${group.name}`} title={`New thread in ${group.name}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setError(""); void createThread(group.id); }}>＋</button>}<b>{group.threads.length}</b></summary>{group.threads.slice(0, limit).map((item) => renaming?.id === item.id
            ? <form key={item.id} className="project-thread renaming" onSubmit={(event) => { event.preventDefault(); void renameThread(item.id, renaming.value); }}><ThreadStatus status={threadStatus.get(item.id)} /><input autoFocus value={renaming.value} aria-label="Thread name" onChange={(event) => setRenaming({ id: item.id, value: event.target.value })} onBlur={() => void renameThread(item.id, renaming.value)} onKeyDown={(event) => { if (event.key === "Escape") setRenaming(null); }} /></form>
            : <div className={`project-row ${threadMenu?.id === item.id ? "menu-open" : ""}`} key={item.id}><button type="button" style={{ "--thread-depth": threadDepth(group.threads, item) } as CSSProperties} className={`project-thread ${item.id === thread?.id && view === "threads" && !selection.length ? "active" : ""} ${selection.includes(item.id) ? "selected" : ""}`} title={threadLabel(item)} disabled={uiBusy} onClick={(event) => clickThread(event, group, item.id)} onDoubleClick={() => setRenaming({ id: item.id, value: threadLabel(item) })} onContextMenu={(event) => { event.preventDefault(); setThreadMenu({ id: item.id, x: event.clientX, y: event.clientY }); }}><ThreadStatus status={threadStatus.get(item.id)} /><span className="nav-label">{threadLabel(item)}</span>{tags[item.id] && <em className={`thread-tag ${tags[item.id].auto ? "auto" : ""}`} title={tags[item.id].auto ? `${tags[item.id].tag} · Emma’s guess, right-click to change it` : tags[item.id].tag}>{tags[item.id].tag}</em>}</button><button type="button" className="thread-actions" title="Thread options" aria-label={`Options for ${threadLabel(item)}`} aria-haspopup="menu" aria-expanded={threadMenu?.id === item.id} disabled={uiBusy} onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); setThreadMenu({ id: item.id, x: box.left, y: box.bottom + 2 }); }}><DotsIcon /></button></div>)}{group.threads.length > limit && <button type="button" className="project-more" onClick={() => setThreadLimits((current) => ({ ...current, [group.id]: limit + THREAD_PAGE }))}>Load more ({group.threads.length - limit})</button>}{!group.threads.length && <p className="project-empty">No threads yet</p>}</details>}</Sortable>; })}
          {search && !visibleProjects.length && <p className="project-empty">No threads match that search</p>}
        </div>
        </SortableContext>
        </DndContext>
        {snapshot.scheduledJobs.length > 0 && <details className="sidebar-scheduled">
          <summary><HourglassIcon /><span className="nav-label">Scheduled tasks</span><b>{scheduledThreads.length}</b></summary>
          {snapshot.scheduledJobs.map((job) => { const runs = scheduledThreads.filter((item) => item.scheduledJobId === job.id); return <details className="project-group" key={job.id} open><summary><span className="nav-label">{job.title}</span><b>{runs.length}</b></summary>{runs.map((item) => <button key={item.id} type="button" style={{ "--thread-depth": 1 } as CSSProperties} className={`project-thread ${item.id === thread?.id && view === "threads" && !selection.length ? "active" : ""}`} title={`${threadLabel(item)} · ${date(item.createdAt)} ${time(item.createdAt)}`} disabled={uiBusy} onClick={() => openThread(item.id)} onContextMenu={(event) => { event.preventDefault(); setThreadMenu({ id: item.id, x: event.clientX, y: event.clientY }); }}><ThreadStatus status={threadStatus.get(item.id)} /><span className="nav-label">{date(item.createdAt)} · {time(item.createdAt)}</span></button>)}{!runs.length && <p className="project-empty">No runs yet</p>}</details>; })}
        </details>}
        <div className="nav-foot"><span><i /> Agent online</span><button type="button" className={`nav-settings ${layout.navIcons ? "active" : ""}`} title={layout.navIcons ? "Show sections as rows" : "Show sections as icons"} aria-label="Show sections as icons" aria-pressed={layout.navIcons} onClick={() => pane({ navIcons: !layout.navIcons })}><NavIcon view="tiles" /></button><button type="button" data-view="archive" className={`nav-settings nav-archive ${view === "archive" ? "active" : ""}`} title="Archive" aria-label="Archive" aria-pressed={view === "archive"} disabled={uiBusy} onClick={() => setView("archive")}><NavIcon view="archive" /></button><button type="button" data-view="settings" className={`nav-settings ${view === "settings" ? "active" : ""}`} title="Settings" aria-label="Settings" aria-pressed={view === "settings"} disabled={uiBusy} onClick={() => setView("settings")}><NavIcon view="settings" /></button></div>
        {!layout.sidebarCollapsed && <ResizeHandle label="Resize navigation" value={layout.sidebarWidth} min={200} max={340} onChange={(sidebarWidth) => pane({ sidebarWidth })} />}
      </aside>
      </Region>
      <main id="content" className="content">
        {view === "threads" ? <ThreadView key={thread?.id} thread={thread} snapshot={snapshot} notes={notes} busy={uiBusy} act={act} reload={load} agents={agents} tab={tab} setTab={setTab} newThread={() => { setError(""); void createThread(); }} onSendingChange={setInteractionLocked} onModelChanged={setSettings} onManageModels={() => { setView("settings"); setSettingsPage("models"); }} onManageImports={() => { setView("settings"); setSettingsPage("imports"); }} modelKey={settings.selectedModel} modelLabel={modelLabel} modelTag={modelTag} modelBrand={modelBrand} thinkingLevel={settings.thinkingLevel} defaultMode={settings.defaultPermissionMode} contextTokens={contextTokens} contextPages={settings.contextPages} onContextPages={(contextPages) => setSettings(persistSettings({ ...settings, contextPages }))} layout={layout} pane={pane} showBrowser={showBrowser} /> : view === "knowledge" ? <NotesView notes={notes} busy={uiBusy} reload={reloadNotes} /> : view === "artifacts" ? <ArtifactsView key={artifactPick.at} busy={uiBusy} select={artifactPick.id} openArtifact={(artifact) => void editArtifact(artifact)} /> : view === "agent" ? <Suspense fallback={<AgentLoading />}><AgentView snapshot={snapshot} act={act} busy={uiBusy} openThread={openThread} /></Suspense> : view === "scheduled" ? <ScheduledView snapshot={snapshot} act={act} busy={uiBusy} openThread={openThread} /> : view === "plugins" ? <PluginsView busy={uiBusy} /> : view === "research" ? <Suspense fallback={<AgentLoading copy="Loading the autoresearch graph…" />}><ResearchView snapshot={snapshot} act={act} busy={uiBusy} /></Suspense> : view === "archive" ? <ArchiveView threads={archivedThreads} busy={uiBusy} restore={(id) => void setArchived(id, false)} /> : <SettingsView page={settingsPage} onSelectPage={setSettingsPage} act={act} busy={uiBusy} onModelChanged={setSettings} />}
      </main>
      {(error || snapshot.warnings.length > 0) && <div className="notice" role="status"><button aria-label="Dismiss notice" onClick={() => setError("")}>×</button>{error || snapshot.warnings[0]}</div>}
      {threadMenu && <div className="thread-menu-scrim" onClick={() => setThreadMenu(null)} onContextMenu={(event) => { event.preventDefault(); setThreadMenu(null); }}><menu className="thread-menu" style={{ left: threadMenu.x, top: threadMenu.y }}><form className="thread-menu-tag" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); setThreadTag(threadMenu.id, String(new FormData(event.currentTarget).get("tag") ?? "")); setThreadMenu(null); }}><input name="tag" list="thread-tag-names" autoFocus autoComplete="off" maxLength={32} defaultValue={tags[threadMenu.id]?.tag ?? ""} placeholder="Tag" aria-label="Thread tag" /><datalist id="thread-tag-names">{handTags().map((tag) => <option key={tag} value={tag} />)}</datalist></form><button type="button" disabled={uiBusy} onClick={() => { const item = liveThreads.find((entry) => entry.id === threadMenu.id); setThreadMenu(null); if (item) setRenaming({ id: item.id, value: threadLabel(item) }); }}>Rename</button><button type="button" disabled={uiBusy} onClick={() => void archiveThreads(selection.includes(threadMenu.id) ? selection : [threadMenu.id])}>{selection.includes(threadMenu.id) && selection.length > 1 ? `Archive ${selection.length} threads` : "Archive"}</button></menu></div>}
      {projectMenu && <div className="thread-menu-scrim" onClick={() => setProjectMenu(null)} onContextMenu={(event) => { event.preventDefault(); setProjectMenu(null); }}><menu className="thread-menu" style={{ left: projectMenu.x, top: projectMenu.y }}><ProjectSweep threads={visibleProjects.find((group) => group.id === projectMenu.id)?.threads ?? []} busy={uiBusy} archive={archiveThreads} />{projectMenu.id !== "unfiled" && <button type="button" disabled={uiBusy} onClick={() => forgetProject(projectMenu.id)}>Remove from sidebar</button>}</menu></div>}
      {setupOpen
        ? <SetupDialog close={() => { localStorage.setItem(SETUP_SEEN_KEY, "1"); localStorage.setItem(IMPORTS_SEEN_KEY, "1"); setSetupOpen(false); setImportsOpen(false); }} />
        : importsOpen && <ImportDialog close={() => { localStorage.setItem(IMPORTS_SEEN_KEY, "1"); setImportsOpen(false); }} />}
      <PermissionPrompt agents={agents} />
      <PreviewHost />
    </div>
  );
}

const THREAD_PAGE = 6;

const NAV_PINNED = 3;

const SWEEP_DAYS = [7, 30, 90, 180];

function ProjectSweep({ threads, busy, archive }: { threads: Thread[]; busy: boolean; archive: (ids: string[]) => Promise<void> }) {
  const stale = (days: number) => threads.filter((item) => Date.parse(item.updatedAt) < Date.now() - days * 86_400_000).map((item) => item.id);
  return <>{SWEEP_DAYS.map((days) => { const ids = stale(days); return <button key={days} type="button" disabled={busy || !ids.length} onClick={() => void archive(ids)}>Archive older than {days} days ({ids.length})</button>; })}</>;
}

function NavIcon({ view }: { view: string }) {
  const paths: Record<string, ReactNode> = {
    threads: <><path d="M13.8 9.2a1.3 1.3 0 0 1-1.3 1.3H5.4l-2.7 2.7V4a1.3 1.3 0 0 1 1.3-1.3h8.5A1.3 1.3 0 0 1 13.8 4z" /><path d="M5.4 5.9h5.2M5.4 8h3.4" /></>,
    knowledge: <><path d="M8 4.4S6.6 3.1 3.2 3.1a.6.6 0 0 0-.6.6v7.6a.6.6 0 0 0 .6.6c3.4 0 4.8 1.3 4.8 1.3s1.4-1.3 4.8-1.3a.6.6 0 0 0 .6-.6V3.7a.6.6 0 0 0-.6-.6C9.4 3.1 8 4.4 8 4.4z" /><path d="M8 4.4v8.8" /></>,
    artifacts: <><path d="M9.3 1.9H4.4a1 1 0 0 0-1 1v10.2a1 1 0 0 0 1 1h7.2a1 1 0 0 0 1-1V5.2z" /><path d="M9.3 1.9v3.3h3.3M5.9 8.4h4.2M5.9 10.9h2.8" /></>,
    agent: <><path d="M8 1.4v2.1" /><rect x="2.9" y="3.5" width="10.2" height="8.9" rx="2.4" /><path d="M1.3 7.3v2.2M14.7 7.3v2.2M6.1 10.2h3.8" /><circle cx="6" cy="7.3" r="0.95" fill="currentColor" stroke="none" /><circle cx="10" cy="7.3" r="0.95" fill="currentColor" stroke="none" /></>,
    scheduled: <><circle cx="8" cy="8" r="5.8" /><path d="M8 4.6V8l2.4 1.6" /></>,
    plugins: <><path d="M6.1 2.2v3.2M9.9 2.2v3.2" /><path d="M4.3 5.4h7.4v2.4a3.7 3.7 0 0 1-7.4 0z" /><path d="M8 11.5v2.3" /></>,
    research: <><path d="M6.4 1.9v4L2.9 11.6a1.2 1.2 0 0 0 1 1.9h8.2a1.2 1.2 0 0 0 1-1.9L9.6 5.9v-4" /><path d="M5.6 1.9h4.8M4.4 9.3h7.2" /></>,
    archive: <><path d="M2.2 3.4h11.6v2.7H2.2z" /><path d="M3.3 6.1v6.1a1 1 0 0 0 1 1h7.4a1 1 0 0 0 1-1V6.1M6.4 8.6h3.2" /></>,
    settings: <g transform="scale(.667)" strokeWidth="1.95"><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" /><circle cx="12" cy="12" r="3" /></g>,
    tiles: <><rect x="2.4" y="2.4" width="4.7" height="4.7" rx="1" /><rect x="8.9" y="2.4" width="4.7" height="4.7" rx="1" /><rect x="2.4" y="8.9" width="4.7" height="4.7" rx="1" /><rect x="8.9" y="8.9" width="4.7" height="4.7" rx="1" /></>,
    more: <path d="M4 6.3 8 10.2l4-3.9" />,
  };
  return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[view]}</svg>;
}

function Sortable({ id, className, children }: { id: string; className: string; children: (handle: Record<string, unknown>) => ReactNode }) {
  const { setNodeRef, setActivatorNodeRef, listeners, transform, transition, isDragging } = useSortable({ id });
  return <div ref={setNodeRef} className={className} data-dragging={isDragging || undefined} style={{ transform: CSS.Transform.toString(transform), transition }}>
    {children({ ref: setActivatorNodeRef, ...listeners })}
  </div>;
}

function FolderIcon() {
  return <span className="project-folder" aria-hidden="true"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"><path d="M1.8 12.4V4.1a.8.8 0 0 1 .8-.8h3.3l1.5 1.6h6a.8.8 0 0 1 .8.8v6.7a.8.8 0 0 1-.8.8H2.6a.8.8 0 0 1-.8-.8z" /></svg></span>;
}

function HourglassIcon() {
  return <span className="project-folder" aria-hidden="true"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round"><path d="M4.2 2.4h7.6M4.2 13.6h7.6M5.4 2.4v2.2L8 8l-2.6 3.4v2.2M10.6 2.4v2.2L8 8l2.6 3.4v2.2" /></svg></span>;
}

function DotsIcon() {
  return <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><circle cx="8" cy="3.4" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="8" cy="12.6" r="1.2" /></svg>;
}

function AgentLoading({ copy = "Reading what Emma's own runs recorded…" }: { copy?: string }) {
  return <div className="content-empty" role="status" aria-live="polite"><Mark /><p>{copy}</p></div>;
}

const NODE_PLACEHOLDER = '[\n  {"id": "collect", "kind": "agent", "text": "Find this week\'s papers", "saveAs": "digest"},\n  {"id": "check", "kind": "if", "text": "{{digest}} is not empty", "next": "write", "otherwise": "end"},\n  {"id": "write", "kind": "agent", "text": "Write up {{digest}}"}\n]';

const NODE_GLYPHS = { agent: "◆", set: "◇", if: "◈" } as const;

function variableRows(outputs: string) {
  return Object.entries(parseVariables(outputs)).slice(0, 12);
}

function TaskEditor({ job, runs, act, busy, openThread, onSaved, onDeleted, commands }: {
  job?: ScheduledJob;
  runs: Thread[];
  act: (method: string, params?: Record<string, string>) => Promise<unknown>;
  busy: boolean;
  openThread: (id: string) => void;
  onSaved: (id: string) => void;
  onDeleted: () => void;
  commands: { skills: SlashCommand[]; tools: SlashCommand[]; atItems: SlashCommand[] };
}) {
  const [title, setTitle] = useState(job?.title ?? "");
  const [trigger, setTrigger] = useState(job?.schedule ?? "0 9 * * 1");
  const [prompt, setPrompt] = useState(job?.prompt ?? "");
  const [nodes, setNodes] = useState(job?.nodes ?? "");
  const [mode, setMode] = useState<PermissionMode>(job?.permissionMode ?? DEFAULT_PERMISSION_MODE);
  const [dryRun, setDryRun] = useState("");
  const [confirming, setConfirming] = useState(false);
  const graph = parseWorkflow(nodes, prompt);
  const problem = triggerProblem(trigger);
  const ready = Boolean(title.trim() && prompt.trim()) && !problem && !graph.errors.length && graph.nodes.length > 0;
  const save = async () => {
    if (!ready || busy) return;
    const saved = await act("saveScheduledJob", {
      ...(job ? { jobId: job.id } : {}),
      title: title.trim(),
      schedule: trigger.trim(),
      prompt: prompt.trim(),
      ...(nodes.trim() ? { nodes: nodes.trim() } : {}),
      sourceDomains: JSON.stringify(job?.sourceDomains ?? []),
      permissionMode: mode,
    }) as { id?: string } | undefined;
    if (saved?.id) onSaved(saved.id);
  };
  const test = async () => {
    const run = await runWorkflow(graph.nodes, parseVariables(job?.outputs ?? ""), (text) => Promise.resolve(`(a turn would run: ${text})`));
    setDryRun(`${describeRun(run.steps)}\n\nVariables afterwards: ${Object.keys(run.variables).join(", ") || "none"}`);
  };
  const remove = async () => {
    if (!job) return;
    if (!confirming) { setConfirming(true); return; }
    await act("deleteScheduledJob", { jobId: job.id });
    onDeleted();
  };
  return <div className="task-detail">
    <header>
      <h3>{job ? job.title : "New task"}</h3>
      <span>{!job ? "Not saved yet" : job.nextRunAt ? `Next run ${date(job.nextRunAt)} · ${time(job.nextRunAt)}` : job.enabled ? "Waits for its trigger" : "Paused"}</span>
    </header>
    <div className="task-fields">
      <label><span>Title</span><input value={title} maxLength={128} disabled={busy} onChange={(event) => setTitle(event.target.value)} placeholder="Weekly reading sweep" /></label>
      <div className="task-wide"><span className="task-label">Trigger</span><TriggerPicker value={trigger} onChange={setTrigger} disabled={busy} /></div>
      <div className="task-wide"><span className="task-label">What it does</span><PromptField value={prompt} onChange={setPrompt} commands={[...commands.skills, ...commands.tools]} atItems={commands.atItems} disabled={busy} label="What this task does on each run" placeholder="What should Emma do on each run? Type / for a skill or tool, @ for a file, artifact or saved page" /></div>
      <label className="task-wide"><span>Runs as</span><ModePicker mode={mode} setMode={setMode} disabled={busy} /></label>
    </div>
    <section className="task-graph">
      <header><h4>Steps</h4><small>{graph.nodes.length} {plural(graph.nodes.length, "step")}</small></header>
      <ol>{graph.nodes.map((node) => <li key={node.id}>
        <span className={`task-node ${node.kind}`}>{NODE_GLYPHS[node.kind]} {node.kind}</span>
        <b>{node.id}</b>
        <span className="task-node-text">{node.text}</span>
        <small>{[node.saveAs && `→ ${node.saveAs}`, node.next && `then ${node.next}`, node.otherwise && `else ${node.otherwise}`].filter(Boolean).join("  ")}</small>
      </li>)}</ol>
      {graph.errors.map((error) => <p key={error} className="task-problem">{error}</p>)}
      <details className="task-nodes">
        <summary>Write the graph</summary>
        <textarea value={nodes} rows={10} spellCheck={false} disabled={busy} onChange={(event) => setNodes(event.target.value)} placeholder={NODE_PLACEHOLDER} aria-label="Node graph as JSON" />
        <p>Each node has an <b>id</b>, a <b>kind</b> and <b>text</b>. <b>agent</b> runs its text as a turn, <b>set</b> stores its text, <b>if</b> reads its text as a condition and takes <b>next</b> or <b>otherwise</b>. <b>saveAs</b> keeps a step's result as a variable; write it back anywhere with <b>{"{{name}}"}</b>, and <b>{"{{last}}"}</b> is the last agent answer. A step with no <b>next</b> falls through to the one below it; <b>"next": "end"</b> finishes the run. Leave this empty for a task that is just its prompt.</p>
      </details>
    </section>
    <div className="task-actions">
      <button type="button" disabled={busy || !ready} onClick={() => void save()}>{job ? "Save" : "Create task"}</button>
      <button type="button" disabled={busy || !graph.nodes.length || graph.errors.length > 0} onClick={() => void test()}>Test</button>
      {job && <button type="button" disabled={busy} onClick={() => void act("runScheduledJob", { jobId: job.id })}>Run now</button>}
      {job && <button type="button" disabled={busy} onClick={() => void act("setScheduledJobEnabled", { jobId: job.id, enabled: String(!job.enabled) })}>{job.enabled ? "Pause" : "Resume"}</button>}
      {job && <button type="button" className="task-danger" disabled={busy} onClick={() => void remove()}>{confirming ? "Delete for good" : "Delete"}</button>}
    </div>
    {dryRun && <pre className="task-dry-run">{dryRun}</pre>}
    {job && <section className="task-runs">
      <header><h4>Runs</h4><small>{runs.length} {plural(runs.length, "thread")}</small></header>
      {runs.slice(0, 8).map((item) => <button key={item.id} type="button" disabled={busy} onClick={() => openThread(item.id)}>{date(item.createdAt)} · {time(item.createdAt)}<small>{item.messages.length} {plural(item.messages.length, "message")}</small></button>)}
      {!runs.length && <p>Nothing has run yet.</p>}
      {variableRows(job.outputs).length > 0 && <dl>{variableRows(job.outputs).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>}
    </section>}
  </div>;
}

function TaskGraphView({ job, busy, act }: { job?: ScheduledJob; busy: boolean; act: (method: string, params?: Record<string, string>) => Promise<unknown> }) {
  const [selected, setSelected] = useState("");
  if (!job) return <div className="task-detail"><p className="graph-empty">Pick a task on the left to see its graph.</p></div>;
  const graph = parseWorkflow(job.nodes, job.prompt);
  const node = graph.nodes.find((item) => item.id === selected);
  return <div className="task-detail task-graph-view">
    <header>
      <h3>{job.title}</h3>
      <span>{describeTrigger(job.schedule)} · {graph.nodes.length} {plural(graph.nodes.length, "step")}</span>
    </header>
    <WorkflowGraph nodes={graph.nodes} errors={graph.errors} selected={selected} onSelect={setSelected} />
    {node && <dl className="graph-detail">
      <div><dt>Step</dt><dd>{node.id} · {node.kind}</dd></div>
      <div><dt>{node.kind === "if" ? "Condition" : node.kind === "set" ? "Value" : "Prompt"}</dt><dd>{node.text}</dd></div>
      {node.saveAs && <div><dt>Saves as</dt><dd>{node.saveAs}</dd></div>}
      <div><dt>Goes to</dt><dd>{node.kind === "if" ? `${node.next ?? "end"} when true, ${node.otherwise ?? "end"} when false` : node.next ?? "the step below it"}</dd></div>
    </dl>}
    <div className="task-actions">
      <button type="button" disabled={busy} onClick={() => void act("runScheduledJob", { jobId: job.id })}>Run now</button>
      <button type="button" disabled={busy} onClick={() => void act("setScheduledJobEnabled", { jobId: job.id, enabled: String(!job.enabled) })}>{job.enabled ? "Pause" : "Resume"}</button>
    </div>
  </div>;
}

function ScheduledView({ snapshot, act, busy, openThread }: { snapshot: Snapshot; act: (method: string, params?: Record<string, string>) => Promise<unknown>; busy: boolean; openThread: (id: string) => void }) {
  const jobs = snapshot.scheduledJobs;
  const [picked, setPicked] = useState("");
  const [mode, setMode] = useState<"editor" | "graph">("editor");
  const commands = useTaskCommands(readSettings().tools.disabledTools);
  const selected = jobs.find((item) => item.id === picked);
  const creating = picked === "new" || (!selected && !jobs.length);
  const job = creating ? undefined : selected ?? jobs[0];
  return <section className="tasks-view">
    <header>
      <span>Scheduled tasks · they run with nobody watching</span>
      <h2>Workflows</h2>
      <p>A task is a trigger and a graph of steps that pass variables between them. Every run opens its own thread under Scheduled tasks in the sidebar. Ask Emma to build one, or write it here.</p>
      <div className="tasks-modes" role="tablist" aria-label="How to view this task">
        {(["editor", "graph"] as const).map((item) => <button key={item} type="button" role="tab" aria-selected={mode === item} className={mode === item ? "active" : ""} onClick={() => setMode(item)}>{item === "editor" ? "Editor" : "Graph"}</button>)}
      </div>
    </header>
    <div className="tasks-body">
      <nav className="tasks-rail" aria-label="Scheduled tasks">
        {jobs.map((item) => <button key={item.id} type="button" className={!creating && item.id === job?.id ? "active" : ""} disabled={busy} onClick={() => setPicked(item.id)}>
          <span>{item.title}</span>
          <small>{describeTrigger(item.schedule)}</small>
          <b className={item.enabled ? "on" : ""}>{item.enabled ? "live" : "paused"}</b>
        </button>)}
        <button type="button" className={`tasks-new ${creating ? "active" : ""}`} disabled={busy} onClick={() => { setPicked("new"); setMode("editor"); }}>+ New task</button>
      </nav>
      {mode === "graph" ? <TaskGraphView key={job?.id ?? "none"} job={creating ? undefined : job} busy={busy} act={act} /> : <TaskEditor
        key={creating ? "new" : job?.id ?? "new"}
        job={job}
        runs={snapshot.threads.filter((item) => item.scheduledJobId === job?.id)}
        act={act}
        busy={busy}
        openThread={openThread}
        onSaved={setPicked}
        onDeleted={() => setPicked("")}
        commands={commands}
      />}
    </div>
  </section>;
}

const ARCHIVE_RETENTION_DAYS = 30;

function ArchiveView({ threads, busy, restore }: { threads: Thread[]; busy: boolean; restore: (id: string) => void }) {
  return <section className="scheduled-view"><header><span>Archive · auto-discard</span><h2>Archived threads</h2><p>Right-click any thread in the sidebar to archive it. Archived threads are deleted permanently {ARCHIVE_RETENTION_DAYS} days after they are archived.</p></header>{!threads.length && <div className="content-empty"><span className="mark" aria-hidden="true">◇</span><h2>Nothing archived</h2><p>Archived threads appear here until they are discarded.</p></div>}<div className="job-list">{threads.map((item) => <article key={item.id}><header><div><span className="job-state">Archived</span><h3>{threadLabel(item)}</h3></div><button type="button" disabled={busy} onClick={() => restore(item.id)}>Restore</button></header><dl><div><dt>Archived</dt><dd>{date(item.archivedAt ?? "")} · {time(item.archivedAt ?? "")}</dd></div><div><dt>Messages</dt><dd>{item.messages.length} {plural(item.messages.length, "message")}</dd></div></dl></article>)}</div></section>;
}

function useVault() {
  const [vault, setVault] = useState<VaultChoice | null>(null);
  const read = useCallback(() => void window.emma.vaultStatus().then(setVault).catch(() => setVault(null)), []);
  useEffect(read, [read]);
  return { vault, setVault, reloadVault: read };
}

function NotesView({ notes, busy, reload }: { notes: KeptNote[]; busy: boolean; reload: () => void }) {
  const { vault, setVault } = useVault();
  const [error, setError] = useState("");
  const sorted = useMemo(() => [...notes].sort((a, b) => b.savedAt.localeCompare(a.savedAt)), [notes]);
  const choose = async () => {
    try {
      const picked = await window.emma.pickVaultFolder();
      if (!picked) return;
      await window.emma.setVault(picked);
      setVault(picked);
      reload();
    } catch (reason) { setError(reasonText(reason)); }
  };
  const open = (note: KeptNote) => void window.emma.openInObsidian(note.path).catch((reason: unknown) => setError(reasonText(reason)));
  return <section className="scheduled-view">
    <header><span>{vault ? `${vault.name} · ${vault.folder}` : "No vault chosen"}</span><h2>Knowledge base</h2></header>
    {error && <p className="capability-error" role="alert">{error}</p>}
    {!vault && <div className="content-empty"><span className="mark" aria-hidden="true">◇</span><h2>No vault yet</h2><p>Pick the Obsidian vault or folder Emma saves into.</p><button type="button" disabled={busy} onClick={() => void choose()}>Choose a folder…</button></div>}
    {vault && !sorted.length && <div className="content-empty"><span className="mark" aria-hidden="true">◇</span><h2>Nothing saved yet</h2><p>Saved pages, screenshots and highlights land in {noteFolder(vault)}.</p></div>}
    <div className="job-list">{sorted.map((note) => <article key={note.path}>
      <header><div><span className="job-state">{keepKindLabel(note.kind)}</span><h3>{note.title}</h3></div><button type="button" disabled={busy} onClick={() => open(note)}>Open ↗</button></header>
      <dl>
        <div><dt>Saved</dt><dd>{date(note.savedAt)} · {time(note.savedAt)}</dd></div>
        {note.tags.length > 0 && <div><dt>Tags</dt><dd>{note.tags.join(" · ")}</dd></div>}
        {(note.sourceUrl || note.sourceApplication) && <div><dt>Source</dt><dd>{note.sourceUrl ?? note.sourceApplication}</dd></div>}
        <div><dt>File</dt><dd>{note.relative}</dd></div>
      </dl>
    </article>)}</div>
  </section>;
}

type PaneProps = { layout: PaneLayout; pane: (change: Partial<PaneLayout>) => void; showBrowser: (open: boolean) => void };

const pickKindLabel = (pick: ContextPick) => pick.kind === "note" ? KIND_LABELS.page : pick.kind === "attachment" ? KIND_LABELS.file : KIND_LABELS[pick.kind];

const home = (path: string) => path.replace(/^\/Users\/[^/]+/, "~");

function ProjectBar({ folders, ids, setFolders, setIds, git, name, busy }: { folders: FolderGrant[]; ids: string[]; setFolders: (folders: FolderGrant[]) => void; setIds: (ids: string[]) => void; git: GitSnapshot | null; name: string; busy: boolean }) {
  const [error, setError] = useState("");
  const [open, setOpen] = useState<"" | "project" | "branch">("");
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState("");
  const bar = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const branchTrigger = useRef<HTMLButtonElement>(null);
  const shut = useCallback(() => {
    const back = open === "branch" ? branchTrigger.current : trigger.current;
    setOpen(""); setNaming(false); setDraft("");
    queueMicrotask(() => back?.focus());
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!bar.current?.contains(event.target as Node)) { setOpen(""); setNaming(false); } };
    addEventListener("pointerdown", outside);
    return () => removeEventListener("pointerdown", outside);
  }, [open]);
  const project = folders.find((folder) => folder.id === ids[0]);
  const say = (reason: unknown) =>
    setError(reasonText(reason));
  const lead = (id: string) => setIds([id]);
  const choose = (value: string) => {
    setError("");
    if (value !== "pick") { if (value) lead(value); else setIds([]); return; }
    void window.emma.pickFolder().then((granted) => {
      setFolders(granted);
      const chosen = granted.find((grant) => !folders.some((known) => known.id === grant.id)) ?? granted.at(-1);
      if (chosen) lead(chosen.id);
    }).catch(say);
  };
  const worktree = (on: boolean) => {
    if (!project) return;
    setError("");
    void window.emma.setWorktree({ folderId: project.id, name, on }).then((moved) => {
      setFolders(moved.folders);
      lead(moved.folderId);
    }).catch(say);
  };
  const branchTo = (branch: string, create: boolean) => {
    if (!project || !branch.trim()) return;
    setError("");
    void window.emma.setBranch({ folderId: project.id, branch: branch.trim(), create }).catch(say).finally(shut);
  };
  const options = [
    { pick: "", label: "General", detail: "Chat only — no files", current: !project },
    ...folders.map((folder) => ({ pick: folder.id, label: `/${folder.name}`, detail: home(folder.path), current: folder.id === project?.id })),
    { pick: "pick", label: "Connect a folder…", detail: "Native picker", current: false },
  ];
  return <div className="composer-project" ref={bar}>
    <span className="project-chip">
      <button ref={trigger} type="button" className="project-button" disabled={busy} aria-haspopup="listbox" aria-expanded={open === "project"}
        aria-label={`Project folder, currently ${project?.name ?? "General"}`} title={project?.path ?? "No folder — Emma can only chat in this thread"}
        onClick={() => open === "project" ? shut() : setOpen("project")}>
        <span className="project-name">{project ? `/${project.name}` : "General"}</span><span aria-hidden="true">▾</span>
      </button>
      {open === "project" && <section className="source-popover project-menu" role="listbox" aria-label="Project folder" tabIndex={-1}
        onKeyDown={(event) => { if (event.key === "Escape") shut(); }}>
        {options.map((option) => <button type="button" role="option" aria-selected={option.current} key={option.pick || "general"}
          className={`slash-row ${option.current ? "active" : ""}`} onClick={() => { choose(option.pick); shut(); }}>
          <strong>{option.label}</strong><small>{option.detail}</small>
        </button>)}
      </section>}
    </span>
    {git && <span className="project-chip">
      <button ref={branchTrigger} type="button" className="project-branch" disabled={busy} aria-haspopup="listbox" aria-expanded={open === "branch"}
        aria-label={`Branch, currently ${git.branch}`} title="Check out another branch, or start one here"
        onClick={() => open === "branch" ? shut() : setOpen("branch")}>⑂ {git.branch}</button>
      {open === "branch" && <section className="source-popover project-menu branch-menu" role="listbox" aria-label="Branch" tabIndex={-1}
        onKeyDown={(event) => { if (event.key === "Escape") shut(); }}>
        {git.branches.map((branch) => <button type="button" role="option" aria-selected={branch === git.branch} key={branch}
          className={`slash-row ${branch === git.branch ? "active" : ""}`} onClick={() => branchTo(branch, false)}>
          <strong>{branch}</strong>{branch === git.branch && <small>current</small>}
        </button>)}
        {naming
          ? <form className="branch-new" onSubmit={(event) => { event.preventDefault(); branchTo(draft, true); }}>
            <input autoFocus value={draft} maxLength={128} spellCheck={false} placeholder="new-branch-name" aria-label="New branch name" onChange={(event) => setDraft(event.target.value)} />
            <button disabled={!draft.trim()}>Create</button>
          </form>
          : <button type="button" className="slash-row" onClick={() => setNaming(true)}><strong>New branch…</strong><small>from {git.branch}</small></button>}
      </section>}
    </span>}
    {git && <label title={`Work on a checkout of this repo at ${name}, beside the folder itself`}>
      <input type="checkbox" checked={git.worktree} disabled={busy} onChange={(event) => worktree(event.target.checked)} />worktree
    </label>}
    {error && <small role="alert">{error}</small>}
  </div>;
}

function CapabilityPopover({ threadId, locked, close, skill, setSkill, setBusy }: { threadId: string; locked: boolean; close: () => void; skill: ImportedSkill | null; setSkill: (skill: ImportedSkill | null) => void; setBusy: (busy: boolean) => void }) {
  const [skillQuery, setSkillQuery] = useState("");
  const [skills, setSkills] = useState<ImportedSkill[]>([]);
  const [servers, setServers] = useState<ImportedMcpServer[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let active = true;
    void window.emma.searchImportedSkills({ query: "", limit: 64 }).then((value) => { if (active) setSkills(value); }).catch(() => undefined);
    void window.emma.listImportedMcpServers().then((value) => { if (active) setServers(value); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  const run = async <T,>(operation: () => Promise<T>, onResult: (value: T) => void) => {
    if (locked || pending) return;
    setPending(true); setBusy(true); setError("");
    try { onResult(await operation()); }
    catch (reason) { setError(reasonText(reason)); }
    finally { setPending(false); setBusy(false); }
  };
  const shownSkills = skills.filter((item) => `${item.source}/${item.name}`.toLowerCase().includes(skillQuery.trim().toLowerCase()));
  const attach = (item: ImportedSkill) => void run(() => window.emma.selectImportedSkill({ id: item.id, threadId }), setSkill);
  const clearSkill = () => void run(() => window.emma.clearImportedSkill(skill?.id ?? ""), () => setSkill(null));
  return <section className="capability-panel" aria-label="Imported capabilities"><header><div><span>Imported skills & MCP</span><small>A skill attaches to the next turn; imported MCP servers are handed to the harness with every turn.</small></div><button type="button" disabled={locked || pending} onClick={close} aria-label="Back to add menu">← Back</button></header>{skill && <div className="capability-attached"><span>Skill attached · {skill.source}/{skill.name}</span><button type="button" disabled={locked || pending} onClick={clearSkill}>Clear</button></div>}<div className="capability-section"><label>Filter skills<input value={skillQuery} disabled={locked || pending} onChange={(event) => setSkillQuery(event.target.value)} placeholder="review, research…" /></label>{!shownSkills.length && <p className="project-empty">{skills.length ? "Nothing matches that." : "No skills imported yet."}</p>}{shownSkills.map((item) => <button type="button" className="capability-row" disabled={locked || pending} key={item.id} onClick={() => attach(item)}><strong>{item.name}</strong><small>{item.source} · attach to this thread</small></button>)}<small>Instructions remain main-side and apply only to the next turn.</small></div><div className="capability-section"><div className="capability-label"><span>MCP servers</span></div>{!servers.length && <p className="project-empty">No MCP servers imported yet.</p>}{servers.map((item) => <div className="capability-row" key={item.id}><strong>{item.name}</strong><small>{item.source} · {item.command} · env: {item.environmentKeys.join(", ") || "none"}</small></div>)}<small>The harness starts these itself and searches their tools when a turn needs one. Switch one off in Settings → Tools.</small></div>{error && <p className="capability-error" role="alert">{error}</p>}</section>;
}

const BUILTIN_COMMANDS: SlashCommand[] = [
  { id: "agent", name: "agent", kind: "builtin", detail: "built-in · Zig coding harness" },
  { id: "import", name: "import", kind: "builtin", detail: "built-in · import skills & MCP" },
  { id: "new", name: "new", kind: "builtin", detail: "built-in · new thread in this project" },
  { id: "clear", name: "clear", kind: "builtin", detail: "built-in · empty the context window" },
];

const onTagsChanged = (fire: () => void) => {
  addEventListener("emma-thread-tags-changed", fire);
  return () => removeEventListener("emma-thread-tags-changed", fire);
};

function TagPicker({ threadId }: { threadId: string }) {
  const filed = useSyncExternalStore(onTagsChanged, () => threadTags()[threadId]?.tag ?? "");
  const guessed = useSyncExternalStore(onTagsChanged, () => threadTags()[threadId]?.auto === true);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    addEventListener("pointerdown", outside);
    return () => removeEventListener("pointerdown", outside);
  }, [open]);
  const typed = tagName(query);
  const matches = handTags().filter((tag) => !typed || tag.includes(typed));
  const coin = typed && !matches.includes(typed) ? typed : "";
  const apply = (tag: string) => { setThreadTag(threadId, tag); setOpen(false); setQuery(""); };
  return <div className="tag-picker" ref={box}>
    <button type="button" className="tag-trigger" data-state={!filed ? "none" : guessed ? "auto" : "filed"}
      aria-haspopup="listbox" aria-expanded={open}
      title={guessed ? `${filed} · Emma’s guess` : filed || "Tag this thread"}
      aria-label={filed ? `Tag: ${filed}${guessed ? ", Emma’s guess" : ""}` : "Tag this thread"}
      onClick={() => { setQuery(""); setOpen((was) => !was); }}>{filed || "＋ tag"}</button>
    {open && <section className="source-popover tag-menu" role="listbox" aria-label="Thread tag">
      <input autoFocus value={query} maxLength={32} autoComplete="off" placeholder="Find or name a tag" aria-label="Find or name a tag"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") { setOpen(false); return; }
          if (event.key !== "Enter") return;
          event.preventDefault();
          if (coin || matches.length === 1) apply(coin || matches[0]);
        }} />
      {coin && <button type="button" role="option" aria-selected={false} className="tag-row" onClick={() => apply(coin)}><strong>{coin}</strong><em>New</em></button>}
      {matches.map((tag) => <button type="button" role="option" aria-selected={tag === filed} key={tag} className="tag-row" onClick={() => apply(tag)}><strong>{tag}</strong>{tag === filed && <em>Filed</em>}</button>)}
      {!matches.length && !coin && <p className="slash-empty">No tags yet — type one and press Enter.</p>}
      {filed && <button type="button" className="tag-row clear" onClick={() => apply("")}>Clear tag</button>}
    </section>}
  </div>;
}

function ThreadView({ thread, snapshot, notes, busy, act, reload, agents, tab, setTab, newThread, onSendingChange, onModelChanged, onManageModels, onManageImports, modelKey, modelLabel, modelTag, modelBrand, thinkingLevel, defaultMode, contextTokens, contextPages, onContextPages, layout, pane, showBrowser }: { thread?: Thread; snapshot: Snapshot; notes: KeptNote[]; busy: boolean; act: (method: string, params?: Record<string, string>) => Promise<unknown>; reload: () => unknown; agents: LiveAgent[]; tab: string; setTab: (tab: string) => void; newThread: () => void; onSendingChange: (busy: boolean) => void; onModelChanged: (settings: UserSettings) => void; onManageModels: () => void; onManageImports: () => void; modelKey: string; modelLabel: string; modelTag: string; modelBrand?: BrandDefinition; thinkingLevel: ThinkingLevel; defaultMode: PermissionMode; contextTokens: number; contextPages: ContextPage[]; onContextPages: (pages: ContextPage[]) => void } & PaneProps) {
  const [message, setMessage] = useState(() => takeComposerSeed(thread?.id ?? ""));
  useEffect(() => { if (composerSeed.threadId === thread?.id) composerSeed = { threadId: "", text: "" }; }, [thread?.id]);
  const [mode, setMode] = useState<PermissionMode>(() => threadMode(thread?.id ?? "", defaultMode));
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [capabilityBusy, setCapabilityBusy] = useState(false);
  const [runError, setRunError] = useState("");
  const [skill, setSkill] = useState<ImportedSkill | null>(null);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactMeta[]>([]);
  const [folders, setFolders] = useState<FolderGrant[]>([]);
  const threadId = thread?.id;
  const [folderIds, setFolderIds] = useState<string[]>(() => {
    const own = threadFolders(threadId ?? "");
    return own.length ? own : threadFolders(thread?.parentThreadId ?? "");
  });
  const [folderFiles, setFolderFiles] = useState<Record<string, FolderFile[]>>({});
  const [contextQuery, setContextQuery] = useState("");
  const [picks, setPicks] = useState<ContextPick[]>([]);
  const [, ledgerChanged] = useState(0);
  const [caret, setCaret] = useState(0);
  const [slashPick, setSlashPick] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [history, setHistory] = useState(-1);
  const addPick = (pick: ContextPick) => setPicks((current) => current.some((item) => pickKey(item) === pickKey(pick)) ? current.map((item) => pickKey(item) === pickKey(pick) ? pick : item) : [...current, pick]);
  useEffect(() => {
    const take = (event: Event) => addPick((event as CustomEvent<ContextPick>).detail);
    addEventListener(PICK_CONTEXT_EVENT, take);
    return () => removeEventListener(PICK_CONTEXT_EVENT, take);
  }, []);
  const run = useRun(threadId ?? "");
  const sending = run.sending;
  const queued = sending ? run.queue.slice(1) : run.queue;
  const input = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const { ref: transcript, onScroll: transcriptScroll, atEnd, toEnd } = useTailScroll<HTMLDivElement>(
    [thread?.id, thread?.messages.length, run.blocks],
    thread?.id,
  );
  useEffect(() => { if (tab === "thread" && !thread?.messages.length) input.current?.focus(); }, [tab, thread?.messages.length]);
  const runFences = useMemo(() => ({
    folderId: folderIds[0],
    addContext: (text: string) => {
      setMessage((current) => `${current}${current.trim() ? "\n\n" : ""}${text}\n\n`);
      input.current?.focus();
    },
  }), [folderIds]);
  const sourceTrigger = useRef<HTMLButtonElement>(null);
  const modelTrigger = useRef<HTMLButtonElement>(null);
  const modelMenu = useRef<HTMLElement>(null);
  const sourceMenu = useRef<HTMLElement | null>(null);
  const closeSources = useCallback(() => { setSourcesOpen(false); setCapabilitiesOpen(false); queueMicrotask(() => sourceTrigger.current?.focus()); }, []);
  useEffect(() => {
    if (!sourcesOpen || busy || capabilityBusy) return;
    const outside = (event: PointerEvent) => { const node = event.target as Node; if (!sourceMenu.current?.contains(node) && !sourceTrigger.current?.contains(node)) closeSources(); };
    addEventListener("pointerdown", outside);
    return () => removeEventListener("pointerdown", outside);
  }, [busy, capabilityBusy, closeSources, sourcesOpen]);
  const closeModels = useCallback(() => { setModelsOpen(false); queueMicrotask(() => modelTrigger.current?.focus()); }, []);
  useEffect(() => {
    if (!modelsOpen) return;
    const outside = (event: PointerEvent) => { const node = event.target as Node; if (!modelMenu.current?.contains(node) && !modelTrigger.current?.contains(node)) closeModels(); };
    addEventListener("pointerdown", outside);
    return () => removeEventListener("pointerdown", outside);
  }, [closeModels, modelsOpen]);
  useEffect(() => {
    let active = true;
    void window.emma.importedSkillStatus().then((status) => { if (active) setSkill(status?.threadId === thread?.id ? status : null); }).catch(() => { if (active) setSkill(null); });
    return () => { active = false; };
  }, [thread?.id]);
  useEffect(() => {
    let active = true;
    const skills = window.emma.searchImportedSkills({ query: "", limit: 32 }).catch(() => [] as ImportedSkill[]);
    const servers = window.emma.listImportedMcpServers().catch(() => [] as ImportedMcpServer[]);
    void Promise.all([skills, servers]).then(([imported, mcp]) => {
      if (!active) return;
      setCommands([
        ...BUILTIN_COMMANDS,
        ...imported.map((item) => ({ id: item.id, name: item.name, kind: "skill" as const, detail: `${item.source} · skill` })),
        ...mcp.map((item) => ({ id: item.id, name: item.name, kind: "mcp" as const, detail: `${item.source} · MCP server` })),
        ...toolCommands(readSettings().tools.disabledTools),
      ]);
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    const load = () => void window.emma.listArtifacts().then((list) => { if (active) setArtifacts(list); }).catch(() => undefined);
    load();
    const stop = window.emma.onArtifactsChanged(load);
    return () => { active = false; stop(); };
  }, []);
  useEffect(() => { void window.emma.listFolders().then(setFolders).catch(() => setFolders([])); }, []);
  useEffect(() => window.emma.onFolderAttached((attached) => {
    if (attached.threadId !== threadId) return;
    void window.emma.listFolders().then(setFolders).catch(() => undefined);
    setFolderIds((current) => current[0] === attached.folderId ? current : [attached.folderId]);
  }), [threadId]);
  useEffect(() => {
    if (!threadId) return;
    setThreadFolders(threadId, folderIds);
    setThreadMode(threadId, mode);
    void window.emma.setThreadContext({ threadId, folderIds, mode, model: modelKey }).catch(() => undefined);
  }, [folderIds, mode, modelKey, threadId]);
  useEffect(() => {
    let active = true;
    for (const id of folderIds) {
      void window.emma.listFolderFiles(id).then((files) => { if (active) setFolderFiles((current) => ({ ...current, [id]: files })); }).catch(() => undefined);
    }
    return () => { active = false; };
  }, [folderIds, sending]);
  const subagents = useMemo(() => agents.filter((agent) => agent.parentThreadId === threadId), [agents, threadId]);
  const subthreads = useMemo(
    () => snapshot.threads.filter((item) => item.parentThreadId === threadId && !item.archivedAt && item.kind !== "subagent"),
    [snapshot.threads, threadId],
  );
  const inFlight = useMemo(
    () => [...subagents, ...agents.filter((agent) => agent.threadId === threadId)]
      .filter((agent) => agent.status === "running" || agent.status === "waiting"),
    [agents, subagents, threadId],
  );
  const cliRuns = useCliRuns();
  useEffect(() => {
    if (tab === "thread" || tab === "changes" || tab === "git") return;
    if (!subagents.some((agent) => agent.threadId === tab) && !cliRuns.some((run) => run.id === tab)) setTab("thread");
  }, [subagents, cliRuns, tab, setTab]);
  const [contextPage, setContextPage] = useState(readContextPage);
  const page = contextPages.find((item) => item.id === contextPage) ?? contextPages[0];
  useEffect(() => { writeContextPage(page.id); }, [page.id]);
  const uses = threadUses(threadId ?? "");
  const cleared = Math.min(clearedAt(threadId ?? ""), thread?.messages.length ?? 0);
  const carried = useMemo(() => thread && cleared ? { ...thread, messages: thread.messages.slice(cleared) } : thread, [thread, cleared]);
  const landedCalls = useThreadCalls(threadId, sending);
  const ledger = useContextLedger(carried, uses, contextTokens, inFlight, threadExperiments(threadId ?? ""), landedCalls, threadBreakdown(threadId ?? ""));
  const git = useGit(folderIds[0], sending);
  const [changes, setChanges] = useState<FileChange[]>([]);
  const reloadChanges = useCallback(() => {
    if (!threadId) return;
    void window.emma.threadChanges(threadId).then(setChanges).catch(() => setChanges([]));
  }, [threadId]);
  useEffect(() => {
    reloadChanges();
    const listener = window.emma.onChanged(reloadChanges);
    return () => window.emma.offChanged(listener);
  }, [reloadChanges]);
  useEffect(() => {
    const open = () => { if (changes.length) setTab("changes"); };
    addEventListener(OPEN_CHANGES_EVENT, open);
    return () => removeEventListener(OPEN_CHANGES_EVENT, open);
  }, [changes.length, setTab]);
  const cached = useMemo(() => cachedBlocks(thread?.id ?? ""), [thread?.id]);
  useEffect(() => {
    if (!thread) return;
    const paired = pairBlocks(thread.messages, run.landed, {});
    rememberBlocks(thread.id, Object.fromEntries(thread.messages.flatMap((item, index) =>
      paired[index] && wrote(item.content, paired[index]!) ? [[item.timestamp, paired[index]!]] : [])));
  }, [thread, run.landed]);
  const attachedTurns = useMemo(() => thread ? turnAttachments(thread.id, thread.messages) : {}, [thread]);
  if (!thread) return <div className="content-empty"><Mark /><h2>Start a durable thread</h2><p>Threads keep their transcript, folder and context between launches.</p><button type="button" disabled={busy} onClick={newThread}>New thread</button></div>;
  const locked = busy || capabilityBusy;
  const echo = run.pending && !hasPersistedPrompt(snapshot, thread.id, run.pending.after, run.pending.content) ? run.pending.content : null;
  const unlanded = !sending && run.blocks.length > 0 && !arrived(thread.messages, run.blocks);
  const streaming = (sending || unlanded) && run.blocks.length ? run.blocks : null;
  const landedBlocks = pairBlocks(thread.messages, unlanded ? run.landed.slice(0, -1) : run.landed, cached);
  const setCapabilityRunning = (value: boolean) => { setCapabilityBusy(value); onSendingChange(value); };
  const localContext = contextCommands(folders, folderIds, folderFiles);
  const allCommands = commands;
  const imported = commands.filter((item) => item.kind === "skill" || item.kind === "mcp");
  const atItems = atCommands(artifacts, notes, folders, folderIds, folderFiles);
  const noteUses = (added: Omit<ContextUse, "turns">[]) => { recordUses(thread.id, added); ledgerChanged((current) => current + 1); };
  const dropPick = (pick: ContextPick) => setPicks((current) => current.filter((item) => pickKey(item) !== pickKey(pick)));
  const holdAttachments = (held: HeldAttachment[]) =>
    held.forEach((item) => addPick({ kind: "attachment", id: item.id, name: item.name, path: item.path, ...(item.thumbnail ? { thumbnail: item.thumbnail } : {}) }));
  const attachDropped = (files: FileList | null | undefined) => {
    if (locked || !files?.length) return;
    setRunError("");
    void Promise.all([...files].map(async (file) => window.emma.attachData({ name: file.name, data: await file.arrayBuffer() })))
      .then(holdAttachments)
      .catch((reason: unknown) => setRunError(reasonText(reason)));
  };
  const slash = locked || slashDismissed ? null : slashQuery(message, caret);
  const slashMatches = slash ? matchCommands(slash.sigil === "@" ? atItems : allCommands, slash.query).slice(0, MENU_MAX) : [];
  const slashOpen = slash !== null;
  const slashActive = Math.min(slashPick, slashMatches.length - 1);
  const typing = (element: HTMLTextAreaElement) => { setMessage(element.value); setCaret(element.selectionStart ?? element.value.length); setSlashDismissed(false); setSlashPick(0); setHistory(-1); };
  const past = thread.messages.filter((item) => item.role === "user").map((item) => sentByThread(item.content).body).reverse();
  const openCapabilities = () => { setModelsOpen(false); setSourcesOpen(true); setCapabilitiesOpen(true); };
  const pickCommand = (command: SlashCommand) => {
    if (!slash) return;
    const next = command.kind === "builtin" ? { text: `${message.slice(0, slash.start)}${message.slice(slash.start + slash.query.length + 1)}`, caret: slash.start } : insertCommand(message, slash, command.name);
    setMessage(next.text);
    setSlashPick(0);
    queueMicrotask(() => { input.current?.focus(); input.current?.setSelectionRange(next.caret, next.caret); setCaret(next.caret); });
    if (command.pick) addPick(command.pick);
    else if (command.kind === "tool" || command.kind === "mcp") return;
    else if (command.kind === "skill") void window.emma.selectImportedSkill({ id: command.id, threadId: thread.id }).then(setSkill).catch(() => undefined);
    else if (command.id === "agent") setAgentOpen(true);
    else if (command.id === "import") onManageImports();
    else if (command.id === "new") newThread();
    else if (command.id === "clear") {
      markCleared(thread.id, thread.messages.length);
      ledgerChanged((current) => current + 1);
      void window.emma.clearThreadContext(thread.id).catch((reason: unknown) => setRunError(reasonText(reason)));
    }
    else openCapabilities();
  };
  const composerKeys = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen && slashMatches.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setSlashPick((current) => (Math.min(current, slashMatches.length - 1) + (event.key === "ArrowDown" ? 1 : slashMatches.length - 1)) % slashMatches.length); return; }
      if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); pickCommand(slashMatches[slashActive]); return; }
    }
    if (slashOpen && event.key === "Escape") { event.preventDefault(); setSlashDismissed(true); return; }
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.shiftKey) {
      const element = event.currentTarget;
      const edge = event.key === "ArrowUp" ? 0 : element.value.length;
      if (element.selectionStart === edge && element.selectionEnd === edge) {
        const next = event.key === "ArrowUp" ? Math.min(history + 1, past.length - 1) : history - 1;
        if (next < -1) return;
        event.preventDefault();
        setHistory(next);
        const text = next < 0 ? "" : past[next];
        setMessage(text);
        queueMicrotask(() => { input.current?.setSelectionRange(text.length, text.length); setCaret(text.length); });
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
  };
  const send = async (event?: FormEvent, text?: string) => {
    event?.preventDefault();
    if (locked) return;
    const content = (text ?? message).trim();
    if (!content) return;
    if (text === undefined) { setMessage(""); setHistory(-1); }
    const attached = folderIds.length || picks.length ? await buildAttachedContext(folders, folderIds, picks, folderFiles) : { text: "", uses: [], images: [] };
    const attachedSkill = skill;
    const after = thread.messages.length;
    rememberTurnAttachments(thread.id, after, content, picks.flatMap((pick) => pick.kind === "attachment"
      ? [{ name: pick.name, path: pick.path, ...(pick.thumbnail ? { thumbnail: pick.thumbnail } : {}) }]
      : []));
    sendTurn(thread.id, {
      content,
      after,
      params: { ...(attached.text ? { attachedContext: attached.text } : {}), ...(attached.images.length ? { attachedImages: JSON.stringify(attached.images) } : {}), ...(attachedSkill ? { skillAttachmentId: attachedSkill.id } : {}) },
      delivered: () => noteUses([...attached.uses, ...(attachedSkill ? [{ kind: "skills" as const, label: `${attachedSkill.source}/${attachedSkill.name}`, chars: attachedSkill.chars ?? 0 }] : [])]),
    }, reload);
    setSkill(null);
    setPicks([]);
  };
  const steer = () => {
    const text = message.trim();
    if (!text) return;
    setMessage("");
    setRunError("");
    void window.emma.steerAgent({ threadId: thread.id, text }).catch((reason: unknown) => {
      setMessage((current) => current || text);
      setRunError(reasonText(reason));
    });
  };
  const openAgent = subagents.find((agent) => agent.threadId === tab);
  const agentThread = openAgent && snapshot.threads.find((item) => item.id === openAgent.threadId);
  const threadClis = cliRuns.filter((run) => run.threadId === thread.id);
  const openCli = threadClis.find((run) => run.id === tab);
  const tabs: AgentTab[] = [
    { id: "thread", label: threadLabel(thread), closable: false },
    ...subagents.map((agent) => ({ id: agent.threadId, label: agent.title, color: agent.color, closable: agent.status !== "running" && agent.status !== "waiting" })),
    ...threadClis.map((run) => ({
      id: run.id,
      label: `${cliHarness(run.cli)?.label ?? run.cli} ${run.id}`,
      icon: <BrandIcon brand={brandForImporter(run.cli)} className={`cli-mark ${run.cli}`} />,
      closable: run.status !== "running",
    })),
    ...(changes.length ? [{ id: "changes", label: "Changes", closable: false }] : []),
    ...(git ? [{ id: "git", label: `Git · ${git.branch}`, closable: false }] : []),
  ];
  const panel = openCli ? <CliPanel run={openCli} busy={locked} />
    : tab === "changes" ? <ChangesPanel changes={changes} busy={locked} onReverted={reloadChanges} />
    : tab === "git" && git ? <GitPanel snapshot={git} folderId={folderIds[0]} full />
    : openAgent ? <AgentPanel agent={openAgent} transcript={<AgentTranscript threadId={openAgent.threadId} thread={agentThread} />} />
    : null;
  return <div className="thread-layout">
    <div className="thread-column">
      <CliDock runs={threadClis} active={tab} onOpen={setTab} />
      <TabStrip tabs={tabs} active={tab} onPick={setTab} onClose={(id) => { if (tab === id) setTab("thread"); }} />
      {panel}
      <div className="chat-pane" hidden={!!panel}>
        <Region name="chat" props={{
          thread, messages: thread.messages, busy: locked, sending,
          send: (text: string) => void send(undefined, text), stop: () => window.emma.stopAgent(thread.id),
          streaming, mode, setMode,
        }}>
        <section className="conversation" aria-label={`Thread: ${threadLabel(thread)}`}>
      <header className="thread-bar"><input
        className="thread-name"
        key={`${thread.id}:${thread.title}`}
        defaultValue={threadLabel(thread)}
        aria-label="Thread name"
        maxLength={128}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === "Escape") { if (event.key === "Escape") event.currentTarget.value = threadLabel(thread); event.currentTarget.blur(); } }}
        onBlur={(event) => {
          const named = event.currentTarget.value.trim();
          if (!named || named === thread.title) { event.currentTarget.value = threadLabel(thread); return; }
          void act("renameThread", { threadId: thread.id, title: named }).then(reload);
        }}
      /><TagPicker threadId={thread.id} /><div className="thread-actions">
        {folderIds[0] && (!!git?.diff.trim() || changes.length > 0) && <OpenIn folderId={folderIds[0]} label />}
        <PaneSwitch open={layout.terminalOpen}
          running={() => window.emma.listTerminals(thread.id).then((tabs) => tabs.some((tab) => tab.running))}
          onOpen={() => pane({ terminalOpen: true })}
          onHide={() => pane({ terminalOpen: false })}
          onClose={() => { pane({ terminalOpen: false }); void closeTerminals(thread.id); }}
          openLabel="Open the terminal" closeLabel="Close the terminal"
          hideNote="Keeps every shell running where it is" closeNote="Ends every shell and frees what it holds"><TerminalIcon /></PaneSwitch>
        <PaneSwitch open={layout.browserOpen}
          running={() => window.emma.browserStatus(thread.id).then((status) => status.running)}
          onOpen={() => showBrowser(true)}
          onHide={() => showBrowser(false)}
          onClose={() => { showBrowser(false); void window.emma.browserNav({ threadId: thread.id, action: "close" }).catch(() => undefined); }}
          openLabel="Open the browser pane" closeLabel="Close the browser pane"
          hideNote="Keeps the page, its cookies and its memory" closeNote="Quits Chrome and frees what it holds"><GlobeIcon /></PaneSwitch>
        <button type="button" className="page-info-button" aria-label="Show thread details" aria-haspopup="dialog" onClick={() => setAgentOpen(true)}>i</button></div></header>
      <div className="transcript-wrap">
      <TranscriptRail messages={thread.messages} scroller={transcript} />
      <div className="transcript" ref={transcript} onScroll={transcriptScroll}>
        <RunContext.Provider value={runFences}>
        {!thread.messages.length && echo === null && !sending && <div className="welcome"><Mark /><h3>What are we working on?</h3><p>Ask Emma to research, plan, write, or think. Nothing enters knowledge unless you choose it.</p></div>}
        {thread.messages.map((item, index) => <Fragment key={`${item.timestamp}-${index}`}>{cleared > 0 && index === cleared && <ContextCut />}<Turn item={item} blocks={landedBlocks[index]} index={index} attached={attachedTurns[index]} /></Fragment>)}
        {cleared > 0 && cleared === thread.messages.length && <ContextCut />}
        {echo !== null && <article className="message user pending"><div className="message-body"><p>{echo}</p></div><footer className="message-meta"><span>You</span></footer></article>}
        {streaming !== null && <Streaming blocks={streaming} threadId={thread.id} />}
        {sending && streaming === null && <p className="waiting" role="status"><Mark /> Emma is working…</p>}
        {!sending && run.stopped && <p className="waiting stopped" role="status">Agent stopped. Ask Emma to continue where it left off.</p>}
        </RunContext.Provider>
      </div>
      {!atEnd && <button type="button" className="transcript-tail" onClick={toEnd} aria-label="Scroll to the latest message" title="Jump to the end">↓</button>}
      </div>
      <ProjectBar folders={folders} ids={folderIds} setFolders={setFolders} setIds={setFolderIds} git={git} name={worktreeName(thread.id)} busy={locked} />
      {queued.length > 0 && <div className="queued-stack" aria-label="Queued messages">{queued.map((turn, index) => <div className="queued-row" key={`${index}-${turn.content}`}><span>Queued · {turn.content}</span><button type="button" onClick={() => dropQueued(thread.id, index)} aria-label="Drop this queued message">×</button></div>)}</div>}
      <form className="composer" onSubmit={(event) => void send(event)}
        onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
        onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); attachDropped(event.dataTransfer.files); } }}><label className="sr-only" htmlFor="message">Message Emma</label>
        {picks.some((pick) => pick.kind === "attachment") && <div className="composer-tray">{picks.map((pick) => pick.kind !== "attachment" ? null : <div className="composer-tile" key={pickKey(pick)} title={pick.name}>{pick.thumbnail ? <img src={pick.thumbnail} alt="" /> : <><FileMark path={pick.name} /><small>{pick.name}</small></>}<button type="button" disabled={locked} onClick={() => dropPick(pick)} aria-label={`Remove ${pick.name}`}>×</button></div>)}</div>}<div className="composer-input"><div className="composer-highlight" ref={mirror} aria-hidden="true">{highlightSegments(message, allCommands.map((item) => item.name), atItems.map((item) => item.name)).map((segment, index) => <span key={index} className={segment.hue === undefined ? undefined : "slash-token"} data-hue={segment.hue}>{segment.text}</span>)}{"\n"}</div><textarea ref={input} autoFocus={!thread.messages.length} id="message" value={message} disabled={locked} maxLength={65_536} role="combobox" aria-expanded={slashOpen} aria-controls="slash-menu" aria-autocomplete="list" onChange={(event) => typing(event.currentTarget)} onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)} onScroll={(event) => { if (mirror.current) mirror.current.scrollTop = event.currentTarget.scrollTop; }} onKeyDown={composerKeys} onPaste={(event) => { if (event.clipboardData.files.length) { event.preventDefault(); attachDropped(event.clipboardData.files); } }} placeholder={sending ? "Emma is working — Enter queues, ⤳ steers…" : "Ask Emma to continue…"} rows={2} /></div>{slashOpen && <section className="source-popover slash-menu" id="slash-menu" role="listbox" aria-label={slash?.sigil === "@" ? "Artifacts, saved notes and files" : "Built-in tools, skills and MCP servers"}>{slashMatches.map((item, index) => <button type="button" role="option" aria-selected={index === slashActive} className={`slash-row ${index === slashActive ? "active" : ""}`} key={`${item.kind}-${item.id}`} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setSlashPick(index)} title={item.detail} onClick={() => pickCommand(item)}><strong>{slash?.sigil ?? "/"}{item.name}</strong><em className="slash-kind" data-kind={item.kind}>{KIND_LABELS[item.kind]}</em><small>{item.detail}</small></button>)}{!slashMatches.length && <p className="slash-empty">Nothing matches “{slash?.query}”. {slash?.sigil === "@" ? "Artifacts, saved notes and the files of this thread's folders appear here." : "Built-in tools, imported skills and MCP servers appear here."}</p>}</section>}<div className="composer-row"><div className="composer-tools"><button ref={sourceTrigger} type="button" className="source-trigger" disabled={locked} aria-label="Add context or plugin" aria-haspopup="dialog" aria-expanded={sourcesOpen} onClick={() => sourcesOpen ? closeSources() : setSourcesOpen(true)}>＋</button><ModePicker mode={mode} setMode={setMode} disabled={locked} /></div><button ref={modelTrigger} type="button" className="model-button" disabled={locked} aria-haspopup="dialog" aria-expanded={modelsOpen} aria-label={`Select model, currently ${modelLabel}${modelTag ? ` · ${modelTag}` : ""}${thinkingLevel ? ` · thinking ${THINKING_LABELS[thinkingLevel]}` : ""}`} onClick={() => { if (modelsOpen) { closeModels(); return; } setSourcesOpen(false); setModelsOpen(true); }}><BrandIcon brand={modelBrand} className="model-brand" /><span className="model-label">{modelLabel}</span>{modelTag && <em className={`model-route ${modelTag === "Local" ? "local" : "remote"}`}>{modelTag}</em>}<ThinkingTag level={thinkingLevel} /><span aria-hidden="true">▾</span></button>{sending
          ? (message.trim()
            ? <button type="button" className="composer-send steering" disabled={locked} onClick={steer} aria-label="Steer this turn" title="Steer — arrives with the next tool result">⤳</button>
            : <button type="button" className="composer-send stopping" onClick={() => window.emma.stopAgent(thread.id)} aria-label="Stop this turn" title="Stop this turn">■</button>)
          : <button className="composer-send" disabled={locked || !message.trim()} aria-label="Send message">↑</button>}</div>{modelsOpen && <ModelMenu ref={modelMenu} close={closeModels} act={act} busy={locked} onSettingsChanged={onModelChanged} onManage={onManageModels} />}{runError && <p className="capability-error" role="alert">{runError}</p>}{run.error && <p className="capability-error" role="alert">{run.error}</p>}{run.draft && <div className="composer-attachment queued-turn"><span>Not sent · {run.draft}</span><button type="button" onClick={() => setMessage((current) => current || takeDraft(thread.id))} aria-label="Put this message back in the composer">↺</button></div>}{skill &&<div className="composer-attachment"><span>Skill · {skill.name} · next turn only</span><button type="button" disabled={locked} onClick={() => void window.emma.clearImportedSkill(skill.id).then(() => setSkill(null))} aria-label="Clear attached skill">×</button></div>}{picks.map((pick) => pick.kind === "attachment" ? null : <div className="composer-attachment" key={pickKey(pick)}><span>{pickKindLabel(pick)} · {pickLabel(pick, folders)} · next turn only</span><button type="button" disabled={locked} onClick={() => dropPick(pick)} aria-label={`Clear ${pickLabel(pick, folders)}`}>×</button></div>)}{sourcesOpen && <section className="source-popover add-menu" role="dialog" aria-modal="false" aria-labelledby="source-popover-title" tabIndex={-1} ref={(node) => { sourceMenu.current = node; if (node && !node.contains(document.activeElement)) node.focus(); }} onKeyDown={(event) => { if (event.key === "Escape" && !locked) closeSources(); }}><header><h3 id="source-popover-title">Add</h3><button type="button" disabled={locked} aria-label="Close add menu" onClick={closeSources}>×</button></header>{capabilitiesOpen ? <CapabilityPopover threadId={thread.id} locked={locked} close={() => setCapabilitiesOpen(false)} skill={skill} setSkill={setSkill} setBusy={setCapabilityRunning} /> : <><button type="button" className="add-row kind-knowledge" disabled={locked} onClick={() => { closeSources(); void window.emma.attachFiles().then(holdAttachments).catch((reason: unknown) => setRunError(reasonText(reason))); }}><b><ClipIcon /></b><div><strong>Attach files</strong><small>Images, code, CSVs, Markdown — dropping or pasting into the composer works too</small></div></button><span className="add-section">Files</span><div className="add-context"><label className="sr-only" htmlFor="context-search">Search the files of this thread's folders</label><input id="context-search" value={contextQuery} disabled={locked} onChange={(event) => setContextQuery(event.target.value)} placeholder="Search files, skills & MCP — same as typing /" />{matchCommands(localContext, contextQuery).slice(0, 12).map((item) => <button type="button" className="slash-row" key={item.id} title={item.detail} disabled={locked} onClick={() => { if (item.pick) addPick(item.pick); }}>{item.pick?.kind === "file" ? <FileMark path={item.pick.path} /> : <span className="git-type" aria-hidden>·</span>}<strong>/{item.name}</strong><small>{item.detail}</small></button>)}{!localContext.length && <p className="project-empty">Pick a folder in the project chip to list its files here.</p>}</div><span className="add-section">Skills &amp; MCP servers</span><div className="add-context">{matchCommands(imported, contextQuery).map((item) => <button type="button" className="slash-row" key={`${item.kind}-${item.id}`} title={item.detail} disabled={locked} onClick={() => { if (item.kind === "skill") { void window.emma.selectImportedSkill({ id: item.id, threadId: thread.id }).then(setSkill).catch(() => undefined); closeSources(); } else openCapabilities(); }}><strong>{item.kind === "skill" ? "Skill" : "MCP"} · {item.name}</strong><small>{item.detail}</small></button>)}{!imported.length && <p className="project-empty">Nothing imported yet — use /import to scan this Mac.</p>}</div><button type="button" className="add-row kind-capability" onClick={() => openCapabilities()}><b>⌘</b><div><strong>Imported skills &amp; MCP</strong><small>Attach a skill, or see the MCP servers every turn is handed</small></div></button><span className="add-section">Built-in plugins</span><button type="button" className="add-row kind-agent" onClick={() => { closeSources(); setAgentOpen(true); }}><b>⌁</b><div><strong>Agent runtime</strong><small>Inspect Emma's Zig harness and headless entry point</small></div></button><div className="add-row muted kind-hint"><b>⌥</b><div><strong>Draw on screen</strong><small>Double-tap left Option, then choose the yellow pen</small></div></div></>}</section>}</form>
    </section></Region></div>
    </div>
    <Region name="context" props={{
      thread, messages: thread.messages, ledger, busy: locked, sending, agents, subagents, subthreads, git,
      collapsed: layout.inspectorCollapsed, setCollapsed: (inspectorCollapsed: boolean) => pane({ inspectorCollapsed }),
    }}>
    <aside className={`inspector ${layout.inspectorCollapsed ? "collapsed" : ""}`}>
      {!layout.inspectorCollapsed && <ResizeHandle label="Resize thread inspector" value={layout.inspectorWidth} min={210} max={360} direction={-1} onChange={(inspectorWidth) => pane({ inspectorWidth })} />}
      <button type="button" className="inspector-toggle" aria-label={layout.inspectorCollapsed ? "Expand thread inspector" : "Collapse thread inspector"} aria-expanded={!layout.inspectorCollapsed} onClick={() => pane({ inspectorCollapsed: !layout.inspectorCollapsed })}>{layout.inspectorCollapsed ? "‹" : "›"}</button>
      {!layout.inspectorCollapsed && <div className="inspector-body"><header>
        {contextPages.length > 1 ? <span className="inspector-tabs" role="tablist" aria-label="Context bar pages">
          {contextPages.map((item) => <button key={item.id} type="button" role="tab" aria-selected={item.id === page.id} title={`${item.name} — ${item.widgets.length} ${plural(item.widgets.length, "component")}`} onClick={() => setContextPage(item.id)}>{item.name}</button>)}
        </span> : <span>{page.name}</span>}
        {changes.length > 0 && <button type="button" className="changes-open" title={`${changes.length} ${plural(changes.length, "file")} changed — open the diff`} onClick={() => setTab("changes")}><ChangeCount stat={diffStat(changes)} /></button>}</header>
      <ContextWidgets page={page} context={{ ledger, threadId: thread.id, sending, subagents, subthreads, agents, onOpenThread: openThreadPage, tab, onPick: setTab, git, onOpenGit: () => setTab("git") }} onChange={(widgets) => onContextPages(contextPages.map((item) => item.id === page.id ? { ...item, widgets } : item))} /></div>}
    </aside></Region>
    {layout.browserOpen && <div className="browser-column">
      <ResizeHandle label="Resize browser" value={layout.browserWidth} min={MIN_BROWSER_WIDTH} max={720} direction={-1} onChange={(browserWidth) => pane({ browserWidth })} />
      <BrowserPane threadId={thread.id}
        wide={layout.browserWidth >= WIDE_BROWSER_WIDTH}
        onToggleWide={() => pane({ browserWidth: layout.browserWidth >= WIDE_BROWSER_WIDTH ? MIN_BROWSER_WIDTH : WIDE_BROWSER_WIDTH })}
        onHide={() => showBrowser(false)}
        onClose={() => { showBrowser(false); void window.emma.browserNav({ threadId: thread.id, action: "close" }).catch(() => undefined); }} />
    </div>}
    {layout.terminalOpen && <div className="terminal-row">
      <ResizeHandle label="Resize terminal" axis="y" value={layout.terminalHeight} min={MIN_TERMINAL_HEIGHT} max={MAX_TERMINAL_HEIGHT} direction={-1} onChange={(terminalHeight) => pane({ terminalHeight })} />
      <TerminalPanel threadId={thread.id}
        onSelect={(value) => addPick({ kind: "terminal", id: value.id, text: value.text, lines: value.lines })}
        onHide={() => pane({ terminalOpen: false })}
        onOpenInEmma={(url) => { showBrowser(true); void window.emma.browserOpen({ threadId: thread.id, url }).catch((reason: unknown) => setRunError(reasonText(reason))); }} />
    </div>}{agentOpen && <AgentDialog thread={thread} close={() => setAgentOpen(false)} />}
  </div>;
}

function AgentDialog({ thread, close }: { thread: Thread; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);
  const dismiss = () => dialog.current?.close();
  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="agent-title" onClose={close} onCancel={(event) => { event.preventDefault(); dismiss(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) dismiss(); }}><section className="agent-dialog"><header><div><span>Thread agent</span><h2 id="agent-title">Emma harness</h2></div><button type="button" onClick={dismiss} aria-label="Close agent details">×</button></header><dl><div><dt>Thread</dt><dd className="copyable"><span>{thread.id}</span><CopyTurn text={thread.id} label="Copy thread ID" /></dd></div><div><dt>Created</dt><dd>{date(thread.createdAt)} · {time(thread.createdAt)}</dd></div><div><dt>Modified</dt><dd>{date(thread.updatedAt)} · {time(thread.updatedAt)}</dd></div><div><dt>Runtime</dt><dd><i /> emma-cli · ACP</dd></div><div><dt>Context</dt><dd>{thread.messages.length} durable {plural(thread.messages.length, "message")}</dd></div><div><dt>Tools</dt><dd>Lazy MCP search; schemas load only after selection</dd></div></dl><div className="agent-cli"><span>Headless entry point</span><code>./harness/zig-out/bin/emma-cli acp</code><p>Run coding or automation threads without Electron. See harness/README.md for the protocol.</p></div></section></dialog>;
}

const SETTINGS_KEY = "emma.settings.v1";
function readSettings(): UserSettings {
  let settings: UserSettings;
  try { settings = validateSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null")); } catch { settings = structuredClone(defaultSettings); }
  applyAppearance(settings);
  return settings;
}

function applyAppearance({ interfaceFont, agentFont, accent, navIconColors, uiScale }: UserSettings) {
  const root = document.documentElement;
  root.style.setProperty("--font-mono", fontStack(interfaceFont));
  root.style.setProperty("--font", fontStack(agentFont));
  root.style.setProperty("--accent", accent.startsWith("#") ? accent : `var(--${accent})`);
  root.toggleAttribute("data-nav-mono", !navIconColors);
  if (isWorkspaceWindow) void window.emma.setZoom(uiScale / 100);
}

function persistSettings(settings: UserSettings): UserSettings {
  const valid = validateSettings(settings);
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(valid));
  dispatchEvent(new Event("emma-settings-changed"));
  return valid;
}

const FREE_ROUTER_NAME = "Emma Free Router";
const freeRouterBrand: BrandDefinition = { id: FREE_ROUTER_KEY, label: "Emma", fallback: "∞" };
const freeRouterEntry: CatalogEntry = {
  maker: "other",
  key: FREE_ROUTER_KEY,
  name: FREE_ROUTER_NAME,
  detail: `${FREE_ROUTER_MODELS.length} free models, best first · falls through when one is rate-limited`,
  brand: freeRouterBrand,
  free: true,
};

function modelKeyLabel(settings: UserSettings, key: string): string {
  if (key === FREE_ROUTER_KEY) return FREE_ROUTER_NAME;
  if (key === "fallback") return "No model chosen";
  if (key.startsWith("openrouter:")) return key.slice("openrouter:".length).split("/").at(-1) ?? "OpenRouter";
  if (key.startsWith("local:")) return settings.localModels.find((profile) => profile.id === key.slice("local:".length))?.name ?? "Local model";
  return "Model";
}

function modelKeyBrand(settings: UserSettings, key: string): BrandDefinition | undefined {
  if (key === FREE_ROUTER_KEY) return freeRouterBrand;
  if (key.startsWith("openrouter:")) return brandForModel(key.slice("openrouter:".length), "openrouter");
  if (key.startsWith("local:")) {
    const profile = settings.localModels.find((item) => item.id === key.slice("local:".length));
    return profile ? brandForModel(profile.modelId, "local") : undefined;
  }
  return undefined;
}

function modelKeyRoute(settings: UserSettings, key: string): string {
  if (key === FREE_ROUTER_KEY) return `${FREE_ROUTER_MODELS.length} free models · via OpenRouter`;
  if (key === "fallback") return "No model sent · the agent’s own free route";
  if (key.startsWith("openrouter:")) return `${modelKeyBrand(settings, key)?.label ?? "Community"} · via OpenRouter`;
  if (key.startsWith("local:")) return `${modelKeyBrand(settings, key)?.label ?? "Custom"} · via local server`;
  return "Unknown route";
}

const modelKeyTag = (key: string) => key.startsWith("local:") ? "Local" : key === "fallback" || isFreeModel(key) || key === FREE_ROUTER_KEY ? "Free" : "";

const selectedModelLabel = (settings: UserSettings) => modelKeyLabel(settings, settings.selectedModel);
const selectedModelBrand = (settings: UserSettings) => modelKeyBrand(settings, settings.selectedModel);

function useSelectedModel(selectedModel: string): { contextTokens: number } {
  const [windows, setWindows] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!selectedModel.startsWith("openrouter:")) return;
    let live = true;
    void window.emma.request<OpenRouterCatalog>("listOpenRouterModels")
      .then((catalog) => { if (live) setWindows((current) => ({ ...current, [selectedModel]: catalog.models.find((model) => model.id === selectedModel.slice("openrouter:".length))?.contextLength ?? 0 })); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [selectedModel]);
  return { contextTokens: windows[selectedModel] ?? 0 };
}

const THINKING_LABELS: Record<ThinkingLevel, string> = { "": "Default", off: "Off", none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Very high", max: "Max" };

function ThinkingTag({ level }: { level: ThinkingLevel }) {
  return level ? <em className="model-effort" data-level={level}>{THINKING_LABELS[level]}</em> : null;
}

function ThinkingSlider({ level, stops, setLevel, disabled }: { level: ThinkingLevel; stops: ThinkingLevel[]; setLevel: (level: ThinkingLevel) => void | Promise<void>; disabled: boolean }) {
  const [dragged, setDragged] = useState<ThinkingLevel | null>(null);
  const [saved, setSaved] = useState(level);
  if (saved !== level) { setSaved(level); setDragged(null); }
  const shown = dragged !== null && stops.includes(dragged) ? dragged : level;
  const index = Math.max(0, stops.indexOf(shown));
  const style = { "--stop": String(index), "--stops": String(Math.max(1, stops.length - 1)) } as CSSProperties;
  const drag = (next: ThinkingLevel) => {
    setDragged(next);
    void Promise.resolve(setLevel(next)).finally(() => setDragged((current) => current === next ? null : current));
  };
  return <label className="thinking-slider" data-level={shown} style={style} title={`Thinking · ${THINKING_LABELS[shown]}`}>
    <span className="sr-only">Thinking effort</span>
    <span className="thinking-control">
      <span className="thinking-track" aria-hidden="true"><span className="thinking-fill" />{stops.map((stop, position) => <i key={stop} data-on={position <= index ? "true" : "false"} />)}<span className="thinking-knob" /></span>
      <input type="range" min={0} max={stops.length - 1} step={1} value={index} disabled={disabled || stops.length < 2} aria-label="Thinking effort" aria-valuetext={THINKING_LABELS[shown]} onChange={(event) => drag(stops[Number(event.target.value)])} />
    </span>
    <em>{stops.length < 2 && shown === "" ? "None" : THINKING_LABELS[shown]}</em>
  </label>;
}

async function selectModelKey(settings: UserSettings, key: string, act: (method: string, params?: Record<string, string>) => Promise<unknown>, effort = ""): Promise<UserSettings | undefined> {
  if (key === FREE_ROUTER_KEY) {
    const ids = await window.emma.request<OpenRouterCatalog>("listOpenRouterModels").then((catalog) => catalog.models.map((model) => model.id)).catch(() => []);
    if (await act("selectOpenRouterModel", { modelId: freeRouterChain(ids).split(",")[0], effort: "" }) === undefined) return undefined;
  } else if (key.startsWith("openrouter:")) {
    if (await act("selectOpenRouterModel", { modelId: key.slice("openrouter:".length), effort }) === undefined) return undefined;
  } else if (key.startsWith("local:")) {
    const profile = settings.localModels.find((item) => item.id === key.slice("local:".length));
    if (!profile || await act("selectLocalModel", { baseUrl: profile.baseUrl, modelId: profile.modelId, credentialEnv: profile.credentialEnv }) === undefined) return undefined;
  } else if (await act("selectFallbackModel") === undefined) return undefined;
  return { ...settings, selectedModel: key };
}

function syncMainPreferences(settings: UserSettings) {
  window.emma.setOverlayPreferences({ notchGap: settings.notchGap, cursorOrbsEnabled: settings.cursorOrbsEnabled, notchConcurrency: settings.notchConcurrency, systemPrompt: settings.systemPrompt, prompts: settings.prompts, connections: settings.connections });
  void window.emma.setVerifier(settings.verifier).catch(() => undefined);
  void window.emma.setToolSettings(settings.tools).catch(() => undefined);
  void window.emma.setHarnessExperiments(settings.harnessExperiments).catch(() => undefined);
  void window.emma.setKeybinds(settings.keybinds).catch(() => []);
  syncImprovements();
}

const credits: { title: string; body: string; href?: string; link?: string }[] = [
  { title: "vercel-labs/fx", body: "Emma's coding harness, emma-cli, is a fork of fx — a coding agent harness written in Zig by Vercel. It keeps fx's agent loop, permission model, hooks, skills, subagents, tools, and MCP client, and replaces what tied it to Vercel's hosted services. Apache-2.0; the license and upstream notices ship with the fork.", href: "https://github.com/vercel-labs/fx", link: "vercel-labs/fx ↗" },
  { title: "ripgrep", body: "The ripgrep tool is BurntSushi's ripgrep 14.1.1, pinned by version and by the SHA-256 its release publishes, and shipped inside the app. MIT / Unlicense.", href: "https://github.com/BurntSushi/ripgrep", link: "BurntSushi/ripgrep ↗" },
  { title: "Icons and marks", body: "Vendor icons come from official brand kits where one exists, and otherwise from pinned Simple Icons (CC0 1.0) and lobe-icons (MIT) revisions; the settings gear is Lucide's path (ISC). Every file is bundled rather than fetched at runtime, and each mark stays its owner's trademark.", href: "https://github.com/simple-icons/simple-icons", link: "simple-icons ↗" },
  { title: "Departure Mono", body: "The interface face is Departure Mono by Helena Zhang, bundled as a woff2 rather than loaded from a font CDN. SIL Open Font License 1.1; the license text ships beside the file." },
  { title: "xterm.js", body: "The terminal panel is a real login shell, drawn by xterm.js. Its pty is a small clang-built helper rather than node-pty, which would need a rebuild for every Electron release. MIT.", href: "https://github.com/xtermjs/xterm.js", link: "xtermjs/xterm.js ↗" },
  { title: "karpathy/autoresearch", body: "Autoresearch jobs are that loop generalised: propose one change, measure the metric, commit it if the metric improved and hard-reset the project if it did not.", href: "https://github.com/karpathy/autoresearch", link: "karpathy/autoresearch ↗" },
  { title: "Electron + React", body: "The renderer is sandboxed and reaches main only through a narrow preload API. Electron owns the windows; clang-built helpers own the ⌥⌥ Quick Ask gesture and macOS dictation. React 19, TypeScript, and Vite build it; Recharts draws the charts and Mermaid the diagrams." },
  { title: "Rust + Markdown", body: "Threads and knowledge are Markdown on this Mac: emma-core owns their records, their validation, and the atomic writes, and the Rust host is an NDJSON server onto it that talks to no model. Rust 1.97, and Zig 0.16 builds the harness." },
  { title: "Model Context Protocol", body: "Emma speaks no MCP herself: configured servers are handed to the harness, which starts them and holds their tools behind a search until the model asks for one. Servers and skills already set up for another agent are referenced where they sit, not copied, and every call still stops at Emma's permission gate." },
  { title: "OpenAI-compatible providers", body: "Every remote route is a Chat Completions endpoint — OpenRouter by default, any compatible local or hosted server otherwise. A setting names an environment variable and never holds a key; a pasted key is encrypted with the macOS keychain and reaches the agent only through its spawn environment." },
];

type SettingsPage = "keybinds" | "notch" | "voice" | "appearance" | "contextbar" | "models" | "prompts" | "tools" | "permissions" | "harness" | "imports" | "connections" | "privacy" | "about";
const settingsPages: { id: SettingsPage; label: string; copy: string; group: string }[] = [
  { id: "keybinds", label: "Keybinds", copy: "Shortcuts, actions, orbs", group: "Personal" },
  { id: "notch", label: "Notch", copy: "Quick Ask model and tasks", group: "Personal" },
  { id: "voice", label: "Voice", copy: "Dictation and cleanup", group: "Personal" },
  { id: "appearance", label: "Appearance", copy: "Accent colour, section marks, fonts", group: "Personal" },
  { id: "contextbar", label: "Context bar", copy: "Arrange the thread inspector", group: "Personal" },
  { id: "models", label: "Models", copy: "Picker, keys, and routes", group: "Personal" },
  { id: "prompts", label: "System prompt", copy: "Global, and per model", group: "Coding" },
  { id: "tools", label: "Tools", copy: "What the agent may call", group: "Integrations" },
  { id: "permissions", label: "Permissions", copy: "What macOS lets Emma do", group: "Integrations" },
  { id: "harness", label: "Harness", copy: "Experimental context hooks", group: "Coding" },
  { id: "imports", label: "Imports & plugins", copy: "Skills and MCP sources", group: "Integrations" },
  { id: "connections", label: "Connections", copy: "Third-party CLI tools", group: "Integrations" },
  { id: "privacy", label: "Data & privacy", copy: "Boundaries and reset", group: "Emma" },
  { id: "about", label: "About Emma", copy: "Build and architecture", group: "Emma" },
];

const providerMarks = [
  ["openai", "OpenAI", "US"], ["anthropic", "Anthropic", "US"], ["gemini", "Gemini", "US"], ["xai", "xAI", "US"],
  ["openrouter", "OpenRouter", "Router"], ["meta", "Meta", "US"], ["mistral", "Mistral", "EU"], ["cohere", "Cohere", "CA"], ["qwen", "Qwen", "CN"],
  ["deepseek", "DeepSeek", "CN"], ["kimi", "Kimi", "CN"], ["glm", "Z.ai / GLM", "CN"], ["minimax", "MiniMax", "CN"],
  ["ernie", "ERNIE", "CN"], ["hunyuan", "Hunyuan", "CN"], ["naver", "HyperCLOVA", "KR"], ["sakana", "Sakana AI", "JP"],
  ["nvidia", "NVIDIA", "US"], ["poolside", "Poolside", "US"], ["liquid", "Liquid AI", "US"],
] as const;

function SettingsNavigation({ page, onSelect, busy }: { page: SettingsPage; onSelect: (page: SettingsPage) => void; busy: boolean }) {
  return <nav className="settings-sidebar" aria-label="Settings sections"><h1>Settings</h1>{[...new Set(settingsPages.map((item) => item.group))].map((group) => <div className="settings-group" key={group}><span className="settings-group-label">{group}</span>{settingsPages.filter((item) => item.group === group).map((item) => <button key={item.id} disabled={busy} className={page === item.id ? "selected" : ""} onClick={() => onSelect(item.id)}><strong>{item.label}</strong><span>{item.copy}</span></button>)}</div>)}</nav>;
}

const KEY_CODES: Record<string, string> = {
  Space: "Space", Enter: "Return", NumpadEnter: "Return", Tab: "Tab", Backspace: "Backspace", Delete: "Delete",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`",
};

function acceleratorFromEvent(event: KeyboardEvent): string | null {
  const key = /^Key([A-Z])$/.exec(event.code)?.[1] ?? /^Digit(\d)$/.exec(event.code)?.[1] ?? (/^F([1-9]|1\d|2[0-4])$/.test(event.code) ? event.code : KEY_CODES[event.code]);
  if (!key) return null;
  const modifiers = [event.metaKey && "Command", event.ctrlKey && "Control", event.altKey && "Alt", event.shiftKey && "Shift"].filter(Boolean) as string[];
  return [...modifiers, key].join("+");
}

const KEYBIND_GLYPHS: Record<KeybindAction, string> = { toggle: "▭", voice: "●", draw: "✎", keep: "⧉", action0: "⌘1", action1: "⌘2", action2: "⌘3" };

function KeybindSettings({ settings, save }: { settings: UserSettings; save: (keybinds: Keybinds) => Promise<string[]> }) {
  const [recording, setRecording] = useState<KeybindAction | "">("");
  const [problem, setProblem] = useState("");
  const [refused, setRefused] = useState<string[]>([]);
  const holding = useRef("");
  const bind = async (keybinds: Keybinds) => setRefused(await save(keybinds));
  const commit = (action: KeybindAction, keybind: Keybind) => {
    const clash = Object.entries(settings.keybinds).find(([other, value]) => other !== action && keybindLabel(value) === keybindLabel(keybind));
    if (clash) { setProblem(`${keybindLabel(keybind)} already runs “${KEYBIND_ACTIONS.find((item) => item.id === clash[0])?.label}”.`); return; }
    if (!keybind.hold) {
      const trouble = keybindProblem(keybind.accelerator);
      if (trouble) { setProblem(trouble); return; }
    }
    setProblem("");
    setRecording("");
    void bind({ ...settings.keybinds, [action]: keybind });
  };
  useEffect(() => {
    if (!recording) return;
    const down = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") { holding.current = ""; setRecording(""); setProblem(""); return; }
      if (HOLD_KEYS[event.code] && !acceleratorFromEvent(event)) { holding.current = event.code; return; }
      holding.current = "";
      const accelerator = acceleratorFromEvent(event);
      if (accelerator) commit(recording, comboKeybind(normalizeAccelerator(accelerator)));
    };
    const up = (event: KeyboardEvent) => {
      event.preventDefault();
      if (holding.current !== event.code) return;
      holding.current = "";
      commit(recording, holdKeybind(event.code, settings.keybinds[recording]?.ms || DEFAULT_HOLD_MS));
    };
    addEventListener("keydown", down, true);
    addEventListener("keyup", up, true);
    return () => { removeEventListener("keydown", down, true); removeEventListener("keyup", up, true); };
  });
  const bound = KEYBIND_ACTIONS.filter((action) => settings.keybinds[action.id]?.accelerator || settings.keybinds[action.id]?.hold).length;
  return <div className="settings-lines">
    <header>
      <div className="settings-head"><h3>Shortcuts</h3><InfoDot>A global shortcut is system-wide: whatever it takes, no other app can have it while Emma runs. The built-in gesture on a row is never taken away, so an empty row means no shortcut added — not no way in.</InfoDot></div>
      <strong>{bound ? `${bound} bound` : "None bound"}</strong>
    </header>
    {KEYBIND_ACTIONS.map((action) => {
    const keybind = settings.keybinds[action.id];
    const listening = recording === action.id;
    return <section className="keybind-row" key={action.id}>
      <span className="orb" aria-hidden="true"><kbd>{KEYBIND_GLYPHS[action.id]}</kbd></span>
      <div><h3>{action.label}</h3><p>{action.detail}</p>
        {action.builtin && <small className="keybind-builtin">Built in, always on · {action.builtin}</small>}
        {listening && problem && <small className="keybind-problem">{problem}</small>}
        {!listening && keybind && refused.includes(action.id) && <small className="keybind-problem">Another app holds {keybindLabel(keybind)}. Pick a different one.</small>}
      </div>
      <div className="keybind-controls">
        <button type="button" className={`keybind-capture ${listening ? "recording" : ""}`} aria-label={`${listening ? "Recording shortcut for" : "Record shortcut for"} ${action.label}`} onClick={() => { setProblem(""); holding.current = ""; setRecording(listening ? "" : action.id); }}>
          {listening ? "Press a combination, or hold one modifier… (Esc cancels)" : keybind ? <kbd>{keybindLabel(keybind)}</kbd> : "Add a shortcut"}
        </button>
        {keybind?.hold && <label className="keybind-duration">Hold for<select value={keybind.ms} onChange={(event) => void bind({ ...settings.keybinds, [action.id]: holdKeybind(keybind.hold, Number(event.target.value)) })}>{HOLD_DURATIONS.map((ms) => <option key={ms} value={ms}>{ms}ms</option>)}</select></label>}
        <button type="button" disabled={!keybind} onClick={() => { setProblem(""); setRecording(""); void bind({ ...settings.keybinds, [action.id]: comboKeybind("") }); }}>Clear</button>
      </div>
    </section>;
  })}</div>;
}

const microphoneCopy: Record<string, string> = {
  granted: "Granted",
  denied: "Refused — macOS is blocking it",
  restricted: "Blocked by this Mac's policy",
  "not-determined": "Not asked yet",
  unknown: "Checking…",
};

function VoiceSettings({ settings, onChange, busy }: { settings: UserSettings; onChange: (next: UserSettings) => void; busy: boolean }) {
  const [heard, setHeard] = useState("");
  const [problem, setProblem] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const dictation = useDictation(settings, setHeard);
  const save = (patch: Partial<UserSettings>) => {
    try { onChange(persistSettings({ ...settings, ...patch })); setProblem(""); }
    catch (reason) { setProblem(reasonText(reason)); }
  };
  type TextField = "transcriptionEndpoint" | "transcriptionModel" | "voiceCleanupEndpoint" | "voiceCleanupModel";
  const field = (key: TextField, label: string) => <label>{label}<input
    value={drafts[key] ?? settings[key]}
    disabled={busy}
    spellCheck={false}
    aria-label={label}
    onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))}
    onBlur={() => { const value = drafts[key]; setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([name]) => name !== key))); if (value !== undefined && value !== settings[key]) save({ [key]: value.trim() }); }}
  /></label>;
  const grant = async () => { if (await dictation.start()) dictation.cancel(); await dictation.refresh(); };
  const { status } = dictation;
  return <div className="settings-lines">
    <section>
      <div>
        <h3>1 · Microphone</h3>
        <p>macOS asks the first time Emma records, and only you can answer. Nothing is captured until you hold the key or press the button below, and the recording goes to a server on this Mac and nowhere else.</p>
        {problem && <small className="keybind-problem">{problem}</small>}
      </div>
      <div className="voice-values">
        <strong className={status.microphone === "granted" ? "status-live" : "status-idle"}><i /> {microphoneCopy[status.microphone] ?? status.microphone}</strong>
        {status.microphone === "granted"
          ? <button type="button" disabled={busy} onClick={() => void dictation.refresh()}>Re-check</button>
          : status.microphone === "not-determined" || status.microphone === "unknown"
            ? <button type="button" disabled={busy} onClick={() => void grant()}>Ask for the microphone</button>
            : <button type="button" disabled={busy} onClick={() => void window.emma.openPrivacySettings("microphone")}>Open System Settings ↗</button>}
      </div>
    </section>
    <section>
      <div>
        <h3>2 · Speech to text</h3>
        {settings.transcriptionEngine === "apple"
          ? <>
              <p>macOS already has a speech recognizer — the one system dictation uses — and Emma can just ask it. Nothing to install, nothing to keep running. Emma pins it to on-device recognition, so the recording never leaves this Mac; it needs Dictation switched on under <b>System Settings → Keyboard</b>, which is what downloads the model.</p>
              <p><small>The llama.cpp route hears more accurately, especially names and technical words. Switch engines here if you would rather run a server.</small></p>
            </>
          : <>
              <p>Both halves of voice run on <a href={LLAMA_SITE_URL} target="_blank" rel="noreferrer">llama.cpp</a> — Metal-accelerated, multimodal through libmtmd, and its server speaks the two OpenAI routes this needs. Install it once, then start the speech server on <a href={SPEECH_MODEL_URL} target="_blank" rel="noreferrer">{SPEECH_MODEL}</a>; the first run downloads the weights.</p>
              <pre className="voice-command">{LLAMA_INSTALL}</pre>
              <pre className="voice-command">{SPEECH_INSTALL}</pre>
            </>}
        <label className="check"><input type="checkbox" checked={settings.transcriptionEnabled} disabled={busy} onChange={(event) => save({ transcriptionEnabled: event.target.checked })} /> Voice input on — hold space in the island to dictate</label>
      </div>
      <div className="voice-values">
        <strong className={status.speech ? "status-live" : "status-idle"}><i /> {status.speech ? (settings.transcriptionEngine === "apple" ? "Ready" : "Answering") : "Not running"}</strong>
        <label>Engine<select value={settings.transcriptionEngine} disabled={busy} onChange={(event) => save({ transcriptionEngine: event.target.value as TranscriptionEngine })}>
          <option value="apple">macOS · built in</option>
          <option value="server">llama.cpp server</option>
        </select></label>
        {settings.transcriptionEngine === "server" && field("transcriptionEndpoint", "Endpoint")}
        {settings.transcriptionEngine === "server" && field("transcriptionModel", "Model")}
        {!status.speech && !!status.speechError && <small className="keybind-problem">{status.speechError}</small>}
        <button type="button" disabled={busy} onClick={() => void dictation.refresh()}>Check again</button>
        {settings.transcriptionEngine === "apple"
          ? <button type="button" disabled={busy} onClick={() => void window.emma.openPrivacySettings("speech")}>Speech Recognition ↗</button>
          : <small>Localhost only</small>}
      </div>
    </section>
    <section>
      <div>
        <h3>3 · Clean the transcript up · optional</h3>
        <p><a href={VOICE_MODEL_URL} target="_blank" rel="noreferrer">{VOICE_MODEL}</a> is a 0.6B text model that rewrites a raw transcript as written English: fillers dropped, false starts resolved, punctuation, numbers and dates rendered properly. It hears nothing — it reads what the speech server heard — so it is the second half of the pipeline, never the first. A second <code>llama-server</code>, on the Q4_K_M build, 462 MB.</p>
        <pre className="voice-command">{CLEANUP_INSTALL}</pre>
        <p><small>The flags matter: S1-mini was trained with thinking off and greedy decoding, and the file's own metadata says otherwise. Emma sends both again on every request.</small></p>
        <label className="check"><input type="checkbox" checked={settings.voiceCleanup} disabled={busy} onChange={(event) => save({ voiceCleanup: event.target.checked })} /> Clean transcripts up when the model is available</label>
      </div>
      <div className="voice-values">
        <strong className={status.model ? "status-live" : "status-idle"}><i /> {status.model ? "Model loaded" : status.cleanup ? "Server running · S1-mini not loaded" : "Not running"}</strong>
        {field("voiceCleanupEndpoint", "Endpoint")}
        {field("voiceCleanupModel", "Model")}
        {!!status.models.length && <small title={status.models.join(", ")}>Serving {status.models.length}: {status.models.slice(0, 3).join(", ")}</small>}
        <small>A cleanup that fails keeps the raw words</small>
      </div>
    </section>
    <section>
      <div>
        <h3>4 · Hold to talk</h3>
        <p>In the island, hold the space bar while the box is empty, say your piece, and let go — Emma types what you said. A tap is still just a tap. The same is on the ● button, and on the <b>Quick Ask with voice</b> keybind.</p>
      </div>
      <div className="voice-values">
        <label>Hold for<select value={settings.voiceHoldMs} disabled={busy} onChange={(event) => save({ voiceHoldMs: Number(event.target.value) })}>{HOLD_TO_TALK_MS.map((ms) => <option key={ms} value={ms}>{ms}ms</option>)}</select></label>
      </div>
    </section>
    <section>
      <div>
        <h3>5 · Try it</h3>
        <p>Press and hold, say something, and let go. This is the whole path the island uses, so what comes back here is what it would have typed.</p>
        {dictation.error && <small className="keybind-problem">{dictation.error}</small>}
        {heard && <p className="voice-heard">“{heard}”</p>}
      </div>
      <div className="voice-values">
        <button
          type="button"
          className={dictation.listening ? "keybind-capture recording" : "keybind-capture"}
          disabled={busy || dictation.working || status.microphone === "denied" || status.microphone === "restricted"}
          onPointerDown={() => void dictation.start()}
          onPointerUp={() => void dictation.stop()}
          onPointerLeave={() => { if (dictation.listening) void dictation.stop(); }}
        >{dictation.working ? "Transcribing…" : dictation.listening ? "Listening — let go" : "Hold to talk"}</button>
      </div>
    </section>
  </div>;
}

function NotchSettings({ settings, onChange, busy }: { settings: UserSettings; onChange: (settings: UserSettings) => void; busy: boolean }) {
  const [catalog, setCatalog] = useState<OpenRouterCatalog>();
  useEffect(() => { void window.emma.request<OpenRouterCatalog>("listOpenRouterModels").then(setCatalog).catch(() => undefined); }, []);
  const routes = [...new Set([settings.notchModel, ...settings.favoriteModels, ...(catalog?.models ?? []).map((model) => `openrouter:${model.id}`)])]
    .filter((key) => key.startsWith("openrouter:"));
  return <div className="settings-lines">
    <section>
      <div>
        <div className="settings-head"><h3>Quick Ask model</h3><InfoDot>Emma pins this model to the thread the island creates, so the notch and the workspace run on different models at the same time. Only OpenRouter routes can be pinned — the host takes no local profile per thread. The island’s own picker writes this same setting while a model is pinned here.</InfoDot></div>
        <p>Decoupled from the composer’s picker.</p>
      </div>
      <div className="notch-values">
        <label>Runs on<select value={settings.notchModel} disabled={busy} onChange={(event) => onChange({ ...settings, notchModel: event.target.value })}>
          <option value="">Workspace picker</option>
          {routes.map((key) => <option key={key} value={key}>{modelKeyLabel(settings, key)}</option>)}
        </select></label>
      </div>
    </section>
    <section>
      <div>
        <div className="settings-head"><h3>Shortcut while a task is running</h3><InfoDot>A separate task leaves the running one where it is: it finishes in main and its answer lands in its own thread, which the workspace lists like any other. Carrying on instead reopens the running thread, so the next ask reads everything already said in it — and waits, because a thread runs one turn at a time.</InfoDot></div>
        <p>Pressing it again on a busy island.</p>
      </div>
      <div className="notch-values">
        <label>Opens<select value={settings.notchConcurrency} disabled={busy} onChange={(event) => onChange({ ...settings, notchConcurrency: event.target.value as NotchConcurrency })}>
          <option value="separate">A separate task</option>
          <option value="continue">The running task</option>
        </select></label>
      </div>
    </section>
  </div>;
}

function SettingsView({ page, onSelectPage, busy, ...rest }:{ page: SettingsPage; onSelectPage: (page: SettingsPage) => void; act: (method: string, params?: Record<string, string>) => Promise<unknown>; busy: boolean; onModelChanged: (settings: UserSettings) => void }) {
  return <div className="settings-layout"><SettingsNavigation page={page} onSelect={onSelectPage} busy={busy} /><SettingsBody page={page} busy={busy} {...rest} /></div>;
}

function SettingsBody({ page, act, busy, onModelChanged }: { page: SettingsPage; act: (method: string, params?: Record<string, string>) => Promise<unknown>; busy: boolean; onModelChanged: (settings: UserSettings) => void }) {
  const [settings, setSettings] = useState(readSettings);
  const [saved, setSaved] = useState(false);
  const [orb, setOrb] = useState(0);
  const setOrbs = (cursorOrbs: CursorCommand[]) => setSettings((current) => ({ ...current, cursorOrbs }));
  const resizeOrbs = (count: number) => {
    if (!Number.isFinite(count)) return;
    const size = Math.min(MAX_CURSOR_ORBS, Math.max(1, Math.round(count)));
    const cursorOrbs = settings.cursorOrbs.slice(0, size);
    while (cursorOrbs.length < size) cursorOrbs.push(CURSOR_COMMANDS.find((command) => !cursorOrbs.includes(command)) ?? "screen");
    setOrb((current) => Math.min(current, size - 1));
    setOrbs(cursorOrbs);
  };
  const moveOrb = (step: number) => {
    const next = (orb + step + settings.cursorOrbs.length) % settings.cursorOrbs.length;
    const cursorOrbs = [...settings.cursorOrbs];
    [cursorOrbs[orb], cursorOrbs[next]] = [cursorOrbs[next], cursorOrbs[orb]];
    setOrbs(cursorOrbs);
    setOrb(next);
  };
  const updateAction = (index: number, field: string, value: string | boolean) => setSettings((current) => ({ ...current, quickActions: current.quickActions.map((action, actionIndex) => actionIndex === index ? { ...action, [field]: value } : action) as UserSettings["quickActions"] }));
  const save = (event: FormEvent) => { event.preventDefault(); try { const valid = persistSettings(settings); setSettings(valid); syncMainPreferences(valid); onModelChanged(valid); setSaved(true); } catch { setSaved(false); } };
  const saveModelSettings = (next: UserSettings) => { const valid = persistSettings(next); setSettings(valid); onModelChanged(valid); };
  const saveNotch = (next: UserSettings) => { const valid = persistSettings(next); setSettings(valid); syncMainPreferences(valid); };
  const saveZeroRetention = async (requireZeroRetention: boolean) => {
    const valid = persistSettings({ ...settings, requireZeroRetention });
    setSettings(valid);
    await window.emma.setZeroRetention(requireZeroRetention);
    await selectModelKey(valid, valid.selectedModel, act);
    onModelChanged(valid);
  };
  const saveKeybinds = async (keybinds: Keybinds) => {
    const valid = persistSettings({ ...settings, keybinds });
    setSettings(valid);
    return await window.emma.setKeybinds(valid.keybinds).catch(() => [] as string[]);
  };
  const saveVerifier = async (verifier: VerifierSettings) => {
    const valid = persistSettings({ ...settings, verifier });
    setSettings(valid);
    await window.emma.setVerifier(valid.verifier);
  };
  const saveTools = async (tools: ToolSettings) => {
    const valid = persistSettings({ ...settings, tools });
    setSettings(valid);
    await window.emma.setToolSettings(valid.tools);
  };
  const saveHarnessExperiments = async (harnessExperiments: HarnessExperiments) => {
    const valid = persistSettings({ ...settings, harnessExperiments });
    setSettings(valid);
    await window.emma.setHarnessExperiments(valid.harnessExperiments);
  };
  const saveConnections = (connections: string[]) => { const valid = persistSettings({ ...settings, connections }); setSettings(valid); syncMainPreferences(valid); };
  const savePrompts = (next: UserSettings) => { const valid = persistSettings(next); setSettings(valid); syncMainPreferences(valid); };
  const saveAppearance = (patch: Partial<UserSettings>) => setSettings(persistSettings({ ...settings, ...patch }));
  const accentHex = settings.accent.startsWith("#") ? settings.accent : getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  const saveContextPages = (contextPages: ContextPage[]) => { try { setSettings(persistSettings({ ...settings, contextPages })); } catch { setSettings((current) => ({ ...current, contextPages })); } };
  const resetData = () => {
    if (!confirm("Delete all Emma data and start fresh?\n\nEvery thread, artifact, connected folder, saved key, and setting on this Mac goes, and Emma restarts empty. This cannot be undone.")) return;
    localStorage.clear();
    void window.emma.resetData();
  };
  if (page === "contextbar") return <section className="settings-view settings-wide"><header><span>Settings / thread inspector</span><h2>Context bar</h2><p>The panel down the right of a thread, as components you arrange. Drag them in and out of the column, reorder them, and lay a component across instead of down. Keep up to {MAX_CONTEXT_PAGES} pages; the bar's own tabs switch between them. The preview is the real components over a made-up thread.</p></header><ContextBarSettings pages={settings.contextPages} onChange={saveContextPages} busy={busy} /></section>;
  if (page === "appearance") return <section className="settings-view"><header><span>Settings / appearance</span><h2>Appearance</h2></header><div className="settings-lines"><section><div><h3>Accent</h3><p>The one hue that means action: primary buttons, the focus ring, a checked control, and any figure meant to read as data.</p></div><div className="accent-values">{ACCENT_CHOICES.map((hue) => <button key={hue} type="button" className={`accent-swatch ${settings.accent === hue ? "active" : ""}`} style={{ "--swatch": `var(--${hue})` } as CSSProperties} title={hue} aria-label={hue} aria-pressed={settings.accent === hue} disabled={busy} onClick={() => saveAppearance({ accent: hue })} />)}<label className={`accent-swatch accent-custom ${settings.accent.startsWith("#") ? "active" : ""}`} title="Any colour"><input type="color" value={accentHex} disabled={busy} onChange={(event) => saveAppearance({ accent: event.target.value as AccentChoice })} /><span className="sr-only">Any colour</span></label><small>{accentHex}</small></div></section><section><div><h3>Interface scale</h3><p>Zooms the whole window the way a browser does, from {MIN_UI_SCALE}% to {MAX_UI_SCALE}%. Everything scales together — type, rules, and spacing.</p></div><div className="font-values"><label>Scale · {settings.uiScale}%<input type="range" min={MIN_UI_SCALE} max={MAX_UI_SCALE} step={5} value={settings.uiScale} disabled={busy} onChange={(event) => saveAppearance({ uiScale: Number(event.target.value) })} /></label></div></section><section><div><h3>Section marks</h3><p>The sidebar's section marks take a hue each, in palette order. Off, they draw in the same grey as their labels.</p><label className="check"><input type="checkbox" checked={settings.navIconColors} disabled={busy} onChange={(event) => saveAppearance({ navIconColors: event.target.checked })} /> Colour the section marks</label></div></section><section><div><h3>Interface font</h3><p>Everything on the grid: the sidebar, tabs, buttons, model picker, and every label in Settings.</p></div><div className="font-values"><label>Face<select value={settings.interfaceFont} disabled={busy} onChange={(event) => saveAppearance({ interfaceFont: event.target.value as FontChoice })}>{FONT_CHOICES.map((font) => <option key={font.id} value={font.id}>{font.label}</option>)}</select></label><p className="font-sample" style={{ fontFamily: fontStack(settings.interfaceFont) }}>Threads · Knowledge · Agent 0123</p></div></section><section><div><h3>Agent font</h3><p>What the agent writes in a thread, plus the composer you answer it in.</p></div><div className="font-values"><label>Face<select value={settings.agentFont} disabled={busy} onChange={(event) => saveAppearance({ agentFont: event.target.value as FontChoice })}>{FONT_CHOICES.map((font) => <option key={font.id} value={font.id}>{font.label}</option>)}</select></label><p className="font-sample" style={{ fontFamily: fontStack(settings.agentFont) }}>The quick brown fox jumps over the lazy dog.</p></div></section></div></section>;
  if (page === "models") return <section className="settings-view"><header><span>Settings / models &amp; providers</span><h2>Models</h2></header><ModelCatalog settings={settings} onChange={saveModelSettings} act={act} busy={busy} /><LocalModelSettings settings={settings} onChange={saveModelSettings} act={act} busy={busy} /><VerifierPanel settings={settings} onSave={saveVerifier} busy={busy} /><AdvisorPanel settings={settings} onSave={(advisor) => saveTools({ ...settings.tools, advisor })} busy={busy} /><VisionPanel settings={settings} onSave={(vision) => saveTools({ ...settings.tools, vision })} busy={busy} /><ProviderKeys settings={settings} act={act} busy={busy} /><div className="settings-lines"><section><div><h3>Private routing</h3><p>On, Emma demands endpoints that neither train on nor retain your prompts. OpenRouter offers no free endpoint that qualifies, so every free model fails while this is on — leave it off unless you route to a paid or local model. Changing it restarts the local agent.</p><label className="check"><input type="checkbox" checked={settings.requireZeroRetention} disabled={busy} onChange={(event) => void saveZeroRetention(event.target.checked)} /> Require no-training, zero-retention endpoints (blocks every free model)</label></div></section><section><div><div className="settings-head"><h3>When no model is chosen</h3><InfoDot>Emma sends no model with the turn, so the agent answers on its own default free route. Nothing runs on this Mac, and nothing works offline. With no OpenRouter key saved, the turn fails rather than falling back to anything.</InfoDot></div><p>Emma leaves the choice to the agent, which answers on its free OpenRouter route. Pick a model above to route every turn yourself.</p></div><strong className="status-idle"><i /> No model sent</strong></section><section><div><h3>Speech to text</h3><p>Dictation runs against local OpenAI-compatible servers and is set up on its own page — the microphone grant, the speech server, and the S1-mini cleanup pass all live in <b>Settings → Voice</b>.</p></div><div className="voice-values"><strong className={settings.transcriptionEnabled ? "status-live" : "status-idle"}><i /> {settings.transcriptionEnabled ? "On" : "Off"}</strong><small>Localhost only</small></div></section></div></section>;
  if (page === "notch") return <section className="settings-view"><header><span>Settings / local to this Mac</span><h2>Notch</h2></header><NotchSettings settings={settings} onChange={saveNotch} busy={busy} /></section>;
  if (page === "voice") return <section className="settings-view"><header><span>Settings / local to this Mac</span><h2>Voice</h2></header><VoiceSettings settings={settings} onChange={saveModelSettings} busy={busy} /></section>;
  if (page === "prompts") return <section className="settings-view"><header><span>Settings / coding harness</span><h2>System prompt</h2><p>The text every turn opens with. One global prompt, plus as many as you like pinned to a model family or a single model — the pinned ones are read after the global, so they win where the two disagree. Anything in <b>{"{braces}"}</b> is filled in when the turn goes out.</p></header><PromptSettings settings={settings} onChange={savePrompts} busy={busy} /></section>;
  if (page === "tools") return <section className="settings-view"><header><span>Settings / extensions</span><h2>Tools</h2></header><ToolSettingsPanel settings={settings} onChange={saveTools} onDefaultMode={(defaultPermissionMode) => saveModelSettings({ ...settings, defaultPermissionMode })} busy={busy} /></section>;
  if (page === "permissions") return <section className="settings-view"><header><span>Settings / local to this Mac</span><h2>Permissions</h2></header><PermissionSettings busy={busy} /></section>;
  if (page === "harness") return <section className="settings-view"><header><span>Settings / coding harness</span><h2>Harness <b className="tag-experimental">Experimental</b></h2></header><HarnessExperimentsPanel settings={settings} onChange={saveHarnessExperiments} busy={busy} /></section>;
  if (page === "imports") return <section className="settings-view"><header><span>Settings / extensions</span><h2>Imports & plugins</h2></header><AgentImports /></section>;
  if (page === "connections") return <section className="settings-view"><header><span>Settings / extensions</span><h2>Connections</h2></header><ConnectionSettings settings={settings} onChange={saveConnections} busy={busy} /></section>;
  if (page === "privacy") return <section className="settings-view"><header><span>Settings / data boundaries</span><h2>Data &amp; privacy</h2></header><div className="settings-lines"><section><div><div className="settings-head"><h3>Start fresh</h3><InfoDot>Threads, artifacts, plans, connected folders, saved keys, and every setting go. The notes in your vault are left where they are — they are your files, in your folder.</InfoDot></div><p>Deletes everything Emma keeps on this Mac, then restarts her empty. This cannot be undone.</p></div><button type="button" className="reset-data" disabled={busy} onClick={resetData}>Reset Emma</button></section></div><div className="settings-lines prose-lines"><section><div><div className="settings-head"><h3>OpenRouter can be set to train on your prompts</h3><InfoDot>Opting in is what unlocks parts of the free catalog, and free routes are Emma’s default path — her fallback chain and her verifier and vision models are all free models. Your account setting sits above anything Emma sends, so <b>Private routing</b> does not override it.</InfoDot></div><p>Prompt logging is an opt-in on your OpenRouter account: switch it on and OpenRouter and the providers behind it may keep your prompts and Emma’s replies, and train on them. Emma cannot read that setting or change it — check it yourself.</p><a href="https://openrouter.ai/settings/privacy" target="_blank" rel="noreferrer">Review OpenRouter privacy settings ↗</a></div></section><section><div><div className="settings-head"><h3>Zero-retention routing is opt-in</h3><InfoDot>The flag rides the harness request body, so it covers thread turns to an <code>openrouter.ai</code> endpoint and nothing else — the verifier, vision and advisor calls go out with no routing flags on them. No free endpoint qualifies, so every free model fails while it is on.</InfoDot></div><p>Emma’s own switch is off until you turn it on. <b>Private routing</b> in <b>Settings → Models</b> demands no-training, zero-retention endpoints and fails the turn rather than route around them.</p></div></section><section><div><div className="settings-head"><h3>Threads and notes stay local</h3><InfoDot>Durable thread records live in <code>~/Library/Application Support/Emma</code>, moved by <code>EMMA_DATA_DIR</code>. Saved notes live only in the vault folder you chose, as plain Markdown you can open in anything.</InfoDot></div><p>Emma stores durable Markdown through the Rust host. Pane layout, quick-action preferences, and an unsent overlay draft stay in Electron’s local application storage.</p></div></section><section><div><div className="settings-head"><h3>Dictation never leaves this Mac</h3><InfoDot>Checked at two boundaries: a non-local speech or cleanup endpoint is refused when you save it, and refused again before every use. The utterance goes to a temporary file, is read once, and is deleted — no audio is kept.</InfoDot></div><p>Recorded audio and raw transcripts only ever reach <code>127.0.0.1</code> or on-device macOS speech, and a settings file edited by hand cannot redirect them.</p></div></section><section><div><div className="settings-head"><h3>Screens never reach the model</h3><InfoDot>The <code>vision</code> tool is the deliberate exception: hand it an image and it posts that image to the vision endpoint set in <b>Settings → Models</b>.</InfoDot></div><p>The yellow pen’s capture is compressed and held in Emma’s own process, and the turn goes out without it. Computer-use screenshots stay there too — the <code>computer</code> tool answers in text.</p></div></section><section><div><h3>Nothing saves silently</h3><p>Normal agent requests remain in their thread. A note is only ever written into your vault when you ask for one.</p></div></section><section><div><div className="settings-head"><h3>Every run is gated by the mode picker</h3><InfoDot>The step and action ceilings, the rate limit, the on-screen banner, the Escape kill switch, and the action log apply in every mode, with nothing that turns them off. A run also stops when the turn ends and when Emma quits.</InfoDot></div><p>Driving the pointer and keyboard is the <code>computer</code> tool, so the composer’s permission mode decides it: <em>Ask</em> and <em>Accept edits</em> stop for your yes on every call, <em>Auto</em> sends the call to your verifier model, and <em>Full access</em> lets it through.</p></div></section><section><div><h3>Nothing is reported about you</h3><p>No telemetry, no analytics, and no crash reporter exist anywhere in Emma.</p></div></section></div></section>;
  if (page === "about") return <section className="settings-view"><header><span>Settings / about</span><h2>Emma</h2></header><div className="settings-lines prose-lines">{credits.map((credit) => <section key={credit.title}><div><h3>{credit.title}</h3><p>{credit.body}</p>{credit.href ? <a href={credit.href} target="_blank" rel="noreferrer">{credit.link}</a> : null}</div></section>)}</div></section>;
  return <form className="settings-view" onSubmit={save}><header><span>Settings / local to this Mac</span><h2>Keybinds</h2></header>
    <KeybindSettings settings={settings} save={saveKeybinds} />
    <div className="settings-lines">
      <header>
        <div className="settings-head"><h3>Quick actions</h3><InfoDot>Each one is a prompt the island runs against whatever you hand it — a capture, the page your browser has in front, or nothing at all. Destination and category decide where the answer is filed when <b>Save analyzed result</b> is on.</InfoDot></div>
        <strong>⌘1 – ⌘3</strong>
      </header>
      {settings.quickActions.map((action, index) => <section className="quick-action-row" key={index}>
        <span className="orb" aria-hidden="true"><kbd>⌘{index + 1}</kbd></span>
        <div className="quick-fields"><label>Label<input value={action.label} maxLength={40} onChange={(event) => updateAction(index, "label", event.target.value)} /></label><label className="prompt-field">Prompt<textarea value={action.prompt} maxLength={4096} rows={2} onChange={(event) => updateAction(index, "prompt", event.target.value)} /></label></div>
      </section>)}
    </div>
    <section className="orb-settings"><div><div className="settings-head"><h3>Orbs you can rearrange</h3><InfoDot>The ring opens where the pointer is when Quick Ask does, and the same commands hang under the island when the pointer swipes below it. <b>Save page</b> keeps the page your browser has in front — its text, its favicon, and the pictures it leads with. Each save lands as one Markdown note in your vault.</InfoDot></div><p>Pick an orb to change what it runs or where it sits.</p>
      <label className="check"><input type="checkbox" checked={settings.cursorOrbsEnabled} onChange={(event) => setSettings((current) => ({ ...current, cursorOrbsEnabled: event.target.checked }))} /> Ring the cursor when Quick Ask opens</label>
      <label className="check"><input type="checkbox" checked={settings.notchCommandsEnabled} onChange={(event) => setSettings((current) => ({ ...current, notchCommandsEnabled: event.target.checked }))} /> Reveal commands under the island on a swipe</label>
      <div className="orb-fields"><label>Orbs · 1–{MAX_CURSOR_ORBS}<input type="number" min={1} max={MAX_CURSOR_ORBS} value={settings.cursorOrbs.length} onChange={(event) => resizeOrbs(event.currentTarget.valueAsNumber)} /></label>
      <label>Orb {orb + 1} runs<select value={settings.cursorOrbs[orb]} onChange={(event) => setOrbs(settings.cursorOrbs.map((command, index) => index === orb ? event.target.value as CursorCommand : command))}>{CURSOR_COMMANDS.map((command) => <option key={command} value={command}>{orbLabel(command, settings)}</option>)}</select></label>
      <div className="orb-order"><span>Position</span><button type="button" onClick={() => moveOrb(-1)} aria-label="Move orb counter-clockwise">↺</button><button type="button" onClick={() => moveOrb(1)} aria-label="Move orb clockwise">↻</button></div></div></div>
      <div className="orb-preview"><OrbRing commands={settings.cursorOrbs} settings={settings} selected={orb} onPick={setOrb} /></div></section>
    <section className="notch-settings"><div><div className="settings-head"><h3>Where the island hangs</h3><InfoDot>Emma measures the real camera housing on each display and wraps the menu bar around it. The gap below is the fallback for Macs and external displays without a housing.</InfoDot></div><p>Quick Ask hangs off the camera housing.</p></div><div className="notch-values"><label>Fallback gap · 120–260 pt<input type="number" min={120} max={260} step={2} value={settings.notchGap} onChange={(event) => setSettings((current) => ({ ...current, notchGap: event.currentTarget.valueAsNumber }))} /></label></div></section>
    <button className="save-settings">{saved ? "Saved ✓" : "Save settings"}</button></form>;
}

const MODALITY_MARKS: Record<ModelModality, { label: string; path: string }> = {
  image: { label: "Accepts images", path: "M2.5 3.5h11v9h-11zM4 10l2.5-2.5 2 2 2-2L13.5 10" },
  file: { label: "Accepts files", path: "M4 1.5h5.5L12 4v10.5H4zM9.5 1.5V4H12" },
  audio: { label: "Accepts audio", path: "M3.5 6.5h2.5l3.5-3v9l-3.5-3H3.5zM11.5 5.5a4 4 0 0 1 0 5" },
};

const contextMark = new Intl.NumberFormat("en", { notation: "compact" });

const modalityMarks = (modalities: ModelModality[] = []) => modalities
  .filter((modality) => modality in MODALITY_MARKS)
  .map((modality) => <svg key={modality} className="model-modality" viewBox="0 0 16 16" role="img" aria-label={MODALITY_MARKS[modality].label}><title>{MODALITY_MARKS[modality].label}</title><path d={MODALITY_MARKS[modality].path} /></svg>);

type ModelEntry = { key: string; name: string; detail: string; brand?: BrandDefinition; modalities?: ModelModality[]; free?: boolean; context?: number };
type CatalogEntry = ModelEntry & { maker: string };

const isFreeModel = (idOrKey: string) => idOrKey.endsWith(":free");
const priceBadge = (free: boolean) => free
  ? <span className="model-free">Free</span>
  : <span className="model-paid">Paid</span>;

const localBrand: BrandDefinition = { id: "local", label: "Local models", fallback: "L" };
const allBrand: BrandDefinition = { id: "all", label: "All models", fallback: "∗" };

const catalogMarks = [["local", "Local models", "Mac"], ...providerMarks, ["other", "Other providers", "Various"]] as const;

function modelEntries(localModels: LocalModelProfile[], models: OpenRouterCatalog["models"]): CatalogEntry[] {
  const entries: CatalogEntry[] = [
    { maker: "other", key: "fallback", name: "No model chosen", detail: "Emma sends no model · the agent answers on its own free OpenRouter route", free: true },
    ...localModels.map((profile) => ({ maker: "local", key: `local:${profile.id}`, name: profile.name, detail: `${profile.modelId} · ${profile.baseUrl}`, brand: brandForModel(profile.modelId, "local") ?? localBrand })),
    ...models.map((model) => {
      const brand = brandForModel(model.id, "openrouter");
      return { maker: brand?.id ?? "other", key: `openrouter:${model.id}`, name: model.name, detail: `${model.id} · ${Math.round(model.contextLength / 1000)}K context`, brand, modalities: model.inputModalities, free: model.free, context: model.contextLength };
    }),
  ];
  const order = ["local", ...providerBrands.map((brand) => brand.id), "other"];
  return entries.sort((left, right) => order.indexOf(left.maker) - order.indexOf(right.maker));
}

function catalogStatus(catalog: OpenRouterCatalog): string {
  if (catalog.stale) return `Offline \u00b7 showing ${catalog.models.length} cached models`;
  const changes = [
    catalog.added?.length ? `${catalog.added.length} new` : "",
    catalog.removed?.length ? `${catalog.removed.length} gone` : "",
  ].filter(Boolean).join(" \u00b7 ");
  return `${catalog.models.length} models \u00b7 ${changes || "no change since the last reload"}`;
}

const CATALOG_PAGE = 15;

const MODEL_MENU_LIMIT = 30;
const FREE_ONLY_KEY = "emma.freeModelsOnly.v1";
const STAR_MARK = "starred";

function ModelRow({ entry, current, busy, onPick, starred, onStar }: {
  entry: ModelEntry;
  current: boolean;
  busy?: boolean;
  onPick: (key: string) => void;
  starred?: boolean;
  onStar?: (key: string) => void;
}) {
  return <div className={`model-row ${current ? "current" : ""}`}>
    <button type="button" className="model-row-pick" disabled={busy} aria-current={current} title={entry.detail} onClick={() => onPick(entry.key)}>
      <strong><span>{entry.name}</span>{modalityMarks(entry.modalities)}{entry.free ? priceBadge(true) : null}</strong>
      <small><BrandIcon brand={entry.brand} className="model-brand" /><span>{entry.brand?.label ?? entry.detail}</span></small>
    </button>
    <span className="model-context" title={entry.context ? `${entry.context.toLocaleString()}-token context window` : ""}>{entry.context ? contextMark.format(entry.context) : ""}</span>
    {onStar && <button type="button" className="model-star" aria-pressed={starred} aria-label={`${starred ? "Unstar" : "Star"} ${entry.name}`} title={starred ? "Remove from the composer's picker" : "Show in the composer's picker"} onClick={() => onStar(entry.key)}>{starred ? "★" : "☆"}</button>}
  </div>;
}

function ModelPicker({ entries, active, onPick, busy, favorites, onStar, label, lead, freeRouter, children }: {
  entries: CatalogEntry[];
  active: string;
  onPick: (key: string) => void;
  busy?: boolean;
  freeRouter?: boolean;
  favorites?: string[];
  onStar?: (key: string) => void;
  label: string;
  lead?: ModelEntry;
  children?: ReactNode;
}) {
  const [maker, setMaker] = useState("");
  const [query, setQuery] = useState("");
  const [freeOnly, setFreeOnly] = useState(() => localStorage.getItem(FREE_ONLY_KEY) === "1");
  const showFree = (on: boolean) => { localStorage.setItem(FREE_ONLY_KEY, on ? "1" : ""); setFreeOnly(on); };
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => { search.current?.focus(); }, []);
  const starred = favorites ?? [];
  const listed = freeOnly ? freeModels(entries, active) : entries;
  const needle = query.trim().toLowerCase();
  const searched = listed.filter((entry) => !needle || `${entry.name} ${entry.key}`.toLowerCase().includes(needle));
  const counts = new Map<string, number>([[STAR_MARK, searched.filter((entry) => starred.includes(entry.key)).length]]);
  for (const entry of searched) counts.set(entry.maker, (counts.get(entry.maker) ?? 0) + 1);
  const filter = counts.get(maker) ? maker : "";
  const matched = filter === STAR_MARK ? searched.filter((entry) => starred.includes(entry.key))
    : filter ? searched.filter((entry) => entry.maker === filter)
      : searched;
  const weight = (key: string) => key === active ? 0 : starred.includes(key) ? 1 : 2;
  const shown = [...matched].sort((left, right) => weight(left.key) - weight(right.key)).slice(0, MODEL_MENU_LIMIT);
  const marks = catalogMarks.filter(([id]) => listed.some((entry) => entry.maker === id));
  return <>
    <nav className="model-rail" aria-label={`Filter ${label} by maker`}>
      {favorites && <>
        <button type="button" className="model-mark model-star" aria-pressed={filter === STAR_MARK} disabled={!counts.get(STAR_MARK)} title="Starred" aria-label="Starred models" onClick={() => setMaker(maker === STAR_MARK ? "" : STAR_MARK)}>★</button>
        <hr />
      </>}
      {marks.map(([id, name]) => <button type="button" key={id} className="model-mark" aria-pressed={filter === id} disabled={!counts.get(id)} title={name} aria-label={name} onClick={() => setMaker(id === maker ? "" : id)}>
        <BrandIcon brand={id === "local" ? localBrand : brandForProvider(id) ?? allBrand} className="model-brand" />
      </button>)}
    </nav>
    <div className="model-body">
      <div className="model-find">
        <input ref={search} className="model-search" value={query} aria-label={`Search ${label}`} placeholder="Search models…" onChange={(event) => setQuery(event.target.value)} />
        <button type="button" className="model-free-only" aria-pressed={freeOnly} title="Only the models the catalog lists as free" onClick={() => showFree(!freeOnly)}>Free only</button>
      </div>
      <div className="model-rows">
        {lead && <ModelRow entry={lead} current={active === lead.key} busy={busy} onPick={onPick} />}
        {freeRouter && (freeOnly || active === FREE_ROUTER_KEY) && <ModelRow entry={freeRouterEntry} current={active === FREE_ROUTER_KEY} busy={busy} onPick={onPick} />}
        {shown.map((entry) => <ModelRow key={entry.key} entry={entry} current={active === entry.key} busy={busy} onPick={onPick} starred={starred.includes(entry.key)} onStar={onStar} />)}
        {!shown.length && <p className="model-menu-note">Nothing matches “{query}”.</p>}
        {matched.length > shown.length && <p className="model-menu-note">{matched.length - shown.length} more · search to narrow.</p>}
      </div>
      {children}
    </div>
  </>;
}

function ModelCatalog({ settings, onChange, act, busy }: { settings: UserSettings; onChange: (settings: UserSettings) => void; act: (method: string, params?: Record<string, string>) => Promise<unknown>; busy: boolean }) {
  const [models, setModels] = useState<OpenRouterCatalog["models"]>([]);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [maker, setMaker] = useState("");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(CATALOG_PAGE);
  const load = useCallback(() => window.emma.request<OpenRouterCatalog>("listOpenRouterModels")
    .then((catalog) => { setModels(catalog.models); setError(catalog.error ?? ""); setStatus(catalogStatus(catalog)); })
    .catch((reason: unknown) => setError(reasonText(reason)))
    .finally(() => setLoading(false)), []);
  useEffect(() => { void load(); }, [load]);
  const reload = () => { setLoading(true); setError(""); setStatus(""); void load(); };
  const entries = useMemo(() => modelEntries(settings.localModels, models), [settings.localModels, models]);
  const needle = query.trim().toLowerCase();
  const searched = entries.filter((entry) => !needle || `${entry.name} ${entry.key}`.toLowerCase().includes(needle));
  const counts = new Map<string, number>();
  for (const entry of searched) counts.set(entry.maker, (counts.get(entry.maker) ?? 0) + 1);
  const filter = counts.has(maker) ? maker : "";
  const matched = filter ? searched.filter((entry) => entry.maker === filter) : searched;
  const starWeight = (key: string) => settings.favoriteModels.includes(key) ? 0 : 1;
  const ordered = [...matched].sort((left, right) => starWeight(left.key) - starWeight(right.key));
  const shown = ordered.slice(0, limit);
  const narrow = (next: () => void) => { setLimit(CATALOG_PAGE); next(); };
  const star = (key: string) => {
    setError("");
    try { onChange(toggleFavoriteModel(settings, key)); }
    catch (reason) { setError(reasonText(reason)); }
  };
  const use = async (key: string) => {
    setError("");
    const next = await selectModelKey(settings, key, act);
    if (next) onChange(next);
  };
  return <section className="model-catalog">
    <header><div><span>Model catalog</span><h3>Choose a model, star up to {MAX_FAVORITE_MODELS}</h3><p>Starred models fill the picker beside the composer and sit at the top of this list. Search the whole catalog, or click a maker's mark to see only its models. The marks are local assets; the trademarks belong to their owners.</p></div><strong>{settings.favoriteModels.length} / {MAX_FAVORITE_MODELS} starred</strong></header>
    <div className="catalog-active"><BrandIcon brand={selectedModelBrand(settings)} className="model-brand" /><div><strong>{selectedModelLabel(settings)}</strong><span>{modelKeyRoute(settings, settings.selectedModel)}</span></div><em>Active</em></div>
    <div className="catalog-search"><input type="search" value={query} aria-label="Search the model catalog" placeholder="Search models by name or ID" onChange={(event) => narrow(() => setQuery(event.target.value))} /></div>
    <div className="catalog-marks" role="group" aria-label="Filter the catalog by maker">
      <button type="button" className="catalog-mark" aria-pressed={!filter} onClick={() => narrow(() => setMaker(""))}>
        <BrandIcon brand={allBrand} className="provider-mark" />
        <span className="provider-mark-text"><strong>All models</strong><small>{searched.length}</small></span>
      </button>
      {catalogMarks.map(([id, name, region]) => {
        const count = counts.get(id) ?? 0;
        return <button type="button" key={id} className="catalog-mark" disabled={!count} aria-pressed={id === filter} aria-label={`${name} · ${count} ${plural(count, "model")}`} onClick={() => narrow(() => setMaker(id === filter ? "" : id))}>
          <BrandIcon brand={id === "local" ? localBrand : brandForProvider(id)} className="provider-mark" />
          <span className="provider-mark-text"><strong>{name}</strong><small>{region}</small></span>
        </button>;
      })}
    </div>
    {error && <p className="local-model-error" role="alert">{error}</p>}
    {status && <p className="local-model-status" role="status">{status}</p>}
    {!filter && (!needle || `${freeRouterEntry.name} ${freeRouterEntry.key}`.toLowerCase().includes(needle)) && <div className={`catalog-row free-router ${settings.selectedModel === FREE_ROUTER_KEY ? "selected" : ""}`}>
      <BrandIcon brand={freeRouterBrand} className="model-brand" />
      <span><span className="model-name"><strong>{freeRouterEntry.name}</strong>{priceBadge(true)}</span><small>{freeRouterEntry.detail}</small></span>
      <button type="button" className="catalog-use" disabled={busy || settings.selectedModel === FREE_ROUTER_KEY} onClick={() => void use(FREE_ROUTER_KEY)}>{settings.selectedModel === FREE_ROUTER_KEY ? "Active" : "Use"}</button>
    </div>}
    <div className="model-list">{shown.map((entry) => {
      const starred = settings.favoriteModels.includes(entry.key);
      const active = settings.selectedModel === entry.key;
      return <div className={`catalog-row ${active ? "selected" : ""}`} key={entry.key}>
        <BrandIcon brand={entry.brand} className="model-brand" />
        <span><span className="model-name"><strong>{entry.name}</strong>{entry.free === undefined ? null : priceBadge(entry.free)}{modalityMarks(entry.modalities)}</span><small>{entry.detail}</small></span>
        <button type="button" className="catalog-star" aria-pressed={starred} aria-label={`${starred ? "Unstar" : "Star"} ${entry.name}`} title={starred ? "Remove from the model picker" : "Show in the model picker"} onClick={() => star(entry.key)}>{starred ? "★" : "☆"}</button>
        <button type="button" className="catalog-use" disabled={busy || active} onClick={() => void use(entry.key)}>{active ? "Active" : "Use"}</button>
      </div>;
    })}</div>
    {!matched.length && !loading && <p className="local-model-empty">{needle ? `Nothing matches “${query}”.` : "No models under this maker."}</p>}
    {filter === "local" && <a className="load-models catalog-setup" href="#local-models">Set up a local model</a>}
    {matched.length > limit && <button type="button" className="load-models" onClick={() => setLimit(limit + CATALOG_PAGE)}>Show {Math.min(CATALOG_PAGE, matched.length - limit)} more · {matched.length - limit} left</button>}
    <button type="button" className="load-models" disabled={loading} onClick={reload}>{loading ? "Loading OpenRouter catalog…" : "Reload OpenRouter catalog"}</button>
  </section>;
}

function LocalModelSettings({ settings, onChange, act, busy }: { settings: UserSettings; onChange: (settings: UserSettings) => void; act: (method: string, params?: Record<string, string>) => Promise<unknown>; busy: boolean }) {
  const [draft, setDraft] = useState({ name: "", modelId: "", baseUrl: "http://127.0.0.1:1234/v1", credentialEnv: "" });
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const update = (field: keyof typeof draft, value: string) => setDraft((current) => ({ ...current, [field]: value }));
  const add = (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setStatus("");
    try {
      const profile: LocalModelProfile = { id: `local-${Date.now().toString(36)}`, ...draft };
      const next = validateSettings({ ...settings, localModels: [...settings.localModels, profile] });
      onChange(next);
      setDraft({ name: "", modelId: "", baseUrl: "http://127.0.0.1:1234/v1", credentialEnv: "" });
      setStatus(`${profile.name} added. Choose Use to route the next turn.`);
    } catch (reason) { setError(reasonText(reason)); }
  };
  const select = async (profile: LocalModelProfile) => {
    setError("");
    const result = await act("selectLocalModel", { baseUrl: profile.baseUrl, modelId: profile.modelId, credentialEnv: profile.credentialEnv });
    if (result === undefined) return;
    onChange({ ...settings, selectedModel: `local:${profile.id}` });
    setStatus(`${profile.name} is active for new turns.`);
  };
  const remove = (profile: LocalModelProfile) => { if (canRemoveLocalModel(settings, profile.id)) onChange(forgetLocalModel(settings, profile.id)); };
  return <section className="local-model-settings" id="local-models"><header><div><span>Local OpenAI-compatible models</span><h3>Import a local profile</h3><p>Store a friendly name, model ID, loopback `/v1` endpoint, and optionally the environment variable that holds its credential. Emma never stores the secret.</p></div><strong>Local only</strong></header><form className="local-model-form" onSubmit={add}><label>Name<input required maxLength={64} value={draft.name} onChange={(event) => update("name", event.target.value)} placeholder="Qwen local" /></label><label>Model ID<input required maxLength={128} value={draft.modelId} onChange={(event) => update("modelId", event.target.value)} placeholder="qwen3:8b" /></label><label>Base URL<input required maxLength={2048} value={draft.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} placeholder="http://127.0.0.1:1234/v1" /></label><label>Credential env<input maxLength={128} value={draft.credentialEnv} onChange={(event) => update("credentialEnv", event.target.value)} placeholder="Optional · LOCAL_API_KEY" /></label><button disabled={busy}>Add local model</button></form>{(error || status) && <p className={error ? "local-model-error" : "local-model-status"} role="status">{error || status}</p>}<div className="local-model-list">{settings.localModels.map((profile) => <div className={`local-model-row ${settings.selectedModel === `local:${profile.id}` ? "selected" : ""}`} key={profile.id}><div><BrandIcon brand={brandForModel(profile.modelId, "local")} className="local-model-brand" /><div><strong>{profile.name}</strong><span>{profile.modelId} · {profile.baseUrl}</span><small>{profile.credentialEnv || "No credential · loopback only"}</small></div></div><div><button type="button" disabled={busy} onClick={() => void select(profile)}>{settings.selectedModel === `local:${profile.id}` ? "Active" : "Use"}</button><button type="button" disabled={busy || !canRemoveLocalModel(settings, profile.id)} title={settings.selectedModel === `local:${profile.id}` ? "Select another model before removing the active profile" : "Remove local profile"} onClick={() => remove(profile)}>Remove</button></div></div>)}{!settings.localModels.length && <p className="local-model-empty">No local profiles yet.</p>}</div></section>;
}

const seesImages = (model: OpenRouterCatalog["models"][number]) => model.inputModalities?.includes("image") ?? false;

function PromptEditor({ value, onChange, busy, rows }: { value: string; onChange: (value: string) => void; busy: boolean; rows: number }) {
  const mirror = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const insert = (name: string) => {
    const node = input.current;
    if (!node) return;
    const start = node.selectionStart ?? value.length;
    const caret = start + name.length + 2;
    onChange(`${value.slice(0, start)}{${name}}${value.slice(node.selectionEnd ?? start)}`.slice(0, MAX_SYSTEM_PROMPT_CHARS));
    requestAnimationFrame(() => { node.focus(); node.setSelectionRange(caret, caret); });
  };
  return <div className="prompt-editor">
    <div className="prompt-canvas">
      <div className="prompt-highlight" ref={mirror} aria-hidden="true">{promptSegments(value).map((segment, index) => <span key={index} className={segment.hue === undefined ? segment.unknown ? "prompt-token prompt-token-unknown" : undefined : "prompt-token"} data-hue={segment.hue}>{segment.text}</span>)}{"\n"}</div>
      <textarea ref={input} value={value} disabled={busy} spellCheck={false} rows={rows} maxLength={MAX_SYSTEM_PROMPT_CHARS} aria-label="Prompt text"
        onScroll={(event) => { if (mirror.current) mirror.current.scrollTop = event.currentTarget.scrollTop; }}
        onChange={(event) => onChange(event.target.value)} />
    </div>
    <div className="prompt-variables">{PROMPT_VARIABLES.map((variable, index) => <button type="button" key={variable.name} className="prompt-token" data-hue={index % 6} disabled={busy} title={variable.detail} onClick={() => insert(variable.name)}>{`{${variable.name}}`}</button>)}</div>
  </div>;
}

function ScopePicker({ settings, entries, scope, onChange, busy }: { settings: UserSettings; entries: CatalogEntry[]; scope: string; onChange: (scope: string) => void; busy: boolean }) {
  const [picking, setPicking] = useState(false);
  const modelKey = scope.startsWith("model:") ? scope.slice("model:".length) : "";
  const family = scope.startsWith("family:") ? scope.slice("family:".length) : "";
  return <div className="scope-picker">
    <div className="scope-marks">
      <button type="button" className="scope-mark" aria-pressed={!scope} disabled={busy} onClick={() => { onChange(""); setPicking(false); }}><BrandIcon brand={allBrand} className="model-brand" /><span>Every model</span></button>
      {MODEL_FAMILIES.map((entry) => <button type="button" key={entry.id} className="scope-mark" aria-pressed={family === entry.id} disabled={busy} title={`Only ${entry.label} models`} onClick={() => { onChange(`family:${entry.id}`); setPicking(false); }}>
        <BrandIcon brand={brandForProvider(entry.brand) ?? allBrand} className="model-brand" /><span>{entry.label}</span>
      </button>)}
      <button type="button" className="scope-mark" aria-pressed={!!modelKey} aria-expanded={picking} disabled={busy} onClick={() => setPicking(!picking)}>
        <BrandIcon brand={modelKey ? modelKeyBrand(settings, modelKey) ?? allBrand : allBrand} className="model-brand" /><span>{modelKey ? modelKeyLabel(settings, modelKey) : "One model…"}</span>
      </button>
    </div>
    {picking && <div className="scope-models model-menu"><ModelPicker entries={entries} active={modelKey} label="the model this prompt is pinned to" busy={busy} onPick={(key) => { onChange(`model:${key}`); setPicking(false); }} /></div>}
  </div>;
}

function PromptSettings({ settings, onChange, busy }: { settings: UserSettings; onChange: (settings: UserSettings) => void; busy: boolean }) {
  const [models, setModels] = useState<OpenRouterCatalog["models"]>([]);
  const [error, setError] = useState("");
  useEffect(() => { void window.emma.request<OpenRouterCatalog>("listOpenRouterModels").then((catalog) => setModels(catalog.models)).catch(() => setModels([])); }, []);
  const entries = useMemo(() => modelEntries(settings.localModels, models), [settings.localModels, models]);
  const apply = (next: Partial<UserSettings>) => {
    setError("");
    try { onChange({ ...settings, ...next }); }
    catch (reason) { setError(reasonText(reason)); }
  };
  const write = (id: string, patch: Partial<PromptPreset>) => apply({ prompts: settings.prompts.map((preset) => preset.id === id ? { ...preset, ...patch } : preset) });
  const add = (preset: PromptPreset) => {
    if (settings.prompts.length >= MAX_PROMPTS) { setError(`Keep at most ${MAX_PROMPTS} prompts.`); return; }
    apply({ prompts: [...settings.prompts, preset] });
  };
  return <>
    <section className="prompt-card">
      <header>
        <div><h3>Global</h3><p>The whole system prompt, sent on every turn whatever model answers it. Emma’s harness adds its own tool contracts underneath, so the tools keep working however this is rewritten.</p></div>
        <div className="prompt-card-actions">
          <button type="button" disabled={busy} onClick={() => add({ id: newPresetId(), name: "Forked from global", body: settings.systemPrompt, scope: "", enabled: false })}>Fork</button>
          <button type="button" disabled={busy || settings.systemPrompt === DEFAULT_SYSTEM_PROMPT} onClick={() => apply({ systemPrompt: DEFAULT_SYSTEM_PROMPT })}>Reset to default</button>
        </div>
      </header>
      <PromptEditor value={settings.systemPrompt} busy={busy} rows={18} onChange={(systemPrompt) => apply({ systemPrompt })} />
      <footer><small>{settings.systemPrompt.length} / {MAX_SYSTEM_PROMPT_CHARS} characters</small></footer>
    </section>
    {settings.prompts.map((preset) => <section className={`prompt-card ${promptApplies(preset, settings.selectedModel) ? "prompt-live" : ""}`} key={preset.id}>
      <header>
        <div className="prompt-name">
          <label className="check"><input type="checkbox" checked={preset.enabled} disabled={busy} onChange={(event) => write(preset.id, { enabled: event.target.checked })} /> On</label>
          <input value={preset.name} maxLength={MAX_PROMPT_NAME_CHARS} disabled={busy} aria-label="Prompt name" onChange={(event) => write(preset.id, { name: event.target.value })} />
          {promptApplies(preset, settings.selectedModel) && <strong className="status-live"><i /> Applies to {modelKeyLabel(settings, settings.selectedModel)}</strong>}
        </div>
        <div className="prompt-card-actions">
          <button type="button" disabled={busy} onClick={() => add(forkPreset(preset, newPresetId()))}>Fork</button>
          <button type="button" disabled={busy} onClick={() => apply({ prompts: settings.prompts.filter((item) => item.id !== preset.id) })}>Delete</button>
        </div>
      </header>
      <ScopePicker settings={settings} entries={entries} scope={preset.scope} busy={busy} onChange={(scope) => write(preset.id, { scope })} />
      <PromptEditor value={preset.body} busy={busy} rows={10} onChange={(body) => write(preset.id, { body })} />
      <footer><small>{preset.body.length} / {MAX_SYSTEM_PROMPT_CHARS} characters · read after the global one, so it wins where the two disagree</small></footer>
    </section>)}
    <div className="prompt-add">
      <button type="button" disabled={busy || settings.prompts.length >= MAX_PROMPTS} onClick={() => add({ id: newPresetId(), name: "New prompt", body: "", scope: "", enabled: true })}>Add a conditional prompt</button>
      <small>{settings.prompts.length} / {MAX_PROMPTS}</small>
    </div>
    {error && <p className="local-model-error" role="status">{error}</p>}
  </>;
}

function SecondModelPicker({ label, off, draft, localModels, onChange, busy, accepts }: {
  label: string;
  off: string;
  draft: VerifierSettings;
  localModels: LocalModelProfile[];
  onChange: (next: VerifierSettings) => void;
  busy?: boolean;
  accepts?: (model: OpenRouterCatalog["models"][number]) => boolean;
}) {
  const [catalog, setCatalog] = useState<OpenRouterCatalog["models"]>([]);
  useEffect(() => { void window.emma.request<OpenRouterCatalog>("listOpenRouterModels").then((loaded) => setCatalog(loaded.models)).catch(() => undefined); }, []);
  const [forced, setForced] = useState(false);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const natural = verifierKey(draft, localModels);
  const picked = forced ? "custom" : natural;
  useEffect(() => {
    if (!open) return;
    const away = (event: Event) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const entries = useMemo(() => {
    const listed = accepts ? catalog.filter(accepts) : catalog;
    const key = `openrouter:${draft.model}`;
    const brand = brandForModel(draft.model, "openrouter");
    const saved: CatalogEntry[] = natural === key && !listed.some((model) => `openrouter:${model.id}` === key)
      ? [{ maker: brand?.id ?? "other", key, name: draft.model, detail: "Saved", brand }]
      : [];
    return [...saved, ...modelEntries(localModels, listed).filter((entry) => entry.key !== "fallback")];
  }, [catalog, natural, draft.model, accepts, localModels]);
  const chosen = entries.find((row) => row.key === picked);
  const pick = (key: string) => {
    setForced(key === "custom");
    setOpen(false);
    if (key !== "custom") onChange(verifierFromKey(key, localModels, draft.system));
  };
  return <>
    <div className="verifier-pick" ref={box}>
      <span className="verifier-pick-label">{label}</span>
      <button type="button" className="verifier-pick-trigger" disabled={busy} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
        <BrandIcon brand={picked === "custom" ? undefined : chosen?.brand} className="model-brand" />
        <span>{picked === "custom" ? draft.model || "Custom endpoint" : chosen?.name ?? (draft.model || off)}</span>
        <b aria-hidden="true">▾</b>
      </button>
      {open && <section className="source-popover model-menu" role="dialog" aria-label={label} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>
        <ModelPicker label={label} entries={entries} active={picked} busy={busy} onPick={pick} lead={{ key: "", name: off, detail: "Off" }}>
          <div className="model-menu-foot"><button type="button" className="model-menu-row quiet" aria-current={picked === "custom"} onClick={() => pick("custom")}><span>Custom endpoint…</span><b aria-hidden="true">↗</b></button></div>
        </ModelPicker>
      </section>}
    </div>
    {picked === "custom" && <>
      <label>Model ID<input maxLength={128} value={draft.model} disabled={busy} onChange={(event) => onChange({ ...draft, model: event.target.value })} placeholder="vendor/model-id" /></label>
      <label>Endpoint<input required maxLength={2048} value={draft.endpoint} disabled={busy} onChange={(event) => onChange({ ...draft, endpoint: event.target.value })} placeholder={OPENROUTER_CHAT_ENDPOINT} /></label>
      <label>Credential env<input maxLength={128} value={draft.credentialEnv} disabled={busy} onChange={(event) => onChange({ ...draft, credentialEnv: event.target.value })} placeholder="OPENROUTER_API_KEY" /></label>
      <button type="button" className="verifier-custom" disabled={busy} onClick={() => pick(natural)}>Back to the picker</button>
    </>}
  </>;
}

function VerifierPanel({ settings, onSave, busy }: { settings: UserSettings; onSave: (verifier: VerifierSettings) => Promise<void>; busy: boolean }) {
  const [draft, setDraft] = useState(settings.verifier);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const update = (field: keyof VerifierSettings, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setError("");
    setStatus("");
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setStatus("");
    void onSave(draft)
      .then(() => setStatus(draft.model ? `${draft.model} reviews every gated call in Auto mode.` : "No verifier: Auto mode asks you, exactly like Ask."))
      .catch((reason: unknown) => setError(reasonText(reason)));
  };
  return <section className="local-model-settings">
    <header><div><div className="settings-head"><h3>Verifier · clears a call in Auto</h3><InfoDot>In <b>Auto</b>, anything that would stop and ask goes to this model first with what you asked for and the exact command about to run. It answers allow or block; a call it will not clear still comes to you, with its reason. Small models get the answer format wrong, so Emma re-asks up to three times before falling back to the dialog.</InfoDot></div><p>A small, cheap second model that allows or blocks each gated call. Leave it off and Auto asks you.</p></div><strong>{settings.verifier.model ? "Configured" : "Off"}</strong></header>
    <form className="local-model-form" onSubmit={submit}>
      <SecondModelPicker label="Verifier model" off="No verifier · Auto asks you" draft={draft} localModels={settings.localModels} busy={busy} onChange={(next) => { setDraft(next); setError(""); setStatus(""); }} />
      <label className="verifier-rules">Rules it judges by<textarea rows={10} maxLength={MAX_VERIFIER_SYSTEM_CHARS} value={draft.system} onChange={(event) => update("system", event.target.value)} /></label>
      <div className="verifier-rules prompt-footer"><small>{draft.system.length} / {MAX_VERIFIER_SYSTEM_CHARS} characters · the request and the command are appended below this</small><button type="button" onClick={() => update("system", defaultVerifierSystem)}>Reset to default</button></div>
      <button disabled={busy}>Save verifier</button>
    </form>
    {(error || status) && <p className={error ? "local-model-error" : "local-model-status"} role="status">{error || status}</p>}
  </section>;
}

type CredentialSlot = { env: string; label: string; detail: string; hint: string; brand?: BrandDefinition };

function credentialSlots(settings: UserSettings, stored: CredentialSummary[]): CredentialSlot[] {
  const slots = new Map<string, CredentialSlot>();
  for (const item of providerCredentials) slots.set(item.env, { env: item.env, label: item.label, detail: item.detail, hint: item.hint, brand: brandForProvider(item.providerId) });
  for (const profile of settings.localModels) {
    if (!profile.credentialEnv || slots.has(profile.credentialEnv)) continue;
    slots.set(profile.credentialEnv, { env: profile.credentialEnv, label: profile.name, detail: `${profile.modelId} · ${profile.baseUrl}`, hint: "Local server key", brand: brandForModel(profile.modelId, "local") });
  }
  for (const item of stored) if (!slots.has(item.env)) slots.set(item.env, { env: item.env, label: item.env, detail: "Custom environment variable", hint: "Key", brand: brandForProvider(item.env.split("_")[0]) });
  return [...slots.values()];
}

function ProviderKeys({ settings, act, busy }: { settings: UserSettings; act: (method: string, params?: Record<string, string>) => Promise<unknown>; busy: boolean }) {
  const [stored, setStored] = useState<CredentialSummary[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const fail = (reason: unknown) => setError(reasonText(reason));
  useEffect(() => { void window.emma.listCredentials().then(setStored).catch(fail); }, []);
  const slots = credentialSlots(settings, stored);
  const draft = (env: string) => (drafts[env] ?? "").trim();
  const save = async (env: string, secret?: string) => {
    setError("");
    setStatus("");
    try {
      setStored(await window.emma.saveCredential(secret === undefined ? { env } : { env, secret }));
      setDrafts((current) => ({ ...current, [env]: "" }));
      await selectModelKey(settings, settings.selectedModel, act);
      setStatus(secret === undefined ? `${env} removed. The agent restarted without it.` : `${env} saved. The agent restarted with it.`);
    } catch (reason) { fail(reason); }
  };
  const addCustom = (event: FormEvent) => {
    event.preventDefault();
    const env = custom.trim().toUpperCase();
    if (!isEnvName(env)) { setError("An environment variable name must start with a letter or underscore and hold only letters, digits, and underscores."); return; }
    setDrafts((current) => ({ ...current, [env]: current[env] ?? "" }));
    setStored((current) => current.some((item) => item.env === env) ? current : [...current, { env, masked: "" }]);
    setCustom("");
  };
  return <section className="provider-keys">
    <header><div><span>API keys</span><h3>Keys stay in the keychain</h3><p>A key reaches the agent only through its process environment. Changing one restarts the local agent, so save it between turns.</p></div><strong>{stored.filter((item) => item.masked).length} stored</strong></header>
    {(error || status) && <p className={error ? "local-model-error" : "local-model-status"} role="status">{error || status}</p>}
    <div className="provider-key-list">{slots.map((slot) => {
      const saved = stored.find((item) => item.env === slot.env && item.masked);
      return <div className={`provider-key-row ${saved ? "set" : ""}`} key={slot.env}>
        <BrandIcon brand={slot.brand} className="provider-mark" />
        <div><strong>{slot.label}</strong><small>{slot.detail}</small><code>{slot.env}</code></div>
        <span className="provider-key-value">{saved ? saved.masked : "Not set"}</span>
        <label><span className="sr-only">{slot.label} API key</span><input type="password" autoComplete="off" spellCheck={false} maxLength={MAX_SECRET_CHARS} disabled={busy} value={drafts[slot.env] ?? ""} placeholder={saved ? "Paste a replacement" : slot.hint} onChange={(event) => setDrafts((current) => ({ ...current, [slot.env]: event.target.value }))} /></label>
        <button type="button" disabled={busy || !draft(slot.env)} onClick={() => void save(slot.env, draft(slot.env))}>Save</button>
        <button type="button" disabled={busy || !saved} onClick={() => void save(slot.env)}>Remove</button>
      </div>;
    })}</div>
    <form className="provider-key-add" onSubmit={addCustom}><label>Another environment variable<input value={custom} maxLength={64} disabled={busy} placeholder="TOGETHER_API_KEY" onChange={(event) => setCustom(event.target.value)} /></label><button disabled={busy || !custom.trim()}>Add slot</button></form>
  </section>;
}

function ToolSettingsPanel({ settings, onChange, onDefaultMode, busy }: { settings: UserSettings; onChange: (tools: ToolSettings) => Promise<void>; onDefaultMode: (mode: PermissionMode) => void; busy: boolean }) {
  const tools = settings.tools;
  const [targets, setTargets] = useState<{ written: ToolTarget[]; skills: ImportedSkill[]; servers: ImportedMcpServer[] }>({ written: [], skills: [], servers: [] });
  const [error, setError] = useState("");
  useEffect(() => {
    const load = () => void window.emma.listToolTargets().then(setTargets).catch(() => undefined);
    load();
    return window.emma.onToolsChanged(load);
  }, []);
  const save = (next: ToolSettings) => { setError(""); void onChange(next).catch((reason: unknown) => setError(reasonText(reason))); };
  const toggle = (field: "disabledTools" | "disabledSkills" | "disabledServers", id: string, on: boolean) =>
    save({ ...tools, [field]: on ? tools[field].filter((item) => item !== id) : [...new Set([...tools[field], id])] });
  const groups = [...new Set(TOOL_CATALOG.map((tool) => tool.group))];
  const off = tools.disabledTools.length;
  const rows = (field: "disabledTools" | "disabledSkills" | "disabledServers", items: { id: string; name: string; source: string }[], empty: string) =>
    items.length
      ? items.map((item) => <label className="check tool-row" key={item.id}><input type="checkbox" checked={!tools[field].includes(item.id)} disabled={busy} onChange={(event) => toggle(field, item.id, event.target.checked)} /><div><strong>{item.name}</strong><span>{item.source}</span></div></label>)
      : <p className="tool-empty">{empty}</p>;
  return <div className="tool-settings">
    <section className="local-model-settings default-mode">
      <header><div><div className="settings-head"><h3>Default permission mode</h3><InfoDot>The rung a thread's picker opens on. Change it in the composer and that thread keeps its own from then on; this only decides where a fresh one starts. Quick Ask keeps its own memory and is not affected.</InfoDot></div></div><ModePicker mode={settings.defaultPermissionMode} setMode={onDefaultMode} disabled={busy} /></header>
    </section>
    <section className="local-model-settings">
      <header><div><span>Built in</span><h3>What the agent may call</h3><p>Switching a tool off hides it from the model entirely — it is not offered, and a call to it is refused. Permission modes still apply on top of this: <b>Plan</b> already hides everything that changes anything. The two tools that call a model of their own — <b>Advisor</b> and <b>Vision</b> — pick it in <b>Settings → Models</b>.</p></div><strong>{off ? `${off} off` : "All on"}</strong></header>
      {groups.map((group) => <div className="tool-group" key={group}><span className="settings-group-label">{group}</span>{TOOL_CATALOG.filter((tool) => tool.group === group).map((tool) => <label className="check tool-row" key={tool.name}><input type="checkbox" checked={!tools.disabledTools.includes(tool.name)} disabled={busy} onChange={(event) => toggle("disabledTools", tool.name, event.target.checked)} /><div><strong>{tool.label}</strong><span>{tool.blurb}</span></div></label>)}</div>)}
    </section>
    <WebSearchPanel search={tools.webSearch} disabled={tools.disabledTools.includes("web_search")} onChange={(webSearch) => save({ ...tools, webSearch })} busy={busy} />
    <section className="local-model-settings">
      <header><div><span>Written by Emma</span><h3>Her own tools</h3><p>Every tool Emma wrote for herself with <b>write_tool</b>. They appear here the moment she saves one — nothing to relaunch. Switching one off leaves the script on disk but hides it from <b>run_tool</b>.</p></div><strong>{targets.written.length || "None"}</strong></header>
      <div className="tool-group">{rows("disabledTools", targets.written, "Emma has not written any tools yet.")}</div>
    </section>
    <section className="local-model-settings">
      <header><div><span>Imported</span><h3>Skills</h3><p>A skill that is off never reaches the model, and cannot be attached to a thread. Import more in <b>Settings → Imports &amp; plugins</b>.</p></div><strong>{targets.skills.length || "None"}</strong></header>
      <div className="tool-group">{rows("disabledSkills", targets.skills.map((skill) => ({ id: skill.id, name: skill.name, source: `from ${skill.source}` })), "No skills imported yet.")}</div>
    </section>
    <section className="local-model-settings">
      <header><div><span>Imported</span><h3>MCP servers</h3><p>A server that is off is not handed to the harness, so it never starts and its tools are never offered.</p></div><strong>{targets.servers.length || "None"}</strong></header>
      <div className="tool-group">{rows("disabledServers", targets.servers.map((server) => ({ id: server.id, name: server.name, source: `from ${server.source} · ${server.command}` })), "No MCP servers imported yet.")}</div>
    </section>
    {error && <p className="local-model-error" role="status">{error}</p>}
  </div>;
}

function ExperimentRow({ label, blurb, kind, steps, percent, suggested, onChange, busy }: {
  label: string;
  blurb: string;
  kind: "reinject" | "prune";
  steps: number;
  percent: number;
  suggested: number;
  onChange: (next: { steps: number; percent: number }) => void;
  busy: boolean;
}) {
  const on = steps > 0 || percent > 0;
  const number = (value: string, ceiling: number) => Math.max(0, Math.min(ceiling, Math.trunc(Number(value) || 0)));
  return <div className="tool-group">
    <div className="settings-head">
      <label className="check tool-row">
        <input type="checkbox" checked={on} disabled={busy} onChange={(event) => onChange(event.target.checked ? { steps: suggested, percent: 0 } : { steps: 0, percent: 0 })} />
        <strong>{label}</strong>
      </label>
      <InfoDot>{blurb}</InfoDot>
    </div>
    {kind === "reinject"
      ? <div className="ctx-anim ctx-reinject" aria-hidden="true">
        <div className="ctx-track">
          <span className="ctx-block ctx-prompt">prompt</span>
          <span className="ctx-block">tool result</span>
          <span className="ctx-block">tool result</span>
          <span className="ctx-block">tool result</span>
          <span className="ctx-block ctx-prompt ctx-echo">prompt</span>
        </div>
      </div>
      : <div className="ctx-anim ctx-prune" aria-hidden="true">
        <div className="ctx-track">
          <span className="ctx-block ctx-older">tool result<em>pruned</em></span>
          <span className="ctx-block ctx-older">tool result<em>pruned</em></span>
          <span className="ctx-block ctx-newest">tool result<em>kept</em></span>
        </div>
      </div>}
    <div className="font-values">
      <label>Every N steps<input type="number" min={0} max={MAX_EXPERIMENT_STEPS} value={steps} disabled={busy} onChange={(event) => onChange({ steps: number(event.target.value, MAX_EXPERIMENT_STEPS), percent })} /></label>
      <label>At % of context<input type="number" min={0} max={100} value={percent} disabled={busy} onChange={(event) => onChange({ steps, percent: number(event.target.value, 100) })} /></label>
      <small>{on ? "0 switches a trigger off; set both and either one fires." : "Off. Nothing is added to or removed from the context window."}</small>
    </div>
  </div>;
}

function HarnessExperimentsPanel({ settings, onChange, busy }: { settings: UserSettings; onChange: (experiments: HarnessExperiments) => Promise<void>; busy: boolean }) {
  const experiments = settings.harnessExperiments;
  const [error, setError] = useState("");
  const save = (next: HarnessExperiments) => { setError(""); void onChange(next).catch((reason: unknown) => setError(reasonText(reason))); };
  return <div className="tool-settings">
    <section className="local-model-settings">
      <header>
        <div>
          <span>Experimental</span>
          <div className="settings-head">
            <h3>Context window hooks</h3>
            <InfoDot>Both levers act on the copy sent to the model for one step — the thread, the transcript and the harness's own history are untouched, and the next step rebuilds from the originals. A step is one model request; a turn is capped at 120. The percentage is measured against the selected model's context window at four characters a token, so a model whose window Emma does not know leaves the percentage triggers inert — use steps there.</InfoDot>
          </div>
        </div>
        <strong>{experiments.reinjectPromptSteps || experiments.reinjectPromptPercent || experiments.pruneToolsSteps || experiments.pruneToolsPercent ? "On" : "Off"}</strong>
      </header>
      <ExperimentRow
        label="Repeat the original prompt"
        kind="reinject"
        blurb="Appends what you asked for, unchanged, after the newest tool results — so a long run of tool calls does not bury the request under its own output."
        steps={experiments.reinjectPromptSteps}
        percent={experiments.reinjectPromptPercent}
        suggested={15}
        busy={busy}
        onChange={({ steps, percent }) => save({ ...experiments, reinjectPromptSteps: steps, reinjectPromptPercent: percent })}
      />
      <ExperimentRow
        label="Prune older tool results"
        kind="prune"
        blurb="Replaces the output of earlier tool calls with a one-line placeholder, keeping the newest batch intact so the model is not made to re-run the call it just made. It can always run a tool again."
        steps={experiments.pruneToolsSteps}
        percent={experiments.pruneToolsPercent}
        suggested={15}
        busy={busy}
        onChange={({ steps, percent }) => save({ ...experiments, pruneToolsSteps: steps, pruneToolsPercent: percent })}
      />
    </section>
    {error && <p className="local-model-error" role="status">{error}</p>}
  </div>;
}

function WebSearchPanel({ search, disabled, onChange, busy }: { search: WebSearchSettings; disabled: boolean; onChange: (value: WebSearchSettings) => void; busy: boolean }) {
  const [draft, setDraft] = useState(search);
  const provider = webSearchProvider(draft.provider);
  const pick = (id: WebSearchProvider) => setDraft({ provider: id, endpoint: webSearchProvider(id).endpoint, credentialEnv: webSearchCredentials[id] });
  return <section className="local-model-settings">
    <header><div><span>web_search</span><h3>Where the search goes</h3><p>{provider.detail}</p></div><strong>{disabled ? "Tool off" : provider.keyless ? "No key needed" : draft.credentialEnv ? "Key set up" : "Needs a key"}</strong></header>
    <form className="local-model-form" onSubmit={(event) => { event.preventDefault(); onChange(draft); }}>
      <label>Provider<select value={draft.provider} disabled={busy} onChange={(event) => pick(event.target.value as WebSearchProvider)}>{WEB_SEARCH_PROVIDERS.map((item) => <option key={item.id} value={item.id}>{item.label}{item.keyless ? "" : " · needs a key"}</option>)}</select></label>
      <label>Endpoint<input required maxLength={2048} value={draft.endpoint} disabled={busy} onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })} /></label>
      {!provider.keyless && <label>Credential env<input maxLength={128} value={draft.credentialEnv} disabled={busy} onChange={(event) => setDraft({ ...draft, credentialEnv: event.target.value })} placeholder={webSearchCredentials[draft.provider]} /></label>}
      {!provider.keyless && !draft.credentialEnv && <p className="local-model-error">{provider.label} needs a key. Store it in <b>Settings → Models → Provider keys</b> under the name above, or pick 4get, which needs none.</p>}
      <button disabled={busy}>Save search provider</button>
    </form>
  </section>;
}

function AdvisorPanel({ settings, onSave, busy }: { settings: UserSettings; onSave: (advisor: VerifierSettings) => Promise<void>; busy: boolean }) {
  const [draft, setDraft] = useState(settings.tools.advisor);
  const [note, setNote] = useState<{ text: string; bad?: boolean }>({ text: "" });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setNote({ text: "" });
    void onSave(draft)
      .then(() => setNote({ text: draft.model ? `${draft.model} answers when the agent asks for advice.` : "No advisor: the tool tells the agent to come back here." }))
      .catch((reason: unknown) => setNote({ text: reasonText(reason), bad: true }));
  };
  return <section className="local-model-settings">
    <header><div><div className="settings-head"><h3>Advisor · asked when the agent is stuck</h3><InfoDot>The agent hands this model the thread and what it has tried, and gets back a plan. Pick something <b>stronger</b> than the model you run on — asking a weaker one costs a turn and returns worse advice. Leave it empty and the tool tells the agent to come back here.</InfoDot></div><p>A stronger second model the agent asks for a plan when it is stuck.</p></div><strong>{settings.tools.advisor.model ? "Configured" : "Not set up"}</strong></header>
    {!draft.model && <p className="local-model-error">No advisor model is set, so the tool does nothing but point back at this page. Pick one below — any model whose key you have already stored.</p>}
    <form className="local-model-form" onSubmit={submit}>
      <SecondModelPicker label="Advisor model" off="No advisor · the tool does nothing" draft={draft} localModels={settings.localModels} busy={busy} onChange={(next) => { setDraft(next); setNote({ text: "" }); }} />
      <label className="verifier-rules">What it is asked to do<textarea rows={6} maxLength={MAX_VERIFIER_SYSTEM_CHARS} value={draft.system} disabled={busy} onChange={(event) => setDraft({ ...draft, system: event.target.value })} /></label>
      <div className="verifier-rules prompt-footer"><small>{draft.system.length} / {MAX_VERIFIER_SYSTEM_CHARS} characters · the thread is appended below this</small><button type="button" onClick={() => setDraft({ ...draft, system: defaultAdvisorSystem })}>Reset to default</button></div>
      <button disabled={busy}>Save advisor</button>
    </form>
    {note.text && <p className={note.bad ? "local-model-error" : "local-model-status"} role="status">{note.text}</p>}
  </section>;
}

function VisionPanel({ settings, onSave, busy }: { settings: UserSettings; onSave: (vision: VerifierSettings) => Promise<void>; busy: boolean }) {
  const [draft, setDraft] = useState(settings.tools.vision);
  const [note, setNote] = useState<{ text: string; bad?: boolean }>({ text: "" });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setNote({ text: "" });
    void onSave(draft)
      .then(() => setNote({ text: draft.model ? `${draft.model} answers when the agent looks at an image.` : "No vision model: the tool tells the agent it cannot look." }))
      .catch((reason: unknown) => setNote({ text: reasonText(reason), bad: true }));
  };
  return <section className="local-model-settings">
    <header><div><div className="settings-head"><h3>Vision · asked to look at an image</h3><InfoDot>Most models cannot see. This one is sent one image and one question — what is in it, what does it say, where exactly is the button — and answers in words the agent can use. Only models that take images are listed; a free one reads a screenshot perfectly well.</InfoDot></div><p>The model the agent sends an image to. Only models that can see are listed.</p></div><strong>{settings.tools.vision.model ? "Configured" : "Not set up"}</strong></header>
    {!draft.model && <p className="local-model-error">No vision model is set, so the tool tells the agent it cannot look.</p>}
    <form className="local-model-form" onSubmit={submit}>
      <SecondModelPicker label="Vision model" off="No vision model · the agent cannot look" draft={draft} localModels={settings.localModels} busy={busy} accepts={seesImages} onChange={(next) => { setDraft(next); setNote({ text: "" }); }} />
      <label className="verifier-rules">What it is asked to do<textarea rows={6} maxLength={MAX_VERIFIER_SYSTEM_CHARS} value={draft.system} disabled={busy} onChange={(event) => setDraft({ ...draft, system: event.target.value })} /></label>
      <div className="verifier-rules prompt-footer"><small>{draft.system.length} / {MAX_VERIFIER_SYSTEM_CHARS} characters · the question and the image are appended below this</small><button type="button" onClick={() => setDraft({ ...draft, system: defaultVisionSystem })}>Reset to default</button></div>
      <button disabled={busy}>Save vision model</button>
    </form>
    {note.text && <p className={note.bad ? "local-model-error" : "local-model-status"} role="status">{note.text}</p>}
  </section>;
}

function AgentImports({ done }: { done?: () => void }) {
  const [sources, setSources] = useState<AgentImportSource[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(true);
  const [status, setStatus] = useState("");
  useEffect(() => {
    void window.emma.discoverAgentImports().then((items) => {
      setSources(items);
      setSelected(items.filter((item) => item.skills || item.mcpConfigs).map((item) => item.id));
    }).catch((reason) => setStatus(reasonText(reason))).finally(() => setBusy(false));
  }, []);
  const submit = async () => {
    setBusy(true); setStatus("");
    try {
      const imported = await window.emma.importAgentSources(selected);
      setStatus(`${imported.length} ${plural(imported.length, "agent source")} registered`);
      done?.();
    } catch (reason) { setStatus(reasonText(reason)); }
    finally { setBusy(false); }
  };
  return <div className="import-sources"><div className="import-list">{sources.map((source) => { const available = source.skills > 0 || source.mcpConfigs > 0; return <label key={source.id} className={available ? "" : "unavailable"}><input type="checkbox" disabled={!available || busy} checked={selected.includes(source.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, source.id] : selected.filter((id) => id !== source.id))} /><BrandIcon brand={brandForImporter(source.id)} className={`integration-mark ${source.id}`} /><div><strong>{source.label}</strong><small>{available ? `${source.skills} ${plural(source.skills, "skill")} · ${source.mcpConfigs} MCP ${plural(source.mcpConfigs, "config")}` : "Nothing found in default locations"}</small>{source.locations.length > 0 && <code>{source.locations.join(" · ")}</code>}</div></label>; })}</div><footer><p>References, not copies.</p><InfoDot>Skill instructions and MCP servers remain inactive until a thread or plugin explicitly selects them.</InfoDot><button type="button" onClick={() => void submit()} disabled={busy || !selected.length}>{busy ? "Scanning…" : "Import selected"}</button></footer>{status && <p className="import-status" role="status">{status}</p>}</div>;
}

function ConnectionSettings({ settings, onChange, busy }: { settings: UserSettings; onChange: (connections: string[]) => void; busy: boolean }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [outdated, setOutdated] = useState<string[]>([]);
  const [working, setWorking] = useState("");
  const [status, setStatus] = useState("Looking…");
  const refresh = useCallback(async () => {
    const items = await window.emma.detectConnections();
    setConnections(items);
    setStatus("");
    setOutdated(items.some((item) => item.binary) ? await window.emma.outdatedConnections() : []);
  }, []);
  useEffect(() => { queueMicrotask(() => void refresh().catch((reason) => setStatus(reasonText(reason)))); }, [refresh]);
  const toggle = (id: string, on: boolean) => onChange(on ? [...settings.connections, id] : settings.connections.filter((item) => item !== id));
  const setUp = async (id: string, action: "install" | "upgrade") => {
    setWorking(id);
    setStatus(`${action === "install" ? "Installing" : "Updating"} — this can take a few minutes.`);
    try {
      const result = await window.emma.setUpConnection({ id, action });
      await refresh();
      setStatus(result.message);
    } catch (reason) { setStatus(reasonText(reason)); }
    finally { setWorking(""); }
  };
  return <div className="connection-list">{connections.map((connection) => {
    const stale = outdated.includes(connection.id);
    const action = connection.binary ? (stale ? "upgrade" : "") : "install";
    return <div key={connection.id} className={`connection-row ${connection.binary ? "" : "unavailable"}`}>
      <label>
        <input type="checkbox" disabled={busy || !connection.binary} checked={settings.connections.includes(connection.id)} onChange={(event) => toggle(connection.id, event.target.checked)} />
        <BrandIcon brand={brandForConnection(connection.id)} className={`integration-mark ${connection.id}`} />
        <div><strong>{connection.label}</strong><small>{connection.detail}</small></div>
      </label>
      <code>{connection.binary || `brew install ${connection.formula}`}</code>
      {action
        ? <button type="button" disabled={busy || Boolean(working)} onClick={() => void setUp(connection.id, action)}>{working === connection.id ? "…" : action === "install" ? "Install" : "Update"}</button>
        : <em>{connection.binary ? "Current" : ""}</em>}
    </div>;
  })}{status && <p className="import-status" role="status">{status}</p>}</div>;
}

const SETUP_STEPS = ["Emma", "Permissions", "Quick Ask", "Knowledge", "Agents"] as const;

const SETUP_PROMISES = [
  { key: "⌥⌥", line: "Ask from anywhere, over whatever app you are in." },
  { key: "Explicit", line: "Nothing is filed, written, or run until you say so." },
  { key: "Local", line: "Threads, knowledge, and every key stay on this Mac." },
] as const;

const NOTCH_LESSONS = [
  { key: "⌥⌥", line: "Double-tap the left Option key. Both taps inside a third of a second." },
  { key: "↩", line: "Enter sends. Shift-Enter starts a new line." },
  { key: "esc", line: "Escape parks a running turn as a chip. Click it to come back." },
  { key: "▽", line: "Swipe below the island for your three quick actions." },
  { key: "◎", line: "Orbs ring the cursor: capture, draw, save the page." },
] as const;

const NOTCH_ORBS = [{ glyph: "▣", name: "Screen" }, { glyph: "✎", name: "Draw" }, { glyph: "⧉", name: "Save page" }] as const;

function vaultTree(vault: VaultChoice | null, folder: string): string {
  const name = vault ? (vault.root.split("/").filter(Boolean).pop() ?? vault.name) : "Your vault";
  return [
    `${name}/`,
    `└─ ${folder || DEFAULT_VAULT_FOLDER}/`,
    "   ├─ 2026-08-24-tuning-a-kiln.md",
    "   ├─ 2026-08-24-glaze-chemistry.md",
    `   └─ ${ATTACHMENT_FOLDER}/`,
  ].join("\n");
}

const GRANT_STATES = { on: { mark: "[ok]", title: "Granted" }, off: { mark: "[  ]", title: "Not granted" }, unknown: { mark: "[--]", title: "macOS does not report this one" } };

function SetupMark({ on }: { on: boolean | null | undefined }) {
  const state = on === true ? "on" : on === false ? "off" : "unknown";
  return <i className={`setup-mark ${state}`} title={GRANT_STATES[state].title} role="img" aria-label={GRANT_STATES[state].title}>{GRANT_STATES[state].mark}</i>;
}

function PermissionSettings({ busy }: { busy: boolean }) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(() => { void window.emma.setupStatus().then(setStatus).catch(() => undefined); }, []);
  useEffect(() => { refresh(); window.addEventListener("focus", refresh); return () => window.removeEventListener("focus", refresh); }, [refresh]);
  const open = (permission: SetupPermission) => void window.emma.openPrivacySettings(permission).catch((reason: unknown) => setError(reasonText(reason)));
  const granted = SETUP_PERMISSIONS.filter((permission) => status?.[permission.id] === true).length;
  return <>
    <div className="settings-lines permission-lines">
      <header>
        <div className="settings-head"><h3>What this Mac lets Emma do</h3><InfoDot>Every grant here belongs to macOS, not to Emma: she can only send you to the pane that flips it. Nothing on this list is asked for until a task needs it, and a refused grant stops that task rather than the app.</InfoDot></div>
        <strong>{granted} of {SETUP_PERMISSIONS.length}</strong>
      </header>
      {SETUP_PERMISSIONS.map((permission) => {
        const ok = status?.[permission.id];
        return <section key={permission.id}>
          <div>
            <div className="settings-head"><h3><SetupMark on={ok} />{permission.title}</h3><InfoDot>{permission.why}</InfoDot></div>
            <p>{permission.what}</p>
            <ul className="permission-tasks">{permission.tasks.map((task) => <li key={task}>{task}</li>)}</ul>
            {permission.relaunch && ok !== true && <small className="keybind-builtin">Relaunch Emma once you have granted it.</small>}
          </div>
          <button type="button" disabled={busy} onClick={() => open(permission.id)}>{ok === true ? "Review ↗" : "Grant ↗"}</button>
        </section>;
      })}
    </div>
    <div className="settings-lines">
      <section>
        <div><div className="settings-head"><h3>What the agent may call</h3><InfoDot>A tool switched off is never offered to the model, and a call to it is refused even if the model asks anyway. On top of that, the thread's permission mode decides which calls stop for your yes first.</InfoDot></div><p>Tools, skills, and MCP servers each have their own switch, and the mode picker decides which calls ask you first.</p></div>
        <button type="button" disabled={busy} onClick={() => openSettingsPage("tools")}>Open Tools</button>
      </section>
    </div>
    {error && <p className="dialog-error" role="alert">{error}</p>}
  </>;
}

function NotchDrawing() {
  return <div className="setup-notch" aria-hidden="true">
    <div className="island">
      <header className="island-bar">
        <div className="brand"><EmmaMark /><strong>Emma</strong></div>
        <span className="setup-housing" />
        <span className="island-status"><i /> Quick thread</span>
      </header>
      <div className="island-body"><span className="setup-caret">Ask Emma anything…</span></div>
      <footer className="island-foot"><span>Auto</span><span>— ctx</span></footer>
    </div>
    <div className="setup-orbs">
      {NOTCH_ORBS.map((orb) => <span key={orb.name}><span className="orb"><kbd>{orb.glyph}</kbd></span>{orb.name}</span>)}
    </div>
  </div>;
}

function SetupDialog({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(() => { void window.emma.setupStatus().then(setStatus).catch(() => undefined); }, []);
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);
  useEffect(() => { refresh(); window.addEventListener("focus", refresh); return () => window.removeEventListener("focus", refresh); }, [refresh]);
  const open = (permission: SetupPermission) => void window.emma.openPrivacySettings(permission).catch((reason: unknown) => setError(reasonText(reason)));
  const [vaults, setVaults] = useState<VaultChoice[]>([]);
  const [obsidian, setObsidian] = useState({ installed: false, command: "" });
  const [typedFolder, setTypedFolder] = useState("");
  const folder = typedFolder || status?.vault?.folder || DEFAULT_VAULT_FOLDER;
  useEffect(() => {
    if (step !== 3) return;
    void window.emma.detectVaults().then(setVaults).catch(() => setVaults([]));
    void window.emma.installObsidian().then(setObsidian).catch(() => setObsidian({ installed: false, command: "" }));
  }, [step]);
  const apply = (choice: VaultChoice) => {
    setError("");
    void window.emma.setVault(choice).then(setStatus).catch((reason: unknown) => setError(reasonText(reason)));
  };
  const pickFolder = () => {
    setError("");
    void window.emma.pickVaultFolder()
      .then((picked) => { if (picked) apply({ ...picked, folder: validVaultFolder(folder) ? folder : DEFAULT_VAULT_FOLDER }); })
      .catch((reason: unknown) => setError(reasonText(reason)));
  };
  const granted = SETUP_PERMISSIONS.filter((permission) => status?.[permission.id] === true).length;
  const last = step === SETUP_STEPS.length - 1;
  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="setup-title" onCancel={(event) => { event.preventDefault(); close(); }}>
    <section className="import-dialog setup-dialog">
      <header>
        <EmmaMark className="setup-crest blinks" />
        <div>
          <span>Setup / {step + 1} of {SETUP_STEPS.length}</span>
          <h2 id="setup-title">{SETUP_STEPS[step]}</h2>
        </div>
        <button type="button" onClick={close} aria-label="Skip setup">×</button>
      </header>
      <nav className="setup-rail" aria-label="Setup steps">
        {SETUP_STEPS.map((title, index) => <span key={title} className={index === step ? "on" : index < step ? "done" : ""} aria-current={index === step ? "step" : undefined}><b>{String(index + 1).padStart(2, "0")}</b> {title}</span>)}
      </nav>
      {step === 0 && <div className="setup-intro">
        <EmmaMark className="setup-hero blinks" />
        <dl>{SETUP_PROMISES.map((promise) => <div key={promise.key}><dt>{promise.key}</dt><dd>{promise.line}</dd></div>)}</dl>
      </div>}
      {step === 1 && <div className="setup-grants">
        <p className="setup-meter"><span aria-hidden="true">[{"#".repeat(granted)}{".".repeat(SETUP_PERMISSIONS.length - granted)}]</span> {granted} of {SETUP_PERMISSIONS.length} granted · macOS asks one at a time</p>
        {SETUP_PERMISSIONS.map((permission) => {
          const ok = status?.[permission.id];
          return <section key={permission.id}>
            <h3><SetupMark on={ok} />{permission.title}<InfoDot>{permission.why}</InfoDot></h3>
            <button type="button" onClick={() => open(permission.id)}>{ok === true ? "Review ↗" : "Grant ↗"}</button>
            <div>
              <p>{permission.what}</p>
              {permission.relaunch && ok !== true && <small>Relaunch Emma once you have granted it.</small>}
            </div>
          </section>;
        })}
      </div>}
      {step === 2 && <div className="setup-notch-step">
        <NotchDrawing />
        <dl>{NOTCH_LESSONS.map((lesson) => <div key={lesson.key}><dt>{lesson.key}</dt><dd>{lesson.line}</dd></div>)}</dl>
        <div className="setup-choices">
          <button type="button" onClick={() => void window.emma.demoQuickAsk().catch((reason: unknown) => setError(reasonText(reason)))}>Show me ↗</button>
          {status?.accessibility !== true && <small>⌥⌥ stays dead until Accessibility is granted — this button opens it either way.</small>}
        </div>
      </div>}
      {step === 3 && <div className="setup-grants">
        <section>
          <h3><SetupMark on={!!status?.vault} />Where notes are saved<InfoDot>Every save is one Markdown note in a folder you already own — an Obsidian vault, an iCloud Drive folder, anywhere. Obsidian, or whatever you read Markdown with, is the reader; Emma keeps no second copy. Writing there is what makes macOS ask about Files &amp; Folders.</InfoDot></h3>
          <button type="button" onClick={pickFolder}>Any folder…</button>
          <div>
            <code>{status?.vault ? noteFolder(status.vault) : "No vault yet"}</code>
            <pre className="setup-art" aria-hidden="true">{vaultTree(status?.vault ?? null, folder)}</pre>
            {vaults.length > 0 && <div className="setup-choices">{vaults.map((choice) => <button key={choice.root} type="button" onClick={() => apply({ ...choice, folder: validVaultFolder(folder) ? folder : DEFAULT_VAULT_FOLDER })}>{choice.name}</button>)}</div>}
            {!vaults.length && !obsidian.installed && <div className="setup-choices">{obsidian.command
              ? <><code>{obsidian.command}</code><CopyTurn text={obsidian.command} label="Copy the Obsidian install command" /></>
              : <a href="https://obsidian.md/download" target="_blank" rel="noreferrer">obsidian.md/download ↗</a>}</div>}
            <label className="sr-only" htmlFor="vault-folder">Folder inside the vault</label>
            <input id="vault-folder" value={folder} maxLength={128} spellCheck={false} placeholder={DEFAULT_VAULT_FOLDER}
              onChange={(event) => setTypedFolder(event.target.value)}
              onBlur={() => { if (status?.vault && validVaultFolder(folder) && folder !== status.vault.folder) apply({ ...status.vault, folder }); }} />
            {status?.files !== true && <small>macOS has not let Emma write there yet. <button type="button" className="setup-skip" onClick={() => open("files")}>Open Settings ↗</button></small>}
          </div>
        </section>
      </div>}
      {step === 4 && <AgentImports />}
      {error && <p className="dialog-error" role="alert">{error}</p>}
      <footer className="setup-foot">
        {!last && <button type="button" className="setup-skip" onClick={close}>Skip setup</button>}
        {step > 0 && <button type="button" onClick={() => setStep(step - 1)}>Back</button>}
        <button type="button" className="dialog-primary" onClick={() => last ? close() : setStep(step + 1)}>{last ? "Start using Emma" : "Continue"}</button>
      </footer>
    </section>
  </dialog>;
}

function ImportDialog({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="import-title" onCancel={(event) => { event.preventDefault(); close(); }}><section className="import-dialog"><header><div><span>First launch / optional</span><h2 id="import-title">Bring your agent setup</h2><p>Emma can find Codex, Claude, Antigravity, Pi, OpenCode, Cursor, Windsurf, and Devin defaults on this Mac.</p></div><button type="button" onClick={close} aria-label="Skip agent imports">×</button></header><AgentImports done={close} /><button className="import-later" type="button" onClick={close}>Not now</button></section></dialog>;
}

function ModelMenu({ ref, close, act, busy, onSettingsChanged, onManage, pinned }: { ref: RefObject<HTMLElement | null>; close: () => void; act: (method: string, params?: Record<string, string>) => Promise<unknown>; busy: boolean; onSettingsChanged: (settings: UserSettings) => void; onManage: () => void; pinned?: { key: string; onPick: (key: string) => void } }) {
  const [catalog, setCatalog] = useState<OpenRouterCatalog>();
  const [settings, setSettings] = useState(readSettings);
  const [error, setError] = useState("");
  useEffect(() => {
    void window.emma.request<OpenRouterCatalog>("listOpenRouterModels")
      .then(setCatalog)
      .catch((reason: unknown) => setError(reasonText(reason)));
  }, []);
  const modelFor = (key: string) => key.startsWith("openrouter:") ? catalog?.models.find((model) => model.id === key.slice("openrouter:".length)) : undefined;
  const choose = async (key: string) => {
    if (busy) return;
    if (pinned) { pinned.onPick(key); return; }
    const selected = await selectModelKey(settings, key, act);
    if (!selected) return;
    const next = persistSettings({ ...selected, thinkingLevel: "" });
    setSettings(next);
    onSettingsChanged(next);
  };
  const setThinking = async (thinkingLevel: ThinkingLevel) => {
    if (busy) return;
    const selected = await selectModelKey(settings, settings.selectedModel, act, thinkingLevel);
    if (!selected) return;
    const next = persistSettings({ ...settings, thinkingLevel });
    setSettings(next);
    onSettingsChanged(next);
  };
  const star = (key: string) => {
    setError("");
    try {
      const next = persistSettings(toggleFavoriteModel(settings, key));
      setSettings(next);
      onSettingsChanged(next);
    } catch (reason) { setError(reasonText(reason)); }
  };
  const stops = thinkingStops(modelFor(settings.selectedModel));
  const active = pinned ? pinned.key : settings.selectedModel;
  const entries = useMemo(() => {
    const all = modelEntries(settings.localModels, catalog?.models ?? []);
    const listed = pinned ? all.filter((entry) => entry.key.startsWith("openrouter:")) : all;
    if (!active || listed.some((entry) => entry.key === active)) return listed;
    const brand = modelKeyBrand(settings, active);
    return [{ maker: brand?.id ?? "other", key: active, name: modelKeyLabel(settings, active), detail: modelKeyRoute(settings, active), brand }, ...listed];
  }, [settings, catalog, pinned, active]);
  return <section className="source-popover model-menu" ref={ref} role="dialog" aria-modal="false" aria-label="Model" tabIndex={-1} onKeyDown={(event) => { if (event.key === "Escape") close(); }}>
    <ModelPicker label="models" entries={entries} active={active} busy={busy} favorites={settings.favoriteModels} onStar={star} freeRouter={!pinned} onPick={(key) => void choose(key)}
      lead={pinned ? { key: "", name: "Same as the workspace", detail: pinned.key ? selectedModelLabel(settings) : "Active" } : undefined}>
      {!pinned && <div className="model-menu-thinking"><span>Thinking</span>
        <ThinkingSlider level={stops.includes(settings.thinkingLevel) ? settings.thinkingLevel : ""} stops={stops.length ? stops : [""]} setLevel={setThinking} disabled={busy || !stops.length} />
      </div>}
      {!catalog && !error && <p className="model-menu-note">Loading the OpenRouter catalog…</p>}
      {error && <p className="capability-error" role="alert">{error}</p>}
      <div className="model-menu-foot"><button type="button" className="model-menu-row quiet" onClick={onManage}><span>All models, keys, and local profiles</span><b aria-hidden="true">↗</b></button></div>
    </ModelPicker>
  </section>;
}

const OVERLAY_DRAFT_KEY = "emma.overlayDraft.v1";
const SPARKLE_RAMP = " ·∙░▒▓";
const WAVE_ROWS = 2;
const ATTACHMENT_BAND = 60;
const SETTLE_MS = 700;
const ISLAND_BOTTOM = 97;
const ORB_DROP = 105;
const MAX_TRANSCRIPT = 260;
const MIGRATE_AFTER = 6;
const POPOUT_BAR = 28;
const PILL_LINGER_MS = 2400;
const PILL_FADE_MS = 320;

function NotchWave({ width, busy }: { width: number; busy: boolean }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => setFrame((value) => value + 1), busy ? 55 : 90);
    return () => clearInterval(timer);
  }, [busy]);
  const columns = Math.max(12, Math.round(width / 6));
  const rows = Array.from({ length: WAVE_ROWS }, (_, row) => Array.from({ length: columns }, (_, column) => {
    const edge = 1 - Math.abs((column / (columns - 1)) * 2 - 1) ** (2.4 - row * 0.9);
    const tongue = 0.74 + 0.26 * Math.sin(column * 0.55 - frame * 0.7) * Math.sin(column * 0.19 + frame * 0.31);
    const flicker = Math.abs(Math.sin((column + 1) * 12.9898 + (row + 1) * 4.1414 + frame * (busy ? 1.4 : 0.9)));
    const level = Math.round(edge * tongue * (1 - row * 0.42) * SPARKLE_RAMP.length * (0.7 + flicker * 0.7));
    return SPARKLE_RAMP[Math.min(SPARKLE_RAMP.length - 1, Math.max(0, level))];
  }).join(""));
  return <div className={`notch-wave ${busy ? "busy" : ""}`} aria-hidden="true">{rows.map((row, index) => <span key={index}>{row}</span>)}</div>;
}

function readNotchQuery(fallbackWidth: number) {
  const query = new URLSearchParams(location.search);
  const read = (key: string, fallback: number, min: number, max: number) => {
    const value = Number(query.get(key));
    return Number.isFinite(value) && value >= min && value <= max ? Math.round(value) : fallback;
  };
  return { left: read("notchLeft", 0, 0, 16_384), width: read("notchWidth", fallbackWidth, 40, 600), height: read("notchHeight", 32, 8, 120) };
}

export function orbLabel(command: CursorCommand, settings: UserSettings) {
  return /^[012]$/.test(command) ? settings.quickActions[Number(command)].label : cursorCommandNames[command];
}

function OrbRing({ commands, settings, selected, onPick }: { commands: CursorCommand[]; settings: UserSettings; selected?: number; onPick: (index: number) => void }) {
  return <div className="radial" role="menu" aria-label="Emma context commands">
    {commands.map((command, index) => {
      const angle = (index / commands.length) * 2 * Math.PI - Math.PI / 2;
      const style = { left: `calc(50% + ${Math.round(Math.cos(angle) * 88)}px)`, top: `calc(50% + ${Math.round(Math.sin(angle) * 88)}px)` } as CSSProperties;
      const label = orbLabel(command, settings);
      return <button type="button" key={index} role="menuitem" className={selected === index ? "selected" : ""} style={style} title={label} onClick={() => onPick(index)}><span className="orb" aria-hidden="true"><kbd>{cursorCommandGlyphs[command]}</kbd></span>{label}</button>;
    })}
  </div>;
}

function RadialCommands() {
  const settings = useMemo(() => readSettings(), []);
  return <OrbRing commands={settings.cursorOrbs} settings={settings} onPick={(index) => window.emma.sendQuickCommand(settings.cursorOrbs[index])} />;
}

function NotchHotspot() {
  const [hover, setHover] = useState(false);
  const notch = useMemo(() => readNotchQuery(180), []);
  useEffect(() => window.emma.onNotchHover(setHover), []);
  const style = { "--notch-x": `${notch.left}px`, "--notch-w": `${notch.width}px`, "--notch-h": `${notch.height}px` } as CSSProperties;
  return <button className={`notch-hotspot ${hover ? "open" : ""}`} style={style} onClick={() => window.emma.openOverlay()} aria-label="Open Emma Quick Ask">
    {hover && <NotchWave width={notch.width} busy={false} />}
  </button>;
}

function useNotchSwipe(notch: { left: number; width: number; height: number }, bottom: number) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const move = (event: MouseEvent) => {
      const drop = event.clientY - notch.height;
      const inside = drop >= bottom - 6 && drop <= bottom + ORB_DROP
        && Math.abs(event.clientX - (notch.left + notch.width / 2)) <= notch.width / 2 + 60 + Math.max(0, drop - bottom) * 1.7;
      if (inside) { clearTimeout(timer); timer = undefined; setOpen(true); }
      else if (!timer) timer = setTimeout(() => setOpen(false), 260);
    };
    addEventListener("mousemove", move);
    return () => { removeEventListener("mousemove", move); clearTimeout(timer); };
  }, [bottom, notch.height, notch.left, notch.width]);
  return open;
}

const latestReply = (thread: Thread) => {
  const last = thread.messages.at(-1);
  return last?.role === "assistant" ? last.content : "";
};

const latestRate = (thread?: Thread) => {
  const generation = thread?.messages.at(-1)?.generation;
  return generation?.durationMilliseconds ? Math.round(generation.outputTokens / generation.durationMilliseconds * 1000) : 0;
};

type QuickTurn = { role: "user" | "assistant"; content: string; steps?: ThreadStep[]; choices?: { label: string; run: () => void }[] };

function StatusPill({ status, label }: { status: "working" | "error" | "done"; label: string }) {
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (status !== "done") return;
    const fade = setTimeout(() => setLeaving(true), PILL_LINGER_MS);
    const gone = setTimeout(() => window.emma.dismissOverlay(), PILL_LINGER_MS + PILL_FADE_MS);
    return () => { clearTimeout(fade); clearTimeout(gone); };
  }, [status]);
  const drag = useRef<{ x: number; y: number; moved: boolean } | undefined>(undefined);
  const down = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.screenX - window.screenX, y: event.screenY - window.screenY, moved: false };
  };
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const grab = drag.current;
    if (!grab) return;
    const next = { x: event.screenX - grab.x, y: event.screenY - grab.y };
    if (!grab.moved && Math.abs(next.x - window.screenX) + Math.abs(next.y - window.screenY) < 3) return;
    grab.moved = true;
    window.emma.movePill(next);
  };
  const up = () => {
    const grab = drag.current;
    drag.current = undefined;
    if (grab && !grab.moved) window.emma.expandPill();
  };
  return <button
    type="button"
    className={`status-pill ${status} ${leaving ? "leaving" : ""}`}
    title={label}
    aria-label={`Emma — ${label}. Open the quick thread here`}
    onPointerDown={down}
    onPointerMove={move}
    onPointerUp={up}
  ><Mark /></button>;
}

function Overlay() {
  const { load, error, setError } = useSnapshot();
  const [message, setMessage] = useState(() => localStorage.getItem(OVERLAY_DRAFT_KEY) ?? "");
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(readSettings);
  const [annotationId, setAnnotationId] = useState("");
  const [thumbnail, setThumbnail] = useState("");
  const [attachedApp, setAttachedApp] = useState("");
  const [modelsOpen, setModelsOpen] = useState(false);
  const modelMenu = useRef<HTMLElement>(null);
  const [menuBand, setMenuBand] = useState(0);
  const [mode, setMode] = useState<PermissionMode>(overlayMode);
  const [modesOpen, setModesOpen] = useState(false);
  const modeMenu = useRef<HTMLDivElement>(null);
  const [modeBand, setModeBand] = useState(0);
  const [thread, setThread] = useState<Thread>();
  const [turns, setTurns] = useState<QuickTurn[]>([]);
  const [surface, setSurface] = useState<OverlaySurface>("notch");
  const notch = useMemo(() => readNotchQuery(settings.notchGap), [settings.notchGap]);
  const [grow, setGrow] = useState(0);
  const transcript = useRef<HTMLDivElement>(null);
  const { skills, tools, atItems, folders, files } = useTaskCommands(settings.tools.disabledTools);
  const [servers, setServers] = useState<SlashCommand[]>([]);
  const [caret, setCaret] = useState(0);
  const [slashPick, setSlashPick] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashBand, setSlashBand] = useState(0);
  const slashMenu = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [stream, setStream] = useState<{ text: string; steps: ThreadStep[] }>({ text: "", steps: [] });
  const live = useRef("");
  const liveSteps = useRef<ThreadStep[]>([]);
  const orbs = useNotchSwipe(notch, ISLAND_BOTTOM + grow) && settings.notchCommandsEnabled && surface === "notch";
  const modelKey = settings.notchModel || settings.selectedModel;
  const effort: ThinkingLevel = settings.notchModel ? "" : settings.thinkingLevel;
  const { contextTokens } = useSelectedModel(modelKey);
  const session = useRef(0);
  const running = useRef(0);
  const startRun = useCallback(() => { running.current += 1; window.emma.setOverlayBusy(true); }, []);
  const endRun = useCallback(() => { running.current = Math.max(0, running.current - 1); window.emma.setOverlayBusy(running.current > 0); }, []);
  const rate = latestRate(thread);
  const screenContextId = validScreenContextId(annotationId) ? annotationId : undefined;
  useEffect(() => window.emma.onOverlaySurface(setSurface), []);
  useEffect(() => {
    if (message) localStorage.setItem(OVERLAY_DRAFT_KEY, message);
    else localStorage.removeItem(OVERLAY_DRAFT_KEY);
  }, [message]);
  useEffect(() => {
    let active = true;
    void window.emma.listImportedMcpServers()
      .then((imported: ImportedMcpServer[]) => { if (active) setServers(imported.map((item) => ({ id: item.id, name: item.name, kind: "mcp" as const, detail: `${item.source} · MCP server` }))); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const offDelta = window.emma.onDelta(({ threadId, delta, thinking }) => {
      if (threadId !== live.current || thinking) return;
      setStream((current) => ({ ...current, text: delta ? current.text + delta : "" }));
    });
    const offStep = window.emma.onStep((step) => {
      if (step.threadId !== live.current) return;
      liveSteps.current = [...liveSteps.current.filter((item) => item.toolCallId !== step.toolCallId), step];
      setStream((current) => ({ ...current, steps: liveSteps.current }));
    });
    return () => { offDelta(); offStep(); };
  }, []);
  const startStream = useCallback((threadId: string) => { live.current = threadId; liveSteps.current = []; setStream({ text: "", steps: [] }); }, []);
  const endStream = useCallback(() => { live.current = ""; setStream({ text: "", steps: [] }); }, []);
  const applyMode = useCallback(async (threadId: string) => {
    setThreadMode(threadId, mode);
    await window.emma.request("setThreadModel", { threadId, modelId: settings.notchModel.replace(/^openrouter:/, "") })
      .catch((reason: unknown) => setError(reasonText(reason)));
    await window.emma.setThreadContext({ threadId, folderIds: [], mode, model: modelKey }).catch(() => undefined);
  }, [mode, modelKey, setError, settings]);
  useEffect(() => { setOverlayMode(mode); }, [mode]);
  useEffect(() => window.emma.onNewQuickSession(() => {
    session.current += 1;
    endStream();
    setThread(undefined);
    setTurns([]);
    setBusy(false);
    setError("");
  }), [endStream, setError]);
  useEffect(() => { if (thread) void applyMode(thread.id); }, [applyMode, thread]);
  const slash = busy || slashDismissed ? null : slashQuery(message, caret);
  const slashMatches = slash ? matchCommands(slash.sigil === "@" ? atItems : [...skills, ...servers, ...tools], slash.query).slice(0, MENU_MAX) : [];
  const slashOpen = slash !== null;
  const slashActive = Math.min(slashPick, slashMatches.length - 1);
  const pickCommand = (command: SlashCommand) => {
    if (!slash) return;
    const next = insertCommand(message, slash, command.name);
    setMessage(next.text);
    setSlashPick(0);
    queueMicrotask(() => { input.current?.focus(); input.current?.setSelectionRange(next.caret, next.caret); setCaret(next.caret); });
  };
  const composerKeys = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen) {
      if (event.key === "Escape") { event.preventDefault(); setSlashDismissed(true); return; }
      if (slashMatches.length) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setSlashPick((current) => (Math.min(current, slashMatches.length - 1) + (event.key === "ArrowDown" ? 1 : slashMatches.length - 1)) % slashMatches.length); return; }
        if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); pickCommand(slashMatches[slashActive]); return; }
      }
    }
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
  };
  const send = async (event?: FormEvent, text?: string) => {
    event?.preventDefault();
    const content = (text ?? message).trim();
    if (!content) return;
    if (text === undefined) { localStorage.removeItem(OVERLAY_DRAFT_KEY); setMessage(""); }
    startRun();
    setBusy(true); setError("");
    const mine = session.current;
    setTurns((list) => [...list, { role: "user", content }]);
    let active = thread;
    const previousMessageCount = active?.messages.length ?? 0;
    try {
      if (!active) { active = await window.emma.request<Thread>("createThread"); if (session.current !== mine) return; setThread(active); }
      await applyMode(active.id);
      if (session.current !== mine) return;
      startStream(active.id);
      const named = mentions(content, "/");
      const skill = named.length ? skills.find((item) => named.includes(item.name)) : undefined;
      const attachedSkill = skill ? await window.emma.selectImportedSkill({ id: skill.id, threadId: active.id }).catch(() => undefined) : undefined;
      const paths = mentions(content, "@");
      const picks = atItems.filter((item) => item.pick && paths.includes(item.name)).map((item) => item.pick!);
      const attached = picks.length ? await buildAttachedContext(folders, [], picks, files) : { text: "", images: [] };
      const turn = await window.emma.request<Thread>("sendMessage", {
        threadId: active.id,
        content,
        ...(attached.text ? { attachedContext: attached.text } : {}),
        ...(attached.images.length ? { attachedImages: JSON.stringify(attached.images) } : {}),
        ...(attachedSkill ? { skillAttachmentId: attachedSkill.id } : {}),
        ...(screenContextId ? { screenContextId } : {}),
      });
      if (session.current !== mine) return;
      setThread(turn);
      setTurns((list) => [...list, { role: "assistant", content: latestReply(turn), steps: liveSteps.current }]);
      if (screenContextId) { setAnnotationId(""); setThumbnail(""); setAttachedApp(""); }
      await load();
    } catch (reason) {
      if (session.current !== mine) return;
      const latest = await window.emma.request<Snapshot>("snapshot").catch(() => undefined);
      if (!active || !latest || !hasPersistedPrompt(latest, active.id, previousMessageCount, content)) {
        localStorage.setItem(OVERLAY_DRAFT_KEY, content);
        setMessage(content);
      }
      await load();
      setError(reasonText(reason));
    } finally {
      endRun();
      if (session.current === mine) { endStream(); setBusy(false); }
    }
  };
  const dictation = useDictation(settings, useCallback((text: string) => setMessage((current) => current ? `${current.trimEnd()} ${text}` : text), []));
  const { listening, working: transcribing, refresh: refreshVoice, start: startVoice, stop: stopVoice } = dictation;
  const dictate = useCallback(async () => {
    if (listening) { await stopVoice(); return; }
    const status = await refreshVoice();
    if (!voiceReady(status, settings)) { window.emma.openWorkspace("voice"); return; }
    await startVoice();
  }, [listening, refreshVoice, settings, startVoice, stopVoice]);
  const runAction = useCallback(async (index: number) => {
    const action = settings.quickActions[index];
    if (!action || busy) return;
    startRun();
    setBusy(true); setError("");
    const mine = session.current;
    setTurns((list) => [...list, { role: "user", content: action.label || action.prompt }]);
    try {
      const created = await window.emma.request<Thread>("createThread");
      await applyMode(created.id);
      if (session.current !== mine) return;
      startStream(created.id);
      const answered = await window.emma.request<Thread>("sendMessage", { threadId: created.id, content: action.prompt, ...(screenContextId ? { screenContextId } : {}) });
      if (session.current !== mine) return;
      setTurns((list) => [...list, { role: "assistant", content: latestReply(answered), steps: liveSteps.current }]);
      if (screenContextId) { setAnnotationId(""); setThumbnail(""); setAttachedApp(""); }
      await load();
    } catch (reason) { if (session.current === mine) setError(reasonText(reason)); }
    finally { endRun(); if (session.current === mine) { endStream(); setBusy(false); } }
  }, [applyMode, busy, endRun, endStream, load, screenContextId, setError, settings, startRun, startStream]);
  useSpaceHold(settings.voiceHoldMs, dictation.ready && !busy && !transcribing && !message.trim(), dictation);
  useEffect(() => { const listener = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && /^[123]$/.test(event.key)) { event.preventDefault(); void runAction(Number(event.key) - 1); } }; addEventListener("keydown", listener); return () => removeEventListener("keydown", listener); }, [runAction]);
  useEffect(() => { const reload = () => setSettings(readSettings()); addEventListener("storage", reload); addEventListener("focus", reload); return () => { removeEventListener("storage", reload); removeEventListener("focus", reload); }; }, []);
  useEffect(() => {
    const show = (status: { id: string; image: string; source?: { application: string } } | null) => {
      setAnnotationId(status?.id ?? "");
      setThumbnail(status?.image ?? "");
      setAttachedApp(status?.source?.application ?? "");
    };
    void window.emma.screenAnnotationStatus().then(show).catch(() => show(null));
    return window.emma.onScreenContext(show);
  }, []);
  useEffect(() => {
    const node = transcript.current;
    if (!node) return;
    const height = Math.min(MAX_TRANSCRIPT, node.scrollHeight + menuBand + modeBand + slashBand + (annotationId ? ATTACHMENT_BAND : 0));
    setGrow(height);
    window.emma.setOverlayHeight(height);
    node.scrollTop = node.scrollHeight;
  }, [turns, busy, stream, menuBand, modeBand, slashBand, annotationId, surface]);
  useEffect(() => {
    const node = modelMenu.current;
    if (!node) { setMenuBand(0); return; }
    const observer = new ResizeObserver(() => setMenuBand(node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, [modelsOpen]);
  useEffect(() => {
    const node = modeMenu.current;
    if (!node) { setModeBand(0); return; }
    const observer = new ResizeObserver(() => setModeBand(node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, [modesOpen]);
  useEffect(() => {
    const node = slashMenu.current;
    if (!node) { setSlashBand(0); return; }
    const observer = new ResizeObserver(() => setSlashBand(node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, [slashOpen]);
  const detached = surface === "popout";
  const overlayStyle ={ "--notch-x": `${notch.left}px`, "--notch-w": `${detached ? 0 : notch.width}px`, "--notch-h": `${detached ? POPOUT_BAR : notch.height}px`, "--island-h": `${ISLAND_BOTTOM + grow}px` } as CSSProperties;
  const working = stream.steps.filter((step) => step.status === "pending" || step.status === "in_progress").at(-1)?.title || "Working";
  const startDrawing = async () => { try { await window.emma.startScreenAnnotation(); } catch (reason) { setError(reasonText(reason)); } };
  const pickModel = useCallback((key: string) => {
    try { setSettings(persistSettings({ ...settings, notchModel: key })); }
    catch (reason) { setError(reasonText(reason)); }
  }, [setError, settings]);
  const act = useCallback(async (method: string, params: Record<string, string> = {}) => {
    try { return await window.emma.request<unknown>(method, params); }
    catch (reason) { setError(reasonText(reason)); return undefined; }
  }, [setError]);
  const clearDrawing = async () => { if (!annotationId) return; await window.emma.clearScreenAnnotation(annotationId); setAnnotationId(""); setThumbnail(""); setAttachedApp(""); };
  const captureScreen = useCallback(async () => {
    try {
      const captured = await window.emma.captureScreenContext();
      setThumbnail(captured.image);
      setAnnotationId(captured.id);
      setAttachedApp(captured.source?.application ?? "");
    } catch (reason) { setError(reasonText(reason)); }
  }, [setError]);
  const savePage = useCallback(async () => {
    if (busy) return;
    startRun();
    setBusy(true); setError("");
    const mine = session.current;
    setTurns((list) => [...list, { role: "user", content: "Save this page" }]);
    try {
      const note = await window.emma.keep({ kind: "page" });
      if (session.current !== mine) return;
      setTurns((list) => [...list, { role: "assistant", content: `Saved “${note.title}”${note.tags.length ? ` · ${note.tags.join(" · ")}` : ""}` }]);
    } catch (reason) { if (session.current === mine) setError(reasonText(reason)); }
    finally { endRun(); if (session.current === mine) setBusy(false); }
  }, [busy, endRun, setError, startRun]);
  const runCommand = useCallback((value: string) => {
    if (value === "voice") { void dictate(); return; }
    if (/^[012]$/.test(value)) void runAction(Number(value));
    else if (value === "page") void savePage();
    else if (value === "screen") void captureScreen();
    else if (value === "draw") void window.emma.startScreenAnnotation().catch((reason: unknown) => setError(reasonText(reason)));
    else if (value === "workspace") window.emma.openWorkspace();
  }, [captureScreen, savePage, dictate, runAction, setError]);
  useEffect(() => window.emma.onQuickCommand(runCommand), [runCommand]);
  const started = useRef(false);
  useEffect(() => {
    const command = new URLSearchParams(location.search).get("command");
    if (!command || started.current) return;
    started.current = true;
    runCommand(command);
  }, [runCommand]);
  if (surface === "pill") {
    const state = busy ? "working" : error ? "error" : "done";
    return <StatusPill key={state} status={state} label={busy ? working : error || "Done"} />;
  }
  return <main className={`overlay ${detached ? "detached" : ""}`} style={overlayStyle} role="dialog" aria-label="Emma quick thread">
    <Region name="notch" props={{
      turns, busy, error, stream, status: working, ask: (text: string) => void send(undefined, text),
      open: () => window.emma.openWorkspace(),
    }}>
    <div className={`island ${orbs ? "dimmed" : ""}`}>
      <header className="island-bar"><div className="brand"><EmmaMark className="blinks" /><strong>Emma</strong></div><span className="island-housing" /><span className="island-status"><i /> {listening ? "Listening" : transcribing ? "Transcribing" : busy ? working : "Quick thread"}</span></header>
      <div className="island-body">
        {annotationId && <div className="annotation-chip">{thumbnail && <img src={thumbnail} alt={attachedApp ? `Screen capture of ${attachedApp}` : "Screen capture"} title={attachedApp} />}<button type="button" onClick={() => void clearDrawing()} aria-label="Discard screen markup">×</button></div>}
        <form onSubmit={(event) => void send(event)}><label className="sr-only" htmlFor="quick-message">Ask Emma</label><textarea ref={input} autoFocus disabled={busy} id="quick-message" value={message} role="combobox" aria-expanded={slashOpen} aria-controls="island-slash-menu" aria-autocomplete="list" onChange={(event) => { setMessage(event.target.value); setCaret(event.target.selectionStart ?? event.target.value.length); setSlashDismissed(false); setSlashPick(0); }} onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)} onKeyDown={composerKeys} placeholder="Ask Emma anything…" rows={1} /><div className="overlay-actions"><button type="button" onClick={() => void startDrawing()} disabled={busy} title="Draw yellow highlights over the screen" aria-label="Draw on screen">✎</button><button type="button" className={listening ? "voice-live" : ""} onClick={() => void dictate()} disabled={busy || transcribing} title={dictation.ready ? listening ? "Stop listening" : `Dictate — or hold space for ${settings.voiceHoldMs}ms` : `${dictation.blocker} — set voice up in the workspace`} aria-label={listening ? "Stop listening" : "Dictate"}>●</button><button className="send" disabled={busy || !message.trim()} aria-label="Send">{busy ? "···" : <SendIcon />}</button></div></form>
        {(error || dictation.error) && <button className="overlay-error" onClick={() => { setError(""); dictation.setError(""); }}>{error || dictation.error} ×</button>}
      </div>
      {slashOpen && <section className="source-popover slash-menu" ref={slashMenu} id="island-slash-menu" role="listbox" aria-label={slash?.sigil === "@" ? "Artifacts, saved notes and files" : "Built-in tools, skills and MCP servers"}>
        {slashMatches.map((item, index) => <button type="button" role="option" aria-selected={index === slashActive} className={`slash-row ${index === slashActive ? "active" : ""}`} key={`${item.kind}-${item.id}`} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setSlashPick(index)} title={item.detail} onClick={() => pickCommand(item)}><strong>{slash?.sigil ?? "/"}{item.name}</strong><em className="slash-kind" data-kind={item.kind}>{KIND_LABELS[item.kind]}</em><small>{item.detail}</small></button>)}
        {!slashMatches.length && <p className="slash-empty">Nothing matches “{slash?.query}”. {slash?.sigil === "@" ? "Artifacts, saved notes and the files of granted folders appear here." : "Built-in tools, imported skills and MCP servers appear here."}</p>}
      </section>}
      <div className="island-thread" ref={transcript}>
        {turns.map((turn, index) => <Fragment key={index}>
          <p className={turn.role}><b>{turn.role === "assistant" ? "Emma" : "You"}</b>{turn.content}</p>
          {turn.steps?.length ? <Steps steps={turn.steps} /> : null}
          {turn.choices?.length ? <div className="turn-choices">{turn.choices.map((choice) => <button type="button" key={choice.label} disabled={busy} onClick={choice.run}>{choice.label}</button>)}</div> : null}
        </Fragment>)}
        {busy && <><p className="assistant"><b>Emma</b>{stream.text || "···"}</p><Steps steps={stream.steps} /></>}
        {turns.length >= MIGRATE_AFTER && <button type="button" className="island-migrate" onClick={() => window.emma.openWorkspace()}>Getting long — continue in the full app →</button>}
      </div>
      {modelsOpen && <ModelMenu ref={modelMenu} close={() => setModelsOpen(false)} act={act} busy={busy} onSettingsChanged={setSettings} onManage={() => window.emma.openWorkspace()} pinned={settings.notchModel ? { key: settings.notchModel, onPick: pickModel } : undefined} />}
      {modesOpen && <ModeMenu ref={modeMenu} mode={mode} setMode={setMode} close={() => setModesOpen(false)} />}
      <footer className="island-foot">
        <div className="mode-picker" data-mode={mode}><ModeTrigger mode={mode} open={modesOpen} onToggle={() => { setModesOpen((open) => !open); setModelsOpen(false); }} /></div>
        <button type="button" className="model-button" disabled={busy} aria-haspopup="dialog" aria-expanded={modelsOpen} aria-label={`Select model, currently ${modelKeyLabel(settings, modelKey)}${modelKeyTag(modelKey) ? ` · ${modelKeyTag(modelKey)}` : ""}${effort ? ` · thinking ${THINKING_LABELS[effort]}` : ""}`} onClick={() => { setModelsOpen((open) => !open); setModesOpen(false); }}><BrandIcon brand={modelKeyBrand(settings, modelKey)} className="model-brand" /><span className="model-label">{modelKeyLabel(settings, modelKey)}</span>{modelKeyTag(modelKey) && <em className={`model-route ${modelKeyTag(modelKey) === "Local" ? "local" : "remote"}`}>{modelKeyTag(modelKey)}</em>}<ThinkingTag level={effort} /><span aria-hidden="true">▾</span></button>
        <span className="island-stats"><span title="Context window of the selected model">{contextTokens ? `${Math.round(contextTokens / 1000)}K ctx` : "— ctx"}</span><span title="Output tokens per second of the last answer">{rate ? `${rate} tok/s` : "— tok/s"}</span></span>
      </footer>
    </div>
    </Region>
    <div className={`command-orbs ${orbs ? "open" : ""}`}>{settings.quickActions.map((action, index) => <button key={index} onClick={() => void runAction(index)} disabled={busy} title={action.prompt}><span className="orb" aria-hidden="true"><kbd>⌘{index + 1}</kbd></span>{action.label}</button>)}</div>
  </main>;
}

export default App;
