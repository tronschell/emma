
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { diffLines, diffStat, tokensPerSecond, type BackgroundTask, type FileChange, type LiveAgent, type PermissionAsk } from "../shared/agents";
import { PERMISSION_MODES, permissionModeGlyphs, permissionModeHints, permissionModeNames, type PermissionMode } from "../shared/permissions";
import { isThinkingLevel, THINKING_LABELS } from "../shared/settings";
import { CaretIcon } from "./icons";
import { plural } from "./plural";
import { OpenIn } from "./editors";
import { ReadMarkdown } from "./preview";
import type { Spawned } from "./threads";
import { reasonText } from "./errors";

export function useAgents(): LiveAgent[] {
  const [agents, setAgents] = useState<LiveAgent[]>([]);
  useEffect(() => {
    void window.emma.listAgents().then(setAgents).catch(() => undefined);
    return window.emma.onAgents(setAgents);
  }, []);
  return agents;
}

const alive = (agent: LiveAgent) => agent.status === "running" || agent.status === "waiting";

const permissionModeMeanings: Record<PermissionMode, string> = {
  ask: "Request permission before making any changes",
  acceptEdits: "Edit files without asking, but ask before running anything",
  auto: "A verifier clears gated calls; app access still asks you",
  full: "Skip file and command approvals; app access still asks you",
};

export function ModeTrigger({ ref, mode, open, disabled, onToggle }: { ref?: RefObject<HTMLButtonElement | null>; mode: PermissionMode; open: boolean; disabled?: boolean; onToggle: () => void }) {
  return <button ref={ref} type="button" className="mode-trigger" disabled={disabled} title={permissionModeHints[mode]}
    aria-haspopup="listbox" aria-expanded={open} aria-label={`Permission mode, currently ${permissionModeNames[mode]}`} onClick={onToggle}>
    <b aria-hidden="true">{permissionModeGlyphs[mode]}</b>
    <span className="mode-label">{permissionModeNames[mode]}</span>
    <span aria-hidden="true">▾</span>
  </button>;
}

export function ModeMenu({ ref, mode, setMode, close }: { ref?: RefObject<HTMLDivElement | null>; mode: PermissionMode; setMode: (mode: PermissionMode) => void; close: () => void }) {
  const [active, setActive] = useState(() => Math.max(0, PERMISSION_MODES.indexOf(mode)));
  const own = useRef<HTMLDivElement>(null);
  useEffect(() => { own.current?.querySelectorAll<HTMLButtonElement>("[role=option]")[active]?.focus(); }, [active]);
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); close(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : PERMISSION_MODES.length - 1;
      setActive((index) => (index + step) % PERMISSION_MODES.length);
      return;
    }
    if (event.key === "Home" || event.key === "End") { event.preventDefault(); setActive(event.key === "Home" ? 0 : PERMISSION_MODES.length - 1); return; }
    if (event.key.length === 1) {
      const found = PERMISSION_MODES.findIndex((value) => permissionModeNames[value].toLowerCase().startsWith(event.key.toLowerCase()));
      if (found >= 0) { event.preventDefault(); setActive(found); }
    }
  };
  return <div ref={(node) => { own.current = node; if (ref) ref.current = node; }} className="source-popover mode-menu" role="listbox" aria-label="Permission mode" onKeyDown={keys}>
    {PERMISSION_MODES.map((value) => <button type="button" key={value} role="option" aria-selected={value === mode} tabIndex={value === PERMISSION_MODES[active] ? 0 : -1}
      className="add-row mode-row" data-mode={value} onClick={() => { setMode(value); close(); }}>
      <b aria-hidden="true">{permissionModeGlyphs[value]}</b>
      <div><strong>{permissionModeNames[value]}</strong><small>{permissionModeMeanings[value]}</small></div>
      {value === mode && <em>Active</em>}
    </button>)}
  </div>;
}

