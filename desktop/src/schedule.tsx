
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { buildTrigger, describeTrigger, MONTH_NAMES, parseTrigger, triggerProblem, WEEKDAY_NAMES, workflowEdges, workflowRows, type Trigger, type TriggerKind, type WorkflowNode } from "../shared/workflow";
import { insertCommand, KIND_LABELS as SLASH_KINDS, matchCommands, MENU_MAX, slashQuery, type SlashCommand } from "../shared/slash";
import { isWorkspaceWindow } from "./boot";
import { atCommands, toolCommands } from "./context";
import { edgePath, placeRows } from "./layout";
import type { FolderFile, FolderGrant } from "../shared/folders";
import type { ArtifactMeta } from "../shared/artifacts";
import type { ImportedSkill } from "./types";
import type { KeptNote } from "../shared/vault";
import { zoned } from "./dates";

const KIND_LABELS: Record<TriggerKind, string> = {
  minutes: "Every N minutes",
  hourly: "Every N hours",
  daily: "Every N days",
  weekly: "Weekly on…",
  monthly: "Monthly on a date",
  yearly: "Yearly on a date",
  manual: "Only when run by hand",
  cron: "Cron expression",
};

function Picker<T extends string | number>({ value, options, onChange, disabled, label }: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; disabled: boolean; label: string }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = () => { setOpen(false); queueMicrotask(() => trigger.current?.focus()); };
  useEffect(() => { if (open) menu.current?.querySelectorAll<HTMLButtonElement>("[role=option]")[active]?.focus(); }, [open, active]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const node = event.target as Node;
      if (!menu.current?.contains(node) && !trigger.current?.contains(node)) setOpen(false);
    };
    addEventListener("pointerdown", outside);
    return () => removeEventListener("pointerdown", outside);
  }, [open]);
  const keys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); close(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (index + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
      return;
    }
    if (event.key === "Home" || event.key === "End") { event.preventDefault(); setActive(event.key === "Home" ? 0 : options.length - 1); return; }
    if (event.key.length === 1) {
      const wrapped = [...options.slice(active + 1), ...options.slice(0, active + 1)];
      const found = wrapped.find((option) => option.label.toLowerCase().startsWith(event.key.toLowerCase()));
      if (found) { event.preventDefault(); setActive(options.indexOf(found)); }
    }
  };
  const current = options.find((option) => option.value === value);
  return <div className="picker">
    <button ref={trigger} type="button" className="picker-trigger" disabled={disabled}
      aria-haspopup="listbox" aria-expanded={open} aria-label={`${label}, currently ${current?.label ?? "none"}`}
      onClick={() => { if (open) { close(); return; } setActive(Math.max(0, options.findIndex((option) => option.value === value))); setOpen(true); }}>
      <span>{current?.label ?? ""}</span>
      <span aria-hidden="true">▾</span>
    </button>
    {open && !disabled && <div ref={menu} className="source-popover picker-menu" role="listbox" aria-label={label} onKeyDown={keys}>
      {options.map((option, index) => <button type="button" key={String(option.value)} role="option" aria-selected={option.value === value} tabIndex={index === active ? 0 : -1}
        className="add-row picker-row" onClick={() => { onChange(option.value); close(); }}>
        <strong>{option.label}</strong>
        {option.value === value && <em>Chosen</em>}
      </button>)}
    </div>}
  </div>;
}

const KIND_OPTIONS = (Object.keys(KIND_LABELS) as TriggerKind[]).map((kind) => ({ value: kind, label: KIND_LABELS[kind] }));
const MONTH_OPTIONS = MONTH_NAMES.map((name, index) => ({ value: index + 1, label: name }));

const two = (value: number) => String(value).padStart(2, "0");
const hintFormat = zoned({ hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
const clockValue = (trigger: Trigger) => `${two(trigger.hour)}:${two(trigger.minute)}`;

function localHint(hour: number, minute: number): string {
  const now = new Date();
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute));
  return hintFormat(at);
}

