import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent, type FormEvent, type RefObject } from "react";
import { cliHarness, type CliRun } from "../shared/cli";
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

function useCliOutput(id: string | undefined): string {
  const [seen, setSeen] = useState<{ id?: string; text: string }>({ text: "" });
  useEffect(() => {
    if (!id) return;
    let live = true;
    const read = () => void window.emma.readCliRun(id).then((found) => { if (live) setSeen({ id, text: found?.output ?? "" }); }).catch(() => undefined);
    read();
    const off = window.emma.onCliRuns(read);
    return () => { live = false; off(); };
  }, [id]);
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
  const code = run.exitCode ?? 0;
  return <span className={`cli-state ${run.status}`} title={done ? `${cliLabel(run)} exited with code ${run.exitCode ?? "?"}` : undefined}>
    {run.status === "running" ? `working · ${seconds}s` : run.status === "failed" ? "failed" : code === 0 ? "finished" : `stopped · code ${code}`}
  </span>;
}

export function CliStream({ id, rich }: { id: string; rich: boolean }) {
  const output = useCliOutput(id);
  const { ref, onScroll } = useTailScroll<HTMLDivElement>([output, rich], id);
  const text = output || "Waiting for output…";
  return rich
    ? <div className="pip-prose message-body" ref={ref} onScroll={onScroll}><Markdown text={text} /></div>
    : <pre className="cli-stream" ref={ref as unknown as RefObject<HTMLPreElement>} onScroll={onScroll} aria-live="off">{text}</pre>;
}

function useCliModels(cli: string) {
  const [known, setKnown] = useState<{ cli: string; models: string[]; at: number; busy: boolean }>();
  const load = useCallback((refresh: boolean) => window.emma.cliModels({ cli, refresh })
    .then((found) => setKnown({ ...found, busy: false }))
    .catch(() => setKnown({ cli, models: [], at: 0, busy: false })), [cli]);
  useEffect(() => { void load(false); }, [load]);
  const ready = known?.cli === cli ? known : undefined;
  const refresh = () => {
    setKnown((current) => (current?.cli === cli ? { ...current, busy: true } : current));
    void load(true);
  };
  return { models: ready?.models ?? [], at: ready?.at ?? 0, busy: ready?.busy ?? true, refresh };
}

export function CliModelPicker({ run }: { run: CliRun }) {
  const { models, at, busy, refresh } = useCliModels(run.cli);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const away = (event: Event) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const seen = at ? `${models.length} models, read ${new Date(at).toLocaleDateString()} from ${cliLabel(run)} itself — ↻ reads them again` : `Asking ${cliLabel(run)} what models it has…`;
  const chosen = run.model ?? "";
  const listed = chosen && !models.includes(chosen) ? [chosen, ...models] : models;
  const pick = (model: string) => {
    close();
    void window.emma.setCliRunModel({ id: run.id, model }).catch(() => undefined);
  };
  return <span className="pip-model" ref={box} onKeyDown={(event) => { if (event.key === "Escape" && open) close(); }}>
    <button ref={trigger} type="button" className="model-button" title={seen} aria-haspopup="dialog" aria-expanded={open}
      aria-label={`Model for ${cliLabel(run)}, currently ${chosen || "no model chosen"}`}
      onClick={() => (open ? close() : setOpen(true))}>
      <BrandIcon brand={cliBrand(run)} className={`model-brand cli-mark ${run.cli}`} />
      <span className="model-label">{chosen || "No model chosen"}</span>
      <span aria-hidden="true">▾</span>
    </button>
    {open && <section className="source-popover model-menu" role="dialog" aria-label={`Model for ${cliLabel(run)}`}>
      <div className="model-body">
        <div className="model-rows">
          <button type="button" className="model-menu-row" aria-current={!chosen} onClick={() => pick("")}>
            <span>No model chosen</span><b aria-hidden="true">{cliLabel(run)} decides</b>
          </button>
          {listed.map((model) => <button key={model} type="button" className="model-menu-row" aria-current={model === chosen} onClick={() => pick(model)}>
            <span>{model}</span>
          </button>)}
          {!listed.length && <p className="model-menu-note">{seen}</p>}
        </div>
        <div className="model-menu-foot">
          <button type="button" className="model-menu-row quiet" title={seen} disabled={busy} onClick={refresh}>
            <span>Reread {cliLabel(run)}&apos;s models</span><b aria-hidden="true">↻</b>
          </button>
        </div>
      </div>
    </section>}
  </span>;
}

