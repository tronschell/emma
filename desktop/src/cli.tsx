/* The meta harness, as the user sees it.
 *
 * Two views onto the same runs. `CliDock` is the strip pinned above the thread:
 * whichever CLI is working right now, its logo, its last few lines, live. It is
 * pinned rather than inlined in the transcript because a run outlives the turn
 * that started it — the agent has moved on, and the CLI is still going.
 *
 * `CliPanel` is that run's own tab: the whole terminal, and the composer that
 * sends it the next prompt. Both are read-only about the run itself. Main owns
 * the processes; the only thing either view can do to one is stop it.
 */

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { cliHarness, tailLines, type CliRun } from "../shared/cli";
import { brandForImporter } from "./brands";
import { BrandIcon } from "./icons";
import { reasonText } from "./errors";

/** How many lines of terminal the pinned strip shows before it needs a tab. */
const DOCK_LINES = 6;

/** The live runs, refreshed by main whenever one starts a turn, prints, or ends. */
export function useCliRuns(): CliRun[] {
  const [runs, setRuns] = useState<CliRun[]>([]);
  useEffect(() => {
    const reload = () => void window.emma.listCliRuns().then(setRuns).catch(() => undefined);
    reload();
    return window.emma.onCliRuns(reload);
  }, []);
  return runs;
}

/**
 * A run's terminal, re-read whenever main says something changed.
 *
 * Pulled rather than pushed: main already coalesces its change events, and the
 * whole transcript is at most a few hundred kilobytes, so asking for it again is
 * cheaper than keeping a second copy in sync a chunk at a time.
 */
function useCliOutput(id: string | undefined): string {
  // The run it came from is kept beside the text, so switching tabs shows the new
  // run's terminal or nothing — never the previous one's, for one frame.
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

const brandFor = (run: CliRun) => brandForImporter(run.cli);
const labelFor = (run: CliRun) => cliHarness(run.cli)?.label ?? run.cli;

const turnSeconds = (run: CliRun) =>
  Math.max(0, Math.round(((run.status === "running" ? Date.now() : run.endedAt ?? run.turnStartedAt) - run.turnStartedAt) / 1000));

/** Seconds on the *current* turn, not the whole conversation: that is what is moving. */
function useTurnClock(run: CliRun | undefined): number {
  // Only to keep the clock honest while nothing else about the run changes.
  const [, tick] = useState(0);
  useEffect(() => {
    if (run?.status !== "running") return;
    const timer = setInterval(() => tick((current) => current + 1), 1000);
    return () => clearInterval(timer);
  }, [run?.status]);
  return run ? turnSeconds(run) : 0;
}

/**
 * Keeps a scroller pinned to the bottom unless the user has scrolled up to read:
 * a stream that keeps growing must not drag the view back down under them.
 * `deps` is what grows; `resetKey` is what re-pins (a new thread starts at the end).
 */
export function useTailScroll<T extends HTMLElement>(deps: unknown[], resetKey?: unknown) {
  const node = useRef<T>(null);
  const pinned = useRef(true);
  useEffect(() => { pinned.current = true; }, [resetKey]);
  useEffect(() => {
    const element = node.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  const onScroll = () => {
    const element = node.current;
    if (element) pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
  };
  return { ref: node, onScroll };
}

/**
 * The pinned strip. Shows the run that is working; if none is, the most recent
 * one, so a finished run does not vanish the moment it stops being interesting.
 */
export function CliDock({ runs, active, onOpen }: { runs: CliRun[]; active: string; onOpen: (id: string) => void }) {
  const shown = useMemo(() => runs.find((run) => run.status === "running") ?? runs[runs.length - 1], [runs]);
  const output = useCliOutput(shown?.id);
  const seconds = useTurnClock(shown);
  const { ref: terminal, onScroll } = useTailScroll<HTMLPreElement>([output]);
  if (!shown) return null;
  const working = shown.status === "running";
  const others = runs.length - 1;
  return <section className="cli-dock" data-status={shown.status} aria-label={`${labelFor(shown)} terminal`}>
    <header>
      <BrandIcon brand={brandFor(shown)} className={`cli-mark ${shown.cli}`} />
      <div className="cli-dock-title">
        <strong>{labelFor(shown)}<em>{shown.id}</em></strong>
        <small>{shown.title}</small>
      </div>
      <span className={`cli-state ${shown.status}`}>
        {working ? `turn ${shown.turns} · ${seconds}s` : shown.status === "failed" ? "failed to start" : `idle · exit ${shown.exitCode ?? "?"}`}
      </span>
      {shown.unattended && <span className="cli-unattended" title="Running with this CLI's approvals turned off">unattended</span>}
      <span className="cli-dock-folder">{shown.folder}</span>
      {others > 0 && <span className="cli-dock-more">+{others}</span>}
      {shown.id !== active && <button type="button" onClick={() => onOpen(shown.id)}>Open tab</button>}
      {working && <button type="button" onClick={() => void window.emma.stopCliRun(shown.id)}>Stop</button>}
    </header>
    <pre className="cli-stream" ref={terminal} onScroll={onScroll} aria-live="off">{tailLines(output, DOCK_LINES) || "Waiting for output…"}</pre>
  </section>;
}

/**
 * One run's tab: the whole terminal, and the prompt that gives it its next turn.
 *
 * The composer talks to main directly rather than through an agent turn. Typing
 * into a named CLI's box and pressing send *is* the permission — the same reason
 * Stop needs no dialog — and routing it through Emma would only put a second
 * model between the user and the CLI they picked.
 */
export function CliPanel({ run, busy }: { run: CliRun; busy: boolean }) {
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
  return <section className="conversation cli-conversation" aria-label={`${labelFor(run)} run ${run.id}`}>
    <header className="thread-bar">
      <h2><BrandIcon brand={brandFor(run)} className={`cli-mark ${run.cli}`} /> {labelFor(run)}</h2>
      <div className="thread-actions">
        <span className={`cli-state ${run.status}`}>{working ? `working · ${seconds}s` : run.status === "failed" ? "failed" : `idle · exit ${run.exitCode ?? "?"}`}</span>
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
          placeholder={working ? "Wait for this turn to finish…" : `Give ${labelFor(run)} its next turn — it keeps everything from turn ${run.turns}`}
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