export function TriggerPicker({ value, onChange, disabled }: { value: string; onChange: (trigger: string) => void; disabled: boolean }) {
  const trigger = parseTrigger(value);
  const [raw, setRaw] = useState(trigger.kind === "cron");
  if (raw) trigger.kind = "cron";
  const set = (patch: Partial<Trigger>) => onChange(buildTrigger({ ...trigger, ...patch }));
  const problem = triggerProblem(value);
  const time = <label className="trigger-field"><span>At (UTC)</span>
    <input type="time" value={clockValue(trigger)} disabled={disabled} onChange={(event) => {
      const [hour, minute] = event.target.value.split(":").map(Number);
      set({ hour: hour || 0, minute: minute || 0 });
    }} />
    <small>{localHint(trigger.hour, trigger.minute)} your time</small>
  </label>;
  const every = (unit: string, max: number) => <label className="trigger-field"><span>Every</span>
    <input type="number" min={1} max={max} value={trigger.every} disabled={disabled} onChange={(event) => set({ every: Number(event.target.value) })} />
    <small>{unit}</small>
  </label>;
  return <div className="trigger-picker">
    <label className="trigger-field trigger-repeats"><span>Repeats</span>
      <Picker label="Repeats" value={trigger.kind} options={KIND_OPTIONS} disabled={disabled} onChange={(kind) => {
        setRaw(kind === "cron");
        if (kind !== "cron") onChange(buildTrigger({ ...trigger, kind }));
      }} />
    </label>
    {trigger.kind === "minutes" && every("minutes", 59)}
    {trigger.kind === "hourly" && <>{every("hours", 23)}<label className="trigger-field"><span>At minute</span><input type="number" min={0} max={59} value={trigger.minute} disabled={disabled} onChange={(event) => set({ minute: Number(event.target.value) })} /></label></>}
    {trigger.kind === "daily" && <>{every("days", 31)}{time}</>}
    {trigger.kind === "weekly" && <>
      <div className="trigger-field trigger-days" role="group" aria-label="Days of the week">
        <span>On</span>
        <div>{WEEKDAY_NAMES.map((name, day) => <button key={name} type="button" aria-pressed={trigger.weekdays.includes(day)} className={trigger.weekdays.includes(day) ? "active" : ""} disabled={disabled} onClick={() => set({ weekdays: trigger.weekdays.includes(day) ? trigger.weekdays.filter((item) => item !== day) : [...trigger.weekdays, day] })}>{name}</button>)}</div>
      </div>
      {time}
    </>}
    {trigger.kind === "monthly" && <><label className="trigger-field"><span>Day of month</span><input type="number" min={1} max={31} value={trigger.day} disabled={disabled} onChange={(event) => set({ day: Number(event.target.value) })} /><small>a month without this day is skipped</small></label>{time}</>}
    {trigger.kind === "yearly" && <>
      <label className="trigger-field trigger-month"><span>Month</span><Picker label="Month" value={trigger.month} options={MONTH_OPTIONS} disabled={disabled} onChange={(month) => set({ month })} /></label>
      <label className="trigger-field"><span>Day</span><input type="number" min={1} max={31} value={trigger.day} disabled={disabled} onChange={(event) => set({ day: Number(event.target.value) })} /></label>
      {time}
    </>}
    {trigger.kind === "cron" && <label className="trigger-field trigger-wide"><span>Five cron fields, UTC</span><input value={value} maxLength={128} spellCheck={false} disabled={disabled} onChange={(event) => onChange(event.target.value)} placeholder="0 9 * * 1" /><small>minute hour day-of-month month day-of-week</small></label>}
    <p className="trigger-summary"><b>{describeTrigger(value)}</b><code>{value.trim() || "—"}</code></p>
    {problem && <p className="task-problem">{problem}</p>}
  </div>;
}

