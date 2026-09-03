import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { COUNCIL_SEATS_DEFAULT, COUNCIL_SEATS_MAX, COUNCIL_SEATS_MIN, COUNCIL_VIEWS, addressed, councilCalls, councilRunning, councilSpend, seatSpend, usdLabel, voiceFor, voicesFor, type CouncilRound, type CouncilState, type CouncilView, type CouncilVoice } from "../shared/council";
import { planFor } from "../shared/settings";
import type { PermissionMode } from "../shared/permissions";
import { permissionModeGlyphs, permissionModeNames } from "../shared/permissions";
import { charLabel } from "../shared/usage";
import { BrandIcon, InfoDot } from "./icons";
import type { BrandDefinition } from "./brands";
import { reasonText } from "./errors";
import { Markdown } from "./markdown";

const VIEW_GLYPHS: Record<CouncilView, string> = { bench: "⊞", table: "◎", chat: "☰" };
const VIEW_NAMES: Record<CouncilView, string> = { bench: "Bench", table: "Table", chat: "Chat" };
const ROUND_NAMES: Record<CouncilRound, string> = { draft: "opening", discuss: "turn", verdict: "answer" };

const PHASE_LINES: Record<CouncilState["phase"], string> = {
  drafting: "Drafting alone",
  discussing: "Talking it through",
  deciding: "Chair writing it up",
  waiting: "Waiting on you",
  done: "Landed",
  stopped: "Stopped",
  failed: "Failed",
};

export type CouncilPicker = (model: string, onPick: (key: string) => void, label: string) => ReactNode;

type Draft = { id: string; model: string };
type Brand = (key: string) => BrandDefinition | undefined;

const seatId = () => `seat-${Math.random().toString(36).slice(2, 10)}`;

