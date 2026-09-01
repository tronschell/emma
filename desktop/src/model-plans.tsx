import { useCallback, useEffect, useMemo, useState } from "react";
import { CLI_PLANS, MAX_SECRET_CHARS, MODEL_PLANS, PLAN_WEEK_MS, PLAN_WINDOW_MS, emptySpend, planBalanceLine, planForProfile, planSpend, type CliPlan, type KeyBalance, type ModelPlan, type PlanGeneration, type PlanSpend, type UserSettings } from "../shared/settings";
import { charLabel } from "../shared/usage";
import { reasonText } from "./errors";
import { BrandIcon, InfoDot } from "./icons";
import { TerminalSurface } from "./terminal";
import type { TerminalTab } from "../shared/terminal";
import { brandForProvider } from "./brands";
import type { CredentialSummary, Snapshot } from "./types";

type InstalledCli = { id: string; label: string; bin: string; path: string; signedIn?: boolean };

export function ModelPlans({ settings, busy }: { settings: UserSettings; busy: boolean }) {
  const [stored, setStored] = useState<CredentialSummary[]>([]);
  const [clis, setClis] = useState<InstalledCli[]>([]);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [ledger, setLedger] = useState<{ at: number; generations: PlanGeneration[] }>({ at: 0, generations: [] });
  const [balance, setBalance] = useState<KeyBalance | null>(null);
  const readClis = useCallback(() => void window.emma.installedClis().then(setClis).catch(() => undefined), []);
  useEffect(() => {
    void window.emma.listCredentials().then(setStored).catch(() => undefined);
    readClis();
    void window.emma.deepseekBalance().then(setBalance).catch(() => undefined);
    void window.emma.request<Snapshot>("snapshot").then((snapshot) => setLedger({ at: Date.now(), generations: planGenerations(snapshot) })).catch(() => undefined);
  }, [readClis]);
  const window5h = useMemo(() => planSpend(ledger.generations, settings.providers, ledger.at - PLAN_WINDOW_MS), [ledger, settings.providers]);
  const week = useMemo(() => planSpend(ledger.generations, settings.providers, ledger.at - PLAN_WEEK_MS), [ledger, settings.providers]);
  const keyed = (plan: ModelPlan) => stored.some((item) => item.env === plan.credentialEnv && item.masked);
  const routed = (plan: ModelPlan) => settings.providers.filter((profile) => planForProfile(profile)?.id === plan.id).map((profile) => profile.modelId);
  const active = (plan: ModelPlan) => {
    const profile = settings.selectedModel.startsWith("provider:") ? settings.providers.find((item) => item.id === settings.selectedModel.slice("provider:".length)) : undefined;
    return !!profile && planForProfile(profile)?.id === plan.id;
  };
  const saveKey = async (plan: ModelPlan, secret?: string) => {
    setError("");
    setStatus("");
    try {
      setStored(await window.emma.saveCredential(secret === undefined ? { env: plan.credentialEnv } : { env: plan.credentialEnv, secret }));
      setKeys((current) => ({ ...current, [plan.id]: "" }));
      setStatus(secret === undefined ? `${plan.credentialEnv} removed. The agent restarted without it.` : `${plan.credentialEnv} saved. The agent restarted with it.`);
    } catch (reason) { setError(reasonText(reason)); }
  };
  return <section className="provider-keys model-plans">
    <header>
      <div>
        <span>Subscriptions</span>
        <div className="settings-head">
          <h3>Run a model on a plan you already pay for</h3>
          <InfoDot>Most makers sell a flat monthly coding plan alongside metered credit, on its own endpoint. Emma routes the whole agent loop at that endpoint, so a plan model answers turns exactly like an OpenRouter one. OpenAI and Anthropic are the exception: neither sells a plan endpoint you can buy a key for, so Emma reaches those from the sign-in their own CLI stores, listed below. A ChatGPT plan then answers turns here like any other; a Claude plan still runs inside the claude binary.</InfoDot>
        </div>
        <p>Paste a key here, select a supported model, then choose its provider under the selected row.</p>
      </div>
      <strong>{MODEL_PLANS.filter((plan) => keyed(plan)).length} connected</strong>
    </header>
    {(error || status) && <p className={error ? "local-model-error" : "local-model-status"} role="status">{error || status}</p>}
    <div className="provider-key-list">{MODEL_PLANS.map((plan) => {
      const key = stored.find((item) => item.env === plan.credentialEnv && item.masked);
      const draft = (keys[plan.id] ?? "").trim();
      return <div className={`provider-key-row plan-row ${key ? "set" : ""}`} key={plan.id}>
        <BrandIcon brand={brandForProvider(plan.brand)} className="provider-mark" />
        <div>
          <div className="settings-head"><strong>{plan.label}</strong><InfoDot>{plan.note}</InfoDot></div>
          <small>{key ? key.masked : plan.detail}</small>
          <em className="provider-key-balance"><code>{plan.credentialEnv}</code> <a href={plan.keysUrl} target="_blank" rel="noreferrer">Get a key ↗</a> <SpendLine window5h={window5h.get(plan.id)} week={week.get(plan.id)} balance={plan.id === "deepseek" ? balance : null} /></em>
        </div>
        <label>
          <span className="sr-only">{plan.label} API key</span>
          <input type="password" autoComplete="off" spellCheck={false} maxLength={MAX_SECRET_CHARS} disabled={busy} value={keys[plan.id] ?? ""} placeholder={key ? "Paste a replacement" : plan.hint} onChange={(event) => setKeys((current) => ({ ...current, [plan.id]: event.target.value }))} />
        </label>
        <span className={`plan-model ${active(plan) ? "live" : ""}`}>{routed(plan).join(", ") || "No models"}</span>
        <button type="button" disabled={busy || !draft} onClick={() => void saveKey(plan, draft)}>Save key</button>
        <button type="button" disabled={busy || !key} onClick={() => void saveKey(plan)}>Remove</button>
      </div>;
    })}</div>
    <div className="provider-key-list">{CLI_PLANS.map((plan) => <CliPlanRow key={plan.id} plan={plan} installed={clis.find((item) => item.id === plan.id)} busy={busy} onDone={readClis} />)}</div>
  </section>;
}