export function useTaskCommands(disabledTools: readonly string[] = []) {
  const [skills, setSkills] = useState<SlashCommand[]>([]);
  const [notes, setNotes] = useState<KeptNote[]>([]);
  const [folders, setFolders] = useState<FolderGrant[]>([]);
  const [files, setFiles] = useState<Record<string, FolderFile[]>>({});
  const [artifacts, setArtifacts] = useState<ArtifactMeta[]>([]);
  useEffect(() => {
    let active = true;
    if (isWorkspaceWindow) void window.emma.searchImportedSkills({ query: "", limit: 64 })
      .then((imported: ImportedSkill[]) => { if (active) setSkills(imported.map((item) => ({ id: item.id, name: item.name, kind: "skill" as const, detail: `${item.source} · skill` }))); })
      .catch(() => undefined);
    if (isWorkspaceWindow) void window.emma.listFolders().then((granted: FolderGrant[]) => {
      if (!active) return;
      setFolders(granted);
      for (const folder of granted) {
        void window.emma.listFolderFiles(folder.id).then((listing) => { if (active) setFiles((current) => ({ ...current, [folder.id]: listing.files })); }).catch(() => undefined);
      }
    }).catch(() => undefined);
    void window.emma.listNotes().then((list) => { if (active) setNotes(list); }).catch(() => undefined);
    const loadArtifacts = () => void window.emma.listArtifacts().then((list) => { if (active) setArtifacts(list); }).catch(() => undefined);
    loadArtifacts();
    const stopArtifacts = window.emma.onArtifactsChanged(loadArtifacts);
    return () => { active = false; stopArtifacts(); };
  }, []);
  const tools = toolCommands(disabledTools);
  const atItems = useMemo(() => atCommands(artifacts, notes, folders, folders.map((folder) => folder.id), files), [artifacts, notes, folders, files]);
  return { skills, tools, atItems, folders, files };
}

export function PromptField({ value, onChange, commands, atItems, disabled, rows = 3, placeholder, label }: {
  value: string;
  onChange: (text: string) => void;
  commands: SlashCommand[];
  atItems: SlashCommand[];
  disabled: boolean;
  rows?: number;
  placeholder?: string;
  label: string;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const slash = disabled || dismissed ? null : slashQuery(value, caret);
  const matches = slash ? matchCommands(slash.sigil === "@" ? atItems : commands, slash.query).slice(0, MENU_MAX) : [];
  const active = Math.min(pick, matches.length - 1);
  const choose = (command: SlashCommand) => {
    if (!slash) return;
    const next = insertCommand(value, slash, command.name);
    onChange(next.text);
    setPick(0);
    queueMicrotask(() => { input.current?.focus(); input.current?.setSelectionRange(next.caret, next.caret); setCaret(next.caret); });
  };
  const keys = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (!slash) return;
    if (event.key === "Escape") { event.preventDefault(); setDismissed(true); return; }
    if (!matches.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setPick((current) => (Math.min(current, matches.length - 1) + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length); return; }
    if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); choose(matches[active]); }
  };
  return <div className="task-prompt">
    <textarea
      ref={input}
      value={value}
      maxLength={8192}
      rows={rows}
      disabled={disabled}
      role="combobox"
      aria-expanded={slash !== null}
      aria-autocomplete="list"
      aria-label={label}
      placeholder={placeholder}
      onChange={(event) => { onChange(event.target.value); setCaret(event.target.selectionStart ?? event.target.value.length); setDismissed(false); setPick(0); }}
      onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
      onKeyDown={keys}
    />
    {slash && <section className="source-popover slash-menu" role="listbox" aria-label={slash.sigil === "@" ? "Artifacts, saved notes and files" : "Built-in tools and imported skills"}>
      {matches.map((item, index) => <button type="button" role="option" aria-selected={index === active} className={`slash-row ${index === active ? "active" : ""}`} key={`${item.kind}-${item.id}`} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setPick(index)} onClick={() => choose(item)}>
        <strong>{slash.sigil}{item.name}</strong><em className="slash-kind" data-kind={item.kind}>{SLASH_KINDS[item.kind]}</em><small>{item.detail}</small>
      </button>)}
      {!matches.length && <p className="slash-empty">Nothing matches “{slash.query}”. {slash.sigil === "@" ? "Artifacts, saved notes and the files of granted folders appear here." : "Built-in tools and imported skills appear here — use /import in a thread to scan this computer."}</p>}
    </section>}
  </div>;
}