function take(text: string): string {
  const line = text.split("\n").find((row) => /^\s*TAKE:/i.test(row));
  const said = line ? line.replace(/^\s*TAKE:\s*/i, "") : text.split("\n")[0] ?? "";
  return said.replace(/[*_`#]/g, "").trim();
}

const said = (text: string) => text.split("\n").filter((row) => !/^\s*TAKE:/i.test(row)).join("\n").trim();

const turns = (state: CouncilState) => state.voices.filter((voice) => voice.round === "discuss" && !voice.error);

export function CouncilPanel({ threadId, mode, question, seed, picker, name, brand, onClose }: {
  threadId: string;
  mode: PermissionMode;
  question: string;
  seed: string[];
  picker: CouncilPicker;
  name: (key: string) => string;
  brand: Brand;
  onClose: () => void;
}) {
  const [state, setState] = useState<CouncilState | null>(null);
  const [view, setView] = useState<CouncilView>("bench");
  const [asked, setAsked] = useState(question);
  const [drafts, setDrafts] = useState<Draft[]>(() => seed.slice(0, COUNCIL_SEATS_DEFAULT).map((model) => ({ id: seatId(), model })));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const board = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void window.emma.councilState(threadId).then((current) => { if (live && current) setState(current); }).catch(() => undefined);
    const stop = window.emma.onCouncil((next) => { if (next.threadId === threadId) setState(next); });
    return () => { live = false; stop(); };
  }, [threadId]);

  const phase = state?.phase;
  useEffect(() => { if (phase && councilRunning(phase)) board.current?.scrollIntoView({ block: "nearest" }); }, [phase]);

  const seats = useMemo(() => drafts.map((draft) => ({ id: draft.id, model: draft.model, name: name(draft.model) })), [drafts, name]);
  const ready = seats.length >= COUNCIL_SEATS_MIN && seats.every((seat) => seat.model) && asked.trim().length > 0;

  const start = async () => {
    setError("");
    setBusy(true);
    try {
      setState(await window.emma.startCouncil({ threadId, question: asked.trim(), mode, seats }));
      setView("bench");
    } catch (reason) { setError(reasonText(reason)); }
    finally { setBusy(false); }
  };

  const adopt = async (seat: string) => {
    setError("");
    try { setState(await window.emma.adoptCouncil({ threadId, seatId: seat })); }
    catch (reason) { setError(reasonText(reason)); }
  };

  const close = () => { void window.emma.closeCouncil(threadId).catch(() => undefined); onClose(); };

  if (!state) {
    return <section className="council council-setup" aria-label="Seat a council">
      <header className="council-bar">
        <h4>The council</h4>
        <InfoDot>Each seat drafts alone, then they talk it through in turn until the chair writes up the answer they reached. Seats have no tools. Only the answer lands in this thread.</InfoDot>
        <span className="council-count">{seats.length} seats</span>
        <button type="button" className="council-close" onClick={onClose} aria-label="Do not seat a council">×</button>
      </header>
      <label className="council-ask">
        <span>The question</span>
        <textarea value={asked} maxLength={8_000} rows={3} placeholder="What should the council work out?" onChange={(event) => setAsked(event.target.value)} />
      </label>
      <div className="council-seats">
        {drafts.map((draft, index) => <div className="council-seat-row" key={draft.id}>
          <b className="council-seat-no">{index === 0 ? "chair" : String(index + 1).padStart(2, "0")}</b>
          <BrandIcon brand={brand(draft.model)} className="model-brand" />
          {picker(draft.model, (key) => setDrafts((current) => current.map((item) => item.id === draft.id ? { ...item, model: key } : item)), "the model in this seat")}
          <button type="button" className="council-drop" disabled={drafts.length <= COUNCIL_SEATS_MIN} aria-label={`Empty seat ${index + 1}`} onClick={() => setDrafts((current) => current.filter((item) => item.id !== draft.id))}>×</button>
        </div>)}
        <button type="button" className="council-add" disabled={drafts.length >= COUNCIL_SEATS_MAX} onClick={() => setDrafts((current) => [...current, { id: seatId(), model: "" }])}>＋ New seat</button>
      </div>
      <p className="council-warn" role="note">{seats.length} seats · {councilCalls(seats.length)} model calls · each seat bills itself</p>
      <p className="council-mode">{permissionModeGlyphs[mode]} {permissionModeNames[mode]} · {mode === "ask" ? "you land it" : "lands on its own"}</p>
      {error && <p className="council-error" role="alert">{error}</p>}
      <div className="council-go">
        <button type="button" className="council-start" disabled={!ready || busy} onClick={() => void start()}>{busy ? "Seating…" : `Seat ${seats.length}`}</button>
      </div>
    </section>;
  }

  const spend = councilSpend(state);
  const winner = state.seats.find((seat) => seat.id === state.winnerId);
  const taken = winner ? voiceFor(state, winner.id, "draft") : undefined;
  const running = councilRunning(state.phase);

  return <section className="council" aria-label="The council" ref={board}>
    <header className="council-bar">
      <h4>The council</h4>
      <span className={`council-phase ${running ? "live" : ""}`}>{PHASE_LINES[state.phase]}</span>
      <span className="council-views" role="tablist" aria-label="How to watch the council">
        {COUNCIL_VIEWS.map((id) => <button key={id} type="button" role="tab" aria-selected={view === id} title={VIEW_NAMES[id]} onClick={() => setView(id)}>{VIEW_GLYPHS[id]} {VIEW_NAMES[id]}</button>)}
      </span>
      {running
        ? <button type="button" className="council-stop" onClick={() => void window.emma.stopCouncil(threadId)}>Stop</button>
        : <button type="button" className="council-close" onClick={close} aria-label="Close the council">×</button>}
    </header>

    <div className="council-meter">
      <span><b>{spend.calls}</b> calls</span>
      <span><b>{turns(state).length}</b> turns</span>
      <span><b>{charLabel(spend.inputTokens)}</b> in</span>
      <span><b>{charLabel(spend.outputTokens)}</b> out</span>
      <span className="council-usd"><b>{usdLabel(spend.microDollars)}</b> metered</span>
      {spend.plans.map((id) => <em key={id} className="council-plan">{planFor(id)?.label ?? id} plan</em>)}
      <InfoDot>Metered dollars use OpenRouter's rates for each seat's model. A seat on a plan draws on that plan instead, so it is named, not priced.</InfoDot>
    </div>

    {view === "bench" && <Bench state={state} brand={brand} />}
    {view === "table" && <Table state={state} brand={brand} />}
    {view === "chat" && <Chat state={state} brand={brand} />}

    {state.verdict && <div className={`council-verdict ${state.phase === "waiting" ? "open" : ""}`}>
      <header><b>{winner ? `${winner.name}'s draft, taken as-is` : "The council's answer"}</b></header>
      <div className="council-verdict-body"><Markdown text={taken && !taken.error ? said(taken.text) : state.verdict} /></div>
      {state.phase === "waiting" && <div className="council-take">
        <button type="button" className="picked" onClick={() => void adopt("")}>Land it</button>
        <span>or one draft alone</span>
        {state.seats.map((seat) => <button key={seat.id} type="button" onClick={() => void adopt(seat.id)}>{seat.name}</button>)}
      </div>}
    </div>}

    {state.error && <p className="council-error" role="alert">{state.error}</p>}
    {error && <p className="council-error" role="alert">{error}</p>}
  </section>;
}

function Bench({ state, brand }: { state: CouncilState; brand: Brand }) {
  return <div className="council-bench" style={{ "--seats": state.seats.length } as Record<string, string | number>}>
    {state.seats.map((seat, index) => {
      const draft = voiceFor(state, seat.id, "draft");
      const spoken = voicesFor(state, seat.id, "discuss").filter((voice) => !voice.error);
      const spend = seatSpend(state, seat.id);
      return <article className={`council-column ${state.winnerId === seat.id ? "won" : ""} ${state.floor === seat.id ? "floor" : ""} ${draft?.error ? "stalled" : ""}`} key={seat.id}>
        <header>
          <BrandIcon brand={brand(seat.model)} className="model-brand" />
          <b>{seat.name}</b>
          {index === 0 && <em className="council-chair">chair</em>}
          {state.floor === seat.id && <em className="council-floor">speaking</em>}
        </header>
        <p className="council-take-line">{draft ? draft.error ? "—" : take(draft.text) : "…"}</p>
        <div className="council-body">
          {draft?.error && <p className="council-stalled">stalled · {draft.error}</p>}
          {draft && !draft.error && <Markdown text={said(draft.text)} />}
          {!draft && <p className="council-thinking">drafting…</p>}
        </div>
        {spoken.length > 0 && <div className="council-turns">
          {spoken.map((voice, turn) => <div key={voice.at}><em>turn {turn + 1}</em><Markdown text={voice.text} /></div>)}
        </div>}
        <footer>
          <span>{spoken.length} {spoken.length === 1 ? "turn" : "turns"}</span>
          <span>{charLabel(spend.inputTokens + spend.outputTokens)} tok</span>
          <span className="council-usd">{spend.plan ? planFor(spend.plan)?.label ?? spend.plan : usdLabel(spend.microDollars)}</span>
        </footer>
      </article>;
    })}
  </div>;
}

function Table({ state, brand }: { state: CouncilState; brand: Brand }) {
  const count = state.seats.length;
  const step = 360 / count;
  const radius = 182;
  const centre = 224;
  const point = (index: number) => {
    const angle = (index * step - 90) * (Math.PI / 180);
    return { x: centre + Math.cos(angle) * (radius - 44), y: centre + Math.sin(angle) * (radius - 44) };
  };
  const spoken = turns(state);
  const latest: CouncilVoice | undefined = spoken[spoken.length - 1];
  const heard = latest ? addressed(state.seats, latest.text, latest.seatId) : [];
  const from = latest ? state.seats.findIndex((seat) => seat.id === latest.seatId) : -1;
  const speaker = state.seats.find((seat) => seat.id === state.floor);
  const last = latest ? state.seats.find((seat) => seat.id === latest.seatId) : undefined;
  return <div className="council-table">
    <div className="council-ring" style={{ width: centre * 2, height: centre * 2 }}>
      {from >= 0 && <svg className="council-chords" viewBox={`0 0 ${centre * 2} ${centre * 2}`} aria-hidden="true">
        {heard.map((id) => {
          const to = state.seats.findIndex((seat) => seat.id === id);
          return <line key={id} x1={point(from).x} y1={point(from).y} x2={point(to).x} y2={point(to).y} />;
        })}
      </svg>}
      {state.seats.map((seat, index) => {
        const draft = voiceFor(state, seat.id, "draft");
        const role = state.floor === seat.id ? "floor" : heard.includes(seat.id) ? "heard" : state.winnerId === seat.id ? "won" : "";
        return <div className={`council-seat ${role}`} key={seat.id}
          style={{ transform: `rotate(${index * step}deg) translateY(-${radius}px) rotate(-${index * step}deg)` }}>
          <BrandIcon brand={brand(seat.model)} className="model-brand" />
          <b>{seat.name}</b>
          <small>{draft ? draft.error ? "stalled" : take(draft.text) : "drafting…"}</small>
        </div>;
      })}
      <div className="council-core">
        <b>{speaker ? `${speaker.name} has the floor` : PHASE_LINES[state.phase]}</b>
        <span>{count} seats · {spoken.length} turns</span>
      </div>
    </div>
    {last && latest && <p className="council-floor-line"><b>{last.name}</b>{latest.text}</p>}
  </div>;
}

function Chat({ state, brand }: { state: CouncilState; brand: Brand }) {
  const rows = state.voices.filter((voice) => voice.round !== "verdict").sort((a, b) => a.at - b.at);
  const speaker = state.seats.find((seat) => seat.id === state.floor);
  return <div className="council-chat">
    <p className="council-chat-open">{state.question}</p>
    {rows.map((voice, index) => {
      const seat = state.seats.find((candidate) => candidate.id === voice.seatId);
      return <article className={`council-said ${voice.round}`} key={`${voice.seatId}-${voice.round}-${index}`}>
        <BrandIcon brand={brand(seat?.model ?? "")} className="model-brand" />
        <div>
          <header><b>{seat?.name ?? voice.seatId}</b><em>{ROUND_NAMES[voice.round]}</em></header>
          {voice.error ? <p className="council-stalled">stalled · {voice.error}</p> : <Markdown text={said(voice.text)} />}
        </div>
      </article>;
    })}
    {councilRunning(state.phase) && <p className="council-thinking">{speaker ? `${speaker.name} is typing…` : `${PHASE_LINES[state.phase]}…`}</p>}
  </div>;
}
