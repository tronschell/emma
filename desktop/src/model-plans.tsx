import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { CLI_PLANS, MAX_SECRET_CHARS, MODEL_PLANS, OPENROUTER_KEYS_URL, PLAN_WEEK_MS, PLAN_WINDOW_MS, emptySpend, planBalanceLine, planForProfile, planSpend, type CliPlan, type KeyBalance, type ModelPlan, type PlanGeneration, type PlanSpend, type UserSettings } from "../shared/settings";
import { charLabel } from "../shared/usage";
import { reasonText } from "./errors";
import { BrandIcon, InfoDot } from "./icons";
import { TerminalSurface } from "./terminal";
import type { TerminalTab } from "../shared/terminal";
import { brandForImporter, brandForProvider } from "./brands";
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
    <div className="provider-key-list">{MODEL_PLANS.map((plan) => <details className="settings-section" key={plan.id}><summary><span>{plan.label}</span><small>{keyed(plan) ? "Connected" : "Not connected"}</small></summary><div className="settings-section-body"><PlanKeyRow plan={plan} stored={stored} draft={keys[plan.id] ?? ""} setDraft={(value) => setKeys((current) => ({ ...current, [plan.id]: value }))} busy={busy} onSave={saveKey} models={routed(plan).join(", ")} live={active(plan)} spend={<SpendLine window5h={window5h.get(plan.id)} week={week.get(plan.id)} balance={plan.id === "deepseek" ? balance : null} />} /></div></details>)}</div>
    <div className="provider-key-list">{CLI_PLANS.map((plan) => <details className="settings-section" key={plan.id}><summary><span>{plan.plan}</span><small>{clis.find((cli) => cli.id === plan.id)?.signedIn ? "Signed in" : "Not signed in"}</small></summary><div className="settings-section-body"><CliPlanRow plan={plan} installed={clis.find((item) => item.id === plan.id)} busy={busy} onDone={readClis} /></div></details>)}</div>
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
const SUBSCRIPTION_TILES: readonly ProviderTile[] = [
  ...CLI_PLANS.filter((cli) => cli.id !== "codex").map((cli) => ({ id: `cli:${cli.id}`, label: cli.id === "claude" ? "Claude" : "Gemini", detail: cli.plan, brand: cli.brand, cli })),
  ...MODEL_PLANS.filter((plan) => plan.billing === "subscription" || plan.id === "mistral").map((plan) => ({ id: plan.id, label: plan.label, detail: plan.id === "mistral" ? "Plan credits · then per token" : "Subscription key", brand: plan.brand, plan })),
  ...CLI_PLANS.filter((cli) => cli.id === "codex").map((cli) => ({ id: `cli:${cli.id}`, label: "ChatGPT", detail: cli.plan, brand: cli.brand, cli })),
];