const NODE_WIDTH = 190;
const NODE_HEIGHT = 76;
const GAP_X = 36;
const GAP_Y = 64;
const LANE = 40;
const GRAPH_BOX = { width: NODE_WIDTH, height: NODE_HEIGHT, gapX: GAP_X, gapY: GAP_Y, lane: LANE };
const KIND_HUE = { agent: "var(--blue)", script: "var(--teal)", set: "var(--text-3)", if: "var(--orange)" } as const;
const GLYPHS = { agent: "◆", script: "▶", set: "◇", if: "◈" } as const;
const END_ID = "end";

type Placed = { node?: WorkflowNode; id: string; x: number; y: number };

function place(nodes: WorkflowNode[], rows: string[][], hasEnd: boolean): { placed: Placed[]; width: number; height: number } {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const grid = placeRows(hasEnd ? [...rows, [END_ID]] : rows, { width: NODE_WIDTH, height: NODE_HEIGHT, gapX: GAP_X, gapY: GAP_Y, lane: LANE });
  return { ...grid, placed: grid.placed.map((item) => ({ ...item, node: byId.get(item.id) })) };
}

export function WorkflowGraph({ nodes, errors, selected, onSelect }: {
  nodes: WorkflowNode[];
  errors: string[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  const edges = useMemo(() => workflowEdges(nodes), [nodes]);
  const rows = useMemo(() => workflowRows(nodes, edges), [nodes, edges]);
  const hasEnd = edges.some((edge) => edge.to === END_ID) || !nodes.length;
  const { placed, width, height } = place(nodes, rows, hasEnd);
  const at = new Map(placed.map((item) => [item.id, item]));
  if (!nodes.length) return <p className="graph-empty">This task has no steps yet. Write a prompt, or a node graph, and it draws itself here.</p>;
  return <div className="task-canvas">
    <div className="task-canvas-inner" style={{ width, height }}>
      <svg width={width} height={height} aria-hidden="true">
        <defs><marker id="graph-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--border-strong)" /></marker></defs>
        {edges.map((edge, index) => {
          const from = at.get(edge.from);
          const to = at.get(edge.to);
          if (!from || !to) return null;
          const line = edgePath(from, to, GRAPH_BOX, width);
          const live = selected === edge.from || selected === edge.to;
          return <g key={`${edge.from}-${edge.to}-${index}`} className={live ? "graph-edge live" : "graph-edge"}>
            <path d={line.d} markerEnd="url(#graph-arrow)" />
            {edge.label && <text x={line.labelX} y={line.labelY}>{edge.label}</text>}
          </g>;
        })}
      </svg>
      {placed.map((item) => item.node ? <button
        key={item.id}
        type="button"
        className={`graph-node ${item.node.kind} ${selected === item.id ? "active" : ""}`}
        style={{ left: item.x, top: item.y, width: NODE_WIDTH, height: NODE_HEIGHT, "--node-hue": KIND_HUE[item.node.kind] } as CSSProperties}
        aria-pressed={selected === item.id}
        onClick={() => onSelect(selected === item.id ? "" : item.id)}
      >
        <span className="graph-kind">{GLYPHS[item.node.kind]} {item.node.kind}</span>
        <b>{item.node.id}</b>
        <span className="graph-text">{item.node.text}</span>
        {item.node.saveAs && <em>→ {item.node.saveAs}</em>}
      </button> : <span key={item.id} className="graph-node graph-end" style={{ left: item.x, top: item.y, width: NODE_WIDTH, height: NODE_HEIGHT }}>◼ end of run</span>)}
    </div>
    {errors.map((error) => <p key={error} className="task-problem">{error}</p>)}
  </div>;
}