export function ModePicker({ mode, setMode, disabled }: { mode: PermissionMode; setMode: (mode: PermissionMode) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = () => { setOpen(false); queueMicrotask(() => trigger.current?.focus()); };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const node = event.target as Node;
      if (!menu.current?.contains(node) && !trigger.current?.contains(node)) setOpen(false);
    };
    addEventListener("pointerdown", outside);
    return () => removeEventListener("pointerdown", outside);
  }, [open]);
  return <div className="mode-picker" data-mode={mode}>
    <ModeTrigger ref={trigger} mode={mode} open={open} disabled={disabled} onToggle={() => open ? close() : setOpen(true)} />
    {open && !disabled && <ModeMenu ref={menu} mode={mode} setMode={setMode} close={close} />}
  </div>;
}

let askQueue: PermissionAsk[] = [];
const askListeners = new Set<() => void>();
let permissionEventsWired = false;
const publishAsks = (next: PermissionAsk[]) => { askQueue = next; for (const listener of askListeners) listener(); };
const subscribeAsks = (listener: () => void) => {
  if (!permissionEventsWired) {
    permissionEventsWired = true;
    window.emma.onPermissionAsk((ask) => publishAsks([...askQueue, ask]));
    window.emma.onPermissionResolved(({ id }) => publishAsks(askQueue.filter((ask) => ask.id !== id)));
  }
  askListeners.add(listener);
  return () => { askListeners.delete(listener); };
};

export function usePermissionAsk(threadId: string, agents: LiveAgent[]): PermissionAsk | undefined {
  const queue = useSyncExternalStore(subscribeAsks, () => askQueue);
  return queue.find((ask) => ask.threadId === threadId || agents.some((agent) => agent.threadId === ask.threadId && agent.parentThreadId === threadId));
}

export function PermissionPrompt({ ask, agents }: { ask: PermissionAsk; agents: LiveAgent[] }) {
  const from = agents.find((agent) => agent.threadId === ask.threadId);
  const answer = (allowed: boolean) => {
    window.emma.answerPermission({ id: ask.id, allowed });
    publishAsks(askQueue.filter((item) => item.id !== ask.id));
  };
  return <section className="permission-inline" aria-labelledby="permission-title" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); answer(false); } }}>
    <header>
      <div><span>{from ? from.title : "Emma"} · {permissionModeNames[from?.mode ?? "ask"]}</span><h2 id="permission-title">{ask.summary}</h2></div>
      {from && <i className="agent-dot" style={{ background: from.color }} aria-hidden="true" />}
    </header>
    <pre className="permission-detail">{ask.detail}</pre>
    <div className="computer-dialog-actions">
      <button type="button" autoFocus={ask.tool === "computer"} onClick={() => answer(false)}>Don&apos;t</button>
      <button type="button" className="capability-action" autoFocus={ask.tool !== "computer"} onClick={() => answer(true)}>{ask.tool === "computer" ? "Allow for this turn" : "Allow once"}</button>
    </div>
  </section>;
}

export function AgentRail({ agents, active, onPick }: { agents: LiveAgent[]; active?: string; onPick: (agent: LiveAgent) => void }) {
  const live = agents.filter(alive);
  if (!live.length) return null;
  const chip = (agent: LiveAgent) => <button type="button" key={agent.threadId} className={`agent-chip ${agent.threadId === active ? "active" : ""}`} title={`${agent.title} — ${agent.activity}`} onClick={() => onPick(agent)}>
    <i className="agent-dot" style={{ background: agent.color }} data-status={agent.status} aria-hidden="true" />
    <span className="nav-label">{agent.title}</span>
    <small className="nav-label">{agent.activity}</small>
  </button>;
  const branch = (agent: LiveAgent) => {
    const kids = live.filter((other) => other.parentThreadId === agent.threadId);
    return <div key={agent.threadId}>
      {chip(agent)}
      {!!kids.length && <div className="agent-kids" style={{ "--cols": Math.ceil(Math.sqrt(kids.length)) } as CSSProperties}>{kids.map(branch)}</div>}
    </div>;
  };
  const roots = live.filter((agent) => !live.some((other) => other.threadId === agent.parentThreadId));
  return <div className="sidebar-agents">
    <span className="sidebar-label">Agents · {live.length}</span>
    {roots.map(branch)}
  </div>;
}