function planGenerations(snapshot: Snapshot): PlanGeneration[] {
  const rows: PlanGeneration[] = [];
  for (const thread of snapshot.threads) {
    for (const message of thread.messages) {
      const generation = message.generation;
      if (!generation?.model) continue;
      rows.push({ at: Date.parse(message.timestamp), model: generation.model, inputTokens: generation.inputTokens, outputTokens: generation.outputTokens });
    }
  }
  return rows;
}

function SpendLine({ window5h, week, balance }: { window5h?: PlanSpend; week?: PlanSpend; balance: KeyBalance | null }) {
  const money = planBalanceLine(balance);
  const spent = week ?? emptySpend();
  if (!spent.turns && !money) return null;
  const tokens = (spend: PlanSpend) => `${charLabel(spend.inputTokens)} in · ${charLabel(spend.outputTokens)} out`;
  return <b className="plan-spend">
    {spent.turns > 0 && <span title={`${(window5h ?? emptySpend()).turns} turns in the last 5 hours, ${spent.turns} in the last week`}>{tokens(window5h ?? emptySpend())} · 5h</span>}
    {spent.turns > 0 && <span className="plan-spend-week">{tokens(spent)} · 7d</span>}
    {money && <span className={balance && (balance.error || (balance.remaining !== null && balance.remaining <= 0)) ? "warn" : ""}>{money}</span>}
  </b>;
}

function CliPlanRow({ plan, installed, busy, onDone }: { plan: CliPlan; installed?: InstalledCli; busy: boolean; onDone: () => void }) {
  const [tab, setTab] = useState<TerminalTab>();
  const [error, setError] = useState("");
  const signedIn = installed?.signedIn === true;
  useEffect(() => {
    if (!tab) return;
    const stop = window.emma.onTerminals(() => void window.emma.listTerminals(tab.threadId)
      .then((found) => { if (!found.some((item) => item.id === tab.id && item.running)) { setTab(undefined); onDone(); } })
      .catch(() => undefined));
    return () => { stop(); void window.emma.closeTerminal(tab.id); };
  }, [onDone, tab]);
  const signIn = () => void window.emma.signInCli({ signIn: plan.id, columns: 80, rows: 16 })
    .then(setTab).catch((reason: unknown) => setError(reasonText(reason)));
  return <div className={`provider-key-row cli-plan-row ${signedIn ? "set" : ""}`}>
    <BrandIcon brand={brandForProvider(plan.brand)} className="provider-mark" />
    <div>
      <div className="settings-head"><strong>{plan.plan}</strong><InfoDot>{plan.note}</InfoDot></div>
      <small>{plan.detail}</small>
      <code>{installed ? installed.path : `${plan.label} is not on this Mac`}</code>
    </div>
    <span className="provider-key-value">{installed ? "Sign in with " : "Install, then "}<code>{plan.signIn}</code></span>
    {installed
      ? <button type="button" disabled={busy} onClick={() => (tab ? setTab(undefined) : signIn())}>{tab ? "Close" : signedIn ? "Sign in again" : "Sign in"}</button>
      : <span className="provider-key-value">Not found</span>}
    <span className={`provider-key-value ${signedIn ? "" : "warn"}`}>{!installed ? "Not installed" : signedIn ? "Signed in" : "Not signed in"}</span>
    {error && <p className="settings-error" role="alert">{error}</p>}
    {tab && <div className="cli-plan-terminal">
      <TerminalSurface tab={tab} active onSelect={() => undefined} onLink={() => undefined} />
    </div>}
  </div>;
}