export function CliComposer({ run }: { run: CliRun }) {
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
  return <form className="composer pip-composer" onSubmit={send} onDragOver={(event) => event.preventDefault()} onDrop={drop}>
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
  </form>;
}

export function CliPanel({ run, busy, onFloat }: { run: CliRun; busy: boolean; onFloat?: () => void }) {
  const output = useCliOutput(run.id);
  const seconds = useTurnClock(run);
  const { ref: terminal, onScroll } = useTailScroll<HTMLPreElement>([output]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const harness = cliHarness(run.cli);
  const working = run.status === "running";
  const send = (event: FormEvent) => {
    event.preventDefault();
    const text = message.trim();
    if (!text) return;
    setMessage("");
    setError("");
    void window.emma.sendCliRun({ id: run.id, prompt: text }).catch((reason: unknown) => {
      setMessage((current) => current || text);
      setError(reasonText(reason));
    });
  };
  return <section className="conversation cli-conversation" aria-label={`${cliLabel(run)} run ${run.id}`}>
    <header className="thread-bar">
      <h2><BrandIcon brand={cliBrand(run)} className={`cli-mark ${run.cli}`} /> {cliLabel(run)}</h2>
      <div className="thread-actions">
        <span className={`cli-state ${run.status}`}>{working ? `working · ${seconds}s` : run.status === "failed" ? "failed" : (run.exitCode ?? 0) === 0 ? "finished" : `stopped · code ${run.exitCode}`}</span>
        {onFloat && <button type="button" className="agent-button" title="Float this run as a window" aria-label={`Float ${cliLabel(run)} as a window`} onClick={onFloat}><ExpandIcon /></button>}
        {working && <button type="button" className="agent-button" onClick={() => void window.emma.stopCliRun(run.id)}>Stop</button>}
      </div>
    </header>
    <dl className="agent-stats">
      <div><dt>Run</dt><dd>{run.id}</dd></div>
      <div><dt>Folder</dt><dd>{run.folder || run.cwd}</dd></div>
      <div><dt>Turns</dt><dd>{run.turns}</dd></div>
      <div><dt>Approvals</dt><dd>{run.unattended ? "skipped" : "CLI default"}</dd></div>
    </dl>
    {harness && !harness.ownsSession && <p className="cli-note">{harness.label} continues “the newest session in this folder”, so keep one of these going at a time here.</p>}
    <pre className="cli-terminal" ref={terminal} onScroll={onScroll}>{output || "Waiting for output…"}</pre>
    <form className="composer agent-steer" onSubmit={send}>
      <label className="sr-only" htmlFor={`cli-send-${run.id}`}>Send this CLI its next turn</label>
      <div className="composer-input">
        <textarea id={`cli-send-${run.id}`} value={message} disabled={busy || working} maxLength={32_768} rows={2}
          placeholder={working ? "Wait for this turn to finish…" : `Give ${cliLabel(run)} its next turn — it keeps everything from turn ${run.turns}`}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
      </div>
      <div className="composer-row">
        <span className="agent-steer-hint">Emma sends this as a turn of its own, in the same session.</span>
        <button className="composer-send" disabled={busy || working || !message.trim()} aria-label="Send this CLI its next turn">↑</button>
      </div>
      {error && <p className="capability-error" role="alert">{error}</p>}
    </form>
  </section>;
}