export function BackgroundRail() {
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [open, setOpen] = useState("");
  const [output, setOutput] = useState("");
  const reload = () => void window.emma.listBackground().then(setTasks).catch(() => undefined);
  useEffect(() => { reload(); return window.emma.onBackground(reload); }, []);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const read = () => void window.emma.readBackground(open).then((found) => {
      if (!live) return;
      setOutput(found?.output ?? "");
      if (!found || found.task.status === "exited") clearInterval(timer);
    }).catch(() => undefined);
    read();
    const timer = setInterval(read, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [open]);
  if (!tasks.length) return null;
  const running = tasks.filter((task) => task.status === "running").length;
  return <div className="sidebar-agents sidebar-background">
    <span className="sidebar-label">Background · {running}</span>
    {tasks.map((task) => <div key={task.id}>
      <div className="background-row">
        <button type="button" className={`agent-chip ${task.id === open ? "active" : ""}`} title={task.command} aria-expanded={task.id === open} onClick={() => { setOutput(""); setOpen(task.id === open ? "" : task.id); }}>
          <i className="agent-dot" style={{ background: task.status === "running" ? "#57c785" : "#6b7280" }} aria-hidden="true" />
          <span className="nav-label">{task.command.split("\n")[0]}</span>
          <small className="nav-label">{task.id} · {task.status === "running" ? task.folder || "running" : `exit ${task.exitCode ?? "—"}`}</small>
        </button>
        {task.status === "running" && <button type="button" className="agent-button nav-label" onClick={() => void window.emma.stopBackground(task.id).then(reload)}>Stop</button>}
      </div>
      {task.id === open && <pre className="background-output">{output.trim() || "(no output yet)"}</pre>}
    </div>)}
  </div>;
}

export type AgentTab = { id: string; label: string; color?: string; icon?: ReactNode; closable: boolean };

export function TabStrip({ tabs, active, onPick, onClose }: { tabs: AgentTab[]; active: string; onPick: (id: string) => void; onClose: (id: string) => void }) {
  if (tabs.length < 2 && tabs.some((tab) => tab.id === active)) return null;
  return <div className="agent-tabs" role="tablist" aria-label="Thread tabs">
    {tabs.map((tab) => <span className={`agent-tab ${tab.id === active ? "active" : ""}`} key={tab.id}>
      <button type="button" role="tab" aria-selected={tab.id === active} onClick={() => onPick(tab.id)}>
        {tab.icon}
        {tab.color && <i className="agent-dot" style={{ background: tab.color }} aria-hidden="true" />}
        {tab.label}
      </button>
      {tab.closable && <button type="button" className="agent-tab-close" aria-label={`Close ${tab.label}`} onClick={() => onClose(tab.id)}>×</button>}
    </span>)}
  </div>;
}

const modelShortName = (model: string) => model.split(":").at(-1)?.split("/").at(-1) || "—";

const thinkingLabel = (effort: string | undefined) => effort === undefined ? "—" : isThinkingLevel(effort) ? THINKING_LABELS[effort] : effort;

function Stat({ label, value, title, wide }: { label: string; value: string; title?: string; wide?: boolean }) {
  return <div className={wide ? "agent-stat wide" : "agent-stat"} title={title ?? value}><dt>{label}</dt><dd>{value}</dd></div>;
}

const elapsed = (agent: LiveAgent) => Math.max(0, Math.round(((agent.endedAt ?? Date.now()) - agent.startedAt) / 1000));

