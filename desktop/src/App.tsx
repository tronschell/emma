import { Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type DragEvent as ReactDragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import type { AgentImportSource, ArtifactBlock, Connection, CredentialSummary, HeldAttachment, ImportedMcpServer, ImportedSkill, ToolTarget, KnowledgePage, Message, ModelModality, OpenRouterCatalog, OverlaySurface, PageClip, PageVersion, ScheduledJob, Snapshot, Thread } from "./types";
import { describeRun, describeTrigger, parseVariables, parseWorkflow, runWorkflow, triggerProblem } from "../shared/workflow";
import { PluginsView } from "./plugins";
import { PromptField, TriggerPicker, useTaskCommands, WorkflowGraph } from "./schedule";
import { plural } from "./plural";
import { zoned } from "./dates";
import { nested, threadDepth, threadLabel } from "./threads";
import { comboKeybind, DEFAULT_HOLD_MS, holdKeybind, HOLD_DURATIONS, HOLD_KEYS, keybindLabel, keybindProblem, KEYBIND_ACTIONS, normalizeAccelerator, type Keybind, type KeybindAction, type Keybinds } from "../shared/settings";
import { canRemoveLocalModel, tagName, thinkingStops, type ThinkingLevel, type NotchConcurrency, CURSOR_COMMANDS, FREE_ROUTER_KEY, FREE_ROUTER_MODELS, freeRouterChain, MAX_EXPERIMENT_STEPS, type HarnessExperiments, FONT_CHOICES, fontStack, cursorCommandGlyphs, cursorCommandNames, defaultSettings, forgetLocalModel, freeModels, isEnvName, MAX_CURSOR_ORBS, MAX_FAVORITE_MODELS, MAX_SECRET_CHARS, MAX_SYSTEM_PROMPT_CHARS, MAX_VERIFIER_SYSTEM_CHARS, defaultAdvisorSystem, defaultVisionSystem, defaultVerifierSystem, defaultTaggerSystem, verifierFromKey, verifierKey, migrateQuickActionDestinations, OPENROUTER_CHAT_ENDPOINT, providerCredentials, resolveQuickActionDestination, toggleFavoriteModel, validateSettings, WEB_SEARCH_PROVIDERS, webSearchCredentials, webSearchProvider, type CursorCommand, type FontChoice, type LocalModelProfile, type ToolSettings, type UserSettings, type VerifierSettings, type WebSearchProvider, type WebSearchSettings } from "../shared/settings";
import { TOOL_CATALOG } from "../shared/permissions";
import { defaultPaneLayout, NAV_VIEWS, ordered, validatePaneLayout, type PaneLayout } from "./layout";
import { DndContext, MeasuringStrategy, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { hasPersistedPrompt } from "./drafts";
import { dropQueued, groupBlocks, pairBlocks, sendTurn, takeDraft, thinkingOf, useRun, withoutThinking, wrote, type Block } from "./runs";
import { splitThinking } from "../shared/thinking";
import { brandForConnection, brandForImporter, brandForModel, brandForProvider, providerBrands, type BrandDefinition } from "./brands";
import { DEFAULT_SYSTEM_PROMPT, forkPreset, MAX_PROMPTS, MAX_PROMPT_NAME_CHARS, MODEL_FAMILIES, newPresetId, promptApplies, promptSegments, PROMPT_VARIABLES, type PromptPreset } from "../shared/prompts";
import { validScreenContextId } from "../shared/screen-context";
import { CAPTURE_MODEL, isRawClip, pageForUrl } from "../shared/knowledge";
import { highlightSegments, insertCommand, KIND_LABELS, matchCommands, mentions, MENU_MAX, slashQuery, type SlashCommand } from "../shared/slash";
import { pickKey, type ContextPick, type FolderFile, type FolderGrant } from "../shared/folders";
import { charLabel, CHARS_PER_TOKEN, type ContextUse } from "../shared/usage";
import { formatDuration } from "../shared/trace";
import { ContextBarSettings, ContextWidgets, readContextPage, useContextLedger, useThreadCalls, writeContextPage } from "./context-bar";
import { MAX_CONTEXT_PAGES, type ContextPage } from "../shared/context-bar";
import { documentGroups, parseMarkdown, type Inline } from "./document";
import { Markdown } from "./markdown";
import { RunContext } from "./run-block";
import { openPreview, PreviewHost } from "./preview";
import { ArtifactCard, ArtifactsView } from "./artifacts";
import { Region } from "./regions";
import { ARTIFACT_LABELS, artifactWritten, type Artifact, type ArtifactMeta } from "../shared/artifacts";
import { atCommands, AUTO_FILE_EXAMPLES, autoFileStatus, autoTagStatus, buildAttachedContext, cachedBlocks, contextCommands, handTags, overlayMode, pickLabel, recordUses, rememberBlocks, rememberTurnAttachments, setOverlayMode, setThreadFolders, setThreadMode, setThreadTag, threadBreakdown, threadExperiments, threadFolderMap, threadFolders, threadMode, threadTags, threadUses, toolCommands, turnAttachments, UNFILED_CATEGORY, type TurnAttachment } from "./context";
import { AgentPanel, AgentRail, BackgroundRail, ChangeCount, ChangesPanel, ModeMenu, ModePicker, ModeTrigger, PermissionPrompt, TabStrip, ThreadCard, useAgents, type AgentTab } from "./agents";
import { FileMark, GitPanel, useGit } from "./git";
import { OpenIn } from "./editors";
import { worktreeName, type GitSnapshot } from "../shared/git";
import { BrandIcon, ClipIcon, EmmaMark, InfoDot, ToolIcon } from "./icons";
import { syncImprovements } from "./improvements";
import { CliDock, CliPanel, useCliRuns, useTailScroll } from "./cli";
import { cliHarness } from "../shared/cli";
import { diffStat, sentByThread, spawnedThread, type AgentStatus, type FileChange, type LiveAgent, type ThreadStep } from "../shared/agents";
import { DEFAULT_PERMISSION_MODE, type PermissionMode } from "../shared/permissions";
import { SETUP_PERMISSIONS, type SetupPermission, type SetupStatus } from "../shared/setup";
import { CLEANUP_INSTALL, HOLD_TO_TALK_MS, LLAMA_INSTALL, LLAMA_SITE_URL, SPEECH_INSTALL, SPEECH_MODEL, SPEECH_MODEL_URL, VOICE_MODEL, VOICE_MODEL_URL, voiceReady, type TranscriptionEngine } from "../shared/voice";
import { useDictation, useSpaceHold } from "./voice";
import { reasonText } from "./errors";
import { takeBootSnapshot } from "./boot";

const empty: Snapshot = { threads: [], knowledgeBases: [], pages: [], scheduledJobs: [], researchJobs: [], warnings: [] };
const SNAPSHOT_REFRESH_MS = 60_000;
const AgentView = lazy(() => import("./AgentView"));
const ResearchView = lazy(() => import("./research"));
const ChartArtifact = lazy(() => import("./chart-artifact"));
const dateFormat = zoned({ month: "short", day: "numeric", year: "numeric" });
const timeFormat = zoned({ hour: "numeric", minute: "2-digit" });
const date = (value: string) => dateFormat(new Date(value));
const time = (value: string) => timeFormat(new Date(value));

function Mark() {
  return <span className="mark" aria-hidden="true">◇</span>;
}

/// What a thread is doing, in the one place you can see threads you are not
/// reading. `LiveAgent.status` already separates a turn that is working from one
/// stuck on a permission ask — the sidebar is where that difference is worth
/// money, because it is the only view onto the other threads.
const STATUS_TITLES: Record<string, string> = { running: "Running", waiting: "Waiting for you", failed: "Something went wrong", idle: "Idle" };

function ThreadStatus({ status }: { status?: AgentStatus }) {
  const state = status === "running" || status === "waiting" || status === "failed" ? status : "idle";
  return <span className={`thread-status ${state}`} title={STATUS_TITLES[state]} role="img" aria-label={STATUS_TITLES[state]} />;
}

/// A message's rendered content. Shared by a landed turn and a streaming one so
/// the text does not shift when the host's copy replaces the streamed buffer.
/// Markdown — tables and fences arrive as tables and fences. The scratchpad is
/// not here: it is one row for the whole turn, drawn by `Thought`.
function Body({ content }: { content: string }) {
  return <div className="message-body"><Markdown text={content} /></div>;
}

/// `48s`, `3m 29s` — whole seconds, because the live row ticks once a second and
/// `formatDuration`'s hundredths would only flicker there.
const clock = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)}s` : formatDuration(ms);

/**
 * A turn's reasoning as one row, rather than one caret per burst.
 *
 * The harness thinks between every tool call, so a caret drawn where each burst
 * happened stacked a dozen of them down a single turn and left the answer to be
 * found among them. It is one train of thought and it reads as one line: the
 * clock and the weight while it runs, what it cost once it lands, open either way.
 */
function Thought({ text, ms, tokens, live }: { text: string; ms: number; tokens: number; live?: string }) {
  if (!text.trim() && !live) return null;
  return <details className="thinking" data-live={live ? "true" : undefined}>
    <summary>{live
      ? `${clock(ms)} · ${charLabel(tokens)} tokens · ${live}`
      : ms > 0 ? `Thought for ${clock(ms)} · ${charLabel(tokens)} tokens` : `Thought · ${charLabel(tokens)} tokens`}</summary>
    <p>{text}</p>
  </details>;
}

/// The scratchpad's own weight, which nothing reports: the turn's token count is
/// the answer's too, and this row is not about the answer.
const thoughtTokens = (text: string) => Math.round(text.length / CHARS_PER_TOKEN);

/// The turn's text on the clipboard. The scratchpad is left behind: what a
/// reader means by "this message" is the answer, not the model's notes.
function CopyTurn({ text, label = "Copy message" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);
  // A mark, not a word: the meta line is already three readouts wide, and the
  // tick is the whole confirmation — the label carries it for a screen reader.
  return <button type="button" className="message-copy" aria-label={copied ? "Copied" : label} title={copied ? "Copied" : label} onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(() => undefined)}>
    {copied
      ? <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 8.5 6 12l7.5-8" /></svg>
      : <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" /><path d="M10.5 3.5v-1h-8v8h1" /></svg>}
  </button>;
}

/// The transcript's spine: one tick per question you asked, riding the left edge.
/// Hovering a tick shows what was asked there, clicking it jumps to that turn —
/// a long thread's table of contents, in the width of a scrollbar.
function TranscriptRail({ messages, scroller }: { messages: Message[]; scroller: React.RefObject<HTMLDivElement | null> }) {
  const [peek, setPeek] = useState<number>();
  // User turns only: they are where the thread changes subject, and a tick for
  // every message would be a solid line on any thread worth navigating.
  const marks = messages.flatMap((item, index) => item.role === "user" ? [{ item, index }] : []);
  if (marks.length < 2) return null;
  return <nav
    className="rail"
    aria-label="Jump to a message"
    // The ticks stay 2px and the air between them gives, so the rail is the same
    // height at three turns and at fifty rather than growing past the pane.
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

function Turn({ item, blocks, index, attached }: { item: Message; blocks?: Block[]; index?: number; attached?: TurnAttachment[] }) {
  // Read off the turn, never off the picker: the picker is where the *next* turn
  // will go, so a thread the user switched models midway through would otherwise
  // claim every earlier answer came from whatever is selected now.
  const model = item.generation?.model ?? "";
  // A user turn is only the user's when nobody else put it there: a thread that
  // messaged this one is named instead, because "You" is the one thing the user
  // cannot tell apart from something they typed themselves.
  const { from, body } = sentByThread(item.content);
  // Above the turn, not inside it: a turn that thought between every tool call
  // has its reasoning in a dozen places, and one row for all of it is the only
  // arrangement that does not push the answer off the screen.
  const thought = item.role !== "assistant" ? "" : blocks?.length ? thinkingOf(blocks) : splitThinking(body).thinking;
  return <article className={`message ${item.role}`} data-turn={index}>
    {thought && <Thought text={thought} ms={item.generation?.durationMilliseconds ?? 0} tokens={thoughtTokens(thought)} />}
    {/* The files the turn was handed, above the words it was handed them with —
        the composer's own tiles, minus the × that took one back. Clicking one
        opens the same modal a path in a reply opens. */}
    {!!attached?.length && <div className="message-tray">{attached.map((file) => <button
      type="button" className="composer-tile" key={file.path} title={file.name} aria-label={`Open ${file.name}`}
      onClick={() => openPreview(file.path, file.name)}>
      {file.thumbnail ? <img src={file.thumbnail} alt="" /> : <><FileMark path={file.name} /><small>{file.name}</small></>}
    </button>)}</div>}
    {blocks?.length ? <Blocks blocks={blocks} /> : <Body content={item.role === "assistant" ? splitThinking(body).answer : body} />}
    <footer className="message-meta"><span>{item.role === "user" ? from ? `thread ${from} messaged:` : "You" : "Emma"}</span><CopyTurn text={item.role === "assistant" ? splitThinking(item.content).answer : body} />{model && <span className="message-model" title={`Answered by ${model}`}><BrandIcon brand={brandForModel(model)} className="message-model-mark" /><span>{model}</span></span>}<time dateTime={item.timestamp}>{time(item.timestamp)}</time>{item.generation && <span className="generation-rate" title={`${item.generation.outputTokens} output tokens in ${item.generation.durationMilliseconds} ms`}>{Math.round(item.generation.outputTokens / item.generation.durationMilliseconds * 1000).toLocaleString()} tok/s</span>}</footer>
  </article>;
}

/**
 * A turn in the order it happened, rather than all of its words followed by all of
 * its tool calls. Consecutive calls fold into one list, so a burst of them reads as
 * a block of work and not as a stack of one-row lists — and a call made after a line
 * of narration opens its own list under that line, because that is where it happened.
 */
function Blocks({ blocks }: { blocks: Block[] }) {
  // Reasoning arrives on its own channel here, and inline as <think> in the text.
  // Neither is drawn in place: `Thought` has already hoisted both to one row.
  return <>{groupBlocks(withoutThinking(blocks), STEPS_SHOWN).map((block, index) => block.kind === "steps"
    ? <Steps key={index} steps={block.steps} shown={block.keep} />
    // The same recharts component the knowledge pages draw with, and the same
    // lazy module, so a thread that never asks for a picture never loads it.
    // No card, no title bar, nothing to open: it is not a thing, it is a picture.
    : block.kind === "visual"
      ? <Suspense key={index} fallback={null}><ChartArtifact {...block.visual} /></Suspense>
      : block.kind === "notice"
        ? <ContextNotice key={index} text={block.text} />
        : <Body key={index} content={block.text} />)}</>;
}

/// A Harness lever rewriting the window mid-turn, said where it happened. Emma
/// never edits the context behind the user's back — this only ever appears
/// because they switched a lever on — so it carries the way back to the switch.
function ContextNotice({ text }: { text: string }) {
  return <p className="context-notice">
    <span>{text}</span>
    <button type="button" onClick={() => openSettingsPage("harness")}>Change in settings</button>
  </p>;
}

/// How a call reads in one line, and in the caret above the ones it hides.
function stepLabel(step: ThreadStep): string {
  if (step.edit) return `Edited ${step.edit.path.split("/").pop() ?? step.edit.path}`;
  return step.title || step.kind;
}

/// Rows kept visible before the rest fold into the caret: none, so a turn's tool
/// calls cost the transcript one line and that line is the caret. A turn that made
/// a single call still draws it plainly — folding one row away would cost a row to
/// say so — so the caret itself starts at two.
const STEPS_SHOWN = 0;

/// What the agent is doing, while it does it. Reasoning models spend most of a
/// turn silent, and a run that only ever prints its conclusion reads as a
/// black box — so the scratchpad and every tool call are shown as they arrive.
///
/// Up to a point: a long run's call list is the least re-read thing in the
/// transcript and it pushes the answer off the screen while it grows. So they
/// collapse into one caret naming the call happening right now, and the list is
/// that one line whether the turn made two calls or forty.
function Steps({ steps, shown: keep = STEPS_SHOWN }: { steps: ThreadStep[]; shown?: number }) {
  if (!steps.length) return null;
  const folded = steps.length > keep + 1;
  const shown = folded ? steps.slice(0, keep) : steps;
  const rest = steps.slice(shown.length);
  const latest = rest.at(-1);
  return <>
    {shown.length > 0 && <ol className="steps">{shown.map((step) => <Step key={step.toolCallId} step={step} />)}</ol>}
    {latest && <details className="steps-more">
      {/* Keyed by the call it names, so React swaps the element and the text
          fades in on the change rather than jumping. */}
      <summary><CaretIcon /><span key={latest.toolCallId} className="steps-latest">{stepLabel(latest)}</span><span className="steps-count">{rest.length} more</span></summary>
      <ol className="steps">{rest.map((step) => <Step key={step.toolCallId} step={step} />)}</ol>
    </details>}
  </>;
}

function Step({ step }: { step: ThreadStep }) {
  const made = artifactWritten(step);
  // A spawned thread is a place, not a sentence about one: the card is live, so
  // the user watches it work and can steer it without leaving this transcript.
  const started = spawnedThread(step.output);
  return <li className={`step ${step.status}`}>
    {step.kind === "verifier" ? <Review step={step} />
      // A write says what it did to the file rather than echoing the arguments it
      // was called with: the name, and the two numbers that say how big the edit
      // was. The diff itself is one click away in Changes, which is where every
      // other view of it already lives.
      : step.edit ? <>
        <PencilIcon />
        <span className="step-title">{stepLabel(step)}</span>
        <span className="step-diff"><b>+{step.edit.added}</b><i>-{step.edit.removed}</i></span>
        <button type="button" className="step-open" title={`${step.edit.path} — open the diff`} aria-label={`Open the diff for ${step.edit.path}`} onClick={openChangesPanel}><CaretIcon /></button>
      </> : <>
        <ToolIcon />
        <span className="step-title">{stepLabel(step)}</span>
        {/* The card below says what landed, in full; the usual one-line echo of
            the result would only repeat its own id back at the reader. */}
        {step.output && !made && !started && <span className="step-output">{step.output.replace(/\s+/g, " ").slice(0, 120)}</span>}
      </>}
    {made && <ArtifactCard id={made} onOpen={openArtifactsPage} />}
    {started && <ThreadCard id={started.id} title={started.title} onOpen={openThreadPage} />}
  </li>;
}

/// Turns to point down when its `<details>` opens, and sideways on an edit row —
/// CSS rotates the one mark rather than this file carrying two.
function CaretIcon() {
  return <svg className="caret" viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" /></svg>;
}

/// A write, as against the wrench every other call wears.
function PencilIcon() {
  return <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11.2 2.3 13.7 4.8 5.4 13H2.9v-2.5z" /><path d="M9.7 3.8l2.5 2.5" /></svg>;
}

/// The diff behind an edit row: the Changes tab, which already draws it and can
/// revert it. Dispatched rather than passed down for the same reason the artifact
/// card's opener is — every row in every reply would otherwise carry the prop.
const OPEN_CHANGES_EVENT = "emma:open-changes";
const openChangesPanel = () => dispatchEvent(new Event(OPEN_CHANGES_EVENT));


/// Clicking an artifact in the transcript opens it on the Artifacts page. An
/// event rather than a callback for the same reason the file preview uses one:
/// every card in every reply would otherwise thread a prop up to App.
const OPEN_ARTIFACTS_EVENT = "emma:open-artifacts";
const openArtifactsPage = (id: string) => dispatchEvent(new CustomEvent(OPEN_ARTIFACTS_EVENT, { detail: id }));

/// Opening a spawned thread from its card in the transcript, the same way and for
/// the same reason: the card is drawn several components down from the one that
/// holds which thread is open.
const OPEN_THREAD_EVENT = "emma:open-thread";
const openThreadPage = (id: string) => dispatchEvent(new CustomEvent(OPEN_THREAD_EVENT, { detail: id }));

/// And the same door onto a settings page, for a transcript that has to point at
/// the switch behind something it just did.
const OPEN_SETTINGS_EVENT = "emma:open-settings-page";
const openSettingsPage = (page: SettingsPage) => dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: page }));

/// Auto mode's review, in the transcript where the dialog would have been. It
/// opens in place onto everything the verifier was sent and everything it said:
/// an approval nobody can read afterwards is a worse deal than the question it
/// replaced, so the whole exchange is one click away rather than gone.
function Review({ step }: { step: ThreadStep }) {
  return <details className="step-review">
    <summary><ToolIcon /><span className="step-title">{step.title}</span><span className="step-output">{(step.output ?? "").replace(/\s+/g, " ").slice(0, 120)}</span></summary>
    <b>Context sent to the verifier</b>
    <pre>{step.input || "(nothing)"}</pre>
    <b>What the verifier answered</b>
    <pre>{step.output || "(nothing)"}</pre>
  </details>;
}

/// The turn as it arrives. Same blocks as a landed one, with the reasoning row
/// pinned under them rather than above: while a turn runs, that row is its status
/// line — how long it has been at it, what it has spent, what it is doing — and a
/// status line belongs at the end of what it is reporting on. It fills as the
/// scratchpad streams, so it is also the way to read the thinking mid-turn.
function Streaming({ blocks, threadId }: { blocks: Block[]; threadId: string }) {
  const agent = useAgents().find((item) => item.threadId === threadId);
  // Elapsed is the only readout that moves while a turn thinks, and nothing else
  // on screen changes to carry it, so it gets a clock of its own.
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

/// Text the next composer to mount opens with. Editing an artifact creates a
/// thread and switches view before that composer exists, so the question cannot
/// be handed over as a prop — it waits here until that thread's composer mounts.
///
/// Addressed by thread id rather than just left lying about, because ThreadView
/// mounts twice on a new thread: once keyed `undefined`, before the snapshot has
/// caught up, and again on the real id. A seed the first of those could take is a
/// seed the second never sees.
let composerSeed = { threadId: "", text: "" };
const seedComposer = (threadId: string, text: string) => { composerSeed = { threadId, text }; };
const takeComposerSeed = (threadId: string) => composerSeed.threadId === threadId ? composerSeed.text : "";

/// How many artifacts there are, for the badge on the nav row. Its own reader
/// rather than a field on the snapshot: artifacts live in a folder main owns,
/// not in the host's store, and a turn that writes one says so on its own channel.
function useArtifactCount() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const read = () => void window.emma.listArtifacts().then((list) => setCount(list.length)).catch(() => undefined);
    read();
    return window.emma.onArtifactsChanged(read);
  }, []);
  return count;
}


const LAYOUT_KEY = "emma.layout.v2";
const IMPORTS_SEEN_KEY = "emma.importsSeen.v1";
const SETUP_SEEN_KEY = "emma.setupSeen.v1";
/** The host calls that sit behind a model until it has written a whole document. */
const SLOW_METHODS = new Set(["analyzePage", "chatAboutPage", "revisePageDocument"]);
const readLayout = () => {
  try { return validatePaneLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null"), window.innerWidth); }
  catch { return defaultPaneLayout; }
};

function ResizeHandle({ label, value, min, max, direction = 1, onChange }: { label: string; value: number; min: number; max: number; direction?: 1 | -1; onChange: (value: number) => void }) {
  const drag = useRef<{ x: number; value: number } | undefined>(undefined);
  const clamp = (next: number) => Math.min(max, Math.max(min, Math.round(next)));
  const key = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    onChange(clamp(value + (event.key === "ArrowRight" ? 8 : -8) * direction));
  };
  return <button type="button" className="resize-handle" role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} onKeyDown={key} onPointerDown={(event: ReactPointerEvent<HTMLButtonElement>) => { drag.current = { x: event.clientX, value }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (drag.current) onChange(clamp(drag.current.value + (event.clientX - drag.current.x) * direction)); }} onPointerUp={() => { drag.current = undefined; }} />;
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

/// Always-on-top proof that a run is live. The agent clicks in other apps, so this is
/// the only surface the user is guaranteed to see while it works.
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
  // ponytail: a fixed pause is what marks "done drawing"; make it a setting if it fights multi-stroke markup.
  const endStroke = () => {
    if (!drawing.current) return;
    drawing.current = false;
    clearTimeout(settle.current);
    settle.current = setTimeout(() => void finish(), SETTLE_MS);
  };
  // The screen under the strokes is captured here, once the drawing settles.
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
  const [pageId, setPageId] = useState("");
  const pinSelections = useCallback((next: Snapshot) => {
    const live = next.threads.filter((item) => !item.archivedAt && !item.parentThreadId);
    setThreadId((current) => live.some((item) => item.id === current) ? current : (live[0]?.id ?? ""));
    // The board is the resting state: a refresh never opens a document for you.
    setPageId((current) => next.pages.some((item) => item.id === current) ? current : "");
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
  // A project is a folder on this Mac: the sidebar lists one group per granted
  // folder, and a thread is filed under the folder it works out of. Re-read when
  // a grant is added or a composer attaches one.
  const [grants, setGrants] = useState<FolderGrant[]>([]);
  const [tags, setTags] = useState(threadTags);
  const [filedFolders, setFiledFolders] = useState(threadFolderMap);
  useEffect(() => {
    const reload = () => { void window.emma.listFolders().then(setGrants).catch(() => undefined); setTags(threadTags()); setFiledFolders(threadFolderMap()); };
    reload();
    addEventListener("emma-thread-folders-changed", reload);
    // Tags are the other axis a row is filed on, and they move from three places:
    // the row's own menu, the sweep below, and another window.
    addEventListener("emma-thread-tags-changed", reload);
    return () => { removeEventListener("emma-thread-folders-changed", reload); removeEventListener("emma-thread-tags-changed", reload); };
  }, []);
  // The walkthrough carries the imports step itself, so only a Mac that has already been
  // through it can still be owed the standalone import dialog.
  const [setupOpen, setSetupOpen] = useState(() => !localStorage.getItem(SETUP_SEEN_KEY));
  const [importsOpen, setImportsOpen] = useState(() => !localStorage.getItem(IMPORTS_SEEN_KEY));
  const [layout, setLayout] = useState<PaneLayout>(readLayout);
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("actions");
  const [settings, setSettings] = useState(readSettings);
  const [interactionLocked, setInteractionLocked] = useState(false);
  const agents = useAgents();
  const artifactCount = useArtifactCount();
  /// Which artifact the page should open on, set by a click on a card in the
  /// transcript. Counted as well as named, and the count keys the page: clicking
  /// the same card twice has to reopen it, and the id alone would not have changed.
  const [artifactPick, setArtifactPick] = useState({ id: "", at: 0 });
  useEffect(() => {
    const open = (event: Event) => { setArtifactPick((current) => ({ id: (event as CustomEvent<string>).detail, at: current.at + 1 })); setView("artifacts"); };
    addEventListener(OPEN_ARTIFACTS_EVENT, open);
    return () => removeEventListener(OPEN_ARTIFACTS_EVENT, open);
  }, []);
  // The island hands setup over rather than doing it in the notch: "voice is not set
  // up yet" there arrives here as the page that sets it up. The transcript's own
  // links onto a settings page arrive on the same road, from inside this window.
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
  /// Which tab the thread pane is showing: its own transcript, a subagent's, or
  /// the changes diff. Lives up here because the sidebar rail opens tabs too.
  const [tab, setTab] = useState("thread");
  const actionInFlight = useRef(false);
  const restoredModel = useRef(false);
  // A subagent is a real thread, so it arrives in the snapshot like any other. It
  // belongs to its parent's tab strip, not to the project list, or every delegated
  // call would litter the sidebar with threads nobody opened. A sub thread is the
  // other kind of owned thread — its own main agent — and it is listed, nested
  // under the thread that started it.
  const liveThreads = useMemo(() => snapshot.threads.filter((item) => !item.archivedAt && item.kind !== "subagent"), [snapshot.threads]);
  const archivedThreads = useMemo(() => snapshot.threads.filter((item) => item.archivedAt && item.kind !== "subagent"), [snapshot.threads]);
  const thread = liveThreads.find((item) => item.id === threadId) ?? liveThreads[0];
  const page = snapshot.pages.find((item) => item.id === pageId);
  const uiBusy = busy || interactionLocked;
  // Latest record per thread wins, then subagents escalate onto their parent:
  // a child has no row of its own, and a child stuck on a permission ask is
  // still the user's turn to act on the row they can actually see.
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
  // innerWidth is the viewport Chromium laid the page out at; outerWidth is the
  // window macOS actually gave it, and the two only ever come apart when the page
  // has been drawn past the window's own right edge — the inspector, which lives on
  // that edge, then reads as cut in half. Nothing in here can widen a viewport, so
  // the window is asked for the resize that has always been the fix by hand. Checked
  // on focus as well as on resize: the window this happens to is usually one that
  // was resized while nobody was looking at it, and coming back is when it is seen.
  useEffect(() => {
    let asked = 0;
    const resync = () => {
      // A window nobody can see reports no outer width at all, so it would fail this
      // comparison every time — and dragging one that is minimised or behind another
      // app fixes nothing anyway. It is checked again the moment it comes back, which
      // is when a bad frame is seen. Throttled because the answer arrives as another
      // resize: a window that cannot be put right must not be dragged a pixel forever.
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
  const shellStyle = {
    "--sidebar-width": `${layout.sidebarCollapsed ? 46 : layout.sidebarWidth}px`,
    "--inspector-width": `${layout.inspectorCollapsed ? 30 : layout.inspectorWidth}px`,
  } as CSSProperties;
  // A due run opens an ordinary thread, but it is not one the user started, so it
  // is listed under its job at the foot of the rail rather than in a project.
  const filedThreads = useMemo(() => liveThreads.filter((item) => !item.scheduledJobId), [liveThreads]);
  const scheduledThreads = useMemo(() => liveThreads.filter((item) => item.scheduledJobId), [liveThreads]);
  // A thread's project is the first folder its composer works out of; a thread with
  // no folder attached — a chat-only one — is unfiled. A sub thread has no composer
  // of its own until it is opened, so it is listed under the project of the thread
  // that started it, the same one it inherits when it does open.
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
  /* The tags on the rows, and Emma's own filing into them.
     A tag is the second axis beside the project: the group says which folder the
     thread works out of, the chip says what it is about. */
  const filing = useMemo(() => autoTagStatus(tags), [tags]);
  /* Auto-filing, the thread side of what the knowledge board already does with
     captures: once one hand-applied tag has AUTO_FILE_EXAMPLES threads to learn
     from, a thread that has actually been used and carries no tag gets Emma's
     guess. It runs when a thread first has something in it — and, on the pass
     that crosses the threshold, over everything already sitting there.
     ponytail: one thread per pass, each attempted once per launch, no retry and
     no backoff. Relaunching is the retry. */
  const guessed = useRef(new Set<string>());
  useEffect(() => {
    if (!filing.ready) return;
    const next = liveThreads.find((item) => !tags[item.id] && !guessed.current.has(item.id) && item.messages.some((message) => message.role === "user"));
    if (!next) return;
    guessed.current.add(next.id);
    const said = (item: Thread) => item.messages.filter((message) => message.role === "user").slice(0, 2).map((message) => sentByThread(message.content).body);
    // Only what the user filed themselves is shown as an example: Emma's own
    // guesses would be it marking its own homework.
    const examples = liveThreads.filter((item) => tags[item.id] && !tags[item.id].auto).slice(0, AUTO_FILE_EXAMPLES * 2).map((item) => ({ tag: tags[item.id].tag, text: threadLabel(item) }));
    void window.emma.tagThread({ tagger: settings.tagger, text: [threadLabel(next), ...said(next)].join("\n"), tags: handTags(), examples })
      .then((filed) => { if (filed.tag) setThreadTag(next.id, filed.tag, true); })
      .catch(() => undefined);
  }, [filing.ready, liveThreads, settings.tagger, tags]);
  const search = threadQuery.trim().toLowerCase();
  const visibleProjects = search
    ? projects.map((group) => group.name.toLowerCase().includes(search) ? group : { ...group, threads: group.threads.filter((item) => threadLabel(item).toLowerCase().includes(search) || (tags[item.id]?.tag ?? "").includes(search)) }).filter((group) => group.threads.length)
    : projects;
  const openThread = (id: string) => { setThreadId(id); setView("threads"); };
  // A card in the transcript opens the thread it started. The snapshot may not
  // have that thread yet — it was minted mid-turn — so the list is refreshed on
  // the way in rather than opening onto whatever the sidebar last knew about.
  useEffect(() => {
    const open = (event: Event) => { openThread((event as CustomEvent<string>).detail); void load(); };
    addEventListener(OPEN_THREAD_EVENT, open);
    return () => removeEventListener(OPEN_THREAD_EVENT, open);
  }, [load]);
  /// Removing a project drops the folder grant, nothing else: its threads survive and
  /// re-list under Unfiled. Reconnecting the folder mints a new grant id, so they stay
  /// there rather than snapping back — worth a confirm while there are threads to move.
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
  /// Shift extends from the last plain click inside the same project; ⌘ toggles one.
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
  /// Renaming happens in the row itself: a thread's name is read in the sidebar,
  /// so it is edited there too rather than in a dialog that hides the list.
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
    // A call that waits on a model runs for minutes, and `busy` disables the whole
    // window — the nav, every view, every thread. Taking the app-wide lock for one
    // froze Emma behind a page that was still building. These keep their pending
    // state where they are shown instead, so the rest of the app stays live.
    const holds = !SLOW_METHODS.has(method);
    if (holds) {
      if (actionInFlight.current) { setError("Wait for the current action to finish, then try again."); return undefined; }
      actionInFlight.current = true;
      setBusy(true);
    }
    setError("");
    try {
      const result = await window.emma.request<unknown>(method, params);
      return result;
    } catch (reason) {
      await load();
      setError(reasonText(reason));
    } finally {
      if (holds) {
        actionInFlight.current = false;
        setBusy(false);
      }
    }
  };

  useEffect(() => {
    if (restoredModel.current) return;
    restoredModel.current = true;
    void (async () => {
      // Flipping this recycles the harnesses, so it lands before the model selection does.
      await window.emma.setZeroRetention(settings.requireZeroRetention).catch((reason: unknown) => setError(reasonText(reason)));
      if (settings.selectedModel === "fallback") {
        try {
          if ((JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<UserSettings> | null)?.selectedModel !== "fallback") return;
        } catch { return; }
        await window.emma.request("selectFallbackModel").catch((reason) => setError(reasonText(reason)));
        return;
      }
      try {
        // Emma's own key, not a catalogued model: it re-selects the way the picker does,
        // and throws into the reset below when nothing in the chain is listed any more.
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
          // With the saved stop, or main starts every launch on the model's own
          // default and the slider lies about what the next turn will ask for.
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
        setError(`Saved model unavailable; using local fallback. ${message}${resetFailure ? ` Runtime reset failed: ${resetFailure}` : ""}`);
        const next = persistSettings({ ...settings, selectedModel: "fallback" });
        setSettings(next);
      }
    })();
  }, [settings, setError]);

  // A thread starts in the project it was started from: the row's own folder when
  // it came from a project row, and otherwise the folder the open thread works out
  // of. Without that second half ＋ filed every new thread under Unfiled, however
  // deep inside a project the user was standing when they pressed it.
  const createThread = async (folderId?: string, seed?: string) => {
    const folder = folderId ?? (thread ? projectOf(thread) : "");
    const created = await act("createThread") as Thread | undefined;
    if (!created) return;
    // The composer mounts on this thread next and pushes the attachment to main.
    if (folder) setThreadFolders(created.id, [folder]);
    if (seed) seedComposer(created.id, seed);
    setThreadId(created.id);
    setView("threads");
    await load();
  };
  /// Editing an artifact is a conversation, not a text box: it opens a new thread
  /// with the artifact quoted and the composer ready, so the change is described
  /// rather than typed. The id goes in verbatim because that is what the
  /// `artifact` tool takes — the agent needs no lookup to write the change back.
  const editArtifact = (artifact: Artifact) => createThread(undefined, [
    `Edit the artifact "${artifact.title}" (${ARTIFACT_LABELS[artifact.kind].toLowerCase()}, id \`${artifact.id}\`, v${artifact.version}).`,
    "",
    "Read it first with `artifact {\"action\":\"get\",\"id\":\"" + artifact.id + "\"}`, then write the change back with `update` for a small edit or `rewrite` when most of it changes.",
    "",
    "What I want changed: ",
  ].join("\n"));

  /// Both lists in the rail are the user's to arrange, so both are dragged the same
  /// way: press a row, move 4px, drop it. Under that threshold the press is still a
  /// press — a nav row still opens its page and a folder still toggles.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [draggingProject, setDraggingProject] = useState(false);
  const [navMore, setNavMore] = useState(false);
  const navCounts: Record<string, number> = { threads: snapshot.threads.length, knowledge: snapshot.pages.length, artifacts: artifactCount, agent: 0, scheduled: snapshot.scheduledJobs.length, plugins: 0, research: snapshot.researchJobs.length };
  const navLabels: Record<string, string> = { threads: "Threads", knowledge: "Knowledge base", artifacts: "Artifacts", agent: "Agent", scheduled: "Scheduled", plugins: "Plugins", research: "Autoresearch" };
  const navPages = ordered(NAV_VIEWS.map((id) => ({ id })), layout.navOrder);
  /// The rail opens on the three sections the user dragged to the top and folds the
  /// rest behind one row. The page being read is always drawn, folded or not:
  /// collapsing the list is not a reason for the rail to stop saying where you are.
  const navShown = navMore ? navPages : navPages.filter((item, at) => at < NAV_PINNED || item.id === view);
  /// The move is applied to the full list, never the one on screen: a search hides
  /// groups, and writing the filtered order back would file every hidden folder
  /// behind the visible ones.
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
      {/* Everything a sidebar has to be able to do, and nothing about how this one
          does it: which section is open, the threads to list, and the four verbs.
          A region Emma wrote gets these and renders whatever it likes with them. */}
      <Region name="navbar" props={{
        view, setView, busy: uiBusy,
        threads: liveThreads, projects: visibleProjects, agents,
        counts: { threads: snapshot.threads.length, pages: snapshot.pages.length, artifacts: artifactCount, scheduled: snapshot.scheduledJobs.length, research: snapshot.researchJobs.length },
        threadId: thread?.id, openThread, newThread: () => { setError(""); void createThread(); },
        collapsed: layout.sidebarCollapsed, setCollapsed: (sidebarCollapsed: boolean) => pane({ sidebarCollapsed }),
      }}>
      <aside className={`sidebar ${layout.sidebarCollapsed ? "collapsed" : ""} ${layout.navIcons ? "nav-icons" : ""}`} aria-label="Workspace navigation">
        {/* The window's only drag handle, and the strip the traffic lights sit in — above the wordmark. */}
        <div className="drag-region" />
        {/* Search lives in the brand band as a glyph, left of the rail toggle, and grows into a field in place. */}
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
        {/* Drag a section to move it. The artifact pick is a one-shot command, not a
            level: the nav clears it, or the page would reopen the last-picked
            artifact every time it is entered. */}
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
          // Picking a subagent opens its tab; picking the root just goes to its thread.
          setView("threads");
          if (agent.parentThreadId) { setThreadId(agent.parentThreadId); setTab(agent.threadId); }
          else { setThreadId(agent.threadId); setTab("thread"); }
        }} />
        <BackgroundRail />
        {/* Dragging a folder collapses every group to its own summary row for the
            length of the drag: the folders are what is being arranged, and a rail
            of open groups is a list too tall to see the drop in. */}
        <DndContext sensors={sensors} collisionDetection={closestCenter} measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
          onDragStart={() => setDraggingProject(true)}
          onDragCancel={() => setDraggingProject(false)}
          onDragEnd={(event) => { setDraggingProject(false); dropped(projects, (projectOrder) => pane({ projectOrder }))(event); }}>
        <SortableContext items={visibleProjects.map((group) => group.id)} strategy={verticalListSortingStrategy}>
        <div className="sidebar-projects" data-dragging={draggingProject || undefined}>
          <span className="sidebar-label">Projects</span>
          {selection.length > 0 && <div className="thread-selection"><span className="nav-label">{selection.length} selected</span><button type="button" disabled={uiBusy} onClick={() => void archiveThreads(selection)}>Archive</button><button type="button" onClick={() => setSelection([])} aria-label="Clear selection">×</button></div>}
          {visibleProjects.map((group) => { const limit = threadLimits[group.id] ?? THREAD_PAGE; return <Sortable key={group.id} id={group.id} className="project-sort">{(handle) => <details className="project-group" open><summary {...handle} onContextMenu={(event) => { event.preventDefault(); setProjectMenu({ id: group.id, x: event.clientX, y: event.clientY }); }}><FolderIcon /><span className="nav-label">{group.name}</span>{group.id !== "unfiled" && <button type="button" className="project-new" disabled={uiBusy} aria-label={`New thread in ${group.name}`} title={`New thread in ${group.name}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setError(""); void createThread(group.id); }}>＋</button>}<b>{group.threads.length}</b></summary>{group.threads.slice(0, limit).map((item) => renaming?.id === item.id
            ? <form key={item.id} className="project-thread renaming" onSubmit={(event) => { event.preventDefault(); void renameThread(item.id, renaming.value); }}><ThreadStatus status={threadStatus.get(item.id)} /><input autoFocus value={renaming.value} aria-label="Thread name" onChange={(event) => setRenaming({ id: item.id, value: event.target.value })} onBlur={() => void renameThread(item.id, renaming.value)} onKeyDown={(event) => { if (event.key === "Escape") setRenaming(null); }} /></form>
            : <div className={`project-row ${threadMenu?.id === item.id ? "menu-open" : ""}`} key={item.id}><button type="button" style={{ "--thread-depth": threadDepth(group.threads, item) } as CSSProperties} className={`project-thread ${item.id === thread?.id && view === "threads" && !selection.length ? "active" : ""} ${selection.includes(item.id) ? "selected" : ""}`} title={threadLabel(item)} disabled={uiBusy} onClick={(event) => clickThread(event, group, item.id)} onDoubleClick={() => setRenaming({ id: item.id, value: threadLabel(item) })} onContextMenu={(event) => { event.preventDefault(); setThreadMenu({ id: item.id, x: event.clientX, y: event.clientY }); }}><ThreadStatus status={threadStatus.get(item.id)} /><span className="nav-label">{threadLabel(item)}</span>{tags[item.id] && <em className={`thread-tag ${tags[item.id].auto ? "auto" : ""}`} title={tags[item.id].auto ? `${tags[item.id].tag} · Emma’s guess, right-click to change it` : tags[item.id].tag}>{tags[item.id].tag}</em>}</button><button type="button" className="thread-actions" title="Thread options" aria-label={`Options for ${threadLabel(item)}`} aria-haspopup="menu" aria-expanded={threadMenu?.id === item.id} disabled={uiBusy} onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); setThreadMenu({ id: item.id, x: box.left, y: box.bottom + 2 }); }}><DotsIcon /></button></div>)}{group.threads.length > limit && <button type="button" className="project-more" onClick={() => setThreadLimits((current) => ({ ...current, [group.id]: limit + THREAD_PAGE }))}>Load more ({group.threads.length - limit})</button>}{!group.threads.length && <p className="project-empty">No threads yet</p>}</details>}</Sortable>; })}
          {search && !visibleProjects.length && <p className="project-empty">No threads match that search</p>}
        </div>
        </SortableContext>
        </DndContext>
        {/* Scheduled tasks sit at the foot of the rail: threads Emma opened on a
            timer, filed under the job that opened them rather than in a project. */}
        {snapshot.scheduledJobs.length > 0 && <details className="sidebar-scheduled">
          <summary><HourglassIcon /><span className="nav-label">Scheduled tasks</span><b>{scheduledThreads.length}</b></summary>
          {snapshot.scheduledJobs.map((job) => { const runs = scheduledThreads.filter((item) => item.scheduledJobId === job.id); return <details className="project-group" key={job.id} open><summary><span className="nav-label">{job.title}</span><b>{runs.length}</b></summary>{runs.map((item) => <button key={item.id} type="button" style={{ "--thread-depth": 1 } as CSSProperties} className={`project-thread ${item.id === thread?.id && view === "threads" && !selection.length ? "active" : ""}`} title={`${threadLabel(item)} · ${date(item.createdAt)} ${time(item.createdAt)}`} disabled={uiBusy} onClick={() => openThread(item.id)} onContextMenu={(event) => { event.preventDefault(); setThreadMenu({ id: item.id, x: event.clientX, y: event.clientY }); }}><ThreadStatus status={threadStatus.get(item.id)} /><span className="nav-label">{date(item.createdAt)} · {time(item.createdAt)}</span></button>)}{!runs.length && <p className="project-empty">No runs yet</p>}</details>; })}
        </details>}
        <div className="nav-foot"><span><i /> Agent online</span><button type="button" className={`nav-settings ${layout.navIcons ? "active" : ""}`} title={layout.navIcons ? "Show sections as rows" : "Show sections as icons"} aria-label="Show sections as icons" aria-pressed={layout.navIcons} onClick={() => pane({ navIcons: !layout.navIcons })}><NavIcon view="tiles" /></button><button type="button" data-view="archive" className={`nav-settings nav-archive ${view === "archive" ? "active" : ""}`} title="Archive" aria-label="Archive" aria-pressed={view === "archive"} disabled={uiBusy} onClick={() => setView("archive")}><NavIcon view="archive" /></button><button type="button" data-view="settings" className={`nav-settings ${view === "settings" ? "active" : ""}`} title="Settings" aria-label="Settings" aria-pressed={view === "settings"} disabled={uiBusy} onClick={() => setView("settings")}><NavIcon view="settings" /></button></div>
        {!layout.sidebarCollapsed && <ResizeHandle label="Resize navigation" value={layout.sidebarWidth} min={200} max={340} onChange={(sidebarWidth) => pane({ sidebarWidth })} />}
      </aside>
      </Region>
      <main id="content" className="content">
        {view === "threads" ? <ThreadView key={thread?.id} thread={thread} snapshot={snapshot} busy={uiBusy} act={act} reload={load} agents={agents} tab={tab} setTab={setTab} newThread={() => { setError(""); void createThread(); }} onSendingChange={setInteractionLocked} onModelChanged={setSettings} onManageModels={() => { setView("settings"); setSettingsPage("models"); }} onManageImports={() => { setView("settings"); setSettingsPage("imports"); }} modelKey={settings.selectedModel} modelLabel={modelLabel} modelTag={modelTag} modelBrand={modelBrand} defaultMode={settings.defaultPermissionMode} contextTokens={contextTokens} contextPages={settings.contextPages} onContextPages={(contextPages) => setSettings(persistSettings({ ...settings, contextPages }))} layout={layout} pane={pane} /> : view === "knowledge" ? <PageView key={page?.id} page={page} snapshot={snapshot} act={act} busy={uiBusy} selected={page?.id} onSelect={setPageId} openThread={openThread} /> : view === "artifacts" ? <ArtifactsView key={artifactPick.at} busy={uiBusy} select={artifactPick.id} openArtifact={(artifact) => void editArtifact(artifact)} /> : view === "agent" ? <Suspense fallback={<AgentLoading />}><AgentView snapshot={snapshot} act={act} busy={uiBusy} openThread={openThread} /></Suspense> : view === "scheduled" ? <ScheduledView snapshot={snapshot} act={act} busy={uiBusy} openThread={openThread} /> : view === "plugins" ? <PluginsView busy={uiBusy} /> : view === "research" ? <Suspense fallback={<AgentLoading copy="Loading the autoresearch graph…" />}><ResearchView snapshot={snapshot} act={act} busy={uiBusy} /></Suspense> : view === "archive" ? <ArchiveView threads={archivedThreads} busy={uiBusy} restore={(id) => void setArchived(id, false)} /> : <SettingsView snapshot={snapshot} page={settingsPage} onSelectPage={setSettingsPage} act={act} busy={uiBusy} onModelChanged={setSettings} />}
      </main>
      {(error || snapshot.warnings.length > 0) && <div className="notice" role="status"><button aria-label="Dismiss notice" onClick={() => setError("")}>×</button>{error || snapshot.warnings[0]}</div>}
      {/* The tag field is the whole of manual filing, and the only way back from a
          wrong guess: type over it, or empty it to clear the row. Its datalist is
          the tags already in use, so a set of them stays a set. */}
      {threadMenu && <div className="thread-menu-scrim" onClick={() => setThreadMenu(null)} onContextMenu={(event) => { event.preventDefault(); setThreadMenu(null); }}><menu className="thread-menu" style={{ left: threadMenu.x, top: threadMenu.y }}><form className="thread-menu-tag" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); setThreadTag(threadMenu.id, String(new FormData(event.currentTarget).get("tag") ?? "")); setThreadMenu(null); }}><input name="tag" list="thread-tag-names" autoFocus autoComplete="off" maxLength={32} defaultValue={tags[threadMenu.id]?.tag ?? ""} placeholder="Tag" aria-label="Thread tag" /><datalist id="thread-tag-names">{handTags().map((tag) => <option key={tag} value={tag} />)}</datalist></form><button type="button" disabled={uiBusy} onClick={() => { const item = liveThreads.find((entry) => entry.id === threadMenu.id); setThreadMenu(null); if (item) setRenaming({ id: item.id, value: threadLabel(item) }); }}>Rename</button><button type="button" disabled={uiBusy} onClick={() => void archiveThreads(selection.includes(threadMenu.id) ? selection : [threadMenu.id])}>{selection.includes(threadMenu.id) && selection.length > 1 ? `Archive ${selection.length} threads` : "Archive"}</button></menu></div>}
      {projectMenu && <div className="thread-menu-scrim" onClick={() => setProjectMenu(null)} onContextMenu={(event) => { event.preventDefault(); setProjectMenu(null); }}><menu className="thread-menu" style={{ left: projectMenu.x, top: projectMenu.y }}><ProjectSweep threads={visibleProjects.find((group) => group.id === projectMenu.id)?.threads ?? []} busy={uiBusy} archive={archiveThreads} />{projectMenu.id !== "unfiled" && <button type="button" disabled={uiBusy} onClick={() => forgetProject(projectMenu.id)}>Remove from sidebar</button>}</menu></div>}
      {setupOpen
        ? <SetupDialog close={() => { localStorage.setItem(SETUP_SEEN_KEY, "1"); localStorage.setItem(IMPORTS_SEEN_KEY, "1"); setSetupOpen(false); setImportsOpen(false); }} />
        : importsOpen && <ImportDialog close={() => { localStorage.setItem(IMPORTS_SEEN_KEY, "1"); setImportsOpen(false); }} />}
      <PermissionPrompt agents={agents} />
      {/* One preview for every path the model prints, wherever it was printed. */}
      <PreviewHost />
    </div>
  );
}

const THREAD_PAGE = 6;

const NAV_PINNED = 3;

const SWEEP_DAYS = [7, 30, 90, 180];

/// Clears a project down to what is still current: everything untouched for longer
/// than the chosen span is archived in one pass. It lives in the folder's right-click
/// menu — a row that offers one control on hover offers the ＋, not the trash.
function ProjectSweep({ threads, busy, archive }: { threads: Thread[]; busy: boolean; archive: (ids: string[]) => Promise<void> }) {
  const stale = (days: number) => threads.filter((item) => Date.parse(item.updatedAt) < Date.now() - days * 86_400_000).map((item) => item.id);
  return <>{SWEEP_DAYS.map((days) => { const ids = stale(days); return <button key={days} type="button" disabled={busy || !ids.length} onClick={() => void archive(ids)}>Archive older than {days} days ({ids.length})</button>; })}</>;
}

/**
 * The section marks. One line weight, one 16-grid, one round join across all of
 * them, so the nav reads as one set of drawings rather than a pile of borrowed
 * glyphs — and each says what its page holds: a conversation, a shelf, a written
 * file, a bot, a clock, a plug, an experiment.
 */
function NavIcon({ view }: { view: string }) {
  const paths: Record<string, ReactNode> = {
    threads: <><path d="M13.8 9.2a1.3 1.3 0 0 1-1.3 1.3H5.4l-2.7 2.7V4a1.3 1.3 0 0 1 1.3-1.3h8.5A1.3 1.3 0 0 1 13.8 4z" /><path d="M5.4 5.9h5.2M5.4 8h3.4" /></>,
    knowledge: <><path d="M8 4.4S6.6 3.1 3.2 3.1a.6.6 0 0 0-.6.6v7.6a.6.6 0 0 0 .6.6c3.4 0 4.8 1.3 4.8 1.3s1.4-1.3 4.8-1.3a.6.6 0 0 0 .6-.6V3.7a.6.6 0 0 0-.6-.6C9.4 3.1 8 4.4 8 4.4z" /><path d="M8 4.4v8.8" /></>,
    artifacts: <><path d="M9.3 1.9H4.4a1 1 0 0 0-1 1v10.2a1 1 0 0 0 1 1h7.2a1 1 0 0 0 1-1V5.2z" /><path d="M9.3 1.9v3.3h3.3M5.9 8.4h4.2M5.9 10.9h2.8" /></>,
    agent: <><path d="M8 1.4v2.1" /><rect x="2.9" y="3.5" width="10.2" height="8.9" rx="2.4" /><path d="M1.3 7.3v2.2M14.7 7.3v2.2M6.1 10.2h3.8" /><circle cx="6" cy="7.3" r="0.95" fill="currentColor" stroke="none" /><circle cx="10" cy="7.3" r="0.95" fill="currentColor" stroke="none" /></>,
    scheduled: <><circle cx="8" cy="8" r="5.8" /><path d="M8 4.6V8l2.4 1.6" /></>,
    plugins: <><rect x="4.2" y="6.1" width="7.6" height="7.7" rx="1.4" /><path d="M6.3 6.1V2.5M9.7 6.1V2.5" /></>,
    research: <><path d="M6.4 1.9v4L2.9 11.6a1.2 1.2 0 0 0 1 1.9h8.2a1.2 1.2 0 0 0 1-1.9L9.6 5.9v-4" /><path d="M5.6 1.9h4.8M4.4 9.3h7.2" /></>,
    archive: <><path d="M2.2 3.4h11.6v2.7H2.2z" /><path d="M3.3 6.1v6.1a1 1 0 0 0 1 1h7.4a1 1 0 0 0 1-1V6.1M6.4 8.6h3.2" /></>,
    settings: <><path d="M2.6 4.7h5.8M11.9 4.7h1.5M2.6 11.3h1.5M7.6 11.3h5.8" /><circle cx="9.9" cy="4.7" r="1.6" /><circle cx="5.9" cy="11.3" r="1.6" /></>,
    tiles: <><rect x="2.4" y="2.4" width="4.7" height="4.7" rx="1" /><rect x="8.9" y="2.4" width="4.7" height="4.7" rx="1" /><rect x="2.4" y="8.9" width="4.7" height="4.7" rx="1" /><rect x="8.9" y="8.9" width="4.7" height="4.7" rx="1" /></>,
    more: <path d="M4 6.3 8 10.2l4-3.9" />,
  };
  return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[view]}</svg>;
}

/**
 * One draggable row. The wrapper carries the drag transform so the row inside is
 * whatever it already was — a nav button, a whole project folder — and the handle
 * goes on the part that starts the drag, which is never the part that scrolls.
 */
function Sortable({ id, className, children }: { id: string; className: string; children: (handle: Record<string, unknown>) => ReactNode }) {
  const { setNodeRef, setActivatorNodeRef, listeners, transform, transition, isDragging } = useSortable({ id });
  return <div ref={setNodeRef} className={className} data-dragging={isDragging || undefined} style={{ transform: CSS.Transform.toString(transform), transition }}>
    {children({ ref: setActivatorNodeRef, ...listeners })}
  </div>;
}

/** A project group is a folder on this Mac; the mark says so before its name does. */
function FolderIcon() {
  return <span className="project-folder" aria-hidden="true"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"><path d="M1.8 12.4V4.1a.8.8 0 0 1 .8-.8h3.3l1.5 1.6h6a.8.8 0 0 1 .8.8v6.7a.8.8 0 0 1-.8.8H2.6a.8.8 0 0 1-.8-.8z" /></svg></span>;
}

/** Scheduled runs are threads on a timer; the mark says so before the name does. */
function HourglassIcon() {
  return <span className="project-folder" aria-hidden="true"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round"><path d="M4.2 2.4h7.6M4.2 13.6h7.6M5.4 2.4v2.2L8 8l-2.6 3.4v2.2M10.6 2.4v2.2L8 8l2.6 3.4v2.2" /></svg></span>;
}

/** The row's own menu, same one right-click opens — drawn, since ⋮ is a smudge in a pixel face. */
function DotsIcon() {
  return <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><circle cx="8" cy="3.4" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="8" cy="12.6" r="1.2" /></svg>;
}

function Empty({ copy }: { copy: string }) {
  return <div className="empty"><Mark /><p>{copy}</p></div>;
}

function AgentLoading({ copy = "Reading what Emma's own runs recorded…" }: { copy?: string }) {
  return <div className="content-empty" role="status" aria-live="polite"><Mark /><p>{copy}</p></div>;
}

/** The starting graph for a task written by hand: one agent step on its prompt. */
const NODE_PLACEHOLDER = '[\n  {"id": "collect", "kind": "agent", "text": "Find this week\'s papers", "saveAs": "digest"},\n  {"id": "check", "kind": "if", "text": "{{digest}} is not empty", "next": "write", "otherwise": "end"},\n  {"id": "write", "kind": "agent", "text": "Write up {{digest}}"}\n]';

const NODE_GLYPHS = { agent: "◆", set: "◇", if: "◈" } as const;

/** What a task run left behind, as the next task in the chain will read it. */
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
  // An unattended run is still a full agent turn, so a task carries the same mode
  // picker the composer has: whatever it is saved with is what it fires under.
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
  // The same walk a real run takes, with the turns stood in for: the path, the
  // branches and the variables are real, so a task can be checked before the
  // clock runs it with nobody watching.
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
      {/* Same "/" and "@" grammar as the composer: an unattended run resolves the
          tokens itself when it fires. */}
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

/** The selected task as a graph, on its own: boxes, edges, and whichever step is
    being read. The editor keeps the same steps as a list — this is the map. */
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
  const commands = useTaskCommands(snapshot, readSettings().tools.disabledTools);
  const selected = jobs.find((item) => item.id === picked);
  // "New" is a selection like any other, and so is the state of having no tasks
  // at all: the editor is always on screen, so there is nowhere to be stuck.
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

// Archived threads are discarded 30 days after archiving; see ARCHIVE_RETENTION_SECONDS in crates/core/src/live.rs.
const ARCHIVE_RETENTION_DAYS = 30;

function ArchiveView({ threads, busy, restore }: { threads: Thread[]; busy: boolean; restore: (id: string) => void }) {
  return <section className="scheduled-view"><header><span>Archive · auto-discard</span><h2>Archived threads</h2><p>Right-click any thread in the sidebar to archive it. Archived threads are deleted permanently {ARCHIVE_RETENTION_DAYS} days after they are archived.</p></header>{!threads.length && <div className="content-empty"><span className="mark" aria-hidden="true">◇</span><h2>Nothing archived</h2><p>Archived threads appear here until they are discarded.</p></div>}<div className="job-list">{threads.map((item) => <article key={item.id}><header><div><span className="job-state">Archived</span><h3>{threadLabel(item)}</h3></div><button type="button" disabled={busy} onClick={() => restore(item.id)}>Restore</button></header><dl><div><dt>Archived</dt><dd>{date(item.archivedAt ?? "")} · {time(item.archivedAt ?? "")}</dd></div><div><dt>Messages</dt><dd>{item.messages.length} {plural(item.messages.length, "message")}</dd></div></dl></article>)}</div></section>;
}

function CategoryEditor({ baseId, categories, act, busy }: { baseId: string; categories: string[]; act: (method: string, params?: Record<string, string>) => Promise<unknown>; busy: boolean }) {
  const [value, setValue] = useState("");
  return <details><summary>Manage</summary><div className="category-pop"><form onSubmit={(event) => { event.preventDefault(); if (!busy && value.trim()) void act("addKnowledgeBaseCategory", { knowledgeBaseId: baseId, category: value.trim().toLowerCase().replace(/\s+/g, "-") }).then((result) => { if (result !== undefined) setValue(""); }); }}><input value={value} disabled={busy} onChange={(event) => setValue(event.target.value)} placeholder="research" aria-label="New category" /><button disabled={busy}>Add</button></form>{categories.map((item) => <button key={item} disabled={busy} onClick={() => void act("removeKnowledgeBaseCategory", { knowledgeBaseId: baseId, category: item })}>{item} ×</button>)}</div></details>;
}

// Matches MAX_SCREEN_CONTEXT_CHARS in desktop/main/ipc.ts; the host request ceiling, not the store's.
const MAX_CAPTURE_IMAGE_CHARS = 96 * 1024;

/// Screenshots run far past what one host request carries, so shrink until it fits instead of
/// refusing the drop.
async function encodeCapturedImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This image could not be read.");
  for (let scale = 1; scale >= 0.125; scale /= 2) {
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.8, 0.6, 0.4]) {
      const url = canvas.toDataURL("image/jpeg", quality);
      if (url.length <= MAX_CAPTURE_IMAGE_CHARS) return url;
    }
  }
  throw new Error("This image is too large to capture.");
}

function CaptureDialog({ bases, close, act, busy, onCaptured }: { bases: Snapshot["knowledgeBases"]; close: () => void; act: (method: string, params?: Record<string, string>) => Promise<unknown>; busy: boolean; onCaptured: (id: string) => void }) {
  const [baseId, setBaseId] = useState(bases[0]?.id ?? "");
  const [category, setCategory] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [image, setImage] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileError, setFileError] = useState("");
  const [reading, setReading] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);
  const dismiss = () => dialog.current?.close();
  const base = bases.find((item) => item.id === baseId);
  const categories = base?.categories ?? [];

  const takeFile = async (file?: File) => {
    if (!file) return;
    setFileError("");
    try {
      if (file.type.startsWith("image/")) {
        setImage(await encodeCapturedImage(file));
        setText((current) => current || `Screenshot captured from ${file.name}.`);
      } else {
        const content = await file.text();
        if (content.length > 60_000) throw new Error("This file is too long to capture; paste the part that matters.");
        setImage("");
        setText(content);
      }
      setFileName(file.name);
      setTitle((current) => current || file.name.replace(/\.[^.]+$/, ""));
    } catch (reason) {
      setFileError(reasonText(reason));
    }
  };

  const read = async () => {
    const url = sourceUrl.trim();
    if (busy || !url) return;
    setFileError("");
    setReading(true);
    try {
      const page = await window.emma.fetchUrl(url);
      setText(page.text.slice(0, 60_000));
      setTitle((current) => current || page.title);
      setFileName(page.title || url);
    } catch (reason) {
      setFileError(reasonText(reason));
    } finally {
      setReading(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !baseId || !title.trim() || !text.trim()) return;
    // No category means "Emma, you file it": the item lands unfiled and the
    // analysis picks a category out of the ones this base already keeps. Typing
    // "unfiled" by hand says the same thing, so it must not skip the analysis and
    // leave a raw clip sitting there as the document.
    const filed = category.trim().toLowerCase().replace(/\s+/g, "-");
    const unfiled = !filed || filed === UNFILED_CATEGORY;
    const created = await act("captureToKnowledge", {
      knowledgeBaseId: baseId,
      category: filed || UNFILED_CATEGORY,
      title: title.trim(),
      text: text.trim(),
      ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}),
      ...(image ? { image } : {}),
    }) as KnowledgePage | undefined;
    if (!created) return;
    onCaptured(created.id);
    dismiss();
    if (unfiled) await act("analyzePage", { pageId: created.id });
  };

  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="capture-title" onClose={close} onCancel={(event) => { event.preventDefault(); if (!busy) dismiss(); }} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) dismiss(); }}>
    <form className="new-thread-dialog capture-dialog" onSubmit={(event) => void submit(event)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void takeFile(event.dataTransfer.files[0]); }}>
      <header><div><span>Direct capture</span><h2 id="capture-title">Capture into knowledge</h2></div><button type="button" disabled={busy} aria-label="Close capture" onClick={dismiss}>×</button></header>
      <label>Base<select value={baseId} disabled={busy} onChange={(event) => { setBaseId(event.target.value); setCategory(""); }}>{bases.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Category<input value={category} list="capture-categories" disabled={busy} maxLength={64} placeholder="leave blank and Emma files it" onChange={(event) => setCategory(event.target.value)} /></label>
      <datalist id="capture-categories">{categories.map((item) => <option key={item} value={item} />)}</datalist>
      <label>Title<input value={title} disabled={busy} maxLength={256} onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="capture-url">Source URL<span><input value={sourceUrl} type="url" disabled={busy} maxLength={2048} placeholder="https://" onChange={(event) => setSourceUrl(event.target.value)} /><button type="button" disabled={busy || reading || !sourceUrl.trim()} onClick={() => void read()}>{reading ? "Reading…" : "Read page"}</button></span></label>
      <label>Text<textarea value={text} disabled={busy} maxLength={60_000} rows={6} placeholder="Paste a link, a passage, or notes. Drop a file or screenshot anywhere in this panel." onChange={(event) => setText(event.target.value)} /></label>
      <label className="capture-file">File or screenshot<input type="file" disabled={busy} onChange={(event) => void takeFile(event.target.files?.[0])} /></label>
      {fileName && <small>{image ? "Image attached" : "Text loaded"} · {fileName}</small>}
      {fileError && <small className="capture-error">{fileError}</small>}
      <footer><small>Nothing saves until you capture.</small><button type="button" disabled={busy} onClick={dismiss}>Cancel</button><button className="dialog-primary" disabled={busy || !baseId || !title.trim() || !text.trim()}>Capture</button></footer>
    </form>
  </dialog>;
}

/** The picture is why the thing was kept, so the tile leads with it. */
function pageCover(page: KnowledgePage): { asset: string; alt: string } | null {
  for (const block of page.artifacts ?? []) {
    if (block.type !== "image") continue;
    const payload = objectPayload(block.payload);
    const asset = textValue(payload.asset);
    if (asset) return { asset, alt: textValue(payload.alt) || page.title };
  }
  return null;
}

function PageTile({ page, busy, onSelect }: { page: KnowledgePage; busy: boolean; onSelect: (id: string) => void }) {
  const cover = pageCover(page);
  const source = usePageAsset(cover?.asset ?? "");
  // A clip is marked on the board rather than dressed up as a written page: what its
  // tile shows is the first line of a scrape, not a summary of anything.
  return <button className="page-tile" data-clip={isRawClip(page) || undefined} draggable={!busy} disabled={busy} onDragStart={(event) => event.dataTransfer.setData("text/plain", page.id)} onClick={() => onSelect(page.id)}>
    {source && <img src={source} alt={cover?.alt ?? ""} />}
    <strong>{page.title}</strong>
    <span>{page.analysis.summary}</span>
    <footer><span className="category">{page.category}</span>{isRawClip(page) && <em className="page-clip-chip">raw clip</em>}<small>{date(page.analyzedAt)}</small></footer>
  </button>;
}

function KnowledgeBoard({ snapshot, onSelect, act, busy }: { snapshot: Snapshot; onSelect: (id: string) => void; act: (method: string, params?: Record<string, string>) => Promise<unknown>; busy: boolean }) {
  const [baseId, setBaseId] = useState("all");
  const [category, setCategory] = useState("all");
  const [creating, setCreating] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [over, setOver] = useState("");
  const [name, setName] = useState("");
  const basePages = baseId === "all" ? snapshot.pages : snapshot.pages.filter((page) => page.knowledgeBaseId === baseId);
  const pages = category === "all" ? basePages : basePages.filter((page) => page.category === category);
  const base = snapshot.knowledgeBases.find((item) => item.id === baseId);
  const categories = [...new Set([...basePages.map((page) => page.category), ...(base?.categories ?? [])])].sort();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !name.trim()) return;
    if (await act("createKnowledgeBase", { name: name.trim() }) === undefined) return;
    setName("");
    setCreating(false);
  };
  // Dropping a tile on a category is the whole re-filing gesture; the page keeps
  // its document and only changes shelf.
  const refile = async (pageId: string, next: string) => {
    const page = snapshot.pages.find((item) => item.id === pageId);
    if (busy || !page || page.category === next) return;
    await act("updatePage", { pageId, title: page.title, category: next, summary: page.analysis.summary, body: page.analysis.body });
  };
  const drop = (item: string) => ({
    onDragOver: (event: ReactDragEvent) => { event.preventDefault(); setOver(item); },
    onDragLeave: () => setOver((current) => current === item ? "" : current),
    onDrop: (event: ReactDragEvent) => { event.preventDefault(); setOver(""); void refile(event.dataTransfer.getData("text/plain"), item); },
  });
  return <section className="knowledge-board">
    <header className="knowledge-head"><h1>Knowledge</h1></header>
    <div className="knowledge-toolbar">
      <div className="base-toolbar">
        <button className={`shelf-chip ${baseId === "all" ? "on" : ""}`} onClick={() => { setBaseId("all"); setCategory("all"); }}>All knowledge</button>
        {snapshot.knowledgeBases.map((item) => <button key={item.id} className={`shelf-chip ${baseId === item.id ? "on" : ""}`} onClick={() => { setBaseId(item.id); setCategory("all"); }}>{item.name}</button>)}
        <button aria-label="Create knowledge base" title="Create knowledge base" onClick={() => setCreating(!creating)}>＋</button>
        <button aria-label="Capture into knowledge" title="Capture into knowledge" disabled={busy || !snapshot.knowledgeBases.length} onClick={() => setCapturing(true)}>⇱</button>
      </div>
      <div className="category-toolbar">
        <button className={`shelf-chip ${category === "all" ? "on" : ""}`} onClick={() => setCategory("all")}>All · {basePages.length}</button>
        {categories.map((item) => <button key={item} className={`shelf-chip category ${category === item ? "on" : ""} ${over === item ? "over" : ""}`} onClick={() => setCategory(item)} {...drop(item)}>{item}</button>)}
        {base && <CategoryEditor baseId={base.id} categories={base.categories} act={act} busy={busy} />}
      </div>
    </div>
    {creating && <form className="inline-form" onSubmit={(event) => void submit(event)}><input autoFocus value={name} maxLength={128} onChange={(event) => setName(event.target.value)} placeholder="Base name" aria-label="New knowledge base name" /><button disabled={busy}>Create</button></form>}
    <div className="page-board">
      {pages.map((item) => <PageTile key={item.id} page={item} busy={busy} onSelect={onSelect} />)}
      {!pages.length && <Empty copy="Drop in anything that interests you — a link, a file, a screenshot — or save a thread analysis." />}
    </div>
    {capturing && <CaptureDialog bases={snapshot.knowledgeBases} close={() => setCapturing(false)} act={act} busy={busy} onCaptured={onSelect} />}
  </section>;
}

type PaneProps = { layout: PaneLayout; pane: (change: Partial<PaneLayout>) => void };

/// A grant's path as the user would write it. The renderer has no `os.homedir`, and
/// every grant on this Mac sits under the same two segments, so the shape is enough.
const home = (path: string) => path.replace(/^\/Users\/[^/]+/, "~");

/// The top band of the composer: the project this thread works out of, the branch git
/// has checked out there, and a switch onto an isolated worktree of it. A thread with
/// no folder is General — Emma can only chat there, because it has no filesystem at all.
/// One thread works in one folder: it is the directory `emma-cli` is spawned in, and
/// the only place this thread's tools can reach. Choosing another moves the thread.
function ProjectBar({ folders, ids, setFolders, setIds, git, name, busy }: { folders: FolderGrant[]; ids: string[]; setFolders: (folders: FolderGrant[]) => void; setIds: (ids: string[]) => void; git: GitSnapshot | null; name: string; busy: boolean }) {
  const [error, setError] = useState("");
  /// Which chip's menu is down; one at a time, so opening either closes the other.
  const [open, setOpen] = useState<"" | "project" | "branch">("");
  /// The branch being typed. Empty means the row still reads "New branch…".
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
  // Same dismissal the ＋ and model menus use: a pointer anywhere else closes it.
  // Both menus live inside the band, so one containment test covers them.
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!bar.current?.contains(event.target as Node)) { setOpen(""); setNaming(false); } };
    addEventListener("pointerdown", outside);
    return () => removeEventListener("pointerdown", outside);
  }, [open]);
  const project = folders.find((folder) => folder.id === ids[0]);
  // Electron wraps a handler's throw as "Error invoking remote method 'x': Error: real message".
  const say = (reason: unknown) =>
    setError(reasonText(reason));
  /// Moves the thread onto this folder. Nothing is kept beside it — a second folder
  /// would be reachable by Emma's own tools and invisible to the CLI running in the first.
  const lead = (id: string) => setIds([id]);
  const choose = (value: string) => {
    setError("");
    if (value !== "pick") { if (value) lead(value); else setIds([]); return; }
    void window.emma.pickFolder().then((granted) => {
      setFolders(granted);
      // ponytail: the picker hands back the whole list, so the new grant is the one
      // that was not there before. Re-picking an already-connected folder falls back
      // to the newest. Return the chosen grant from main if that guess ever matters.
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
  /// Checking out is git's own move, uncommitted work and all: main runs it and
  /// broadcasts, and the chip re-reads the branch from the snapshot that follows.
  const branchTo = (branch: string, create: boolean) => {
    if (!project || !branch.trim()) return;
    setError("");
    void window.emma.setBranch({ folderId: project.id, branch: branch.trim(), create }).catch(say).finally(shut);
  };
  /// What the menu lists: General, every connected folder, then the native picker.
  /// A folder wears the leading slash of the path it is, so a directory never reads
  /// as one of the two words beside it that are not directories.
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
        {/* Always the last row, so a repo with one branch still starts the next one. */}
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
  return <section className="capability-panel" aria-label="Imported capabilities"><header><div><span>Imported skills & MCP</span><small>A skill attaches to the next turn; imported MCP servers are handed to the harness with every turn.</small></div><button type="button" disabled={locked || pending} onClick={close} aria-label="Back to add menu">← Back</button></header>{skill && <div className="capability-attached"><span>Skill attached · {skill.source}/{skill.name}</span><button type="button" disabled={locked || pending} onClick={clearSkill}>Clear</button></div>}<div className="capability-section"><label>Filter skills<input value={skillQuery} disabled={locked || pending} onChange={(event) => setSkillQuery(event.target.value)} placeholder="review, research…" /></label>{!shownSkills.length && <p className="project-empty">{skills.length ? "Nothing matches that." : "No skills imported yet."}</p>}{shownSkills.map((item) => <button type="button" className="capability-row" disabled={locked || pending} key={item.id} onClick={() => attach(item)}><strong>{item.name}</strong><small>{item.source} · attach to this thread</small></button>)}<small>Instructions remain main-side and apply only to the next provider-backed turn; local fallback rejects them.</small></div><div className="capability-section"><div className="capability-label"><span>MCP servers</span></div>{!servers.length && <p className="project-empty">No MCP servers imported yet.</p>}{servers.map((item) => <div className="capability-row" key={item.id}><strong>{item.name}</strong><small>{item.source} · {item.command} · env: {item.environmentKeys.join(", ") || "none"}</small></div>)}<small>The harness starts these itself and searches their tools when a turn needs one. Switch one off in Settings → Tools.</small></div>{error && <p className="capability-error" role="alert">{error}</p>}</section>;
}

/* Always in the "/" menu, so it lists something before anything is imported.
   These open the panel that already owns the capability; only skills and MCP
   servers leave a token behind in the message. */
const BUILTIN_COMMANDS: SlashCommand[] = [
  { id: "agent", name: "agent", kind: "builtin", detail: "built-in · Zig coding harness" },
  { id: "import", name: "import", kind: "builtin", detail: "built-in · import skills & MCP" },
];

const onTagsChanged = (fire: () => void) => {
  addEventListener("emma-thread-tags-changed", fire);
  return () => removeEventListener("emma-thread-tags-changed", fire);
};

/**
 * The thread's one tag, on the bar beside its name.
 *
 * The tags already in use are the list, so filing a thread under one you have is
 * a click rather than typing the word again — and typos cannot quietly fork a
 * category in two. The field above them narrows that list and, when nothing
 * matches, is the new tag: picking a tag and coining one are the same act from
 * this side, and the only difference is whether the word is already there.
 */
function TagPicker({ threadId }: { threadId: string }) {
  const filed = useSyncExternalStore(onTagsChanged, () => threadTags()[threadId]?.tag ?? "");
  const guessed = useSyncExternalStore(onTagsChanged, () => threadTags()[threadId]?.auto === true);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    // Same outside-click rule as the mode and model menus.
    const outside = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    addEventListener("pointerdown", outside);
    return () => removeEventListener("pointerdown", outside);
  }, [open]);
  // Narrowed through the same cleaner that will store it, so what the rows are
  // matched against is what typing it would actually save.
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
          // Enter takes the one unambiguous answer — the new word, or the single
          // row it narrowed to. A list of several waits to be pointed at.
          if (coin || matches.length === 1) apply(coin || matches[0]);
        }} />
      {coin && <button type="button" role="option" aria-selected={false} className="tag-row" onClick={() => apply(coin)}><strong>{coin}</strong><em>New</em></button>}
      {matches.map((tag) => <button type="button" role="option" aria-selected={tag === filed} key={tag} className="tag-row" onClick={() => apply(tag)}><strong>{tag}</strong>{tag === filed && <em>Filed</em>}</button>)}
      {!matches.length && !coin && <p className="slash-empty">No tags yet — type one and press Enter.</p>}
      {filed && <button type="button" className="tag-row clear" onClick={() => apply("")}>Clear tag</button>}
    </section>}
  </div>;
}

function ThreadView({ thread, snapshot, busy, act, reload, agents, tab, setTab, newThread, onSendingChange, onModelChanged, onManageModels, onManageImports, modelKey, modelLabel, modelTag, modelBrand, defaultMode, contextTokens, contextPages, onContextPages, layout, pane }: { thread?: Thread; snapshot: Snapshot; busy: boolean; act: (method: string, params?: Record<string, string>) => Promise<unknown>; reload: () => unknown; agents: LiveAgent[]; tab: string; setTab: (tab: string) => void; newThread: () => void; onSendingChange: (busy: boolean) => void; onModelChanged: (settings: UserSettings) => void; onManageModels: () => void; onManageImports: () => void; modelKey: string; modelLabel: string; modelTag: string; modelBrand?: BrandDefinition; defaultMode: PermissionMode; contextTokens: number; contextPages: ContextPage[]; onContextPages: (pages: ContextPage[]) => void } & PaneProps) {
  // ThreadView is keyed by thread id, so a thread opened from the Artifacts page
  // mounts this fresh and the seeded question is what the composer starts with.
  // Read here and cleared in the effect, never taken in the initializer, which
  // StrictMode runs twice: a seed is for one composer, not for every later one.
  const [message, setMessage] = useState(() => takeComposerSeed(thread?.id ?? ""));
  useEffect(() => { if (composerSeed.threadId === thread?.id) composerSeed = { threadId: "", text: "" }; }, [thread?.id]);
  const [mode, setMode] = useState<PermissionMode>(() => threadMode(thread?.id ?? "", defaultMode));
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [capabilityBusy, setCapabilityBusy] = useState(false);
  /// A failed steer, shown under the composer until the next one is typed.
  const [runError, setRunError] = useState("");
  const [skill, setSkill] = useState<ImportedSkill | null>(null);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactMeta[]>([]);
  const [folders, setFolders] = useState<FolderGrant[]>([]);
  const threadId = thread?.id;
  // A sub thread opens on the project its parent works out of — the agent that
  // started it was told it is "in this project", and the sidebar files it there.
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
  /// How far back the ↑ key has walked this thread's own prompts; -1 is the live draft.
  const [history, setHistory] = useState(-1);
  /// The turn in flight, what it is streaming, and anything queued behind it —
  /// held in a store rather than in this component, because this pane is keyed by
  /// thread id and unmounts the moment you look at another project. A run keeps
  /// going, and coming back shows it mid-sentence.
  const run = useRun(threadId ?? "");
  const sending = run.sending;
  /// Typed while the agent was working. The first entry is the one running.
  const queued = sending ? run.queue.slice(1) : run.queue;
  const input = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const { ref: transcript, onScroll: transcriptScroll } = useTailScroll<HTMLDivElement>(
    [thread?.id, thread?.messages.length, run.blocks],
    thread?.id,
  );
  /// What a shell fence in this thread's replies can reach: the folder its
  /// commands run in, and the composer, so what one printed can become the next
  /// question. It lands in the composer rather than sending by itself — the user
  /// still says what the output is *for*.
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
  // A pointer anywhere outside the add menu dismisses it, like the model menu.
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
  // Everything the "/" menu can offer, read once. The built-ins are always there
  // so the menu lists something on a Mac with nothing imported yet; imported
  // skills and MCP servers join them, both bounded main-side, and every built-in
  // tool comes last — what was imported is what the user went looking for, and
  // the tools are a long tail you narrow into by typing.
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
  // What "@" can name besides a file: the artifacts page and the knowledge base.
  // The folder is the truth for artifacts, so the same change event the Artifacts
  // page listens to refreshes this list.
  useEffect(() => {
    let active = true;
    const load = () => void window.emma.listArtifacts().then((list) => { if (active) setArtifacts(list); }).catch(() => undefined);
    load();
    const stop = window.emma.onArtifactsChanged(load);
    return () => { active = false; stop(); };
  }, []);
  useEffect(() => { void window.emma.listFolders().then(setFolders).catch(() => setFolders([])); }, []);
  // The agent can ask for a folder mid-turn: the user picks it in the native
  // dialog, main grants it, and the composer opens it as this thread's project
  // — otherwise the next context push below would detach it again.
  useEffect(() => window.emma.onFolderAttached((attached) => {
    if (attached.threadId !== threadId) return;
    void window.emma.listFolders().then(setFolders).catch(() => undefined);
    setFolderIds((current) => current[0] === attached.folderId ? current : [attached.folderId]);
  }), [threadId]);
  // A folder's listing is what the turn carries, and what the "/" menu offers as files.
  // Main gets the same pair because it is what gates the tools: without this the loop
  // would advertise no filesystem at all, whatever the composer is showing.
  useEffect(() => {
    if (!threadId) return;
    setThreadFolders(threadId, folderIds);
    setThreadMode(threadId, mode);
    // The key, not the name on the button: main routes the turn off this, and a
    // model named by its last path segment is not a route anything can take.
    void window.emma.setThreadContext({ threadId, folderIds, mode, model: modelKey }).catch(() => undefined);
  }, [folderIds, mode, modelKey, threadId]);
  // Re-listed when a turn ends too: a turn that creates files or folders would otherwise
  // leave "@" offering the tree as it looked before the agent touched it.
  useEffect(() => {
    let active = true;
    for (const id of folderIds) {
      void window.emma.listFolderFiles(id).then((files) => { if (active) setFolderFiles((current) => ({ ...current, [id]: files })); }).catch(() => undefined);
    }
    return () => { active = false; };
  }, [folderIds, sending]);
  // A tab that belongs to a finished agent stays open; one whose thread never
  // existed (a stale pick after a reload) falls back to the transcript.
  const subagents = useMemo(() => agents.filter((agent) => agent.parentThreadId === threadId), [agents, threadId]);
  /// The threads this one spawned. Read off the library, not the agent list: a sub
  /// thread is a row in the sidebar that outlives every run in it, so it is listed
  /// here whether or not anything is working in it. A subagent's transcript is
  /// filed under its spawner too and is deliberately left out — it is a tab of
  /// this pane, and the rail above already has it.
  const subthreads = useMemo(
    () => snapshot.threads.filter((item) => item.parentThreadId === threadId && !item.archivedAt && item.kind !== "subagent"),
    [snapshot.threads, threadId],
  );
  // This thread's turn while it is still running, and every subagent under it.
  // The ledger reads the loop's running count off these rather than waiting for
  // the message the turn lands as.
  const inFlight = useMemo(
    () => [...subagents, ...agents.filter((agent) => agent.threadId === threadId)]
      .filter((agent) => agent.status === "running" || agent.status === "waiting"),
    [agents, subagents, threadId],
  );
  const cliRuns = useCliRuns();
  useEffect(() => {
    // Every tab that is not backed by a live subagent or CLI run: the prune below
    // only knows about those two, so a fixed tab left off this list is bounced
    // back to the thread the moment either list refreshes.
    if (tab === "thread" || tab === "changes" || tab === "git") return;
    if (!subagents.some((agent) => agent.threadId === tab) && !cliRuns.some((run) => run.id === tab)) setTab("thread");
  }, [subagents, cliRuns, tab, setTab]);
  /// Which arrangement of the bar is up. Remembered across threads and launches,
  /// because it is a way of working rather than a property of one thread.
  const [contextPage, setContextPage] = useState(readContextPage);
  const page = contextPages.find((item) => item.id === contextPage) ?? contextPages[0];
  useEffect(() => { writeContextPage(page.id); }, [page.id]);
  // The ledger lives in localStorage, so it is read on render and a turn just asks for another one.
  const uses = threadUses(threadId ?? "");
  // Measured once for the whole bar. The stats tiles, the context window and the
  // timeline's context axis are three readings of one number, and the ledger's own
  // figure leans on an async fetch and the provider's input count — a second copy
  // of that arithmetic is a second thing to keep in step. It is measured whether or
  // not the widget that draws it is on the page you happen to be looking at.
  const landedCalls = useThreadCalls(threadId, sending);
  const ledger = useContextLedger(thread, uses, contextTokens, inFlight, threadExperiments(threadId ?? ""), landedCalls, threadBreakdown(threadId ?? ""));
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
  /// An edit row in the transcript, asking for the diff behind it. Nothing to open
  /// once the run that made the change is gone — a restart keeps the row, not the
  /// before-and-after — so the click is quietly ignored rather than opening a
  /// panel with nothing in it.
  useEffect(() => {
    const open = () => { if (changes.length) setTab("changes"); };
    addEventListener(OPEN_CHANGES_EVENT, open);
    return () => removeEventListener(OPEN_CHANGES_EVENT, open);
  }, [changes.length, setTab]);
  /// This session's turns, kept for the next launch against the message each one
  /// wrote. Written from here rather than as the turn lands because this is where
  /// that message — and the timestamp naming it — finally exists.
  const cached = useMemo(() => cachedBlocks(thread?.id ?? ""), [thread?.id]);
  useEffect(() => {
    if (!thread) return;
    const paired = pairBlocks(thread.messages, run.landed, {});
    rememberBlocks(thread.id, Object.fromEntries(thread.messages.flatMap((item, index) =>
      paired[index] && wrote(item.content, paired[index]!) ? [[item.timestamp, paired[index]!]] : [])));
  }, [thread, run.landed]);
  /// Files handed to past turns, resolved to the messages those turns wrote. A
  /// turn sent a moment ago lands here on the render its message arrives on.
  const attachedTurns = useMemo(() => thread ? turnAttachments(thread.id, thread.messages) : {}, [thread]);
  if (!thread) return <div className="content-empty"><Mark /><h2>Start a durable thread</h2><p>Normal agent work stays here until you explicitly save it to knowledge.</p><button type="button" disabled={busy} onClick={newThread}>New thread</button></div>;
  /// A running turn no longer counts: the composer stays live so the next prompt
  /// can be typed and queued, or sent into the run as steering.
  const locked = busy || capabilityBusy;
  /// The echo stands in only until the host's own copy of the prompt arrives.
  // ponytail: `after` is where the thread stood when the prompt was typed, not
  // when it was sent, so queueing the same text twice hides the second echo early.
  // Carry a per-turn id if that ever reads wrong.
  const echo = run.pending && !hasPersistedPrompt(snapshot, thread.id, run.pending.after, run.pending.content) ? run.pending.content : null;
  // Only while the turn is in flight: once it lands the host's own copy renders,
  // and showing both would double the reply for a frame.
  const streaming = sending && run.blocks.length ? run.blocks : null;
  const landedBlocks = pairBlocks(thread.messages, run.landed, cached);
  const setCapabilityRunning = (value: boolean) => { setCapabilityBusy(value); onSendingChange(value); };
  const localContext = contextCommands(folders, folderIds, folderFiles, snapshot);
  // "/" is capabilities only — skills, MCP servers, built-in tools. Files and
  // knowledge categories belong to "@" and the add menu.
  const allCommands = commands;
  /// The same imported skills and MCP servers the "/" menu lists, minus the built-ins.
  const imported = commands.filter((item) => item.kind === "skill" || item.kind === "mcp");
  // The "@" menu names what Emma made and saved before the files on disk, all by path.
  const atItems = atCommands(artifacts, snapshot, folders, folderIds, folderFiles);
  const addPick = (pick: ContextPick) => setPicks((current) => current.some((item) => pickKey(item) === pickKey(pick)) ? current : [...current, pick]);
  const noteUses = (added: Omit<ContextUse, "turns">[]) => { recordUses(thread.id, added); ledgerChanged((current) => current + 1); };
  const dropPick = (pick: ContextPick) => setPicks((current) => current.filter((item) => pickKey(item) !== pickKey(pick)));
  /// Files handed to this message: a screenshot, a CSV, whichever file is the point
  /// of the question. They ride the same attached-context block a picked file does,
  /// so nothing else here has to know where they came from — only the composer
  /// draws them differently, as tiles above the message rather than a band under it.
  const holdAttachments = (held: HeldAttachment[]) =>
    held.forEach((item) => addPick({ kind: "attachment", id: item.id, name: item.name, path: item.path, ...(item.thumbnail ? { thumbnail: item.thumbnail } : {}) }));
  /// A drop or a paste. The browser hands over contents and no path, so the
  /// contents are what crosses to main; the native picker keeps its own paths.
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
  /// Prompts already sent in this thread, newest first — what ↑ walks back through.
  const past = thread.messages.filter((item) => item.role === "user").map((item) => sentByThread(item.content).body).reverse();
  // A skill attaches on pick, exactly as the ＋ menu attaches one. A built-in
  // leaves no token — it is a shortcut to the panel that already owns it, so the
  // fragment is dropped. A built-in tool and an MCP server attach nothing at all:
  // the turn already carries both, so the token is the instruction to reach for
  // that one.
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
    else openCapabilities();
  };
  const composerKeys = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen && slashMatches.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setSlashPick((current) => (Math.min(current, slashMatches.length - 1) + (event.key === "ArrowDown" ? 1 : slashMatches.length - 1)) % slashMatches.length); return; }
      if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); pickCommand(slashMatches[slashActive]); return; }
    }
    if (slashOpen && event.key === "Escape") { event.preventDefault(); setSlashDismissed(true); return; }
    // ↑ from the very start of the composer recalls the last prompt, and keeps
    // walking back; ↓ from the very end walks forward to the empty draft again.
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
  /// Enter always accepts the prompt. If a turn is already running it waits behind
  /// it, so the pane is never a locked box you have to watch. Context resolves here,
  /// at the keystroke, not at delivery: what was attached when you typed it is what
  /// it carries, however long it waits.
  /* `text` is for a caller with its own input — the chat region Emma wrote has a
     composer of its own, and a turn it sends has to be the same turn this one
     sends: attached context, ledger entry, queueing and all. The draft is only
     cleared when the draft is what was sent. */
  const send = async (event?: FormEvent, text?: string) => {
    event?.preventDefault();
    if (locked) return;
    const content = (text ?? message).trim();
    if (!content) return;
    if (text === undefined) { setMessage(""); setHistory(-1); }
    const attached = folderIds.length || picks.length ? await buildAttachedContext(folders, folderIds, picks, folderFiles, snapshot) : { text: "", uses: [] };
    const attachedSkill = skill;
    const after = thread.messages.length;
    /// Recorded against the message this turn is about to write, so the tiles the
    /// composer is drawing right now stay drawn above it once it has been sent.
    rememberTurnAttachments(thread.id, after, content, picks.flatMap((pick) => pick.kind === "attachment"
      ? [{ name: pick.name, path: pick.path, ...(pick.thumbnail ? { thumbnail: pick.thumbnail } : {}) }]
      : []));
    sendTurn(thread.id, {
      content,
      after,
      params: { ...(attached.text ? { attachedContext: attached.text } : {}), ...(attachedSkill ? { skillAttachmentId: attachedSkill.id } : {}) },
      // Only a delivered turn goes in the ledger: it records what Emma was actually sent.
      delivered: () => noteUses([...attached.uses, ...(attachedSkill ? [{ kind: "skills" as const, label: `${attachedSkill.source}/${attachedSkill.name}`, chars: attachedSkill.chars ?? 0 }] : [])]),
    }, reload);
    setSkill(null);
    setPicks([]);
  };
  /// The other door into a running turn: steering rides in with the next batch of
  /// tool results instead of waiting for the turn to end. Nothing in flight is
  /// interrupted — the call the agent is already making finishes first.
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
  // Only this thread's runs: a CLI Emma started somewhere else belongs to that
  // thread's tab strip, the same rule the subagent tabs follow.
  const threadClis = cliRuns.filter((run) => run.threadId === thread.id);
  const openCli = threadClis.find((run) => run.id === tab);
  const tabs: AgentTab[] = [
    { id: "thread", label: threadLabel(thread), closable: false },
    ...subagents.map((agent) => ({ id: agent.threadId, label: agent.title, color: agent.color, closable: agent.status !== "running" && agent.status !== "waiting" })),
    ...threadClis.map((run) => ({
      id: run.id,
      // The run id rides along: two turns of the same CLI would otherwise be two
      // tabs with the same name, and the dock names them that way already.
      label: `${cliHarness(run.cli)?.label ?? run.cli} ${run.id}`,
      icon: <BrandIcon brand={brandForImporter(run.cli)} className={`cli-mark ${run.cli}`} />,
      closable: run.status !== "running",
    })),
    ...(changes.length ? [{ id: "changes", label: "Changes", closable: false }] : []),
    ...(git ? [{ id: "git", label: `Git · ${git.branch}`, closable: false }] : []),
  ];
  return <div className="thread-layout">
    <div className="thread-column">
      <CliDock runs={threadClis} active={tab} onOpen={setTab} />
      <TabStrip tabs={tabs} active={tab} onPick={setTab} onClose={(id) => { if (tab === id) setTab("thread"); }} />
      {openCli ? <CliPanel run={openCli} busy={locked} />
        : tab === "changes" ? <ChangesPanel changes={changes} busy={locked} onReverted={reloadChanges} />
        : tab === "git" && git ? <GitPanel snapshot={git} folderId={folderIds[0]} full />
        : openAgent ? <AgentPanel agent={openAgent} transcript={<AgentTranscript threadId={openAgent.threadId} thread={agentThread} />} />
        : <Region name="chat" props={{
          thread, messages: thread.messages, busy: locked, sending,
          // The composer's own path, so a region Emma wrote sends exactly what the
          // built-in sends: the turn is queued, streamed and stopped the same way.
          send: (text: string) => void send(undefined, text), stop: () => window.emma.stopAgent(thread.id),
          streaming, mode, setMode,
        }}>
        <section className="conversation" aria-label={`Thread: ${threadLabel(thread)}`}>
      {/* The name is edited where it is read, the same rule the sidebar row follows.
          It is an input at rest rather than a click-to-edit dance: one element, and
          the key resets it whenever the thread or its name changes underneath. */}
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
      /><TagPicker threadId={thread.id} /><div className="thread-actions">{/* Only once this thread has actually touched code: with a clean tree the row
          would be three app icons offering to open nothing in particular. */}
        {folderIds[0] && (!!git?.diff.trim() || changes.length > 0) && <OpenIn folderId={folderIds[0]} label />}
        <button type="button" className="page-info-button" aria-label="Show thread details" aria-haspopup="dialog" onClick={() => setAgentOpen(true)}>i</button></div></header>
      <div className="transcript-wrap">
      <TranscriptRail messages={thread.messages} scroller={transcript} />
      <div className="transcript" ref={transcript} onScroll={transcriptScroll}>
        <RunContext.Provider value={runFences}>
        {!thread.messages.length && echo === null && !sending && <div className="welcome"><Mark /><h3>What are we working on?</h3><p>Ask Emma to research, plan, write, or think. Nothing enters knowledge unless you choose it.</p></div>}
        {thread.messages.map((item, index) => <Turn key={`${item.timestamp}-${index}`} item={item} blocks={landedBlocks[index]} index={index} attached={attachedTurns[index]} />)}
        {echo !== null && <article className="message user pending"><div className="message-body"><p>{echo}</p></div><footer className="message-meta"><span>You</span><span className="pending-note">Sending…</span></footer></article>}
        {streaming !== null && <Streaming blocks={streaming} threadId={thread.id} />}
        {sending && streaming === null && <p className="waiting" role="status"><Mark /> Emma is working…</p>}
        {!sending && run.stopped && <p className="waiting stopped" role="status">Agent stopped. Ask Emma to continue where it left off.</p>}
        </RunContext.Provider>
      </div>
      </div>
      <ProjectBar folders={folders} ids={folderIds} setFolders={setFolders} setIds={setFolderIds} git={git} name={worktreeName(thread.id)} busy={locked} />
      {/* Above the composer, one size down: what is waiting reads in the order it
          will be sent, and the box it sits in is plainly the composer's overflow. */}
      {queued.length > 0 && <div className="queued-stack" aria-label="Queued messages">{queued.map((turn, index) => <div className="queued-row" key={`${index}-${turn.content}`}><span>Queued · {turn.content}</span><button type="button" onClick={() => dropQueued(thread.id, index)} aria-label="Drop this queued message">×</button></div>)}</div>}
      <form className="composer" onSubmit={(event) => void send(event)}
        onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
        onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); attachDropped(event.dataTransfer.files); } }}><label className="sr-only" htmlFor="message">Message Emma</label>{/* Attached files sit above what is being typed, in reading order: they are part
          of the message, and a picture has to be seen for the chip to say anything. */}
        {picks.some((pick) => pick.kind === "attachment") && <div className="composer-tray">{picks.map((pick) => pick.kind !== "attachment" ? null : <div className="composer-tile" key={pickKey(pick)} title={pick.name}>{pick.thumbnail ? <img src={pick.thumbnail} alt="" /> : <><FileMark path={pick.name} /><small>{pick.name}</small></>}<button type="button" disabled={locked} onClick={() => dropPick(pick)} aria-label={`Remove ${pick.name}`}>×</button></div>)}</div>}<div className="composer-input"><div className="composer-highlight" ref={mirror} aria-hidden="true">{highlightSegments(message, allCommands.map((item) => item.name), atItems.map((item) => item.name)).map((segment, index) => <span key={index} className={segment.hue === undefined ? undefined : "slash-token"} data-hue={segment.hue}>{segment.text}</span>)}{"\n"}</div><textarea ref={input} id="message" value={message} disabled={locked} maxLength={65_536} role="combobox" aria-expanded={slashOpen} aria-controls="slash-menu" aria-autocomplete="list" onChange={(event) => typing(event.currentTarget)} onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)} onScroll={(event) => { if (mirror.current) mirror.current.scrollTop = event.currentTarget.scrollTop; }} onKeyDown={composerKeys} onPaste={(event) => { if (event.clipboardData.files.length) { event.preventDefault(); attachDropped(event.clipboardData.files); } }} placeholder={sending ? "Emma is working — Enter queues, ⤳ steers…" : "Ask Emma to continue…"} rows={2} /></div>{slashOpen && <section className="source-popover slash-menu" id="slash-menu" role="listbox" aria-label={slash?.sigil === "@" ? "Artifacts, knowledge pages and files" : "Built-in tools, skills and MCP servers"}>{slashMatches.map((item, index) => <button type="button" role="option" aria-selected={index === slashActive} className={`slash-row ${index === slashActive ? "active" : ""}`} key={`${item.kind}-${item.id}`} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setSlashPick(index)} title={item.detail} onClick={() => pickCommand(item)}><strong>{slash?.sigil ?? "/"}{item.name}</strong><em className="slash-kind" data-kind={item.kind}>{KIND_LABELS[item.kind]}</em><small>{item.detail}</small></button>)}{!slashMatches.length && <p className="slash-empty">Nothing matches “{slash?.query}”. {slash?.sigil === "@" ? "Artifacts, knowledge pages and the files of this thread's folders appear here." : "Built-in tools, imported skills and MCP servers appear here."}</p>}</section>}<div className="composer-row"><div className="composer-tools"><button ref={sourceTrigger} type="button" className="source-trigger" disabled={locked} aria-label="Add context or plugin" aria-haspopup="dialog" aria-expanded={sourcesOpen} onClick={() => sourcesOpen ? closeSources() : setSourcesOpen(true)}>＋</button><ModePicker mode={mode} setMode={setMode} disabled={locked} /></div><button ref={modelTrigger} type="button" className="model-button" disabled={locked} aria-haspopup="dialog" aria-expanded={modelsOpen} aria-label={`Select model, currently ${modelLabel}${modelTag ? ` · ${modelTag}` : ""}`} onClick={() => { if (modelsOpen) { closeModels(); return; } setSourcesOpen(false); setModelsOpen(true); }}><BrandIcon brand={modelBrand} className="model-brand" /><span className="model-label">{modelLabel}</span>{modelTag && <em className={`model-route ${modelTag === "Local" ? "local" : "remote"}`}>{modelTag}</em>}<span aria-hidden="true">▾</span></button>{sending
          // ponytail: stop, not pause — neither loop can be resumed mid-turn, so
          // the run ends keeping what it already wrote and "continue" picks it up.
          // Mid-turn the corner holds one door at a time: stop while the composer is
          // empty, steer the moment there is something to steer with. Enter still queues.
          ? (message.trim()
            ? <button type="button" className="composer-send steering" disabled={locked} onClick={steer} aria-label="Steer this turn" title="Steer — arrives with the next tool result">⤳</button>
            : <button type="button" className="composer-send stopping" onClick={() => window.emma.stopAgent(thread.id)} aria-label="Stop this turn" title="Stop this turn">■</button>)
          : <button className="composer-send" disabled={locked || !message.trim()} aria-label="Send message">↑</button>}</div>{modelsOpen && <ModelMenu ref={modelMenu} close={closeModels} act={act} busy={locked} onSettingsChanged={onModelChanged} onManage={onManageModels} />}{runError && <p className="capability-error" role="alert">{runError}</p>}{run.error && <p className="capability-error" role="alert">{run.error}</p>}{run.draft && <div className="composer-attachment queued-turn"><span>Not sent · {run.draft}</span><button type="button" onClick={() => setMessage((current) => current || takeDraft(thread.id))} aria-label="Put this message back in the composer">↺</button></div>}{skill &&<div className="composer-attachment"><span>Skill · {skill.name} · next turn only</span><button type="button" disabled={locked} onClick={() => void window.emma.clearImportedSkill(skill.id).then(() => setSkill(null))} aria-label="Clear attached skill">×</button></div>}{picks.map((pick) => pick.kind === "attachment" ? null : <div className="composer-attachment" key={pickKey(pick)}><span>{KIND_LABELS[pick.kind]} · {pickLabel(pick, folders, snapshot)} · next turn only</span><button type="button" disabled={locked} onClick={() => dropPick(pick)} aria-label={`Clear ${pickLabel(pick, folders, snapshot)}`}>×</button></div>)}{sourcesOpen && <section className="source-popover add-menu" role="dialog" aria-modal="false" aria-labelledby="source-popover-title" tabIndex={-1} ref={(node) => { sourceMenu.current = node; if (node && !node.contains(document.activeElement)) node.focus(); }} onKeyDown={(event) => { if (event.key === "Escape" && !locked) closeSources(); }}><header><h3 id="source-popover-title">Add</h3><button type="button" disabled={locked} aria-label="Close add menu" onClick={closeSources}>×</button></header>{capabilitiesOpen ? <CapabilityPopover threadId={thread.id} locked={locked} close={() => setCapabilitiesOpen(false)} skill={skill} setSkill={setSkill} setBusy={setCapabilityRunning} /> : <><button type="button" className="add-row kind-knowledge" disabled={locked} onClick={() => { closeSources(); void window.emma.attachFiles().then(holdAttachments).catch((reason: unknown) => setRunError(reasonText(reason))); }}><b><ClipIcon /></b><div><strong>Attach files</strong><small>Images, code, CSVs, Markdown — dropping or pasting into the composer works too</small></div></button><span className="add-section">Files &amp; knowledge categories</span><div className="add-context"><label className="sr-only" htmlFor="context-search">Search files and knowledge categories</label><input id="context-search" value={contextQuery} disabled={locked} onChange={(event) => setContextQuery(event.target.value)} placeholder="Search files, categories, skills & MCP — same as typing /" />{matchCommands(localContext, contextQuery).slice(0, 12).map((item) => <button type="button" className="slash-row" key={item.id} title={item.detail} disabled={locked} onClick={() => { if (item.pick) addPick(item.pick); }}>{item.pick?.kind === "file" ? <FileMark path={item.pick.path} /> : <span className="git-type" aria-hidden>·</span>}<strong>/{item.name}</strong><small>{item.detail}</small></button>)}{!localContext.length && <p className="project-empty">Pick a folder in the project chip, or capture pages into a knowledge category.</p>}</div><span className="add-section">Skills &amp; MCP servers</span><div className="add-context">{matchCommands(imported, contextQuery).map((item) => <button type="button" className="slash-row" key={`${item.kind}-${item.id}`} title={item.detail} disabled={locked} onClick={() => { if (item.kind === "skill") { void window.emma.selectImportedSkill({ id: item.id, threadId: thread.id }).then(setSkill).catch(() => undefined); closeSources(); } else openCapabilities(); }}><strong>{item.kind === "skill" ? "Skill" : "MCP"} · {item.name}</strong><small>{item.detail}</small></button>)}{!imported.length && <p className="project-empty">Nothing imported yet — use /import to scan this Mac.</p>}</div><button type="button" className="add-row kind-capability" onClick={() => openCapabilities()}><b>⌘</b><div><strong>Imported skills &amp; MCP</strong><small>Attach a skill, or see the MCP servers every turn is handed</small></div></button><span className="add-section">Built-in plugins</span><button type="button" className="add-row kind-agent" onClick={() => { closeSources(); setAgentOpen(true); }}><b>⌁</b><div><strong>Agent runtime</strong><small>Inspect Emma's Zig harness and headless entry point</small></div></button><div className="add-row muted kind-hint"><b>⌥</b><div><strong>Draw on screen</strong><small>Double-tap left Option, then choose the yellow pen</small></div></div></>}</section>}</form>
    </section></Region>}
    </div>
    <Region name="context" props={{
      thread, messages: thread.messages, ledger, busy: locked, sending, agents, subagents, subthreads, git,
      collapsed: layout.inspectorCollapsed, setCollapsed: (inspectorCollapsed: boolean) => pane({ inspectorCollapsed }),
    }}>
    <aside className={`inspector ${layout.inspectorCollapsed ? "collapsed" : ""}`}>
      {!layout.inspectorCollapsed && <ResizeHandle label="Resize thread inspector" value={layout.inspectorWidth} min={210} max={360} direction={-1} onChange={(inspectorWidth) => pane({ inspectorWidth })} />}
      <button type="button" className="inspector-toggle" aria-label={layout.inspectorCollapsed ? "Expand thread inspector" : "Collapse thread inspector"} aria-expanded={!layout.inspectorCollapsed} onClick={() => pane({ inspectorCollapsed: !layout.inspectorCollapsed })}>{layout.inspectorCollapsed ? "‹" : "›"}</button>
      {!layout.inspectorCollapsed && <div className="inspector-body"><header>
        {/* The label becomes a switch only when there is more than one arrangement
            to switch to; with one, a tablist of one tab is a label wearing a costume.
            Pages are arranged in Settings → Context bar. */}
        {contextPages.length > 1 ? <span className="inspector-tabs" role="tablist" aria-label="Context bar pages">
          {contextPages.map((item) => <button key={item.id} type="button" role="tab" aria-selected={item.id === page.id} title={`${item.name} — ${item.widgets.length} ${plural(item.widgets.length, "component")}`} onClick={() => setContextPage(item.id)}>{item.name}</button>)}
        </span> : <span>{page.name}</span>}
        {changes.length > 0 && <button type="button" className="changes-open" title={`${changes.length} ${plural(changes.length, "file")} changed — open the diff`} onClick={() => setTab("changes")}><ChangeCount stat={diffStat(changes)} /></button>}<button onClick={() => void act("saveToKnowledge", { threadId: thread.id })} disabled={locked || !thread.messages.some((item) => item.role === "assistant")}>Save & analyze</button></header>
      <ContextWidgets page={page} context={{ ledger, threadId: thread.id, sending, subagents, subthreads, agents, onOpenThread: openThreadPage, tab, onPick: setTab, git, onOpenGit: () => setTab("git") }} onChange={(widgets) => onContextPages(contextPages.map((item) => item.id === page.id ? { ...item, widgets } : item))} /></div>}
    </aside></Region>{agentOpen && <AgentDialog thread={thread} close={() => setAgentOpen(false)} />}
  </div>;
}

function AgentDialog({ thread, close }: { thread: Thread; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);
  const dismiss = () => dialog.current?.close();
  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="agent-title" onClose={close} onCancel={(event) => { event.preventDefault(); dismiss(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) dismiss(); }}><section className="agent-dialog"><header><div><span>Thread agent</span><h2 id="agent-title">Emma harness</h2></div><button type="button" onClick={dismiss} aria-label="Close agent details">×</button></header><dl><div><dt>Thread</dt><dd className="copyable"><span>{thread.id}</span><CopyTurn text={thread.id} label="Copy thread ID" /></dd></div><div><dt>Created</dt><dd>{date(thread.createdAt)} · {time(thread.createdAt)}</dd></div><div><dt>Modified</dt><dd>{date(thread.updatedAt)} · {time(thread.updatedAt)}</dd></div><div><dt>Runtime</dt><dd><i /> emma-cli · ACP</dd></div><div><dt>Context</dt><dd>{thread.messages.length} durable {plural(thread.messages.length, "message")} · {thread.sourceKnowledgeBaseIds.length} source {plural(thread.sourceKnowledgeBaseIds.length, "base")}</dd></div><div><dt>Tools</dt><dd>Lazy MCP search; schemas load only after selection</dd></div></dl><div className="agent-cli"><span>Headless entry point</span><code>./harness/zig-out/bin/emma-cli acp</code><p>Run coding or automation threads without Electron. See harness/README.md for the protocol.</p></div></section></dialog>;
}

function PageView(props: { page?: KnowledgePage; snapshot: Snapshot; act: (method: string, params?: Record<string, string>) => Promise<unknown>; busy: boolean; selected?: string; onSelect: (id: string) => void; openThread: (id: string) => void }) {
  // The board is the view; a document takes the whole pane once you press one.
  return <div className="knowledge-layout">
    {props.page
      ? <PageEditor page={props.page} snapshot={props.snapshot} act={props.act} busy={props.busy} openThread={props.openThread} onBack={() => props.onSelect("")} />
      : <KnowledgeBoard snapshot={props.snapshot} onSelect={props.onSelect} act={props.act} busy={props.busy} />}
  </div>;
}

type JsonObject = Record<string, unknown>;

function objectPayload(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function externalArtifactUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

function Spans({ spans }: { spans: Inline[] }) {
  return <>{spans.map((span, index) => {
    if (span.href) return <a key={index} href={span.href} target="_blank" rel="noreferrer">{span.text}</a>;
    if (span.code) return <code key={index}>{span.text}</code>;
    if (span.bold) return <strong key={index}>{span.text}</strong>;
    if (span.italic) return <em key={index}>{span.text}</em>;
    return <span key={index}>{span.text}</span>;
  })}</>;
}

/** Markdown authored by the agent is read as structure, not printed with its syntax showing. */
function RichArtifact({ markdown }: { markdown: string }) {
  const nodes = useMemo(() => parseMarkdown(markdown), [markdown]);
  return <div className="artifact-rich">{nodes.map((node, index) => {
    if (node.kind === "heading") {
      const Heading = `h${Math.min(node.level + 2, 6)}` as "h3";
      return <Heading key={index}><Spans spans={node.spans} /></Heading>;
    }
    if (node.kind === "list") {
      const List = node.ordered ? "ol" : "ul";
      return <List key={index}>{node.items.map((item, itemIndex) => <li key={itemIndex}><Spans spans={item} /></li>)}</List>;
    }
    if (node.kind === "quote") return <blockquote key={index}><Spans spans={node.spans} /></blockquote>;
    if (node.kind === "code") return <pre key={index} className="artifact-code">{node.text}</pre>;
    return <p key={index}><Spans spans={node.spans} /></p>;
  })}</div>;
}

/** The figures worth pinning above the prose that explains them. */
function StatsArtifact({ items }: { items: { label: string; value: string; detail: string }[] }) {
  return <dl className="artifact-stats">{items.map((item, index) => <div key={index}><dt>{item.label}</dt><dd>{item.value}</dd>{item.detail && <small>{item.detail}</small>}</div>)}</dl>;
}

/** Pictures ride in one scrollable strip instead of stacking down the column. */
function ImageCarousel({ blocks }: { blocks: ArtifactBlock[] }) {
  const track = useRef<HTMLDivElement>(null);
  const scroll = (direction: number) => track.current?.scrollBy({ left: direction * track.current.clientWidth * 0.85, behavior: "smooth" });
  return <figure className="artifact-gallery">
    <div className="gallery-track" ref={track} tabIndex={0} role="group" aria-label={`${blocks.length} ${plural(blocks.length, "image")} from this page`}>
      {blocks.map((block) => { const payload = objectPayload(block.payload); return <ImageArtifact key={block.id} asset={textValue(payload.asset)} alt={textValue(payload.alt)} fallback={block.fallback} />; })}
    </div>
    {blocks.length > 1 && <nav className="gallery-nav"><button type="button" onClick={() => scroll(-1)} aria-label="Previous image">‹</button><span>{blocks.length} {plural(blocks.length, "image")}</span><button type="button" onClick={() => scroll(1)} aria-label="Next image">›</button></nav>}
  </figure>;
}

/**
 * A page whose document was never built. What is on disk is the scrape — every nav
 * label and tag the site had — so it is shown as the clip it is: the pictures it came
 * with, the text folded away, and the one button that turns it into a page.
 */
function CapturedClip({ blocks, busy, building, onBuild }: { blocks: ArtifactBlock[]; busy: boolean; building: boolean; onBuild: () => void }) {
  const images = blocks.filter((block) => block.type === "image");
  const clipped = (blocks.find((block) => block.id === "body") ?? blocks.find((block) => block.type !== "image"))?.fallback ?? "";
  return <section className="page-clip" data-building={building || undefined} aria-busy={building}>
    <header><span><i />{building ? "Building document…" : "Raw clip"}</span><button type="button" className="dialog-primary" disabled={busy} onClick={onBuild}>{building ? "Building…" : "Build document"}</button></header>
    {images.length > 0 && <ImageCarousel blocks={images} />}
    <details><summary>What was clipped · {clipped.length.toLocaleString()} characters</summary><pre>{clipped}</pre></details>
  </section>;
}

/** Reading mode: the page as a document, with the lede already shown above it. */
function ArtifactDocument({ blocks, lead = "summary" }: { blocks: ArtifactBlock[]; lead?: string }) {
  return <div className="artifact-document">{documentGroups(blocks, lead).map((group, index) => group.kind === "images"
    ? <ImageCarousel key={`images-${index}`} blocks={group.blocks} />
    : <article className="artifact-block" data-type={group.block.type} key={group.block.id}><ArtifactBlockView block={group.block} /></article>)}</div>;
}

/** The host already validated the data URL; re-check so a bad asset can never become a fetch. */
function usePageAsset(asset: string): string {
  const [loaded, setLoaded] = useState({ asset: "", source: "" });
  useEffect(() => {
    if (!asset) return;
    let live = true;
    void window.emma.request<string>("readPageAsset", { name: asset }).then((value) => { if (live && value.startsWith("data:image/")) setLoaded({ asset, source: value }); }).catch(() => undefined);
    return () => { live = false; };
  }, [asset]);
  // Never hand back the previous page's picture while the new one is loading.
  return loaded.asset === asset ? loaded.source : "";
}

function ImageArtifact({ asset, alt, fallback }: { asset: string; alt: string; fallback: string }) {
  const source = usePageAsset(asset);
  return source ? <img className="artifact-image" src={source} alt={alt || fallback} /> : <pre className="artifact-fallback">{fallback}</pre>;
}

function ArtifactBlockView({ block }: { block: ArtifactBlock }) {
  const payload = objectPayload(block.payload);
  if (block.type === "rich-text" || block.type === "markdown") return <RichArtifact markdown={textValue(payload.markdown) || block.fallback} />;
  if (block.type === "image") return <ImageArtifact asset={textValue(payload.asset)} alt={textValue(payload.alt)} fallback={block.fallback} />;
  if (block.type === "list" || block.type === "bullets") {
    const items = textList(payload.items);
    const List = payload.ordered === true ? "ol" : "ul";
    return items.length ? <List>{items.map((item, index) => <li key={index}>{item}</li>)}</List> : <pre className="artifact-fallback">{block.fallback}</pre>;
  }
  if (block.type === "citations") {
    const items = Array.isArray(payload.items) ? payload.items : [];
    return items.length ? <ul className="artifact-citations">{items.map((item, index) => { const citation = objectPayload(item); const url = externalArtifactUrl(citation.url); return <li key={index}>{url ? <a href={url} target="_blank" rel="noreferrer">{textValue(citation.title) || url} ↗</a> : <span>{textValue(citation.title) || block.fallback}</span>}</li>; })}</ul> : <pre className="artifact-fallback">{block.fallback}</pre>;
  }
  if (block.type === "table") {
    const headers = textList(payload.headers);
    const rows = Array.isArray(payload.rows) ? payload.rows.filter(Array.isArray).map((row) => textList(row)) : [];
    return headers.length ? <div className="artifact-table"><table><thead><tr>{headers.map((header, index) => <th key={index}>{header}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_header, columnIndex) => <td key={columnIndex}>{row[columnIndex] ?? ""}</td>)}</tr>)}</tbody></table></div> : <pre className="artifact-fallback">{block.fallback}</pre>;
  }
  if (block.type === "chart" || block.type === "data") {
    const labels = textList(payload.labels);
    const values = Array.isArray(payload.values) ? payload.values.filter((value): value is number => typeof value === "number") : [];
    const kind = textValue(payload.kind);
    return labels.length && values.length
      ? <Suspense fallback={<pre className="artifact-fallback">{block.fallback}</pre>}><ChartArtifact kind={kind} labels={labels} values={values} caption={textValue(payload.caption)} /></Suspense>
      : <pre className="artifact-fallback">{block.fallback}</pre>;
  }
  if (block.type === "stats") {
    const items = (Array.isArray(payload.items) ? payload.items : []).map((item) => objectPayload(item)).map((item) => ({ label: textValue(item.label), value: textValue(item.value), detail: textValue(item.detail) })).filter((item) => item.label && item.value);
    return items.length ? <StatsArtifact items={items} /> : <pre className="artifact-fallback">{block.fallback}</pre>;
  }
  return <div className="artifact-unknown"><small>Unsupported block · {block.type} v{block.version}</small><pre>{block.fallback}</pre></div>;
}

function editableArtifact(block: ArtifactBlock, value: string): ArtifactBlock {
  if (block.type === "rich-text" || block.type === "markdown") {
    return { ...block, fallback: value, payload: { ...objectPayload(block.payload), markdown: value } };
  }
  if (block.type === "list" || block.type === "bullets") {
    const items = value.split("\n").map((item) => item.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean);
    return { ...block, fallback: value, payload: { ...objectPayload(block.payload), items, ordered: objectPayload(block.payload).ordered === true } };
  }
  return { ...block, fallback: value };
}

function ArtifactEditor({ blocks, setBlocks, busy }: { blocks: ArtifactBlock[]; setBlocks: (blocks: ArtifactBlock[]) => void; busy: boolean }) {
  const update = (index: number, block: ArtifactBlock) => setBlocks(blocks.map((item, itemIndex) => itemIndex === index ? block : item));
  const move = (index: number, delta: number) => { const next = index + delta; if (next < 0 || next >= blocks.length) return; const reordered = [...blocks]; [reordered[index], reordered[next]] = [reordered[next], reordered[index]]; setBlocks(reordered); };
  return <div className="artifact-editor">{blocks.map((block, index) => <fieldset key={block.id}><legend>{block.id} · {block.type} v{block.version}</legend><label>Portable fallback<textarea value={block.fallback} maxLength={65_536} disabled={busy} onChange={(event) => update(index, editableArtifact(block, event.target.value))} /></label>{(block.type === "rich-text" || block.type === "markdown" || block.type === "list" || block.type === "bullets") ? <small className="artifact-edit-help">Editing this fallback updates its declarative payload. Other blocks keep their structured payload and use this text as their export fallback.</small> : <small className="artifact-edit-help">Structured payload is preserved; this text is the portable export fallback.</small>}<div className="artifact-order"><button type="button" disabled={busy || index === 0} onClick={() => move(index, -1)} aria-label={`Move ${block.id} up`}>↑</button><button type="button" disabled={busy || index === blocks.length - 1} onClick={() => move(index, 1)} aria-label={`Move ${block.id} down`}>↓</button></div></fieldset>)}</div>;
}

function artifactMarkdown(blocks: ArtifactBlock[], id: string, fallback: string): string {
  const block = blocks.find((item) => item.id === id);
  const markdown = block ? textValue(objectPayload(block.payload).markdown) : "";
  return markdown || fallback;
}

function PageVersions({ page, act, busy, onRestored }: { page: KnowledgePage; act: (method: string, params?: Record<string, string>) => Promise<unknown>; busy: boolean; onRestored: (page: KnowledgePage) => void }) {
  const [versions, setVersions] = useState<PageVersion[] | null>(null);
  const load = async () => setVersions((await act("listPageVersions", { pageId: page.id }) as PageVersion[] | undefined) ?? []);
  const restore = async (name: string) => {
    const restored = await act("restorePageVersion", { pageId: page.id, name }) as KnowledgePage | undefined;
    if (!restored) return;
    onRestored(restored);
    await load();
  };
  return <details className="page-versions" onToggle={(event) => { if (event.currentTarget.open && versions === null) void load(); }}>
    <summary>Version history</summary>
    {versions === null ? <small>Loading…</small>
      : versions.length === 0 ? <small>No earlier versions yet. Every save keeps the copy it replaced.</small>
      : <ul>{versions.map((version) => <li key={version.name}><span>{version.title}</span><small>{date(version.savedAt)} · {time(version.savedAt)}</small><button type="button" disabled={busy} onClick={() => void restore(version.name)}>Restore</button></li>)}</ul>}
  </details>;
}

function PageConversation({ page, snapshot, act, busy, openThread, onProposal }: { page: KnowledgePage; snapshot: Snapshot; act: (method: string, params?: Record<string, string>) => Promise<unknown>; busy: boolean; openThread: (id: string) => void; onProposal: (blocks: ArtifactBlock[]) => void }) {
  const [draft, setDraft] = useState("");
  // Held here for the same reason the build is: these wait on a model, and the
  // app-wide lock is not theirs to take.
  const [sending, setSending] = useState(false);
  const pending = busy || sending;
  const conversation = snapshot.threads.find((item) => item.id === page.conversationThreadId);
  const send = async (method: "chatAboutPage" | "revisePageDocument") => {
    const instruction = draft.trim();
    if (pending || !instruction) return;
    setSending(true);
    try {
      const result = await act(method, method === "chatAboutPage" ? { pageId: page.id, content: instruction } : { pageId: page.id, instruction });
      if (result === undefined) return;
      setDraft("");
      if (method === "revisePageDocument") onProposal(result as ArtifactBlock[]);
    } finally { setSending(false); }
  };
  return <section className="page-chat">
    <header><span>Document conversation</span>{conversation && <button type="button" disabled={pending} onClick={() => openThread(conversation.id)}>Open in threads</button>}</header>
    <div className="page-chat-log">
      {conversation?.messages.map((message, index) => <p key={index} className={`chat-${message.role}`}><b>{message.role}</b>{message.content}</p>)}
      {!conversation?.messages.length && <small>Ask about this document, or describe a change and Emma will propose a revision you approve.</small>}
    </div>
    <label><span className="sr-only">Message about this document</span><textarea value={draft} disabled={pending} maxLength={16_000} rows={3} placeholder="Ask about this document, or describe a change…" onChange={(event) => setDraft(event.target.value)} /></label>
    <div className="page-chat-actions"><button type="button" disabled={pending || !draft.trim()} onClick={() => void send("chatAboutPage")}>{sending ? "Working…" : "Send"}</button><button type="button" disabled={pending || !draft.trim()} onClick={() => void send("revisePageDocument")}>Propose revision</button></div>
  </section>;
}

function PageEditor({ page, snapshot, act, busy, openThread, onBack }: { page: KnowledgePage; snapshot: Snapshot; act: (method: string, params?: Record<string, string>) => Promise<unknown>; busy: boolean; openThread: (id: string) => void; onBack: () => void }) {
  const base = snapshot.knowledgeBases.find((item) => item.id === page.knowledgeBaseId);
  const [title, setTitle] = useState(page.title);
  const [category, setCategory] = useState(page.category);
  const [blocks, setBlocks] = useState(page.artifacts ?? []);
  const [proposal, setProposal] = useState<ArtifactBlock[] | null>(null);
  const [editing, setEditing] = useState(false);
  // Held locally so building the document changes this pane at once, rather than
  // waiting for the board's next snapshot to say the page is no longer a clip.
  const [model, setModel] = useState(page.telemetry.model);
  const [building, setBuilding] = useState(false);
  const pending = busy || building;
  const clip = model === CAPTURE_MODEL;
  const sourceUrl = externalArtifactUrl(page.context.sourceUrl);
  const [infoOpen, setInfoOpen] = useState(false);
  const info = useRef<HTMLDivElement>(null);
  const infoTrigger = useRef<HTMLButtonElement>(null);
  const closeInfo = useCallback(() => { setInfoOpen(false); queueMicrotask(() => infoTrigger.current?.focus()); }, [setInfoOpen]);
  useEffect(() => {
    if (!infoOpen) return;
    info.current?.focus();
    const outside = (event: PointerEvent) => { if (!info.current?.parentElement?.contains(event.target as Node)) closeInfo(); };
    addEventListener("pointerdown", outside);
    return () => removeEventListener("pointerdown", outside);
  }, [closeInfo, infoOpen]);
  // Turns a raw capture into a document — Emma files it and writes the blocks.
  // Minutes of model, so the wait is held here rather than app-wide: this pane
  // says it is building and the rest of Emma stays usable meanwhile.
  const analyze = async () => {
    if (pending) return;
    setBuilding(true);
    try {
      const next = await act("analyzePage", { pageId: page.id }) as KnowledgePage | undefined;
      if (!next) return;
      setTitle(next.title);
      setCategory(next.category);
      setBlocks(next.artifacts ?? []);
      setModel(next.telemetry.model);
      setProposal(null);
      setEditing(false);
    } finally { setBuilding(false); }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    if (await act("updatePageDocument", { pageId: page.id, title: title.trim(), category: category.trim(), summary: artifactMarkdown(blocks, "summary", page.analysis.summary), body: artifactMarkdown(blocks, "body", page.analysis.body), artifacts: JSON.stringify(blocks) }) !== undefined) setEditing(false);
  };
  return <form className="page page-editor" onSubmit={(event) => void save(event)}><header className="page-head"><div className="page-eyebrow"><button type="button" className="page-back" onClick={onBack}>← Board</button><span>{base?.name} / {clip ? "raw clip" : "artifact document"}</span><button ref={infoTrigger} type="button" className="page-info-button" aria-label="Show page details" aria-haspopup="dialog" aria-expanded={infoOpen} onClick={() => infoOpen ? closeInfo() : setInfoOpen(true)}>i</button>{infoOpen && <div className="page-info" role="dialog" aria-label="Page details" tabIndex={-1} ref={info} onKeyDown={(event) => { if (event.key === "Escape") closeInfo(); }}><header><span>Page details</span><button type="button" aria-label="Close page details" onClick={closeInfo}>×</button></header><dl><div><dt>Added</dt><dd>{date(page.addedAt)} · {time(page.addedAt)}</dd></div><div><dt>Analyzed</dt><dd>{date(page.analyzedAt)} · {time(page.analyzedAt)}</dd></div><div><dt>Model</dt><dd><i />{page.telemetry.model}</dd></div><div><dt>Tokens</dt><dd>{(page.telemetry.inputTokens + page.telemetry.outputTokens).toLocaleString()} total <small>{page.telemetry.inputTokens.toLocaleString()} in · {page.telemetry.outputTokens.toLocaleString()} out</small></dd></div><div><dt>Subagents</dt><dd>{page.telemetry.subagentCount}</dd></div>{page.sourceThreadId && <div><dt>Source thread</dt><dd><code>{page.sourceThreadId}</code></dd></div>}</dl></div>}</div><div className="page-title-row"><label><span className="sr-only">Page title</span><textarea className="page-title" value={title} disabled={pending} maxLength={256} rows={2} onChange={(event) => setTitle(event.target.value)} /></label></div>{!editing && <>{/* A clip has no summary — the first line of the scrape is not one. */}{!clip && <p className="page-summary">{artifactMarkdown(blocks, "summary", page.analysis.summary)}</p>}{sourceUrl &&<p className="page-source"><a href={sourceUrl} target="_blank" rel="noreferrer">{new URL(sourceUrl).hostname} ↗</a>{page.context.sourceApplication ? ` · clipped from ${page.context.sourceApplication}` : ""}</p>}</>}<div className="page-category"><label>Category<input value={category} list="page-categories" disabled={pending} maxLength={64} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" onChange={(event) => setCategory(event.target.value)} /></label><datalist id="page-categories">{(base?.categories ?? []).map((item) => <option key={item} value={item} />)}</datalist><button type="button" className={clip ? "dialog-primary" : ""} disabled={pending} onClick={() => void analyze()}>{building ? "Building…" : clip ? "Build document" : "Rebuild with Emma"}</button><button type="button" disabled={pending} onClick={() => setEditing(!editing)}>{editing ? "Preview document" : "Edit & reorder"}</button>{editing && <button disabled={pending || !title.trim() || !category.trim()}>Save document</button>}</div></header><div className="page-body"><div className="artifact-heading"><small>{blocks.length} / 64 · explicit save only</small></div>{editing ? <ArtifactEditor blocks={blocks} setBlocks={setBlocks} busy={pending} /> : clip ? <CapturedClip blocks={blocks} busy={pending} building={building} onBuild={() => void analyze()} /> : <ArtifactDocument blocks={blocks} />}
    {proposal && <section className="page-proposal"><header><span>Proposed revision · {proposal.length} {plural(proposal.length, "block")}</span><small>Nothing is saved until you accept it and save the document.</small></header><ArtifactDocument blocks={proposal} lead="" /><div className="page-chat-actions"><button type="button" disabled={pending} onClick={() => { setBlocks(proposal); setProposal(null); setEditing(true); }}>Use this revision</button><button type="button" onClick={() => setProposal(null)}>Discard</button></div></section>}
    <PageVersions page={page} act={act} busy={pending} onRestored={(restored) => { setTitle(restored.title); setCategory(restored.category); setBlocks(restored.artifacts ?? []); setProposal(null); setEditing(false); }} />
    <PageConversation page={page} snapshot={snapshot} act={act} busy={pending} openThread={openThread} onProposal={setProposal} />
  </div></form>;
}

const SETTINGS_KEY = "emma.settings.v1";
function readSettings(): UserSettings {
  let settings: UserSettings;
  try { settings = validateSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null")); } catch { settings = structuredClone(defaultSettings); }
  applyFonts(settings);
  return settings;
}

/* Every read applies the faces, and a save dispatches emma-settings-changed,
   which re-reads — so there is no second place that can forget to repaint. */
function applyFonts({ interfaceFont, agentFont }: UserSettings) {
  document.documentElement.style.setProperty("--font-mono", fontStack(interfaceFont));
  document.documentElement.style.setProperty("--font", fontStack(agentFont));
}

function persistSettings(settings: UserSettings): UserSettings {
  const valid = validateSettings(settings);
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(valid));
  dispatchEvent(new Event("emma-settings-changed"));
  return valid;
}

/**
 * Emma's own row: one line item standing for the whole free chain. It is not in
 * anyone's catalog, so it carries its own name, mark, and detail line.
 */
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
  if (key === "fallback") return "Local fallback";
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

/** Who made the model and which route Emma reaches it through, e.g. "Anthropic · via OpenRouter". */
function modelKeyRoute(settings: UserSettings, key: string): string {
  if (key === FREE_ROUTER_KEY) return `${FREE_ROUTER_MODELS.length} free models · via OpenRouter`;
  if (key === "fallback") return "Emma · on this Mac";
  if (key.startsWith("openrouter:")) return `${modelKeyBrand(settings, key)?.label ?? "Community"} · via OpenRouter`;
  if (key.startsWith("local:")) return `${modelKeyBrand(settings, key)?.label ?? "Custom"} · via local server`;
  return "Unknown route";
}

/** The short route qualifier that sits dimmed beside the model name in the composer. A paid OpenRouter route is the default, so it gets no tag. */
const modelKeyTag = (key: string) => key === "fallback" || key.startsWith("local:") ? "Local" : isFreeModel(key) || key === FREE_ROUTER_KEY ? "Free" : "";

const selectedModelLabel = (settings: UserSettings) => modelKeyLabel(settings, settings.selectedModel);
const selectedModelBrand = (settings: UserSettings) => modelKeyBrand(settings, settings.selectedModel);

/**
 * The context window the selected model states, in tokens. Only the OpenRouter
 * catalog states one; the fallback and local routes leave it at zero and their
 * readouts show shares of the send instead.
 */
/**
 * The context window the selected model states, in tokens. Only the OpenRouter
 * catalog states one; the fallback and local routes leave it at zero and their
 * readouts show shares of the send instead.
 */
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

/* The thinking slider, which lives in the model menu because the effort knob
   belongs to the model, not to the message. Its stops are the model's own: three
   for one model, six for the next, none at all for a model that cannot think on
   demand. One hue each, and the fill animates between them rather than snapping:
   the input steps, the bar eases. */
const THINKING_LABELS: Record<ThinkingLevel, string> = { "": "Default", off: "Off", none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Very high", max: "Max" };

function ThinkingSlider({ level, stops, setLevel, disabled }: { level: ThinkingLevel; stops: ThinkingLevel[]; setLevel: (level: ThinkingLevel) => void | Promise<void>; disabled: boolean }) {
  /* Setting the level is a round trip to the main process, so a controlled value
     alone snaps the thumb back to the old stop on every notch and the drag fights
     the cursor. The dragged stop is held here and released once the prop catches up. */
  const [dragged, setDragged] = useState<ThinkingLevel | null>(null);
  const [saved, setSaved] = useState(level);
  if (saved !== level) { setSaved(level); setDragged(null); }
  const shown = dragged !== null && stops.includes(dragged) ? dragged : level;
  const index = Math.max(0, stops.indexOf(shown));
  // A one-stop model has no range to drag; `--stops` is a divisor, so it never hits zero.
  const style = { "--stop": String(index), "--stops": String(Math.max(1, stops.length - 1)) } as CSSProperties;
  // A stop that never lands — the pick was cancelled or refused — is dropped, so the face falls back to the saved level.
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

/**
 * Routes a model key through the host; returns the next settings, or undefined when the
 * host refused. `effort` must be one of the stops the model publishes — the host rejects
 * anything else, so callers without the catalog in hand leave it empty and get the
 * model's own default rather than a refused selection.
 */
async function selectModelKey(settings: UserSettings, key: string, act: (method: string, params?: Record<string, string>) => Promise<unknown>, effort = ""): Promise<UserSettings | undefined> {
  if (key === FREE_ROUTER_KEY) {
    // The chain itself is expanded in main, where the turn is routed. The host still wants
    // one model on its side, so it gets the same primary: the best link still in the catalog.
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
  // Main starts on the default verifier, so a saved one has to be pushed at launch
  // as well as on save — otherwise Auto mode reviews with the wrong model until Settings is opened.
  void window.emma.setVerifier(settings.verifier).catch(() => undefined);
  // Same reason: without this, every tool is on and the advisor unset until Settings opens.
  void window.emma.setToolSettings(settings.tools).catch(() => undefined);
  // Same again: main starts with every context experiment off until this arrives.
  void window.emma.setHarnessExperiments(settings.harnessExperiments).catch(() => undefined);
  void window.emma.setKeybinds(settings.keybinds).catch(() => []);
  // Improvements live in their own store, not in settings — but they need the same
  // push at launch, or a kept lesson does nothing until the Agent page is opened.
  syncImprovements();
}

/* What Emma is built out of, credited in the app and not only in the repo. The
   fork, the vendored binary, and the icon sets each carry an attribution
   obligation of their own; the rest is here because a user reading About should
   see the same stack AGENTS.md and the READMEs describe. */
const credits: { title: string; body: string; href?: string; link?: string }[] = [
  { title: "Electron + React", body: "The sandboxed renderer uses a narrow preload API. Electron owns native windows and a bundled macOS listener owns the Quick Ask gesture. React 19, TypeScript, and Vite build it; Recharts draws every chart." },
  { title: "Rust + Markdown", body: "The Rust host reuses emma-core for thread, knowledge, and provenance rules; Zig 0.16 builds the coding harness." },
  { title: "vercel-labs/fx", body: "Emma's coding harness, emma-cli, is a fork of fx — a minimal Zig agent harness by Vercel. Emma keeps its agent loop, permission model, hooks, skills, subagents, tools, and MCP client. Apache-2.0; the license and upstream notices ship with the fork.", href: "https://github.com/vercel-labs/fx", link: "vercel-labs/fx ↗" },
  { title: "karpathy/autoresearch", body: "Autoresearch jobs are that loop generalised: propose one change, measure the metric, keep it if it improved and revert it if it did not.", href: "https://github.com/karpathy/autoresearch", link: "karpathy/autoresearch ↗" },
  { title: "ripgrep", body: "The ripgrep tool is BurntSushi's ripgrep 14.1.1, vendored as a pinned binary and verified against the SHA-256 its release publishes. MIT / Unlicense.", href: "https://github.com/BurntSushi/ripgrep", link: "BurntSushi/ripgrep ↗" },
  { title: "Model Context Protocol", body: "Imported MCP servers and skills run under Emma's own permission boundary, so tools from other agents work here without a second runtime." },
  { title: "OpenAI-compatible providers", body: "Every remote route is a Chat Completions endpoint — OpenRouter by default, any compatible local or hosted server otherwise. Emma stores the name of an environment variable, never the key." },
  { title: "Brand marks", body: "Vendor icons come from official brand kits where one exists, and otherwise from pinned Simple Icons and lobe-icons revisions (both MIT for the packaging). Each mark stays its owner's trademark.", href: "https://github.com/simple-icons/simple-icons", link: "simple-icons ↗" },
];

type SettingsPage = "actions" | "notch" | "keybinds" | "voice" | "appearance" | "contextbar" | "models" | "prompts" | "tools" | "harness" | "imports" | "connections" | "privacy" | "about";
const settingsPages: { id: SettingsPage; label: string; copy: string; group: string }[] = [
  { id: "actions", label: "Quick actions", copy: "Three overlay shortcuts", group: "Personal" },
  { id: "notch", label: "Notch", copy: "Quick Ask model and tasks", group: "Personal" },
  { id: "keybinds", label: "Keybinds", copy: "System-wide shortcuts", group: "Personal" },
  { id: "voice", label: "Voice", copy: "Dictation and cleanup", group: "Personal" },
  { id: "appearance", label: "Appearance", copy: "Interface and agent fonts", group: "Personal" },
  { id: "contextbar", label: "Context bar", copy: "Arrange the thread inspector", group: "Personal" },
  { id: "models", label: "Models", copy: "Picker, keys, and routes", group: "Personal" },
  { id: "prompts", label: "System prompt", copy: "Global, and per model", group: "Coding" },
  { id: "tools", label: "Tools", copy: "What the agent may call", group: "Integrations" },
  { id: "harness", label: "Harness", copy: "Experimental context hooks", group: "Coding" },
  { id: "imports", label: "Imports & plugins", copy: "Skills and MCP sources", group: "Integrations" },
  { id: "connections", label: "Connections", copy: "Third-party CLI tools", group: "Integrations" },
  { id: "privacy", label: "Data & privacy", copy: "Boundaries and reset", group: "Coding" },
  { id: "about", label: "About Emma", copy: "Build and architecture", group: "Coding" },
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

/* Codes, not `key`: on macOS Option rewrites `key` (⌥2 is “€”), while the code says
   which physical key was struck. */
const KEY_CODES: Record<string, string> = {
  Space: "Space", Enter: "Return", NumpadEnter: "Return", Tab: "Tab", Backspace: "Backspace", Delete: "Delete",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`",
};

/** The struck combination as an Electron accelerator, or null while only modifiers are held. */
function acceleratorFromEvent(event: KeyboardEvent): string | null {
  const key = /^Key([A-Z])$/.exec(event.code)?.[1] ?? /^Digit(\d)$/.exec(event.code)?.[1] ?? (/^F([1-9]|1\d|2[0-4])$/.test(event.code) ? event.code : KEY_CODES[event.code]);
  if (!key) return null;
  const modifiers = [event.metaKey && "Command", event.ctrlKey && "Control", event.altKey && "Alt", event.shiftKey && "Shift"].filter(Boolean) as string[];
  return [...modifiers, key].join("+");
}

function KeybindSettings({ settings, save }: { settings: UserSettings; save: (keybinds: Keybinds) => Promise<string[]> }) {
  const [recording, setRecording] = useState<KeybindAction | "">("");
  const [problem, setProblem] = useState("");
  const [refused, setRefused] = useState<string[]>([]);
  // A lone modifier going down is not yet a binding: it is either a hold in the making
  // or the first half of a chord. Its release is what decides which.
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
    // Capture phase, and preventDefault throughout: while recording, the combination
    // being pressed must not also reach whatever it would normally act on.
    const down = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") { holding.current = ""; setRecording(""); setProblem(""); return; }
      // Modifier alone, with nothing else down: wait to see whether it is held or chorded.
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
  return <div className="settings-lines">{KEYBIND_ACTIONS.map((action) => {
    const keybind = settings.keybinds[action.id];
    const listening = recording === action.id;
    return <section className="keybind-row" key={action.id}>
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

/**
 * Setting voice up, in the order it has to happen.
 *
 * Two servers, because no local one does both halves: speech-to-text turns the
 * recording into words, and S1-mini on oMLX turns those words into written English.
 * Only the first is required — the island dictates without cleanup, it just dictates
 * the way people actually speak, um and all.
 */
function VoiceSettings({ settings, onChange, busy }: { settings: UserSettings; onChange: (next: UserSettings) => void; busy: boolean }) {
  const [heard, setHeard] = useState("");
  const [problem, setProblem] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const dictation = useDictation(settings, setHeard);
  const save = (patch: Partial<UserSettings>) => {
    try { onChange(persistSettings({ ...settings, ...patch })); setProblem(""); }
    catch (reason) { setProblem(reasonText(reason)); }
  };
  // Text fields commit on blur: half a typed URL is not a setting, and validation
  // that runs per keystroke rejects every address on its way to being correct.
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

/**
 * What the notch runs, and what a second press of the shortcut does to what it is
 * already running. Both are the island's own: the workspace picker is untouched
 * by either, which is the point of the page.
 */
function NotchSettings({ settings, onChange, busy }: { settings: UserSettings; onChange: (settings: UserSettings) => void; busy: boolean }) {
  const [catalog, setCatalog] = useState<OpenRouterCatalog>();
  useEffect(() => { void window.emma.request<OpenRouterCatalog>("listOpenRouterModels").then(setCatalog).catch(() => undefined); }, []);
  // The pinned model leads whether or not the catalog has landed, so a saved pin is
  // never shown as an empty box while the list is still on its way.
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

function SettingsView({ page, onSelectPage, busy, ...rest }:{ snapshot: Snapshot; page: SettingsPage; onSelectPage: (page: SettingsPage) => void; act: (method: string, params?: Record<string, string>) => Promise<unknown>; busy: boolean; onModelChanged: (settings: UserSettings) => void }) {
  return <div className="settings-layout"><SettingsNavigation page={page} onSelect={onSelectPage} busy={busy} /><SettingsBody page={page} busy={busy} {...rest} /></div>;
}

function SettingsBody({ snapshot, page, act, busy, onModelChanged }: { snapshot: Snapshot; page: SettingsPage; act: (method: string, params?: Record<string, string>) => Promise<unknown>; busy: boolean; onModelChanged: (settings: UserSettings) => void }) {
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
  const save = (event: FormEvent) => { event.preventDefault(); try { const valid = persistSettings(migrateQuickActionDestinations(settings, snapshot.knowledgeBases)); setSettings(valid); syncMainPreferences(valid); onModelChanged(valid); setSaved(true); } catch { setSaved(false); } };
  const saveModelSettings = (next: UserSettings) => { const valid = persistSettings(next); setSettings(valid); onModelChanged(valid); };
  /* Saved on pick, like the fonts: main decides what the shortcut does to a busy
     island, so the behaviour has to reach it with the pick and not on the next save. */
  const saveNotch = (next: UserSettings) => { const valid = persistSettings(next); setSettings(valid); syncMainPreferences(valid); };
  const saveZeroRetention = async (requireZeroRetention: boolean) => {
    const valid = persistSettings({ ...settings, requireZeroRetention });
    setSettings(valid);
    await window.emma.setZeroRetention(requireZeroRetention);
    // The restart drops the agent's provider selection, so put it back.
    await selectModelKey(valid, valid.selectedModel, act);
    onModelChanged(valid);
  };
  /* Saved on capture, like the fonts: a recorded shortcut is judged by pressing it. */
  const saveKeybinds = async (keybinds: Keybinds) => {
    const valid = persistSettings({ ...settings, keybinds });
    setSettings(valid);
    return await window.emma.setKeybinds(valid.keybinds).catch(() => [] as string[]);
  };
  /* Saved through main rather than beside it: main is what calls the verifier, and
     it validates the endpoint again on the way in, so its answer is the real one. */
  const saveVerifier = async (verifier: VerifierSettings) => {
    const valid = persistSettings({ ...settings, verifier });
    setSettings(valid);
    await window.emma.setVerifier(valid.verifier);
  };
  /* Saved beside the others rather than through main: nothing in main asks for a
     tag on its own, so the route travels with each request and is validated there. */
  const saveTagger = async (tagger: VerifierSettings) => { setSettings(persistSettings({ ...settings, tagger })); };
  /* Saved through main for the same reason as the verifier: main is what reads
     these — it advertises the tools and calls the advisor — and validates them
     again on the way in, so its answer is the real one. */
  const saveTools = async (tools: ToolSettings) => {
    const valid = persistSettings({ ...settings, tools });
    setSettings(valid);
    await window.emma.setToolSettings(valid.tools);
  };
  /* Saved through main like the tools are: main is what hands these to the harness
     with the next prompt, and it validates them again on the way in. */
  const saveHarnessExperiments = async (harnessExperiments: HarnessExperiments) => {
    const valid = persistSettings({ ...settings, harnessExperiments });
    setSettings(valid);
    await window.emma.setHarnessExperiments(valid.harnessExperiments);
  };
  /* Saved on toggle, like the fonts and keybinds: the switch is the whole setting,
     and main re-probes for the binaries when the selection reaches it. */
  const saveConnections = (connections: string[]) => { const valid = persistSettings({ ...settings, connections }); setSettings(valid); syncMainPreferences(valid); };
  /* Saved on every keystroke, like the fonts and the arrangements: main is what
     writes these out for the next turn, and they travel on the one message it
     already receives. A Save button under a prompt editor is a second gesture. */
  const savePrompts = (next: UserSettings) => { const valid = persistSettings(next); setSettings(valid); syncMainPreferences(valid); };
  // Saved on pick, not behind the form's Save: a font is judged by looking at it.
  const saveFont = (field: "interfaceFont" | "agentFont", value: FontChoice) => setSettings(persistSettings({ ...settings, [field]: value }));
  /* Saved on drop, like the fonts and the keybinds: an arrangement is judged by
     looking at it, and a Save button under a drag-and-drop canvas is a second
     gesture for something the first gesture already finished. */
  const saveContextPages = (contextPages: ContextPage[]) => { try { setSettings(persistSettings({ ...settings, contextPages })); } catch { setSettings((current) => ({ ...current, contextPages })); } };
  /* The renderer's own store goes first: main deletes the folder it lives in and
     exits, and a clear here is what stops the leveldb writing settings back out
     on the way. Main takes the rest and relaunches, so this never resolves. */
  const resetData = () => {
    if (!confirm("Delete all Emma data and start fresh?\n\nEvery thread, knowledge page, artifact, connected folder, saved key, and setting on this Mac goes, and Emma restarts empty. This cannot be undone.")) return;
    localStorage.clear();
    void window.emma.resetData();
  };
  if (page === "contextbar") return <section className="settings-view settings-wide"><header><span>Settings / thread inspector</span><h2>Context bar</h2><p>The panel down the right of a thread, as components you arrange. Drag them in and out of the column, reorder them, and lay a component across instead of down. Keep up to {MAX_CONTEXT_PAGES} pages; the bar's own tabs switch between them. The preview is the real components over a made-up thread.</p></header><ContextBarSettings pages={settings.contextPages} onChange={saveContextPages} busy={busy} /></section>;
  if (page === "appearance") return <section className="settings-view"><header><span>Settings / appearance</span><h2>Fonts</h2></header><div className="settings-lines"><section><div><h3>Interface font</h3><p>Everything on the grid: the sidebar, tabs, buttons, model picker, and every label in Settings.</p></div><div className="font-values"><label>Face<select value={settings.interfaceFont} disabled={busy} onChange={(event) => saveFont("interfaceFont", event.target.value as FontChoice)}>{FONT_CHOICES.map((font) => <option key={font.id} value={font.id}>{font.label}</option>)}</select></label><p className="font-sample" style={{ fontFamily: fontStack(settings.interfaceFont) }}>Threads · Knowledge · Agent 0123</p></div></section><section><div><h3>Agent font</h3><p>What the agent writes in a thread, plus the composer you answer it in.</p></div><div className="font-values"><label>Face<select value={settings.agentFont} disabled={busy} onChange={(event) => saveFont("agentFont", event.target.value as FontChoice)}>{FONT_CHOICES.map((font) => <option key={font.id} value={font.id}>{font.label}</option>)}</select></label><p className="font-sample" style={{ fontFamily: fontStack(settings.agentFont) }}>The quick brown fox jumps over the lazy dog.</p></div></section></div></section>;
  if (page === "models") return <section className="settings-view"><header><span>Settings / models &amp; providers</span><h2>Models</h2></header><ModelCatalog settings={settings} onChange={saveModelSettings} act={act} busy={busy} /><LocalModelSettings settings={settings} onChange={saveModelSettings} act={act} busy={busy} /><VerifierPanel settings={settings} onSave={saveVerifier} busy={busy} /><TaggerPanel settings={settings} onSave={saveTagger} busy={busy} /><AdvisorPanel settings={settings} onSave={(advisor) => saveTools({ ...settings.tools, advisor })} busy={busy} /><VisionPanel settings={settings} onSave={(vision) => saveTools({ ...settings.tools, vision })} busy={busy} /><ProviderKeys settings={settings} act={act} busy={busy} /><div className="settings-lines"><section><div><h3>Private routing</h3><p>On, Emma demands endpoints that neither train on nor retain your prompts. OpenRouter offers no free endpoint that qualifies, so every free model fails while this is on — leave it off unless you route to a paid or local model. Changing it restarts the local agent.</p><label className="check"><input type="checkbox" checked={settings.requireZeroRetention} disabled={busy} onChange={(event) => void saveZeroRetention(event.target.checked)} /> Require no-training, zero-retention endpoints (blocks every free model)</label></div></section><section><div><h3>Automatic fallback</h3><p>If the selected model fails — no key, rate limit, provider outage — Emma answers with its deterministic local reply rather than quietly routing your turn to a different model. A local selection never escalates to a provider.</p></div><strong className="status-live"><i /> Always on</strong></section><section><div><h3>Local deterministic profile</h3><p>Without a selected provider, Emma uses its deterministic local fallback. Configure an environment-backed provider with `EMMA_PROVIDER_*` only when you need a remote OpenAI-compatible route.</p></div><strong className="status-live"><i /> Available</strong></section><section><div><h3>Speech to text</h3><p>Dictation runs against local OpenAI-compatible servers and is set up on its own page — the microphone grant, the speech server, and the S1-mini cleanup pass all live in <b>Settings → Voice</b>.</p></div><div className="voice-values"><strong className={settings.transcriptionEnabled ? "status-live" : "status-idle"}><i /> {settings.transcriptionEnabled ? "On" : "Off"}</strong><small>Localhost only</small></div></section></div></section>;
  if (page === "notch") return <section className="settings-view"><header><span>Settings / local to this Mac</span><h2>Notch</h2></header><NotchSettings settings={settings} onChange={saveNotch} busy={busy} /></section>;
  if (page === "voice") return <section className="settings-view"><header><span>Settings / local to this Mac</span><h2>Voice</h2></header><VoiceSettings settings={settings} onChange={saveModelSettings} busy={busy} /></section>;
  if (page === "keybinds") return <section className="settings-view"><header><span>Settings / local to this Mac</span><h2>Keybinds</h2></header><KeybindSettings settings={settings} save={saveKeybinds} /></section>;
  if (page === "prompts") return <section className="settings-view"><header><span>Settings / coding harness</span><h2>System prompt</h2><p>The text every turn opens with. One global prompt, plus as many as you like pinned to a model family or a single model — the pinned ones are read after the global, so they win where the two disagree. Anything in <b>{"{braces}"}</b> is filled in when the turn goes out.</p></header><PromptSettings settings={settings} onChange={savePrompts} busy={busy} /></section>;
  if (page === "tools") return <section className="settings-view"><header><span>Settings / extensions</span><h2>Tools</h2></header><ToolSettingsPanel settings={settings} onChange={saveTools} onDefaultMode={(defaultPermissionMode) => saveModelSettings({ ...settings, defaultPermissionMode })} busy={busy} /></section>;
  if (page === "harness") return <section className="settings-view"><header><span>Settings / coding harness</span><h2>Harness <b className="tag-experimental">Experimental</b></h2></header><HarnessExperimentsPanel settings={settings} onChange={saveHarnessExperiments} busy={busy} /></section>;
  if (page === "imports") return <section className="settings-view"><header><span>Settings / extensions</span><h2>Imports & plugins</h2></header><AgentImports /></section>;
  if (page === "connections") return <section className="settings-view"><header><span>Settings / extensions</span><h2>Connections</h2></header><ConnectionSettings settings={settings} onChange={saveConnections} busy={busy} /></section>;
  if (page === "privacy") return <section className="settings-view"><header><span>Settings / data boundaries</span><h2>Data &amp; privacy</h2></header><div className="settings-lines"><section><div><h3>Start fresh</h3><p>Deletes every thread, knowledge page, artifact, plan, connected folder, saved key, and setting Emma keeps on this Mac, then restarts her empty. The Markdown mirror in your Documents folder is left where it is. This cannot be undone.</p></div><button type="button" className="reset-data" disabled={busy} onClick={resetData}>Reset Emma</button></section></div><div className="settings-lines prose-lines"><section><div><h3>Threads and knowledge stay local</h3><p>Emma stores durable Markdown through the Rust host. Pane layout, quick-action preferences, and an unsent overlay draft stay in Electron’s local application storage.</p></div></section><section><div><h3>Annotated screens remain local</h3><p>The yellow pen captures and compresses a screen image locally. Provider transfer stays disabled until you explicitly authorize sending full-screen images to the selected model endpoint.</p></div></section><section><div><h3>Protected routing remains enforced</h3><p>Selected-model turns request no provider data collection and zero retention. OpenRouter account-level logging and product-improvement settings still apply.</p><a href="https://openrouter.ai/settings/privacy" target="_blank" rel="noreferrer">Review OpenRouter privacy settings ↗</a></div></section><section><div><h3>Nothing saves silently</h3><p>Normal agent requests remain in their thread. Creating or updating knowledge always requires an explicit user action or a quick action configured to save.</p></div></section><section><div><h3>Every run is gated by the mode picker</h3><p>Driving the pointer and keyboard is the <code>computer</code> tool, so the composer’s permission mode decides it: <em>Ask</em> and <em>Accept edits</em> stop for your yes on every call, <em>Auto</em> sends the call to your verifier model, and <em>Full access</em> lets it through. The step ceiling, the action rate limit, the on-screen banner, and the Escape kill switch apply in every mode, and every action is logged.</p></div></section></div></section>;
  if (page === "about") return <section className="settings-view"><header><span>Settings / about</span><h2>Emma</h2></header><div className="settings-lines prose-lines">{credits.map((credit) => <section key={credit.title}><div><h3>{credit.title}</h3><p>{credit.body}</p>{credit.href ? <a href={credit.href} target="_blank" rel="noreferrer">{credit.link}</a> : null}</div></section>)}</div></section>;
  return <form className="settings-view" onSubmit={save}><header><span>Settings / local to this Mac</span><h2>Quick actions</h2></header><section className="notch-settings"><div><h3>Quick Ask hangs off the camera housing</h3><p>Emma measures the real camera housing on each display and wraps the menu bar around it. The gap below is the fallback for Macs and external displays without a housing.</p></div><div className="notch-values"><label>Fallback gap · 120–260 pt<input type="number" min={120} max={260} step={2} value={settings.notchGap} onChange={(event) => setSettings((current) => ({ ...current, notchGap: event.currentTarget.valueAsNumber }))} /></label></div></section><div className="quick-settings">{settings.quickActions.map((action, index) => <section className="quick-action-row" key={index}><div className="shortcut"><kbd>⌘{index + 1}</kbd><span>Overlay action</span></div><div className="quick-fields"><label>Label<input value={action.label} maxLength={40} onChange={(event) => updateAction(index, "label", event.target.value)} /></label><label className="prompt-field">Prompt<textarea value={action.prompt} maxLength={4096} rows={2} onChange={(event) => updateAction(index, "prompt", event.target.value)} /></label><label>Destination<select value={resolveQuickActionDestination(action.destinationKnowledgeBaseId, snapshot.knowledgeBases) ?? ""} onChange={(event) => updateAction(index, "destinationKnowledgeBaseId", event.target.value)}><option value="">Default</option>{snapshot.knowledgeBases.map((base) => <option key={base.id} value={base.id}>{base.name}</option>)}</select></label><label>Category<input value={action.category} placeholder="optional" onChange={(event) => updateAction(index, "category", event.target.value)} /></label><label className="check"><input type="checkbox" checked={action.saveToKnowledge} onChange={(event) => updateAction(index, "saveToKnowledge", event.target.checked)} /> Save analyzed result</label></div></section>)}</div><section className="orb-settings"><div><h3>Orbs you can rearrange</h3><p>The ring opens where the pointer is when Quick Ask does, and the same commands hang under the island when the pointer swipes below it. Pick an orb to change what it runs or where it sits. <b>Save page</b> keeps the page your browser has in front — its text, its favicon, and the pictures it leads with. Emma files captures into a category by itself once one of your categories holds {AUTO_FILE_EXAMPLES} examples to learn from; until then they land unfiled.</p>
      <label className="check"><input type="checkbox" checked={settings.cursorOrbsEnabled} onChange={(event) => setSettings((current) => ({ ...current, cursorOrbsEnabled: event.target.checked }))} /> Ring the cursor when Quick Ask opens</label>
      <label className="check"><input type="checkbox" checked={settings.notchCommandsEnabled} onChange={(event) => setSettings((current) => ({ ...current, notchCommandsEnabled: event.target.checked }))} /> Reveal commands under the island on a swipe</label>
      <div className="orb-fields"><label>Orbs · 1–{MAX_CURSOR_ORBS}<input type="number" min={1} max={MAX_CURSOR_ORBS} value={settings.cursorOrbs.length} onChange={(event) => resizeOrbs(event.currentTarget.valueAsNumber)} /></label>
      <label>Orb {orb + 1} runs<select value={settings.cursorOrbs[orb]} onChange={(event) => setOrbs(settings.cursorOrbs.map((command, index) => index === orb ? event.target.value as CursorCommand : command))}>{CURSOR_COMMANDS.map((command) => <option key={command} value={command}>{orbLabel(command, settings)}</option>)}</select></label>
      <div className="orb-order"><span>Position</span><button type="button" onClick={() => moveOrb(-1)} aria-label="Move orb counter-clockwise">↺</button><button type="button" onClick={() => moveOrb(1)} aria-label="Move orb clockwise">↻</button></div></div></div>
      <div className="orb-preview"><OrbRing commands={settings.cursorOrbs} settings={settings} selected={orb} onPick={setOrb} /></div></section><button className="save-settings">{saved ? "Saved ✓" : "Save settings"}</button></form>;
}

/** Every model takes text, so only the extra inputs get a mark. */
const MODALITY_MARKS: Record<ModelModality, { label: string; path: string }> = {
  image: { label: "Accepts images", path: "M2.5 3.5h11v9h-11zM4 10l2.5-2.5 2 2 2-2L13.5 10" },
  file: { label: "Accepts files", path: "M4 1.5h5.5L12 4v10.5H4zM9.5 1.5V4H12" },
  audio: { label: "Accepts audio", path: "M3.5 6.5h2.5l3.5-3v9l-3.5-3H3.5zM11.5 5.5a4 4 0 0 1 0 5" },
};

/** The stated window, short enough to sit in a row: "200K", "1M". */
const contextMark = new Intl.NumberFormat("en", { notation: "compact" });

const modalityMarks = (modalities: ModelModality[] = []) => modalities
  .filter((modality) => modality in MODALITY_MARKS)
  .map((modality) => <svg key={modality} className="model-modality" viewBox="0 0 16 16" role="img" aria-label={MODALITY_MARKS[modality].label}><title>{MODALITY_MARKS[modality].label}</title><path d={MODALITY_MARKS[modality].path} /></svg>);

type ModelEntry = { key: string; name: string; detail: string; brand?: BrandDefinition; modalities?: ModelModality[]; free?: boolean; context?: number };
type CatalogEntry = ModelEntry & { maker: string };

/**
 * OpenRouter marks its no-cost variants with a `:free` suffix; model keys end with the same ID.
 * The catalog carries the real price flag, so this is only for keys read outside it — the
 * composer's picker, which holds a key and nothing else.
 */
const isFreeModel = (idOrKey: string) => idOrKey.endsWith(":free");
/** Every catalogued model says which it is: a key is what a paid one needs, not a free one. */
const priceBadge = (free: boolean) => free
  ? <span className="model-free">Free</span>
  : <span className="model-paid">Paid</span>;

const localBrand: BrandDefinition = { id: "local", label: "Local models", fallback: "L" };
const allBrand: BrandDefinition = { id: "all", label: "All models", fallback: "∗" };

/** The marks that filter the list: what runs on this Mac, every provider, then the rest. */
const catalogMarks = [["local", "Local models", "Mac"], ...providerMarks, ["other", "Other providers", "Various"]] as const;

/**
 * Every model the page can show, each tagged with the maker whose mark filters it.
 * One flat list: the marks above it are the index, so the rows need no headers.
 */
function modelEntries(localModels: LocalModelProfile[], models: OpenRouterCatalog["models"]): CatalogEntry[] {
  const entries: CatalogEntry[] = [
    // The built-in fallback and your own servers are one maker: both run on this Mac.
    { maker: "local", key: "fallback", name: "Deterministic local fallback", detail: "On this Mac · private drafts and offline routing", brand: localBrand },
    ...localModels.map((profile) => ({ maker: "local", key: `local:${profile.id}`, name: profile.name, detail: `${profile.modelId} · ${profile.baseUrl}`, brand: brandForModel(profile.modelId, "local") ?? localBrand })),
    ...models.map((model) => {
      const brand = brandForModel(model.id, "openrouter");
      return { maker: brand?.id ?? "other", key: `openrouter:${model.id}`, name: model.name, detail: `${model.id} · ${Math.round(model.contextLength / 1000)}K context`, brand, modalities: model.inputModalities, free: model.free, context: model.contextLength };
    }),
  ];
  // What runs on this Mac sorts ahead of every provider route. Sort is stable, so
  // OpenRouter's own order survives inside each maker.
  const order = ["local", ...providerBrands.map((brand) => brand.id), "other"];
  return entries.sort((left, right) => order.indexOf(left.maker) - order.indexOf(right.maker));
}

/**
 * What a reload actually did. An identical list is the common case, and saying so is the
 * difference between a button that worked and a button that looks broken.
 */
function catalogStatus(catalog: OpenRouterCatalog): string {
  if (catalog.stale) return `Offline \u00b7 showing ${catalog.models.length} cached models`;
  const changes = [
    catalog.added?.length ? `${catalog.added.length} new` : "",
    catalog.removed?.length ? `${catalog.removed.length} gone` : "",
  ].filter(Boolean).join(" \u00b7 ");
  return `${catalog.models.length} models \u00b7 ${changes || "no change since the last reload"}`;
}

/** The catalog runs to hundreds of models, so it draws a page at a time. */
const CATALOG_PAGE = 15;

/** How many rows a picker draws before it asks for a narrower search. */
const MODEL_MENU_LIMIT = 30;
/**
 * Free-only is one switch for every picker rather than five: it is a routing
 * choice, so answering it once in the composer is answering it for the verifier
 * and the vision model too. Its own key, not a `UserSettings` field — nothing
 * outside these pickers reads it, and a stray popover write must not race the
 * settings object other views are holding.
 */
const FREE_ONLY_KEY = "emma.freeModelsOnly.v1";
/** The rail slot that filters on starring rather than on a maker. */
const STAR_MARK = "starred";

/** One row of a picker: the model, then who made it, and the star if starring is offered here. */
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
      {/* A catalogued model says its maker; the rows that are not models — off,
          "same as the workspace" — carry no mark and say what they are instead. */}
      <small><BrandIcon brand={entry.brand} className="model-brand" /><span>{entry.brand?.label ?? entry.detail}</span></small>
    </button>
    {/* Drawn even when the model states no window, so the star keeps one column
        down a list that mixes catalogued models with local profiles. */}
    <span className="model-context" title={entry.context ? `${entry.context.toLocaleString()}-token context window` : ""}>{entry.context ? contextMark.format(entry.context) : ""}</span>
    {onStar && <button type="button" className="model-star" aria-pressed={starred} aria-label={`${starred ? "Unstar" : "Star"} ${entry.name}`} title={starred ? "Remove from the composer's picker" : "Show in the composer's picker"} onClick={() => onStar(entry.key)}>{starred ? "★" : "☆"}</button>}
  </div>;
}

/**
 * The model list, drawn the same wherever a model is chosen — the composer, the
 * island, and the second models in Settings. A rail of maker marks down the left
 * filters it, one search runs over the whole catalog rather than the rows on
 * screen, and selection is a fill on the row. The foot is the surface's own
 * (`children`): the effort knob, an error, the way out to the catalog.
 */
function ModelPicker({ entries, active, onPick, busy, favorites, onStar, label, lead, freeRouter, children }: {
  entries: CatalogEntry[];
  active: string;
  onPick: (key: string) => void;
  busy?: boolean;
  /** Offer Emma's free-model chain. Only the picker that routes turns can use it. */
  freeRouter?: boolean;
  /** Starred keys, which also turn on the rail's star slot. Only the app-wide picker has them. */
  favorites?: string[];
  onStar?: (key: string) => void;
  /** What this picker is choosing, for the search box and the rail. */
  label: string;
  /** A row above the list that no filter hides: "off", or "same as the workspace". */
  lead?: ModelEntry;
  children?: ReactNode;
}) {
  const [maker, setMaker] = useState("");
  const [query, setQuery] = useState("");
  // Remembered across opens, unlike the search: a filter that reset every time the
  // popover closed would have to be set again on the way to every model.
  const [freeOnly, setFreeOnly] = useState(() => localStorage.getItem(FREE_ONLY_KEY) === "1");
  const showFree = (on: boolean) => { localStorage.setItem(FREE_ONLY_KEY, on ? "1" : ""); setFreeOnly(on); };
  const search = useRef<HTMLInputElement>(null);
  // The search box takes the focus so the picker opens ready to be typed into.
  useEffect(() => { search.current?.focus(); }, []);
  const starred = favorites ?? [];
  // Everything below reads this rather than `entries`, so the rail's counts and the
  // row cap follow the filter instead of counting rows that are no longer listed.
  const listed = freeOnly ? freeModels(entries, active) : entries;
  const needle = query.trim().toLowerCase();
  const searched = listed.filter((entry) => !needle || `${entry.name} ${entry.key}`.toLowerCase().includes(needle));
  // Counts follow the search, so a mark dims the moment nothing under it can match.
  const counts = new Map<string, number>([[STAR_MARK, searched.filter((entry) => starred.includes(entry.key)).length]]);
  for (const entry of searched) counts.set(entry.maker, (counts.get(entry.maker) ?? 0) + 1);
  // A search can empty the filtered maker; fall back to the whole list rather than
  // to a dead one under a mark that is now dimmed.
  const filter = counts.get(maker) ? maker : "";
  const matched = filter === STAR_MARK ? searched.filter((entry) => starred.includes(entry.key))
    : filter ? searched.filter((entry) => entry.maker === filter)
      : searched;
  // What is chosen leads, then what is starred: the catalog is hundreds of rows
  // long, and the cap below must not be what hides the model already in use.
  const weight = (key: string) => key === active ? 0 : starred.includes(key) ? 1 : 2;
  const shown = [...matched].sort((left, right) => weight(left.key) - weight(right.key)).slice(0, MODEL_MENU_LIMIT);
  // The rail lists every maker the entries cover, dimming rather than dropping the
  // ones the search empties — a rail that reflows while you type moves the mark
  // out from under the pointer.
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
        {/* Free-only is where the chain belongs — it is the answer to "every free model is
            rationed". It stays on while it is what is selected, like any filtered row. */}
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
  // The search runs over the whole catalog, not the page the list happens to be showing.
  const needle = query.trim().toLowerCase();
  const searched = entries.filter((entry) => !needle || `${entry.name} ${entry.key}`.toLowerCase().includes(needle));
  // Counts follow the search, so a mark dims the moment nothing under it can match.
  const counts = new Map<string, number>();
  for (const entry of searched) counts.set(entry.maker, (counts.get(entry.maker) ?? 0) + 1);
  // A reload or a search can empty the filtered maker; fall back to the whole list
  // rather than to a dead one under a mark that is now disabled.
  const filter = counts.has(maker) ? maker : "";
  const matched = filter ? searched.filter((entry) => entry.maker === filter) : searched;
  // Starred first — the picker's six sit on top of whatever else the filter leaves.
  // Sort is stable, so within each half the maker order from modelEntries survives.
  const starWeight = (key: string) => settings.favoriteModels.includes(key) ? 0 : 1;
  const ordered = [...matched].sort((left, right) => starWeight(left.key) - starWeight(right.key));
  const shown = ordered.slice(0, limit);
  // Narrowing the list starts the page over; otherwise a search inherits whatever was expanded.
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
    {/* Emma's own row, above the catalog and outside its filters: it belongs to no maker
        and cannot be starred, because the picker already offers it under Free only. */}
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

/** Only models that can actually see, for the vision tool's picker. */
const seesImages = (model: OpenRouterCatalog["models"][number]) => model.inputModalities?.includes("image") ?? false;

/**
 * The picker every second model shares: Auto mode's verifier, the advisor, and
 * the vision tool.
 *
 * Choosing one of these is choosing a model, not filling in a route — the
 * endpoint and the key name arrive with the choice. The composer's picker, not
 * a `<select>`: a native menu of 300 rows cannot be searched, shows no vendor
 * and no price, and reads nothing like the rest of the app. Three things it
 * still has to get right: a saved model the catalog no longer lists needs its
 * own row or the trigger reads blank on something that is set; `accepts` has to
 * filter that saved row too; and the custom-endpoint escape is the only way to
 * name a route the catalog has never heard of.
 */
/** One editable prompt body: a mirror paints the `{variables}`, the textarea over it takes the typing. */
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

/** What a conditional prompt is pinned to: every model, one family, or one model. */
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

/**
 * Settings → System prompt: the whole prompt, not an addition to one.
 *
 * The global text rides every turn. A conditional one rides only the turns whose
 * model matches it, and is read after the global so the narrower text wins where
 * the two disagree. Forking exists because that is how a per-model prompt is
 * actually written: from the one already working, not from a blank field.
 */
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
  /** What the empty choice means for this model, in its own words. */
  off: string;
  draft: VerifierSettings;
  localModels: LocalModelProfile[];
  onChange: (next: VerifierSettings) => void;
  busy?: boolean;
  /** Which catalog models may be chosen. The vision tool takes only what can see. */
  accepts?: (model: OpenRouterCatalog["models"][number]) => boolean;
}) {
  const [catalog, setCatalog] = useState<OpenRouterCatalog["models"]>([]);
  useEffect(() => { void window.emma.request<OpenRouterCatalog>("listOpenRouterModels").then((loaded) => setCatalog(loaded.models)).catch(() => undefined); }, []);
  // Held rather than derived: a saved route that happens to match OpenRouter reads
  // back as a catalog row, so "Custom endpoint…" needs somewhere to say otherwise.
  const [forced, setForced] = useState(false);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const natural = verifierKey(draft, localModels);
  const picked = forced ? "custom" : natural;
  // A popover over a page that scrolls: anything outside it closes it, same as the composer's.
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
    // A model that is set but no longer catalogued still has to be nameable.
    const saved: CatalogEntry[] = natural === key && !listed.some((model) => `openrouter:${model.id}` === key)
      ? [{ maker: brand?.id ?? "other", key, name: draft.model, detail: "Saved", brand }]
      : [];
    // The deterministic fallback answers nothing, so it is not a route a second model can take.
    return [...saved, ...modelEntries(localModels, listed).filter((entry) => entry.key !== "fallback")];
  }, [catalog, natural, draft.model, accepts, localModels]);
  // The trigger reads its name off the whole list, or a model sitting past the
  // picker's row cap would show as a bare vendor/model-id.
  const chosen = entries.find((row) => row.key === picked);
  const pick = (key: string) => {
    setForced(key === "custom");
    setOpen(false);
    // Custom keeps whatever is in the fields; anything else fills them from the catalog.
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

/**
 * Auto mode's reviewer, which is deliberately not the model doing the work: a
 * second, small, cheap model that reads what you asked for and the call the agent
 * wants to make, and clears it or sends it to you.
 *
 * Three fields, because that is everything an OpenAI-compatible route needs. The
 * key is not one of them — it is named, and stored with the other provider keys.
 */
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

/** Every credential Emma actually reads: its own OpenRouter route, each local profile's env, plus whatever else is stored. */
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
      // Saving restarts the host so the agent inherits the key, which drops its provider selection.
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

/**
 * Everything the agent may reach, in one list of switches. Stored as what is off,
 * so a tool added in a later build arrives on rather than silently missing.
 *
 * ponytail: no search or filter — 24 built-ins and however many skills are
 * imported still fit on a page. Add one when the list needs scrolling to read.
 */
function ToolSettingsPanel({ settings, onChange, onDefaultMode, busy }: { settings: UserSettings; onChange: (tools: ToolSettings) => Promise<void>; onDefaultMode: (mode: PermissionMode) => void; busy: boolean }) {
  const tools = settings.tools;
  const [targets, setTargets] = useState<{ written: ToolTarget[]; skills: ImportedSkill[]; servers: ImportedMcpServer[] }>({ written: [], skills: [], servers: [] });
  const [error, setError] = useState("");
  // Re-read whenever Emma writes a tool or a skill, or installs a server: she can
  // do all three while this page is open, and a stale list is a list that lies.
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

/* One experiment: a checkbox that turns it on at a suggested cadence, and the two
   triggers behind it. Zero is off for both, and setting both means either fires. */
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

/**
 * Settings → Harness: the experimental context-window hooks.
 *
 * These reach the harness as one config option on the next turn, so a change
 * lands on the next thing you send rather than on the next launch. They act on
 * the projection of one step only — durable history is never rewritten — which
 * is what makes them safe to leave on while judging whether they help.
 */
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
  // Switching provider takes that provider's own endpoint and key name with it, so
  // a 4get URL is never left pointing at Brave's API.
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

/** The advisor is a second, stronger model — the same picker the verifier uses. */
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

/**
 * The eyes. The same picker again with one difference that matters: `accepts`
 * keeps it to models with `image` among their input modalities, because a
 * text-only model chosen here fails every call — and out of 335 catalogue rows,
 * choosing one is otherwise very easy to do.
 */
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

/**
 * The filing clerk: the fourth second model, and the only one nothing in a turn
 * calls. It reads the top of an untagged thread and answers with one of the tags
 * the user has applied by hand.
 *
 * The header carries the whole of the mechanism the user needs: how close their
 * own filing is to teaching it one. Nothing files until that count is met, so the
 * count is the setting — the picker below it only decides who does the reading.
 */
function TaggerPanel({ settings, onSave, busy }: { settings: UserSettings; onSave: (tagger: VerifierSettings) => Promise<void>; busy: boolean }) {
  const [draft, setDraft] = useState(settings.tagger);
  const [note, setNote] = useState<{ text: string; bad?: boolean }>({ text: "" });
  const filing = autoTagStatus();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setNote({ text: "" });
    void onSave(draft)
      .then(() => setNote({ text: draft.model ? `${draft.model} files new threads under your tags.` : "No categorizer: threads stay as you tag them." }))
      .catch((reason: unknown) => setNote({ text: reasonText(reason), bad: true }));
  };
  return <section className="local-model-settings">
    <header><div><div className="settings-head"><h3>Categorizer · files a thread under your tags</h3><InfoDot>Right-click any thread in the sidebar to tag it. Once one of your tags holds {AUTO_FILE_EXAMPLES} threads, this model reads the top of every untagged thread and files it under one of them — never a tag you did not make, and never over one you applied by hand. Its guesses are drawn dimmed; retype or empty the field to correct one. Small is the point: the job is one word off a list you wrote.</InfoDot></div><p>Once your own tagging has taught it a category, Emma files new threads into it.</p></div><strong>{filing.ready ? "Filing" : `${filing.category || "no tag"}: ${filing.examples}/${AUTO_FILE_EXAMPLES}`}</strong></header>
    <form className="local-model-form" onSubmit={submit}>
      <SecondModelPicker label="Categorizer model" off="No categorizer · threads stay as you tag them" draft={draft} localModels={settings.localModels} busy={busy} onChange={(next) => { setDraft(next); setNote({ text: "" }); }} />
      <label className="verifier-rules">What it is asked to do<textarea rows={6} maxLength={MAX_VERIFIER_SYSTEM_CHARS} value={draft.system} disabled={busy} onChange={(event) => setDraft({ ...draft, system: event.target.value })} /></label>
      <div className="verifier-rules prompt-footer"><small>{draft.system.length} / {MAX_VERIFIER_SYSTEM_CHARS} characters · your tags and the thread are appended below this</small><button type="button" onClick={() => setDraft({ ...draft, system: defaultTaggerSystem })}>Reset to default</button></div>
      <button disabled={busy}>Save categorizer</button>
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
  /* Detection draws the list; the Homebrew freshness check walks every installed
     formula, so it runs after and only fills the Update buttons in. */
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

function knowledgeTree(directory: string): string {
  const name = directory.split("/").filter(Boolean).pop() ?? "Emma Knowledge";
  return [
    `${name}/`,
    "|- research/",
    "|  `- attention-is-all-you-need.md",
    "|- recipes/",
    "|  `- tartine-country-loaf.md",
    "`- unfiled/",
  ].join("\n");
}

const GRANT_STATES = { on: { mark: "[ok]", title: "Granted" }, off: { mark: "[  ]", title: "Not granted" }, unknown: { mark: "[--]", title: "macOS does not report this one" } };

function SetupMark({ on }: { on: boolean | null | undefined }) {
  const state = on === true ? "on" : on === false ? "off" : "unknown";
  return <i className={`setup-mark ${state}`} title={GRANT_STATES[state].title} role="img" aria-label={GRANT_STATES[state].title}>{GRANT_STATES[state].mark}</i>;
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
  const choose = (mode: "pick" | "default") => {
    setError("");
    void window.emma.setKnowledgeDir(mode).then(setStatus).catch((reason: unknown) => setError(reasonText(reason)));
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
          <h3><SetupMark on={status?.files} />Where knowledge lives<InfoDot>Emma keeps its own copy either way; this folder is the readable one — one Markdown file per saved page, in folders named after your categories. Writing it is what makes macOS ask about your Documents folder.</InfoDot></h3>
          <button type="button" onClick={() => choose("pick")}>Choose folder…</button>
          <div>
            <code>{status?.knowledgeDir || "Mirror switched off"}</code>
            <pre className="setup-art" aria-hidden="true">{knowledgeTree(status?.knowledgeDir ?? "")}</pre>
            {status?.files !== true && <small>macOS has not let Emma write there yet. Grant Files &amp; Folders, then pick the folder again.</small>}
            <div className="setup-choices">
              <button type="button" onClick={() => choose("default")}>Use Documents</button>
              <button type="button" onClick={() => open("files")}>Open Settings ↗</button>
            </div>
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

/**
 * Compact popover anchored to the composer's model button. `pinned` is the island's:
 * a pick writes Quick Ask's own model rather than routing the whole app, so the two
 * pickers stop overwriting each other. Only OpenRouter routes can be pinned to a
 * thread, so nothing else is offered while it is on.
 */
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
    // Models disagree about which efforts they take, and a level that meant "cheap" on one
    // can mean "slow" on the next, so a pick starts at the new model's own default and the
    // slider below is left for the user to set — nothing is carried over.
    const selected = await selectModelKey(settings, key, act);
    if (!selected) return;
    const next = persistSettings({ ...selected, thinkingLevel: "" });
    setSettings(next);
    onSettingsChanged(next);
    // The menu stays open: the thinking stops belong to the model just picked, and
    // closing over them would hide the knob the moment it became meaningful.
  };
  const setThinking = async (thinkingLevel: ThinkingLevel) => {
    if (busy) return;
    const selected = await selectModelKey(settings, settings.selectedModel, act, thinkingLevel);
    if (!selected) return;
    const next = persistSettings({ ...settings, thinkingLevel });
    setSettings(next);
    onSettingsChanged(next);
  };
  // The star on each row, so a model can be pinned from the picker without a trip to the catalog.
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
  // A thread pin is an OpenRouter route or nothing, so the island is offered those alone.
  const entries = useMemo(() => {
    const all = modelEntries(settings.localModels, catalog?.models ?? []);
    const listed = pinned ? all.filter((entry) => entry.key.startsWith("openrouter:")) : all;
    // A key the catalog no longer lists — offline, or a model withdrawn — still has to
    // name itself, or what is in use goes missing from its own picker.
    if (!active || listed.some((entry) => entry.key === active)) return listed;
    const brand = modelKeyBrand(settings, active);
    return [{ maker: brand?.id ?? "other", key: active, name: modelKeyLabel(settings, active), detail: modelKeyRoute(settings, active), brand }, ...listed];
  }, [settings, catalog, pinned, active]);
  return <section className="source-popover model-menu" ref={ref} role="dialog" aria-modal="false" aria-label="Model" tabIndex={-1} onKeyDown={(event) => { if (event.key === "Escape") close(); }}>
    {/* Not on the island: a Quick Ask pin has to be one OpenRouter route, and settings refuse anything else. */}
    <ModelPicker label="models" entries={entries} active={active} busy={busy} favorites={settings.favoriteModels} onStar={star} freeRouter={!pinned} onPick={(key) => void choose(key)}
      /* The way back out of a pinned island: Quick Ask follows the composer's picker again. */
      lead={pinned ? { key: "", name: "Same as the workspace", detail: pinned.key ? selectedModelLabel(settings) : "Active" } : undefined}>
      {/* The knob is shown for whatever is selected, including models that publish no efforts —
          a row that disappears reads as a failed pick, and the pick is what just succeeded. With
          nothing to offer it is the one "Default" stop, drawn but inert. The effort belongs to
          the app's selection; a thread pin carries the model's own default, so the island has none. */}
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
/** Height the attached-capture thumbnail needs, so it is never clipped by the island. */
const ATTACHMENT_BAND = 60;
/** Pause after the last stroke that ends the drawing and attaches it. */
const SETTLE_MS = 700;
/** Band the orbs live in, measured down from the housing; mirrors ISLAND_HEIGHT and .command-orbs. */
const ISLAND_BOTTOM = 97;
const ORB_DROP = 105;
/** Island growth cap; mirrors MAX_TRANSCRIPT in main/overlay.ts. */
const MAX_TRANSCRIPT = 260;
/** A few exchanges in, the quick thread belongs in the full workspace. */
const MIGRATE_AFTER = 6;
/** Header height once the island is off the housing; mirrors POPOUT_BAR in main/overlay.ts. */
const POPOUT_BAR = 28;
/** How long the chip holds its green, and the fade that takes it; mirrors .status-pill in styles/overlay.css. */
const PILL_LINGER_MS = 2400;
const PILL_FADE_MS = 320;

/**
 * Two rows of dither burning off the camera housing: a body along its bottom edge
 * and tongues licking down from it. A travelling wave decides where the flame is
 * tall; a per-cell hash makes it flicker. The hue comes from CSS.
 *
 * The idle hotspot only — it is the affordance that says the housing is a control.
 * Once the island is open the surface says that for itself, and the flame was
 * just colour burning under a box that had a thread in it.
 */
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

/** Camera-housing geometry measured by the main process, in window-relative points. */
function readNotchQuery(fallbackWidth: number) {
  const query = new URLSearchParams(location.search);
  const read = (key: string, fallback: number, min: number, max: number) => {
    const value = Number(query.get(key));
    return Number.isFinite(value) && value >= min && value <= max ? Math.round(value) : fallback;
  };
  return { left: read("notchLeft", 0, 0, 16_384), width: read("notchWidth", fallbackWidth, 40, 600), height: read("notchHeight", 32, 8, 120) };
}

/** A quick action orb takes its name from the action it runs; everything else is fixed. */
export function orbLabel(command: CursorCommand, settings: UserSettings) {
  return /^[012]$/.test(command) ? settings.quickActions[Number(command)].label : cursorCommandNames[command];
}

/** The ring, drawn identically around the cursor and inside Settings. */
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

/** Context ring around the cursor, opened with the island so a command is one flick away. */
function RadialCommands() {
  const settings = useMemo(() => readSettings(), []);
  return <OrbRing commands={settings.cursorOrbs} settings={settings} onPick={(index) => window.emma.sendQuickCommand(settings.cursorOrbs[index])} />;
}

/** Idle affordance: hovering the housing reveals the wave, clicking it opens Quick Ask. */
function NotchHotspot() {
  const [hover, setHover] = useState(false);
  const notch = useMemo(() => readNotchQuery(180), []);
  useEffect(() => window.emma.onNotchHover(setHover), []);
  const style = { "--notch-x": `${notch.left}px`, "--notch-w": `${notch.width}px`, "--notch-h": `${notch.height}px` } as CSSProperties;
  return <button className={`notch-hotspot ${hover ? "open" : ""}`} style={style} onClick={() => window.emma.openOverlay()} aria-label="Open Emma Quick Ask">
    {hover && <NotchWave width={notch.width} busy={false} />}
  </button>;
}

/**
 * Reveals the command orbs while the pointer is inside a triangle that opens from the
 * housing down to the orb row, so a diagonal swipe toward an orb never loses the target.
 */
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

/** The rate the last answer came back at, the same measure the transcript's message meta shows. */
const latestRate = (thread?: Thread) => {
  const generation = thread?.messages.at(-1)?.generation;
  return generation?.durationMilliseconds ? Math.round(generation.outputTokens / generation.durationMilliseconds * 1000) : 0;
};

/** `choices` is a turn that waits on the user: two buttons under what Emma just said. */
type QuickTurn = { role: "user" | "assistant"; content: string; steps?: ThreadStep[]; choices?: { label: string; run: () => void }[] };

/**
 * What Quick Ask leaves behind when the user goes back to their own work mid-ask:
 * one chip, parked wherever they put it, whose colour is the whole report — the
 * accent while the turn runs, red if it broke, green when it lands. Readable from
 * across the screen without being read.
 *
 * A landed turn's chip clears itself after a beat, because the answer is already
 * wherever the user asked for it. A broken one stays: the error is the reason it is
 * still on screen, and it waits to be opened and read.
 */
function StatusPill({ status, label }: { status: "working" | "error" | "done"; label: string }) {
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (status !== "done") return;
    const fade = setTimeout(() => setLeaving(true), PILL_LINGER_MS);
    const gone = setTimeout(() => window.emma.dismissOverlay(), PILL_LINGER_MS + PILL_FADE_MS);
    return () => { clearTimeout(fade); clearTimeout(gone); };
  }, [status]);
  // Parked, not just pressed: the window follows the pointer, and only a press that
  // never travelled counts as opening the island. The grab offset is taken once, so
  // moving the window out from under the pointer cannot feed back into the drag.
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
  const { snapshot, load, error, setError } = useSnapshot();
  const [message, setMessage] = useState(() => localStorage.getItem(OVERLAY_DRAFT_KEY) ?? "");
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(readSettings);
  const [annotationId, setAnnotationId] = useState("");
  const [thumbnail, setThumbnail] = useState("");
  const [attachedApp, setAttachedApp] = useState("");
  const [modelsOpen, setModelsOpen] = useState(false);
  const modelMenu = useRef<HTMLElement>(null);
  // What the open picker actually needs, not what it was guessed to need: its own
  // height changes again when the OpenRouter catalog lands in it.
  const [menuBand, setMenuBand] = useState(0);
  // What this ask is allowed to do. The island opens on Auto — there is nobody
  // sitting in front of a surface that closes on blur, so the verifier answers
  // what it can — and remembers whatever the user picks instead.
  const [mode, setMode] = useState<PermissionMode>(overlayMode);
  const [modesOpen, setModesOpen] = useState(false);
  const modeMenu = useRef<HTMLDivElement>(null);
  const [modeBand, setModeBand] = useState(0);
  // The quick thread is this session's own, created on the first ask. Borrowing the
  // workspace's newest thread linked the notch to it and collided with whatever turn
  // that thread already had in flight.
  const [thread, setThread] = useState<Thread>();
  // Only turns produced by this Quick Ask session are shown. Whatever was said before
  // the notch opened stays in its thread.
  const [turns, setTurns] = useState<QuickTurn[]>([]);
  // Which shape this window is in. Main owns it — it is the one that knows the window
  // lost the pointer to another app — and says so here.
  const [surface, setSurface] = useState<OverlaySurface>("notch");
  const notch = useMemo(() => readNotchQuery(settings.notchGap), [settings.notchGap]);
  const [grow, setGrow] = useState(0);
  const transcript = useRef<HTMLDivElement>(null);
  // The same "/" and "@" the workspace composer offers: imported skills, MCP
  // servers and every built-in tool behind "/", and behind "@" the artifacts, the
  // knowledge pages and the files of every granted folder. The island has no
  // thread to attach anything to until the ask is sent, so what a token names is
  // resolved in send(), against these same lists.
  const { skills, tools, atItems, folders, files } = useTaskCommands(snapshot, settings.tools.disabledTools);
  const [servers, setServers] = useState<SlashCommand[]>([]);
  const [caret, setCaret] = useState(0);
  const [slashPick, setSlashPick] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashBand, setSlashBand] = useState(0);
  const slashMenu = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // What the running turn is doing, while it does it: the answer as it streams and
  // every tool call under it. Main broadcasts both to every window, so the island
  // only has to say which thread is its own.
  const [stream, setStream] = useState<{ text: string; steps: ThreadStep[] }>({ text: "", steps: [] });
  const live = useRef("");
  const liveSteps = useRef<ThreadStep[]>([]);
  // The swipe that reveals the orbs is measured off the housing, so it only means
  // anything while the island is still wrapped around one.
  const orbs = useNotchSwipe(notch, ISLAND_BOTTOM + grow) && settings.notchCommandsEnabled && surface === "notch";
  // Settings → Notch can decouple the island from the composer's picker; until it does,
  // both surfaces read the one selection.
  const modelKey = settings.notchModel || settings.selectedModel;
  const { contextTokens } = useSelectedModel(modelKey);
  /* An island can hold more than one turn at once: the shortcut pressed on a busy one
     starts a task of its own beside it. `busy` gates this session's composer, `session`
     says which session a landing turn belongs to, and main is only told whether
     anything at all is still running in here. */
  const session = useRef(0);
  const running = useRef(0);
  const startRun = useCallback(() => { running.current += 1; window.emma.setOverlayBusy(true); }, []);
  const endRun = useCallback(() => { running.current = Math.max(0, running.current - 1); window.emma.setOverlayBusy(running.current > 0); }, []);
  const rate = latestRate(thread);
  // Whatever is drawn or captured rides along with the next ask; the chip is the way to drop it.
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
      // Reasoning stays out of the island: two lines of a scratchpad would push the
      // answer off a surface this small. An empty delta is the loop restarting on a
      // fallback provider, so it clears what it is about to rewrite.
      if (threadId !== live.current || thinking) return;
      setStream((current) => ({ ...current, text: delta ? current.text + delta : "" }));
    });
    const offStep = window.emma.onStep((step) => {
      if (step.threadId !== live.current) return;
      // Latest status per tool call wins, so a call that finishes replaces its own row.
      liveSteps.current = [...liveSteps.current.filter((item) => item.toolCallId !== step.toolCallId), step];
      setStream((current) => ({ ...current, steps: liveSteps.current }));
    });
    return () => { offDelta(); offStep(); };
  }, []);
  const startStream = useCallback((threadId: string) => { live.current = threadId; liveSteps.current = []; setStream({ text: "", steps: [] }); }, []);
  const endStream = useCallback(() => { live.current = ""; setStream({ text: "", steps: [] }); }, []);
  // Main only ever trusts its own copy of the mode, and it defaults to Ask — so a
  // thread the island created has to be told before its first turn goes out, not
  // on the next render.
  const applyMode = useCallback(async (threadId: string) => {
    setThreadMode(threadId, mode);
    // The island's own model is pinned to the thread it created, which is what keeps it
    // off the workspace's selection; blank unpins, so a thread pinned a moment ago goes
    // back to the picker. A pin the host refuses — a stale catalog — is said out loud
    // rather than swallowed: the turn still goes, on the app's model.
    await window.emma.request("setThreadModel", { threadId, modelId: settings.notchModel.replace(/^openrouter:/, "") })
      .catch((reason: unknown) => setError(reasonText(reason)));
    await window.emma.setThreadContext({ threadId, folderIds: [], mode, model: modelKey }).catch(() => undefined);
  }, [mode, modelKey, setError, settings]);
  useEffect(() => { setOverlayMode(mode); }, [mode]);
  /* The shortcut, pressed while a turn is still running, with Settings → Notch on its
     default: the island comes back empty for a task of its own. The running turn is
     main's, so it carries on and lands in its own thread; only this window's view of
     it ends here. An unsent draft is the user's and is left alone. */
  useEffect(() => window.emma.onNewQuickSession(() => {
    session.current += 1;
    endStream();
    setThread(undefined);
    setTurns([]);
    setBusy(false);
    setError("");
  }), [endStream, setError]);
  // A rung picked mid-thread reaches the turn already in flight, the same way the
  // workspace composer's picker does.
  useEffect(() => { if (thread) void applyMode(thread.id); }, [applyMode, thread]);
  // The menu under the caret: "/" over skills and MCP servers, "@" over files.
  // Picking only writes the token — nothing is attached until the ask is sent.
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
  // `text` is how a notch Emma wrote asks: it has its own composer, so the draft
  // and the box this one types into are not its to clear.
  const send = async (event?: FormEvent, text?: string) => {
    event?.preventDefault();
    const content = (text ?? message).trim();
    if (!content) return;
    if (text === undefined) { localStorage.removeItem(OVERLAY_DRAFT_KEY); setMessage(""); }
    startRun();
    setBusy(true); setError("");
    // Which session this turn belongs to. A turn that lands after the shortcut started
    // a separate task is not this island's any more, and writes nothing back into it.
    const mine = session.current;
    setTurns((list) => [...list, { role: "user", content }]);
    let active = thread;
    const previousMessageCount = active?.messages.length ?? 0;
    try {
      if (!active) { active = await window.emma.request<Thread>("createThread"); if (session.current !== mine) return; setThread(active); }
      await applyMode(active.id);
      if (session.current !== mine) return;
      startStream(active.id);
      // What the composer resolves at the keystroke, the island resolves here: the
      // named skill is attached to this thread, and every named file is read into
      // the same bounded context block a composed turn would carry.
      const named = mentions(content, "/");
      const skill = named.length ? skills.find((item) => named.includes(item.name)) : undefined;
      const attachedSkill = skill ? await window.emma.selectImportedSkill({ id: skill.id, threadId: active.id }).catch(() => undefined) : undefined;
      const paths = mentions(content, "@");
      const picks = atItems.filter((item) => item.pick && paths.includes(item.name)).map((item) => item.pick!);
      const attached = picks.length ? await buildAttachedContext(folders, [], picks, files, snapshot) : { text: "" };
      const turn = await window.emma.request<Thread>("sendMessage", {
        threadId: active.id,
        content,
        ...(attached.text ? { attachedContext: attached.text } : {}),
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
  /* Dictation lands in the composer rather than sending: what came back is a first
     draft of a sentence, and it is worth a glance before it goes. */
  const dictation = useDictation(settings, useCallback((text: string) => setMessage((current) => current ? `${current.trimEnd()} ${text}` : text), []));
  const { listening, working: transcribing, refresh: refreshVoice, start: startVoice, stop: stopVoice } = dictation;
  /* Setting voice up belongs in the workspace, not in the notch: the macOS
     microphone prompt takes focus, and an island that loses focus closes — taking
     the half-finished setup with it. So the island only ever dictates or hands over. */
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
      const destination = resolveQuickActionDestination(action.destinationKnowledgeBaseId, snapshot.knowledgeBases) || snapshot.knowledgeBases[0]?.id || "default";
      await window.emma.request("selectThreadKnowledgeBase", { threadId: created.id, knowledgeBaseId: destination });
      await window.emma.request("selectThreadSources", { threadId: created.id, knowledgeBaseIds: JSON.stringify([destination]) });
      const answered = await window.emma.request<Thread>("sendMessage", { threadId: created.id, content: action.prompt, ...(screenContextId ? { screenContextId } : {}) });
      if (session.current !== mine) return;
      setTurns((list) => [...list, { role: "assistant", content: latestReply(answered), steps: liveSteps.current }]);
      if (screenContextId) { setAnnotationId(""); setThumbnail(""); setAttachedApp(""); }
      if (action.saveToKnowledge) {
        const page = await window.emma.request<KnowledgePage>("saveToKnowledge", { threadId: created.id });
        if (action.category) {
          await window.emma.request("addKnowledgeBaseCategory", { knowledgeBaseId: destination, category: action.category });
          await window.emma.request("updatePage", { pageId: page.id, title: page.title, category: action.category, summary: page.analysis.summary, body: page.analysis.body });
        }
      }
      await load();
    } catch (reason) { if (session.current === mine) setError(reasonText(reason)); }
    finally { endRun(); if (session.current === mine) { endStream(); setBusy(false); } }
  }, [applyMode, busy, endRun, endStream, load, screenContextId, setError, settings, snapshot.knowledgeBases, startRun, startStream]);
  // Push to talk, armed only on an empty composer: a held space bar mid-sentence is
  // a space bar, and the island must never eat one.
  useSpaceHold(settings.voiceHoldMs, dictation.ready && !busy && !transcribing && !message.trim(), dictation);
  useEffect(() => { const listener = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && /^[123]$/.test(event.key)) { event.preventDefault(); void runAction(Number(event.key) - 1); } }; addEventListener("keydown", listener); return () => removeEventListener("keydown", listener); }, [runAction]);
  useEffect(() => { const reload = () => setSettings(readSettings()); addEventListener("storage", reload); addEventListener("focus", reload); return () => { removeEventListener("storage", reload); removeEventListener("focus", reload); }; }, []);
  // What is attached arrives from main: a drawing is finished while this window is
  // hidden, so there is no interaction here to hang a refresh off.
  useEffect(() => {
    const show = (status: { id: string; image: string; source?: { application: string } } | null) => {
      setAnnotationId(status?.id ?? "");
      setThumbnail(status?.image ?? "");
      setAttachedApp(status?.source?.application ?? "");
    };
    void window.emma.screenAnnotationStatus().then(show).catch(() => show(null));
    return window.emma.onScreenContext(show);
  }, []);
  // The island claims height for whatever is open below the composer: the quick
  // thread, the model picker, the "/" menu, and the consent line on an attached
  // capture. The main process clamps the total, after which the transcript
  // scrolls instead.
  useEffect(() => {
    const node = transcript.current;
    if (!node) return;
    const height = Math.min(MAX_TRANSCRIPT, node.scrollHeight + menuBand + modeBand + slashBand + (annotationId ? ATTACHMENT_BAND : 0));
    setGrow(height);
    window.emma.setOverlayHeight(height);
    node.scrollTop = node.scrollHeight;
    // `surface` is a dependency because the transcript is not mounted while this
    // window is a chip: coming back out of one has to claim its height again.
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
  // Off the housing there is no camera to wrap: the header is a plain bar of its own
  // height, and nothing hangs off the notch because there is no notch under it.
  const detached = surface === "popout";
  const overlayStyle ={ "--notch-x": `${notch.left}px`, "--notch-w": `${detached ? 0 : notch.width}px`, "--notch-h": `${detached ? POPOUT_BAR : notch.height}px`, "--island-h": `${ISLAND_BOTTOM + grow}px` } as CSSProperties;
  // The status line says what the turn is doing, not just that it is doing something:
  // the tool call still running, while it runs.
  const working = stream.steps.filter((step) => step.status === "pending" || step.status === "in_progress").at(-1)?.title || "Working";
  const startDrawing = async () => { try { await window.emma.startScreenAnnotation(); } catch (reason) { setError(reasonText(reason)); } };
  /* While the island is decoupled its picker writes its own model, not the app's — the
     whole point of the setting is that picking here does not move the workspace. An
     empty key is the menu's way back to following the composer. */
  const pickModel = useCallback((key: string) => {
    try { setSettings(persistSettings({ ...settings, notchModel: key })); }
    catch (reason) { setError(reasonText(reason)); }
  }, [setError, settings]);
  // What ModelMenu needs of the workspace's `act`: a host call whose failure is
  // reported rather than thrown, since it reads `undefined` as "not selected".
  const act = useCallback(async (method: string, params: Record<string, string> = {}) => {
    try { return await window.emma.request<unknown>(method, params); }
    catch (reason) { setError(reasonText(reason)); return undefined; }
  }, [setError]);
  const clearDrawing = async () => { if (!annotationId) return; await window.emma.clearScreenAnnotation(annotationId); setAnnotationId(""); setThumbnail(""); setAttachedApp(""); };
  // Plain capture: the same annotation pipeline, finished with the untouched frame.
  const captureScreen = useCallback(async () => {
    try {
      const captured = await window.emma.captureScreenContext();
      setThumbnail(captured.image);
      setAnnotationId(captured.id);
      setAttachedApp(captured.source?.application ?? "");
    } catch (reason) { setError(reasonText(reason)); }
  }, [setError]);
  // Stores a clip and builds its document. `pageId` re-reads a page already kept
  // rather than shelving a second copy of the same URL.
  const keepClip = useCallback(async (clip: PageClip, pageId?: string) => {
    startRun();
    setBusy(true); setError("");
    const mine = session.current;
    try {
      const baseId = snapshot.knowledgeBases[0]?.id ?? "default";
      const filing = autoFileStatus(snapshot.pages, baseId);
      const page = await window.emma.request<KnowledgePage>("captureToKnowledge", {
        knowledgeBaseId: baseId,
        category: UNFILED_CATEGORY,
        title: clip.title,
        text: clip.text,
        sourceUrl: clip.url,
        sourceApplication: clip.application,
        ...(clip.images.length ? { images: JSON.stringify(clip.images) } : {}),
        ...(pageId ? { pageId } : {}),
      });
      // The document is always written; only the filing waits for the learned examples.
      const documented = await window.emma.request<KnowledgePage>("analyzePage", { pageId: page.id, ...(filing.ready ? {} : { keepCategory: "true" }) });
      const kept = `${pageId ? "Refreshed" : "Saved"} “${documented.title}” · ${clip.images.length} ${clip.images.length === 1 ? "image" : "images"}`;
      if (session.current !== mine) return;
      setTurns((list) => [...list, { role: "assistant", content: filing.ready
        ? `${kept} · filed under ${documented.category}`
        : `${kept} · left unfiled. Emma files pages by itself once one of your categories has ${AUTO_FILE_EXAMPLES} examples to learn from${filing.category ? ` (${filing.category}: ${filing.examples}/${AUTO_FILE_EXAMPLES})` : ""}.` }]);
      await load();
    } catch (reason) { if (session.current === mine) setError(reasonText(reason)); }
    finally { endRun(); if (session.current === mine) setBusy(false); }
  }, [endRun, load, setError, snapshot.knowledgeBases, snapshot.pages, startRun]);
  // Clips the page the browser had in front: text, favicon, and the pictures it leads with.
  // Emma only files it into a category once the user's own filing has taught it one.
  const clipPage = useCallback(async () => {
    if (busy) return;
    startRun();
    setBusy(true); setError("");
    const mine = session.current;
    setTurns((list) => [...list, { role: "user", content: "Save this page to knowledge" }]);
    try {
      const clip = await window.emma.clipPage();
      const baseId = snapshot.knowledgeBases[0]?.id ?? "default";
      const kept = pageForUrl(snapshot.pages, baseId, clip.url);
      if (session.current !== mine) return;
      // One URL, one page. Which of the two the user meant is theirs to say, so the
      // choice is put to them instead of quietly shelving the same page twice.
      if (kept) {
        setTurns((list) => [...list, { role: "assistant", content: `Already in knowledge as “${kept.title}”${isRawClip(kept) ? " · raw clip, no document built" : ` · filed under ${kept.category}`}.`, choices: [
          { label: "Refresh that page", run: () => void keepClip(clip, kept.id) },
          { label: "Save a second copy", run: () => void keepClip(clip) },
        ] }]);
        return;
      }
      await keepClip(clip);
    } catch (reason) { if (session.current === mine) setError(reasonText(reason)); }
    finally { endRun(); if (session.current === mine) setBusy(false); }
  }, [busy, endRun, keepClip, setError, snapshot.knowledgeBases, snapshot.pages, startRun]);
  const runCommand = useCallback((value: string) => {
    if (value === "voice") { void dictate(); return; }
    if (/^[012]$/.test(value)) void runAction(Number(value));
    else if (value === "page") void clipPage();
    else if (value === "screen") void captureScreen();
    // The capture path already says which permission is missing and where to grant it.
    else if (value === "draw") void window.emma.startScreenAnnotation().catch((reason: unknown) => setError(reasonText(reason)));
    else if (value === "workspace") window.emma.openWorkspace();
  }, [captureScreen, clipPage, dictate, runAction, setError]);
  useEffect(() => window.emma.onQuickCommand(runCommand), [runCommand]);
  // A shortcut that opened the island carries its command in the query, because there was
  // no renderer to send it to yet. Once only: runCommand changes identity as state moves.
  const started = useRef(false);
  useEffect(() => {
    const command = new URLSearchParams(location.search).get("command");
    if (!command || started.current) return;
    started.current = true;
    runCommand(command);
  }, [runCommand]);
  // Collapsed: the same renderer, still holding the turn and everything said so far,
  // drawn as the chip. Every hook above still runs, so the answer lands in a live
  // transcript whether or not anyone is looking at it.
  // Keyed by the state it is in, so a chip that started fading out and then had
  // another turn to report comes back at full strength rather than half gone.
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
      {slashOpen && <section className="source-popover slash-menu" ref={slashMenu} id="island-slash-menu" role="listbox" aria-label={slash?.sigil === "@" ? "Artifacts, knowledge pages and files" : "Built-in tools, skills and MCP servers"}>
        {slashMatches.map((item, index) => <button type="button" role="option" aria-selected={index === slashActive} className={`slash-row ${index === slashActive ? "active" : ""}`} key={`${item.kind}-${item.id}`} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setSlashPick(index)} title={item.detail} onClick={() => pickCommand(item)}><strong>{slash?.sigil ?? "/"}{item.name}</strong><em className="slash-kind" data-kind={item.kind}>{KIND_LABELS[item.kind]}</em><small>{item.detail}</small></button>)}
        {!slashMatches.length && <p className="slash-empty">Nothing matches “{slash?.query}”. {slash?.sigil === "@" ? "Artifacts, knowledge pages and the files of granted folders appear here." : "Built-in tools, imported skills and MCP servers appear here."}</p>}
      </section>}
      <div className="island-thread" ref={transcript}>
        {turns.map((turn, index) => <Fragment key={index}>
          <p className={turn.role}><b>{turn.role === "assistant" ? "Emma" : "You"}</b>{turn.content}</p>
          {turn.steps?.length ? <Steps steps={turn.steps} /> : null}
          {turn.choices?.length ? <div className="turn-choices">{turn.choices.map((choice) => <button type="button" key={choice.label} disabled={busy} onClick={choice.run}>{choice.label}</button>)}</div> : null}
        </Fragment>)}
        {/* The turn as it arrives, the way the workspace transcript shows one: the
            answer as it is written, then every tool call under it. */}
        {busy && <><p className="assistant"><b>Emma</b>{stream.text || "···"}</p><Steps steps={stream.steps} /></>}
        {turns.length >= MIGRATE_AFTER && <button type="button" className="island-migrate" onClick={() => window.emma.openWorkspace()}>Getting long — continue in the full app →</button>}
      </div>
      {modelsOpen && <ModelMenu ref={modelMenu} close={() => setModelsOpen(false)} act={act} busy={busy} onSettingsChanged={setSettings} onManage={() => window.emma.openWorkspace()} pinned={settings.notchModel ? { key: settings.notchModel, onPick: pickModel } : undefined} />}
      {/* The same rows the composer's picker opens, as a band under the foot for
          the same reason the model picker's are: a popover would be clipped by
          this window's own frame. */}
      {modesOpen && <ModeMenu ref={modeMenu} mode={mode} setMode={setMode} close={() => setModesOpen(false)} />}
      <footer className="island-foot">
        <div className="mode-picker" data-mode={mode}><ModeTrigger mode={mode} open={modesOpen} onToggle={() => { setModesOpen((open) => !open); setModelsOpen(false); }} /></div>
        <button type="button" className="model-button" disabled={busy} aria-haspopup="dialog" aria-expanded={modelsOpen} aria-label={`Select model, currently ${modelKeyLabel(settings, modelKey)}${modelKeyTag(modelKey) ? ` · ${modelKeyTag(modelKey)}` : ""}`} onClick={() => { setModelsOpen((open) => !open); setModesOpen(false); }}><BrandIcon brand={modelKeyBrand(settings, modelKey)} className="model-brand" /><span className="model-label">{modelKeyLabel(settings, modelKey)}</span>{modelKeyTag(modelKey) && <em className={`model-route ${modelKeyTag(modelKey) === "Local" ? "local" : "remote"}`}>{modelKeyTag(modelKey)}</em>}<span aria-hidden="true">▾</span></button>
        <span className="island-stats"><span title="Context window of the selected model">{contextTokens ? `${Math.round(contextTokens / 1000)}K ctx` : "— ctx"}</span><span title="Output tokens per second of the last answer">{rate ? `${rate} tok/s` : "— tok/s"}</span></span>
      </footer>
    </div>
    </Region>
    <div className={`command-orbs ${orbs ? "open" : ""}`}>{settings.quickActions.map((action, index) => <button key={index} onClick={() => void runAction(index)} disabled={busy} title={action.prompt}><span className="orb" aria-hidden="true"><kbd>⌘{index + 1}</kbd></span>{action.label}</button>)}</div>
  </main>;
}

export default App;
