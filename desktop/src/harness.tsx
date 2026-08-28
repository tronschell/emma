import { useEffect, useMemo, useRef, useState } from "react";
import { FLOW_LABEL, HEALTH_ADVICE, HEALTH_LABEL, MAX_LOG_LINES, fixPrompt, harnessHealth, type HarnessFlow, type HarnessReport } from "../shared/harness-log";
import { useTailScroll } from "./cli";
import { reasonText } from "./errors";
import { plural } from "./plural";

const EMPTY: HarnessReport = { processes: [], lines: [] };
const FLOWS: HarnessFlow[] = ["out", "in", "err"];
const POLL_MS = 10_000;

const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour12: false });
const folder = (cwd: string) => cwd.split("/").filter(Boolean).pop() || cwd;
const silence = (ms: number) => (ms ? `heard ${ms < 1000 ? "just now" : `${Math.round(ms / 1000)}s ago`}` : "never spoke");

export function HarnessStatus() {
  const [report, setReport] = useState<HarnessReport>(EMPTY);
  const [open, setOpen] = useState(false);
  const [flow, setFlow] = useState<HarnessFlow | "all">("all");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const load = () => void window.emma.harnessReport().then(setReport).catch(() => undefined);
    load();
    const timer = setInterval(load, POLL_MS);
    const off = window.emma.onHarnessLog((line) => {
      if (line.flow === "err") return load();
      setReport((current) => ({ ...current, lines: [...current.lines, line].slice(-MAX_LOG_LINES) }));
    });
    return () => { clearInterval(timer); off(); };
  }, []);

  useEffect(() => { if (open && !dialog.current?.open) dialog.current?.showModal(); }, [open]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);

  const health = harnessHealth(report.processes);
  const lines = useMemo(() => report.lines.filter((line) => flow === "all" || line.flow === flow), [report.lines, flow]);
  const { ref, onScroll } = useTailScroll<HTMLDivElement>([lines.length, open], flow);
  const dismiss = () => dialog.current?.close();

  const restart = () => {
    setBusy(true);
    setError("");
    window.emma.restartHarness().then(setReport).catch((reason: unknown) => setError(reasonText(reason))).finally(() => setBusy(false));
  };

  return <>
    <button type="button" className="nav-status" data-health={health} aria-haspopup="dialog" title={HEALTH_ADVICE[health]} onClick={() => setOpen(true)}>
      <i /><span>{HEALTH_LABEL[health]}</span>
    </button>
    {open && <dialog ref={dialog} className="modal-backdrop" aria-labelledby="harness-title" onClose={() => setOpen(false)} onCancel={(event) => { event.preventDefault(); dismiss(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) dismiss(); }}>
      <section className="agent-dialog harness-dialog" data-health={health}>
        <header><div><span>emma-cli · ACP</span><h2 id="harness-title">{HEALTH_LABEL[health]}</h2></div><button type="button" onClick={dismiss} aria-label="Close agent status">×</button></header>
        <dl>
          {report.processes.map((state) => <div key={state.cwd}>
            <dt title={state.cwd}>{folder(state.cwd)}</dt>
            <dd>{state.running ? "running" : "stopped"} · {state.busy ? "turn in flight" : "idle"} · {silence(state.silentMs)}{state.failure ? ` · ${state.failure}` : ""}</dd>
          </div>)}
          {!report.processes.length && <div><dt>Processes</dt><dd>None — the next turn starts one</dd></div>}
        </dl>
        {health !== "online" && <p className="dialog-error" role={health === "ready" ? undefined : "alert"}>{HEALTH_ADVICE[health]}</p>}
        <div className="harness-filters" role="group" aria-label="Filter wire traffic">
          <button type="button" aria-pressed={flow === "all"} onClick={() => setFlow("all")}>All</button>
          {FLOWS.map((kind) => <button type="button" key={kind} aria-pressed={flow === kind} onClick={() => setFlow(kind)}>{FLOW_LABEL[kind]}</button>)}
          <em>{lines.length} {plural(lines.length, "message")}</em>
        </div>
        <div className="harness-lines" ref={ref} onScroll={onScroll}>
          {lines.map((line) => <details key={`${line.at}-${line.label}-${line.body.length}`} data-flow={line.flow}>
            <summary><b>{clock(line.at)}</b><i />{line.label}<small>{line.body.length.toLocaleString()} chars</small></summary>
            <pre>{line.body}</pre>
          </details>)}
          {!lines.length && <p className="project-empty">Nothing on the wire yet. Streamed answer chunks are left out; everything else Emma sends or reads lands here.</p>}
        </div>
        {error && <p className="dialog-error" role="alert">{error}</p>}
        <div className="harness-actions">
          <button type="button" className="dialog-primary" disabled={busy} onClick={restart}>{busy ? "Restarting…" : "Restart agent"}</button>
          <button type="button" onClick={() => void navigator.clipboard.writeText(fixPrompt(report)).then(() => setCopied(true)).catch(() => undefined)}>{copied ? "Copied" : "Copy fix prompt"}</button>
        </div>
      </section>
    </dialog>}
  </>;
}