export function AgentPanel({ agent, transcript }: { agent: LiveAgent; transcript: ReactNode }) {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [, tick] = useState(0);
  useEffect(() => {
    if (!alive(agent)) return;
    const timer = setInterval(() => tick((current) => current + 1), 1000);
    return () => clearInterval(timer);
  }, [agent]);
  const steer = (event: FormEvent) => {
    event.preventDefault();
    const text = message.trim();
    if (!text) return;
    setMessage("");
    setError("");
    void window.emma.steerAgent({ threadId: agent.threadId, text }).catch((reason: unknown) => setError(reasonText(reason)));
  };
  const rate = tokensPerSecond(agent);
  const seconds = elapsed(agent);
  return <section className="conversation agent-conversation" aria-label={`Subagent: ${agent.title}`}>
    <header className="thread-bar">
      <h2><i className="agent-dot" style={{ background: agent.color }} aria-hidden="true" /> {agent.title}</h2>
      <div className="thread-actions">
        <span className={`agent-status ${agent.status}`}>{agent.status}</span>
        {alive(agent) && <button type="button" className="agent-button" onClick={() => window.emma.stopAgent(agent.threadId)}>Stop</button>}
      </div>
    </header>
    <dl className="agent-stats">
      <Stat label="Model" value={modelShortName(agent.model)} title={agent.model} />
      <Stat label="Thinking" value={thinkingLabel(agent.effort)} />
      <Stat label="Mode" value={permissionModeNames[agent.mode]} title={permissionModeHints[agent.mode]} />
      <Stat label="Speed" value={rate ? `${rate.toFixed(1)} tok/s` : "—"} />
      <Stat label="Tokens" value={`${agent.inputTokens.toLocaleString()} in · ${agent.outputTokens.toLocaleString()} out`} />
      <Stat label="Tool calls" value={agent.toolCalls.toLocaleString()} />
      <Stat label="Steps" value={`${agent.steps} of the turn`} />
      <Stat label="Elapsed" value={`${seconds} ${plural(seconds, "second")}`} />
      <Stat label="Doing" value={agent.activity} wide />
    </dl>
    {agent.error && <p className="capability-error" role="alert">{agent.error}</p>}
    <div className="transcript">{transcript}</div>
    <form className="composer agent-steer" onSubmit={steer}>
      <label className="sr-only" htmlFor="steer">Steer this agent</label>
      <div className="composer-input">
        <textarea id="steer" value={message} disabled={!alive(agent)} maxLength={4096} rows={2} placeholder={alive(agent) ? "Steer this agent — delivered with its next tool result" : "This agent has finished"} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
      </div>
      <div className="composer-row"><span className="agent-steer-hint">Steering never interrupts a call in flight.</span><button className="composer-send" disabled={!alive(agent) || !message.trim()} aria-label="Steer agent">↑</button></div>
      {error && <p className="capability-error" role="alert">{error}</p>}
    </form>
  </section>;
}

export function ThreadCard({ id, title, onOpen }: { id: string; title: string; onOpen: (id: string) => void }) {
  const agent = useAgents().find((item) => item.threadId === id);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState("");
  const live = !!agent && alive(agent);
  const send = (event: FormEvent) => {
    event.preventDefault();
    const text = message.trim();
    if (!text) return;
    setMessage("");
    setError("");
    setSent(live ? "Sent into the run already going there." : "Sent; this thread is working on it.");
    const delivery = live
      ? window.emma.steerAgent({ threadId: id, text })
      : window.emma.request<unknown>("sendMessage", { threadId: id, content: text });
    void delivery.catch((reason: unknown) => { setSent(""); setError(reasonText(reason)); });
  };
  return <article className="thread-card">
    <header>
      <i className="agent-dot" data-status={agent?.status} style={{ background: agent ? agent.color : "var(--text-3)" }} aria-hidden="true" />
      <strong>{title}</strong>
      <span className={`agent-status ${agent?.status ?? "idle"}`}>{agent?.status ?? "idle"}</span>
      <button type="button" className="agent-button" onClick={() => onOpen(id)}>Open</button>
      {live && <button type="button" className="agent-button" onClick={() => window.emma.stopAgent(id)}>Stop</button>}
    </header>
    <small>{agent?.activity || "Nothing is running in this thread."}</small>
    <form onSubmit={send}>
      <label className="sr-only" htmlFor={`thread-card-${id}`}>Message {title}</label>
      <input id={`thread-card-${id}`} value={message} maxLength={4096}
        placeholder={live ? "Steer this thread" : "Send this thread a message"}
        onChange={(event) => { setMessage(event.target.value); setSent(""); }} />
      <button className="agent-button" disabled={!message.trim()}>Send</button>
    </form>
    {sent && <small className="thread-card-sent">{sent}</small>}
    {error && <p className="capability-error" role="alert">{error}</p>}
  </article>;
}

