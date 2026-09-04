import { useCallback, useEffect, useId, useRef, useState, type DragEvent as ReactDragEvent, type FormEvent, type RefObject } from "react";
import { cliHarness, type CliRun, type CliModels, type CliOptions } from "../shared/cli";
import { Markdown } from "./markdown";
import { brandForImporter } from "./brands";
import { BrandIcon, CloseIcon, ExpandIcon } from "./icons";
import type { HeldAttachment } from "./types";
import { reasonText } from "./errors";

export function useCliRuns(): CliRun[] {
  const [runs, setRuns] = useState<CliRun[]>([]);
  useEffect(() => {
    const reload = () => void window.emma.listCliRuns().then(setRuns).catch(() => undefined);
    reload();
    return window.emma.onCliRuns(reload);
  }, []);
  return runs;
}

function useCliOutput(id: string | undefined, rich = false): string {
  const [seen, setSeen] = useState<{ id?: string; text: string }>({ text: "" });
  useEffect(() => {
    if (!id) return;
    let live = true;
    const read = () => void window.emma.readCliRun(id).then((found) => {
      if (!live) return;
      const text = (rich ? (found?.result || (found?.run.status === "running" ? "" : found?.output)) : found?.output) ?? "";
      setSeen({ id, text: rich && found?.resultTruncated ? `${text}\n\n_Output display shortened. Save large deliverables to a file before handing them off._` : text });
    }).catch(() => undefined);
    read();
    const off = window.emma.onCliRuns(read);
    return () => { live = false; off(); };
  }, [id, rich]);
  return seen.id === id ? seen.text : "";
}

export const cliBrand = (run: CliRun) => brandForImporter(run.cli);
export const cliLabel = (run: CliRun) => cliHarness(run.cli)?.label ?? run.cli;

const turnSeconds = (run: CliRun) =>
  Math.max(0, Math.round(((run.status === "running" ? Date.now() : run.endedAt ?? run.turnStartedAt) - run.turnStartedAt) / 1000));

function useTurnClock(run: CliRun | undefined): number {
  const [, tick] = useState(0);
  useEffect(() => {
    if (run?.status !== "running") return;
    const timer = setInterval(() => tick((current) => current + 1), 1000);
    return () => clearInterval(timer);
  }, [run?.status]);
  return run ? turnSeconds(run) : 0;
}

