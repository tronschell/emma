import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { CLI_PLANS, MAX_SECRET_CHARS, MODEL_PLANS, OPENROUTER_CREDITS_URL, OPENROUTER_KEYS_URL, PLAN_WEEK_MS, PLAN_WINDOW_MS, balanceLine, emptySpend, outOfCredit, planBalanceLine, planForProfile, planSpend, type CliPlan, type KeyBalance, type ModelPlan, type PlanGeneration, type PlanSpend, type UserSettings } from "../shared/settings";
import { charLabel } from "../shared/usage";
import { reasonText } from "./errors";
import { BrandIcon, InfoDot } from "./icons";
import { TerminalSurface } from "./terminal";
import type { TerminalTab } from "../shared/terminal";
import { brandForProvider } from "./brands";
import type { CredentialSummary, Snapshot } from "./types";

type InstalledCli = { id: string; label: string; bin: string; path: string; signedIn?: boolean };

export const OPENROUTER_ENV = "OPENROUTER_API_KEY";

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
    <div className="provider-key-list">{MODEL_PLANS.map((plan) => <PlanKeyRow key={plan.id} plan={plan} stored={stored} draft={keys[plan.id] ?? ""} setDraft={(value) => setKeys((current) => ({ ...current, [plan.id]: value }))} busy={busy} onSave={saveKey} models={routed(plan).join(", ")} live={active(plan)} spend={<SpendLine window5h={window5h.get(plan.id)} week={week.get(plan.id)} balance={plan.id === "deepseek" ? balance : null} />} />)}</div>
    <div className="provider-key-list">{CLI_PLANS.map((plan) => <CliPlanRow key={plan.id} plan={plan} installed={clis.find((item) => item.id === plan.id)} busy={busy} onDone={readClis} />)}</div>
  </section>;
}

export function PlanKeyRow({ plan, stored, draft, setDraft, busy, onSave, models = "", live = false, spend = null }: { plan: ModelPlan; stored: CredentialSummary[]; draft: string; setDraft: (value: string) => void; busy: boolean; onSave: (plan: ModelPlan, secret?: string) => Promise<void>; models?: string; live?: boolean; spend?: ReactNode }) {
  const key = stored.find((item) => item.env === plan.credentialEnv && item.masked);
  return <div className={`provider-key-row plan-row ${key ? "set" : ""}`}>
        <BrandIcon brand={brandForProvider(plan.brand)} className="provider-mark" />
        <div>
          <div className="settings-head"><strong>{plan.label}</strong><InfoDot>{plan.note}</InfoDot></div>
          <small>{key ? key.masked : plan.detail}</small>
          <em className="provider-key-balance"><code>{plan.credentialEnv}</code> <a href={plan.keysUrl} target="_blank" rel="noreferrer">Get a key ↗</a> {spend}</em>
        </div>
        <label>
          <span className="sr-only">{plan.label} API key</span>
          <input type="password" autoComplete="off" spellCheck={false} maxLength={MAX_SECRET_CHARS} disabled={busy} value={draft} placeholder={key ? "Paste a replacement" : plan.hint} onChange={(event) => setDraft(event.target.value)} />
        </label>
        <span className={`plan-model ${live ? "live" : ""}`}>{models || "No models"}</span>
        <button type="button" disabled={busy || !draft.trim()} onClick={() => void onSave(plan, draft.trim())}>Save key</button>
        <button type="button" disabled={busy || !key} onClick={() => void onSave(plan)}>Remove</button>
  </div>;
}

type ProviderTile = { id: string; label: string; detail: string; brand: string; plan?: ModelPlan; cli?: CliPlan };
const PROVIDER_TILES: readonly ProviderTile[] = [
  { id: "openrouter", label: "OpenRouter", detail: "free tier · every maker", brand: "openrouter" },
  ...CLI_PLANS.map((cli) => ({ id: `cli:${cli.id}`, label: cli.label, detail: cli.plan, brand: cli.brand, cli })),
  ...MODEL_PLANS.map((plan) => ({ id: plan.id, label: plan.label, detail: plan.detail.split(", ").pop() ?? plan.detail, brand: plan.brand, plan })),
];