export function SubagentChips({ spawned, onOpen }: { spawned: Spawned[]; onOpen: (id: string) => void }) {
  const agents = useAgents();
  const working = (item: Spawned) => {
    const agent = agents.find((live) => live.threadId === item.id);
    return !!agent && alive(agent);
  };
  const live = spawned.filter(working);
  const done = spawned.filter((item) => !working(item));
  const chip = (item: Spawned) => {
    const agent = agents.find((live) => live.threadId === item.id);
    const doing = agent && alive(agent) ? agent.activity : item.brief;
    return <button type="button" key={item.id} className="turn-agent" style={{ "--agent": item.color } as CSSProperties} title={item.brief ? `${item.name} — ${item.brief}` : item.name} onClick={() => onOpen(item.id)}>
      <i className="subagent-square" data-status={agent?.status ?? "done"} style={{ background: item.color }} aria-hidden="true" />
      <span>{item.name}</span>
      {doing && <small>{doing}</small>}
    </button>;
  };
  return <div className="turn-agents" aria-label={`${spawned.length} ${plural(spawned.length, "subagent")}`}>
    {live.map(chip)}
    {!!done.length && <details className="turn-agents-done">
      <summary><CaretIcon />{done.length} finished</summary>
      <div className="turn-agents">{done.map(chip)}</div>
    </details>}
  </div>;
}

export function ChangesPanel({ changes, busy, onReverted }: { changes: FileChange[]; busy: boolean; onReverted: () => void }) {
  const [error, setError] = useState("");
  const stat = useMemo(() => diffStat(changes), [changes]);
  const revert = (change: FileChange) => {
    setError("");
    void window.emma.revertChange({ folderId: change.folderId, path: change.path, before: change.before ?? "" })
      .then(onReverted)
      .catch((reason: unknown) => setError(reasonText(reason)));
  };
  return <section className="conversation changes-view" aria-label="Changes">
    <header className="thread-bar">
      <h2>Changes</h2>
      <div className="thread-actions"><ChangeCount stat={stat} /></div>
    </header>
    {error && <p className="capability-error" role="alert">{error}</p>}
    <div className="transcript">
      {!changes.length && <p className="waiting">Nothing has been written from this thread yet.</p>}
      {[...changes].reverse().map((change) => <article className="change-file" key={`${change.folderId}:${change.path}`}>
        <header>
          <strong>{change.path}</strong>
          <ChangeCount stat={diffStat([change])} />
          <OpenIn folderId={change.folderId} path={change.path} />
          <ReadMarkdown folderId={change.folderId} path={change.path} />
          <button type="button" disabled={busy || change.before === null} title={change.before === null ? "Emma created this file — delete it yourself if you don't want it" : "Restore the text from before this turn"} onClick={() => revert(change)}>Revert</button>
        </header>
        <pre className="diff">{diffLines(change.before ?? "", change.after).map((line, index) => <span key={index} className={line.kind === "+" ? "added" : line.kind === "-" ? "removed" : undefined}>{line.kind}{line.text}{"\n"}</span>)}</pre>
      </article>)}
    </div>
  </section>;
}

export function ChangeCount({ stat }: { stat: { added: number; removed: number } }) {
  return <span className="change-count"><b>+{stat.added}</b> <i>-{stat.removed}</i></span>;
}