export function useTailScroll<T extends HTMLElement>(deps: unknown[], resetKey?: unknown) {
  const node = useRef<T>(null);
  const pinned = useRef(true);
  const [end, setEnd] = useState({ key: resetKey, at: true });
  const atEnd = end.key === resetKey ? end.at : true;
  const onScroll = () => {
    const element = node.current;
    if (!element) return;
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    setEnd({ key: resetKey, at: pinned.current });
  };
  useEffect(() => { pinned.current = true; }, [resetKey]);
  useEffect(() => {
    const element = node.current;
    if (!element) return;
    if (pinned.current) element.scrollTop = element.scrollHeight;
    const settling = new ResizeObserver(() => {
      if (pinned.current) element.scrollTop = element.scrollHeight;
      onScroll();
    });
    for (const child of element.children) settling.observe(child);
    return () => settling.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  const toEnd = () => {
    const element = node.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  };
  return { ref: node, onScroll, atEnd, toEnd };
}

export function CliStatus({ run }: { run: CliRun }) {
  const seconds = useTurnClock(run);
  const done = run.status !== "running" && run.status !== "failed";
  const code = run.exitCode;
  return <span className={`cli-state ${run.status}`} title={done ? `${cliLabel(run)} exited with code ${run.exitCode ?? "?"}` : undefined}>
    {run.status === "running" ? `working · ${seconds}s` : run.status === "failed" ? "failed" : code === 0 ? "finished" : `stopped · code ${code ?? "?"}`}
  </span>;
}

export function CliStream({ id, rich }: { id: string; rich: boolean }) {
  const output = useCliOutput(id, rich);
  const { ref, onScroll } = useTailScroll<HTMLDivElement>([output, rich], id);
  const text = output || "Waiting for output…";
  return rich
    ? <div className="pip-prose message-body" ref={ref} onScroll={onScroll}><Markdown text={text} /></div>
    : <pre className="cli-stream" ref={ref as unknown as RefObject<HTMLPreElement>} onScroll={onScroll} aria-live="off">{text}</pre>;
}

function useCliModels(cli: string) {
  const [known, setKnown] = useState<CliModels & { busy: boolean }>();
  const load = useCallback((refresh: boolean) => window.emma.cliModels({ cli, refresh })
    .then((found) => setKnown({ ...found, busy: false }))
    .catch(() => setKnown({ cli, models: [], at: 0, busy: false })), [cli]);
  useEffect(() => { void load(false); }, [load]);
  const ready = known?.cli === cli ? known : undefined;
  const refresh = () => {
    setKnown((current) => (current?.cli === cli ? { ...current, busy: true } : current));
    void load(true);
  };
  return { models: ready?.models ?? [], effortByModel: ready?.effortByModel, at: ready?.at ?? 0, busy: ready?.busy ?? true, refresh };
}

function CliOptionFields({ cli, options, onChange, disabled = false }: { cli: string; options: CliOptions; onChange: (options: CliOptions) => void; disabled?: boolean }) {
  const { models, effortByModel, busy, refresh } = useCliModels(cli);
  const id = useId();
  const harness = cliHarness(cli);
  const efforts = effortByModel?.[options.model ?? ""] ?? harness?.efforts ?? [];
  const selectedEffort = options.effort ?? "";
  const listedEfforts = selectedEffort && !efforts.includes(selectedEffort) ? [selectedEffort, ...efforts] : efforts;
  return <div className="cli-option-fields">
    <label>Model<input list={`${id}-models`} value={options.model ?? ""} maxLength={256} placeholder="Harness default" disabled={disabled} onChange={(event) => onChange({ ...options, model: event.target.value })} /></label>
    <datalist id={`${id}-models`}>{models.map((model) => <option key={model} value={model} />)}</datalist>
    {cli === "opencode" ? <label>Variant<input list={`${id}-efforts`} value={selectedEffort} maxLength={64} placeholder="Harness default" disabled={disabled} onChange={(event) => onChange({ ...options, effort: event.target.value })} /><datalist id={`${id}-efforts`}>{listedEfforts.map((effort) => <option key={effort} value={effort} />)}</datalist></label>
      : <label>Thinking<select value={selectedEffort} disabled={disabled || !harness?.efforts.length} onChange={(event) => onChange({ ...options, effort: event.target.value })}>
        <option value="">{harness?.efforts.length ? "Harness default" : "Managed by harness"}</option>
        {listedEfforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
      </select></label>}
    <div className="cli-options-note"><span>{busy ? "Reading models…" : models.length ? "Choose a model or enter its exact ID." : "Enter an exact model ID or native alias."} {cli === "opencode" ? "Variants depend on the model and your configuration." : !harness?.efforts.length ? "Separate thinking controls are not exposed by this CLI." : "Supported thinking levels depend on the model."}</span><button type="button" disabled={busy || disabled} onClick={refresh}>Refresh</button></div>
  </div>;
}

export function CliModelPicker({ run }: { run: CliRun }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<CliOptions>({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const away = (event: Event) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const save = () => {
    setSaving(true);
    setError("");
    void window.emma.setCliRunModel({ id: run.id, ...options })
      .then(close).catch((reason: unknown) => setError(reasonText(reason))).finally(() => setSaving(false));
  };
  return <span className="pip-model" ref={box} onKeyDown={(event) => { if (event.key === "Escape" && open) { event.stopPropagation(); close(); } }}>
    <button ref={trigger} type="button" className="model-button" disabled={run.status === "running"} aria-haspopup="dialog" aria-expanded={open}
      aria-label={`Model and thinking for ${cliLabel(run)}, currently ${run.model || "harness default"}${run.effort ? `, ${run.effort}` : ""}`}
      onClick={() => { if (open) close(); else { setOptions({ model: run.model ?? "", effort: run.effort ?? "" }); setError(""); setOpen(true); } }}>
      <BrandIcon brand={cliBrand(run)} className={`model-brand cli-mark ${run.cli}`} />
      <span className="model-label">{run.model || "Harness default"}{run.effort ? ` · ${run.effort}` : ""}</span><span aria-hidden="true">▾</span>
    </button>
    {open && <section className="source-popover model-menu cli-options-menu" role="dialog" aria-label={`Model and thinking for ${cliLabel(run)}`}>
      <CliOptionFields cli={run.cli} options={options} onChange={setOptions} disabled={saving || run.status === "running"} />
      {error && <p className="dialog-error" role="alert">{error}</p>}
      <button type="button" className="dialog-primary" disabled={saving || run.status === "running"} onClick={save}>{saving ? "Saving…" : "Apply to next turn"}</button>
    </section>}
  </span>;
}

export function CliComposer({ run, onOpenRun }: { run: CliRun; onOpenRun?: (id: string) => void }) {
  const [message, setMessage] = useState("");
  const [clips, setClips] = useState<HeldAttachment[]>([]);
  const [error, setError] = useState("");
  const working = run.status === "running";
  const hold = (held: HeldAttachment[]) =>
    setClips((current) => [...current, ...held.filter((item) => !current.some((kept) => kept.id === item.id))]);
  const send = (event: FormEvent) => {
    event.preventDefault();
    const text = message.trim();
    const held = clips;
    if (!text && !held.length) return;
    setMessage("");
    setClips([]);
    setError("");
    void window.emma.sendCliRun({ id: run.id, prompt: [text, ...held.map((clip) => clip.path)].filter(Boolean).join("\n") })
      .catch((reason: unknown) => {
        setMessage((current) => current || text);
        setClips(held);
        setError(reasonText(reason));
      });
  };
  const attach = () => void window.emma.attachFiles().then(hold).catch((reason: unknown) => setError(reasonText(reason)));
  const drop = (event: ReactDragEvent<HTMLFormElement>) => {
    event.preventDefault();
    for (const file of event.dataTransfer.files) {
      void file.arrayBuffer()
        .then((data) => window.emma.attachData({ name: file.name, data }))
        .then((held) => hold([held]))
        .catch((reason: unknown) => setError(reasonText(reason)));
    }
  };
  return <div className="cli-footer"><CliHandoff run={run} onOpenRun={onOpenRun} /><form className="composer pip-composer" onSubmit={send} onDragOver={(event) => event.preventDefault()} onDrop={drop}>
    {clips.length > 0 && <div className="pip-clips">{clips.map((clip) => <span key={clip.id} title={clip.path}>
      {clip.name}
      <button type="button" aria-label={`Remove ${clip.name}`} onClick={() => setClips((current) => current.filter((item) => item.id !== clip.id))}><CloseIcon /></button>
    </span>)}</div>}
    <textarea rows={2} value={message} disabled={working} maxLength={32_768}
      aria-label={`Message ${cliLabel(run)}`}
      placeholder={working ? `${cliLabel(run)} is working…` : `Ask ${cliLabel(run)} to continue…`}
      onChange={(event) => setMessage(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
    <div className="composer-row">
      <div className="composer-tools">
        <button type="button" className="source-trigger" disabled={working} aria-label="Attach files" title="Attach files — dropping them here works too" onClick={attach}>＋</button>
      </div>
      <CliModelPicker run={run} />
      <button className="composer-send" disabled={working || (!message.trim() && !clips.length)} aria-label="Send this turn" title="Send this turn">↑</button>
    </div>
    {error && <p className="capability-error" role="alert">{error}</p>}
  </form></div>;
}

function CliHandoff({ run, onOpenRun }: { run: CliRun; onOpenRun?: (id: string) => void }) {
  const runs = useCliRuns();
  const [installed, setInstalled] = useState<{ id: string; label: string }[]>();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState<CliRun>();
  const [selection, setSelection] = useState<{ target: string; options: CliOptions }>();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    void window.emma.installedClis().then(setInstalled).catch((reason: unknown) => setError(reasonText(reason)));
  }, [open]);
  const eligible = runs.filter((other) => other.threadId === run.threadId && other.id !== run.id && other.status !== "running");
  const destination = target.startsWith("cli:") ? installed?.find((cli) => cli.id === target.slice(4)) : eligible.find((other) => other.id === target.slice(4));
  const destinationLabel = destination && ("label" in destination ? destination.label : cliLabel(destination));
  const options = selection?.target === target ? selection.options : destination && "cli" in destination ? { model: destination.model ?? "", effort: destination.effort ?? "" } : { model: "", effort: "" };
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (busy || !destination || !prompt.trim()) return;
    setBusy(true);
    setError("");
    const [kind, id] = target.split(":");
    void window.emma.handoffCliRun({ sourceId: run.id, prompt: prompt.trim(), ...options, ...(kind === "run" ? { id } : { cli: id }) })
      .then((next) => { setSent(next); dialog.current?.close(); setPrompt(""); })
      .catch((reason: unknown) => setError(reasonText(reason)))
      .finally(() => setBusy(false));
  };
  return <div className="cli-handoff">
    <div className="cli-lineage" aria-label="Harness handoffs">
      {run.inputs?.map((input) => <span className="cli-source" key={input.id}>
        <button type="button" disabled={!onOpenRun || !runs.some((other) => other.id === input.id)} onClick={() => onOpenRun?.(input.id)} title={`Open ${input.id}, source turn ${input.turn}`}>
          <BrandIcon brand={brandForImporter(input.cli)} className="cli-mark" />
          {cliHarness(input.cli)?.label ?? input.cli}<small>Turn {input.turn}</small>
        </button><b aria-hidden="true">→</b>
      </span>)}
      <span className="cli-current"><BrandIcon brand={cliBrand(run)} className="cli-mark" />{cliLabel(run)}<small>Turn {run.turns}</small></span>
    </div>
    <button type="button" className="cli-handoff-trigger" disabled={run.status !== "idle" || run.exitCode !== 0} onClick={() => { setError(""); setOpen(true); }}>Hand off output <span aria-hidden="true">↗</span></button>
    {sent && <div className="cli-handoff-sent" role="status"><span>{sent.status === "failed" ? "The next run needs attention" : "Output passed to " + cliLabel(sent)}</span>{onOpenRun && <button type="button" onClick={() => onOpenRun(sent.id)}>Open {cliLabel(sent)} →</button>}</div>}
    {open && <dialog ref={dialog} className="modal-backdrop" aria-labelledby={`handoff-${run.id}`} onClose={() => setOpen(false)}>
      <form className="agent-dialog cli-handoff-dialog" onSubmit={send}>
        <header><div><span>Harness handoff</span><h2 id={`handoff-${run.id}`}>Who takes it from here?</h2></div><button type="button" aria-label="Close handoff" onClick={() => dialog.current?.close()}><CloseIcon /></button></header>
        <div className="cli-handoff-origin"><BrandIcon brand={cliBrand(run)} className="cli-mark" /><div><strong>{cliLabel(run)}<span>Turn {run.turns} · output included</span></strong><p>{run.title}</p></div><b aria-hidden="true">↗</b></div>
        <div className="cli-handoff-fields">
          <fieldset className="cli-destinations" disabled={busy}><legend>Start a new run <span>Default approvals</span></legend>
            {installed === undefined && <p role="status">Finding your installed harnesses…</p>}
            {installed?.length === 0 && <p>No installed harnesses found.</p>}
            <div>{installed?.map((cli) => <label key={cli.id} className="cli-destination">
              <input type="radio" name="destination" value={`cli:${cli.id}`} checked={target === `cli:${cli.id}`} onChange={(event) => setTarget(event.target.value)} />
              <BrandIcon brand={brandForImporter(cli.id)} className="cli-mark" /><span>{cli.label}</span>
            </label>)}</div>
          </fieldset>
          {eligible.length > 0 && <fieldset className="cli-destinations cli-existing" disabled={busy}><legend>Or continue a run</legend><div>
            {eligible.map((other) => <label key={other.id} className="cli-destination">
              <input type="radio" name="destination" value={`run:${other.id}`} checked={target === `run:${other.id}`} onChange={(event) => setTarget(event.target.value)} />
              <BrandIcon brand={cliBrand(other)} className="cli-mark" /><span>{cliLabel(other)}<small>{other.title}</small><em>{other.model || "Harness default"}{other.effort ? ` · ${other.effort}` : ""} · {other.unattended ? "Approvals skipped" : "Default approvals"}</em></span>
            </label>)}
          </div></fieldset>}
          {destination && <CliOptionFields key={target} cli={"cli" in destination ? destination.cli : destination.id} options={options} onChange={(next) => setSelection({ target, options: next })} disabled={busy} />}
          <label className="cli-next-instruction">What should it do next?<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} required maxLength={32768} rows={3} disabled={busy} placeholder="Review this result, build on it, or take the next step…" /></label>
          {error && <p className="dialog-error" role="alert">{error}</p>}
        </div>
        <footer><span>Output + your instructions</span><button className="dialog-primary" disabled={busy || !destination || !prompt.trim()}>{busy ? "Running next step…" : destinationLabel ? `Hand off to ${destinationLabel}` : "Hand off output"} <span aria-hidden="true">↗</span></button></footer>
      </form>
    </dialog>}
  </div>;
}

export function CliPanel({ run, busy, onFloat, onOpenRun }: { run: CliRun; busy: boolean; onFloat?: () => void; onOpenRun?: (id: string) => void }) {
  const [raw, setRaw] = useState(false);
  const [error, setError] = useState("");
  return <section className="conversation cli-conversation" aria-label={`${cliLabel(run)} run ${run.id}`} aria-busy={busy}>
    <header className="thread-bar">
      <h2>Harness workspace <span>· {run.id}</span></h2>
      <div className="thread-actions">
        <CliStatus run={run} />
        {onFloat && <button type="button" className="agent-button" title="Float this run as a window" aria-label={`Float ${cliLabel(run)} as a window`} onClick={onFloat}><ExpandIcon /></button>}
        {run.status === "running" && <button type="button" className="agent-button" onClick={() => void window.emma.stopCliRun(run.id).catch((reason: unknown) => setError(reasonText(reason)))}>Stop</button>}
      </div>
    </header>
    <div className="cli-brief">
      <div className="cli-identity"><span className="cli-avatar"><BrandIcon brand={cliBrand(run)} className={`cli-mark ${run.cli}`} /></span><div><span className="cli-eyebrow">{cliLabel(run)}</span><h3>{run.title}</h3></div></div>
      <div className="cli-metadata"><span title={run.cwd}>{run.folder || run.cwd}</span><span>{run.model || "Harness default model"}</span>{run.effort && <span>{run.effort} {cliHarness(run.cli)?.effortLabel?.toLowerCase() ?? "thinking"}</span>}<span>{run.unattended ? "Approvals skipped" : "Default approvals"}</span></div>
      <div className="cli-output-tabs" role="group" aria-label="Output view">
        <button type="button" aria-pressed={!raw} onClick={() => setRaw(false)}>Result</button>
        <button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>Terminal log</button>
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
    <CliStream id={run.id} rich={!raw} />
    <div className="cli-panel-footer"><CliComposer key={run.id} run={run} onOpenRun={onOpenRun} /></div>
  </section>;
}