export function ProviderGrid({ busy, onConnected }: { busy: boolean; onConnected?: (count: number) => void }) {
  const [stored, setStored] = useState<CredentialSummary[]>([]);
  const [clis, setClis] = useState<InstalledCli[]>([]);
  const [picked, setPicked] = useState("openrouter");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [balance, setBalance] = useState<KeyBalance | null>(null);
  const [error, setError] = useState("");
  const readClis = useCallback(() => void window.emma.installedClis().then(setClis).catch(() => undefined), []);
  useEffect(() => {
    void window.emma.listCredentials().then(setStored).catch(() => undefined);
    void window.emma.openRouterBalance().then(setBalance).catch(() => undefined);
    readClis();
  }, [readClis]);
  const keyed = (env: string) => stored.some((item) => item.env === env && item.masked);
  const connected = (tile: ProviderTile) => tile.cli ? clis.find((item) => item.id === tile.cli?.id)?.signedIn === true : keyed(tile.plan?.credentialEnv ?? OPENROUTER_ENV);
  const live = PROVIDER_TILES.filter(connected).length;
  useEffect(() => { onConnected?.(live); }, [live, onConnected]);
  const saveKey = async (env: string, secret?: string) => {
    setError("");
    try {
      setStored(await window.emma.saveCredential(secret === undefined ? { env } : { env, secret }));
      setDrafts((current) => ({ ...current, [env]: "" }));
      if (env === OPENROUTER_ENV) setBalance(await window.emma.openRouterBalance());
    } catch (reason) { setError(reasonText(reason)); }
  };
  const tile = PROVIDER_TILES.find((item) => item.id === picked) ?? PROVIDER_TILES[0];
  const openRouter = stored.find((item) => item.env === OPENROUTER_ENV && item.masked);
  return <div className="provider-grid-wrap">
    <div className="provider-grid" role="tablist" aria-label="Ways to reach a model">
      {PROVIDER_TILES.map((item) => <button key={item.id} type="button" role="tab" aria-selected={item.id === picked} className={`provider-tile ${connected(item) ? "on" : ""} ${item.id === "openrouter" ? "free" : ""}`} disabled={busy} onClick={() => setPicked(item.id)}>
        <span className="provider-tile-head"><BrandIcon brand={brandForProvider(item.brand)} className="provider-mark" /><em>{connected(item) ? "connected" : item.id === "openrouter" ? "free" : ""}</em></span>
        <strong>{item.label}</strong><small>{item.detail}</small>
      </button>)}
    </div>
    <div className="provider-grid-form">
      {tile.id === "openrouter" && <>
        <form className="provider-key-row plan-row" onSubmit={(event) => { event.preventDefault(); void saveKey(OPENROUTER_ENV, (drafts[OPENROUTER_ENV] ?? "").trim()); }}>
          <BrandIcon brand={brandForProvider("openrouter")} className="provider-mark" />
          <div><div className="settings-head"><strong>OpenRouter key</strong><InfoDot>One key covers every maker in the catalog. It is encrypted with this computer's credential store and handed to the agent through its environment; changing it restarts the local agent.</InfoDot></div><small>{openRouter ? openRouter.masked : "A free key is enough — models marked FREE cost nothing"}</small><em className="provider-key-balance"><a href={OPENROUTER_KEYS_URL} target="_blank" rel="noreferrer">Get a key ↗</a>{openRouter && <span className={outOfCredit(balance) || balance?.error ? "warn" : ""}>{balanceLine(balance)}</span>}{openRouter && (outOfCredit(balance) || balance?.freeTier) && <a href={OPENROUTER_CREDITS_URL} target="_blank" rel="noreferrer">Add credit ↗</a>}</em></div>
          <label><span className="sr-only">OpenRouter API key</span><input type="password" autoComplete="off" spellCheck={false} maxLength={MAX_SECRET_CHARS} disabled={busy} value={drafts[OPENROUTER_ENV] ?? ""} placeholder={openRouter ? "Paste a replacement" : "sk-or-v1-…"} onChange={(event) => setDrafts((current) => ({ ...current, [OPENROUTER_ENV]: event.target.value }))} /></label>
          <span className={`plan-model ${openRouter ? "live" : ""}`}>{openRouter ? "Whole catalog" : live ? "Optional" : "Required"}</span>
          <button type="submit" disabled={busy || !(drafts[OPENROUTER_ENV] ?? "").trim()}>Save key</button>
          <button type="button" disabled={busy || !openRouter} onClick={() => void saveKey(OPENROUTER_ENV)}>Remove</button>
        </form>
      </>}
      {tile.plan && <PlanKeyRow plan={tile.plan} stored={stored} draft={drafts[tile.plan.credentialEnv] ?? ""} setDraft={(value) => setDrafts((current) => ({ ...current, [tile.plan!.credentialEnv]: value }))} busy={busy} onSave={(plan, secret) => saveKey(plan.credentialEnv, secret)} />}
      {tile.cli && <CliPlanRow plan={tile.cli} installed={clis.find((item) => item.id === tile.cli?.id)} busy={busy} onDone={readClis} />}
      {error && <p className="settings-error" role="alert">{error}</p>}
    </div>
  </div>;
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

export function CliPlanRow({ plan, installed, busy, onDone }: { plan: CliPlan; installed?: InstalledCli; busy: boolean; onDone: () => void }) {
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