export function ProviderGrid({ busy, onReady }: { busy: boolean; onReady: (ready: boolean) => void }) {
  const [stored, setStored] = useState<CredentialSummary[]>([]);
  const [clis, setClis] = useState<InstalledCli[]>([]);
  const [picked, setPicked] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [balance, setBalance] = useState<KeyBalance | null>(null);
  const [checking, setChecking] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const readClis = useCallback(() => void window.emma.installedClis().then(setClis).catch((reason: unknown) => setError(reasonText(reason))), []);
  useEffect(() => {
    let active = true;
    void window.emma.listCredentials().then((next) => { if (active) setStored(next); }).catch((reason: unknown) => { if (active) setError(reasonText(reason)); });
    void window.emma.openRouterBalance().then((next) => { if (active) setBalance(next); }).catch((reason: unknown) => { if (active) setError(reasonText(reason)); }).finally(() => { if (active) setChecking(false); });
    readClis();
    window.addEventListener("focus", readClis);
    return () => { active = false; window.removeEventListener("focus", readClis); };
  }, [readClis]);
  const ready = !!balance?.keyed && !balance.error && !checking && !saving;
  useEffect(() => { onReady(ready); }, [ready, onReady]);
  const connected = (tile: ProviderTile) => tile.cli ? clis.some((item) => item.id === tile.cli?.id && item.signedIn) : stored.some((item) => item.env === tile.plan?.credentialEnv && item.masked);
  const saveKey = async (env: string, secret?: string) => {
    setError("");
    setSaving(true);
    if (env === OPENROUTER_ENV) setBalance(null);
    try {
      setStored(await window.emma.saveCredential(secret === undefined ? { env } : { env, secret }));
      setDrafts((current) => ({ ...current, [env]: "" }));
      if (env === OPENROUTER_ENV) setBalance(await window.emma.openRouterBalance());
    } catch (reason) { setError(reasonText(reason)); }
    finally { setSaving(false); }
  };
  const verify = async () => {
    const draft = (drafts[OPENROUTER_ENV] ?? "").trim();
    if (draft) { await saveKey(OPENROUTER_ENV, draft); return; }
    setChecking(true);
    setError("");
    try { setBalance(await window.emma.openRouterBalance()); }
    catch (reason) { setBalance(null); setError(reasonText(reason)); }
    finally { setChecking(false); }
  };
  const tile = SUBSCRIPTION_TILES.find((item) => item.id === picked);
  const openRouter = stored.find((item) => item.env === OPENROUTER_ENV && item.masked);
  const locked = busy || saving || checking;
  return <div className="setup-connections">
    <section className="setup-router" aria-labelledby="setup-router-title">
      <div className="setup-wash" aria-hidden="true" />
      <header><BrandIcon brand={brandForProvider("openrouter")} className="setup-router-mark" /><div><h3 id="setup-router-title">OpenRouter</h3><p>A free API key is enough to get started.</p></div><span className="setup-badge">{ready ? "Connected" : "Required"}</span></header>
      <p>Create a key in your OpenRouter account, then paste it here.</p>
      <a className="setup-button" href={OPENROUTER_KEYS_URL} target="_blank" rel="noreferrer">Create a free API key ↗</a>
      <form className="setup-key" onSubmit={(event) => { event.preventDefault(); void verify(); }}>
        <label htmlFor="setup-router-key">OpenRouter API key</label>
        <div><input id="setup-router-key" type="password" autoComplete="off" spellCheck={false} maxLength={MAX_SECRET_CHARS} disabled={locked} value={drafts[OPENROUTER_ENV] ?? ""} placeholder={openRouter?.masked ?? "sk-or-v1-…"} onChange={(event) => { setBalance(null); setDrafts((current) => ({ ...current, [OPENROUTER_ENV]: event.target.value })); }} /><button type="submit" className="setup-primary" disabled={locked || (!openRouter && !balance?.keyed && !(drafts[OPENROUTER_ENV] ?? "").trim())}>{checking || saving ? "Checking…" : ready ? "Check again" : "Verify key"}</button></div>
      </form>
      <small className={ready ? "setup-success" : ""} role="status">{ready ? "✓ Key verified. OpenRouter is ready." : checking ? "Checking your saved OpenRouter key…" : "Your key is encrypted using this computer’s credential store."}</small>
      {balance?.error && <p className="dialog-error" role="alert">{balance.error} Check the key or try again.</p>}
    </section>
    <div className="setup-subscription-head"><h3>Already have a subscription?</h3><span>Optional</span></div>
    <p>Connect one or more. OpenRouter stays connected alongside them.</p>
    <div className="setup-subscriptions" aria-label="Subscriptions and plans">{SUBSCRIPTION_TILES.map((item) => <button key={item.id} type="button" className={`setup-subscription subscription-${item.brand}`} data-connected={connected(item)} aria-pressed={item.id === picked} aria-expanded={item.id === picked} aria-controls="setup-subscription-detail" disabled={locked} onClick={() => setPicked(item.id === picked ? "" : item.id)}>
      <span className="setup-wash" aria-hidden="true" />
      <span className="setup-subscription-mark"><BrandIcon brand={item.cli?.id === "claude" ? brandForImporter("claude") : brandForProvider(item.brand)} className="provider-mark" />{connected(item) && <span className="setup-success" aria-label="Connected">✓</span>}</span>
      <strong>{item.label}</strong><small>{item.detail}</small>
    </button>)}</div>
    <div id="setup-subscription-detail" className="setup-subscription-detail" hidden={!tile}>
      {tile && <><div className="setup-subscription-heading"><h3>{tile.label}</h3><button type="button" className="setup-link" disabled={locked} onClick={() => setPicked("")}>Close</button></div>
      {tile.plan && <PlanKeyRow plan={tile.plan} stored={stored} draft={drafts[tile.plan.credentialEnv] ?? ""} setDraft={(value) => setDrafts((current) => ({ ...current, [tile.plan!.credentialEnv]: value }))} busy={locked} onSave={(plan, secret) => saveKey(plan.credentialEnv, secret)} />}
      {tile.cli && <CliPlanRow plan={tile.cli} installed={clis.find((item) => item.id === tile.cli?.id)} busy={locked} onDone={readClis} />}</>}
    </div>
    <small className="setup-subscription-note">Mistral uses plan credits, then metered billing. Other API keys and local models are in Settings.</small>
    {error && <p className="dialog-error" role="alert">{error}</p>}
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
