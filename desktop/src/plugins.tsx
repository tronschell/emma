import { useCallback, useEffect, useRef, useState } from "react";
import { hookRuns, matchesPluginQuery, pluginCategories, type InstalledPlugin, type Marketplace, type MarketplacePlugin, type PluginCatalog, type PluginDetail, type PluginHookState } from "../shared/plugins";
import { reasonText } from "./errors";
import { InfoDot, TrashIcon } from "./icons";

const untrustedHooks = (hooks: PluginHookState[]) => hooks.filter((hook) => hookRuns(hook.event) && !hook.trusted).length;

const empty: PluginCatalog = { marketplaces: [], installed: [] };

export function PluginsView({ busy }: { busy: boolean }) {
  const [catalog, setCatalog] = useState<PluginCatalog>(empty);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [source, setSource] = useState("");
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [showing, setShowing] = useState<{ marketplace: Marketplace; plugin: MarketplacePlugin } | null>(null);
  const [reviewing, setReviewing] = useState("");
  const [loading, setLoading] = useState(true);

  const run = useCallback(async (id: string, work: () => Promise<PluginCatalog>) => {
    setPending(id);
    setError("");
    try { setCatalog(await work()); }
    catch (reason) { setError(reasonText(reason)); }
    finally { setPending(""); }
  }, []);

  useEffect(() => {
    let active = true;
    void window.emma.pluginCatalog()
      .then((found) => { if (active) setCatalog(found); })
      .catch((reason: unknown) => { if (active) setError(reasonText(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const categories = pluginCategories(catalog);
  const sources = catalog.marketplaces.filter((entry) => !source || entry.id === source);
  const installedById = new Map(catalog.installed.map((entry) => [entry.id, entry]));
  const review = catalog.installed.find((entry) => entry.id === reviewing);
  const listings = sources.map((marketplace) => ({
    marketplace,
    plugins: marketplace.plugins.filter((plugin) => (!category || plugin.category === category) && matchesPluginQuery(plugin, query)),
  }));
  const matched = listings.reduce((sum, listing) => sum + listing.plugins.length, 0);
  const working = busy || !!pending;

  return <section className="plugins-view">
    <header>
      <span>Plugins · skills and MCP servers, packaged</span>
      <h2>Plugins</h2>
      <p>The ChatGPT and Codex format: a manifest, a folder of skills, sometimes an MCP server. Install one and Emma has its skills on the next turn.</p>
    </header>

    {error && <p className="dialog-error">{error}</p>}

    <div className="plugins-toolbar">
      <input value={query} disabled={working} onChange={(event) => setQuery(event.target.value)} placeholder="Search plugins" aria-label="Search plugins" />
      <button type="button" className="plugin-add" disabled={working} onClick={() => setAdding(true)}>Add marketplace</button>
    </div>

    {catalog.marketplaces.length > 1 && <div className="plugins-chips" role="group" aria-label="Marketplace">
      <button type="button" className={`shelf-chip ${source ? "" : "on"}`} disabled={working} onClick={() => setSource("")}>All sources</button>
      {catalog.marketplaces.map((entry) => <button key={entry.id} type="button" className={`shelf-chip ${source === entry.id ? "on" : ""}`} disabled={working} onClick={() => setSource(entry.id)}>{entry.displayName}</button>)}
    </div>}

    {categories.length > 0 && <div className="plugins-chips" role="group" aria-label="Category">
      <button type="button" className={`shelf-chip ${category ? "" : "on"}`} disabled={working} onClick={() => setCategory("")}>All</button>
      {categories.map((name) => <button key={name} type="button" className={`shelf-chip ${category === name ? "on" : ""}`} disabled={working} onClick={() => setCategory(name)}>{name}</button>)}
    </div>}

    {loading && !catalog.marketplaces.length && <div className="content-empty" role="status" aria-live="polite">
      <span className="mark" aria-hidden="true">◈</span>
      <p>Fetching the official Codex marketplace…</p>
    </div>}

    {!loading && !catalog.marketplaces.length && <div className="content-empty">
      <span className="mark" aria-hidden="true">◈</span>
      <h2>No marketplaces yet</h2>
      <p>A marketplace is a catalog of plugins: a GitHub repo, a Git URL, or a folder on this Mac. Emma files the ones she writes here too.</p>
      <button type="button" className="plugin-add" disabled={working} onClick={() => setAdding(true)}>Add plugin marketplace</button>
    </div>}

    {catalog.marketplaces.length > 0 && !matched && <p className="artifact-missing">Nothing matches that.</p>}

    {listings.map(({ marketplace, plugins }) => <section key={marketplace.id} className="plugin-source">
      <header>
        <div>
          <span>{marketplace.local ? "Folder on this Mac" : marketplace.origin}{marketplace.ref ? ` · ${marketplace.ref}` : ""}{marketplace.sparse.length ? ` · ${marketplace.sparse.join(", ")}` : ""}</span>
          <h3>{marketplace.displayName}</h3>
        </div>
        {!marketplace.local && <button type="button" disabled={working} onClick={() => void run(marketplace.id, () => window.emma.refreshMarketplace(marketplace.id))}>{pending === marketplace.id ? "Updating…" : "Update"}</button>}
        <button type="button" className="artifact-danger" title={`Remove ${marketplace.displayName}`} aria-label={`Remove ${marketplace.displayName}`} disabled={working} onClick={() => void run(marketplace.id, () => window.emma.removeMarketplace(marketplace.id))}><TrashIcon /></button>
      </header>
      {marketplace.error && <p className="dialog-error">{marketplace.error}</p>}
      {!marketplace.error && !marketplace.plugins.length && <p className="artifact-missing">This marketplace lists no plugins.</p>}
      <div className="plugin-grid">{plugins.map((plugin) => <PluginCard
        key={plugin.name}
        plugin={plugin}
        marketplace={marketplace}
        installed={installedById.has(`${marketplace.id}/${plugin.name}`)}
        hooks={installedById.get(`${marketplace.id}/${plugin.name}`)?.hooks ?? []}
        busy={working}
        pending={pending === `${marketplace.id}/${plugin.name}`}
        install={() => void run(`${marketplace.id}/${plugin.name}`, () => window.emma.installPlugin({ marketplace: marketplace.id, plugin: plugin.name }))}
        uninstall={() => void run(`${marketplace.id}/${plugin.name}`, () => window.emma.uninstallPlugin(`${marketplace.id}/${plugin.name}`))}
        open={() => setShowing({ marketplace, plugin })}
      />)}</div>
    </section>)}

    {catalog.installed.length > 0 && <section className="plugin-installed">
      <header><h3>Installed</h3><small>{catalog.installed.length} {catalog.installed.length === 1 ? "plugin" : "plugins"}</small></header>
      <dl>{catalog.installed.map((plugin) => <div key={plugin.id}>
        <dt>{plugin.displayName}</dt>
        <dd>
          <span>{plugin.marketplace} · v{plugin.version}</span>
          <small>{plugin.skills.length ? `${plugin.skills.length} skill folder` : ""}{plugin.skills.length && plugin.mcpServers.length ? " · " : ""}{plugin.mcpServers.length ? "MCP servers" : ""}</small>
          {plugin.hooks.length > 0 && <button type="button" className={`plugin-hooks-review ${untrustedHooks(plugin.hooks) ? "on" : ""}`} disabled={working} onClick={() => setReviewing(plugin.id)}>
            {plugin.hooks.length} {plugin.hooks.length === 1 ? "hook" : "hooks"}{untrustedHooks(plugin.hooks) ? " · review" : ""}
          </button>}
          <button type="button" disabled={working} onClick={() => void run(plugin.id, () => window.emma.uninstallPlugin(plugin.id))}>Remove</button>
        </dd>
        {plugin.apps.map((hosted) => <small key={hosted.id} className="plugin-hosted">Carries a ChatGPT-hosted connection Emma cannot run · {hosted.id}</small>)}
      </div>)}</dl>
    </section>}

    {showing && <PluginDetailDialog
      plugin={showing.plugin}
      marketplace={showing.marketplace}
      installed={installedById.has(`${showing.marketplace.id}/${showing.plugin.name}`)}
      busy={working}
      close={() => setShowing(null)}
      install={() => void run(`${showing.marketplace.id}/${showing.plugin.name}`, () => window.emma.installPlugin({ marketplace: showing.marketplace.id, plugin: showing.plugin.name }))}
      uninstall={() => void run(`${showing.marketplace.id}/${showing.plugin.name}`, () => window.emma.uninstallPlugin(`${showing.marketplace.id}/${showing.plugin.name}`))}
    />}

    {review && <PluginHooksDialog
      plugin={review}
      busy={working}
      close={() => setReviewing("")}
      trust={(trusted) => void run(review.id, () => window.emma.trustPluginHooks({ id: review.id, trusted }))}
    />}

    {adding && <AddMarketplaceDialog busy={working} close={() => setAdding(false)} add={async (value) => {
      setCatalog(await window.emma.addMarketplace(value));
      setAdding(false);
    }} />}
  </section>;
}

function blockedReason(plugin: MarketplacePlugin): string {
  if (plugin.source.kind === "unsupported") return plugin.source.reason;
  return plugin.installation === "NOT_AVAILABLE" ? "Marked unavailable by this marketplace" : "";
}

function PluginMark({ plugin, size }: { plugin: { displayName: string; icon: string; brandColor: string }; size: "card" | "dialog" }) {
  return <span className={`plugin-mark plugin-mark-${size}`} style={plugin.brandColor ? { borderColor: plugin.brandColor } : undefined} aria-hidden="true">
    {plugin.icon ? <img src={plugin.icon} alt="" /> : <i>{plugin.displayName.slice(0, 1).toUpperCase()}</i>}
  </span>;
}

function PluginCard({ plugin, marketplace, installed, hooks, busy, pending, install, uninstall, open }: {
  plugin: MarketplacePlugin;
  marketplace: Marketplace;
  installed: boolean;
  hooks: PluginHookState[];
  busy: boolean;
  pending: boolean;
  install: () => void;
  uninstall: () => void;
  open: () => void;
}) {
  const unavailable = blockedReason(plugin);
  const untrusted = untrustedHooks(hooks);
  return <article className="plugin-card">
    <header>
      <PluginMark plugin={plugin} size="card" />
      <div>
        <span>{plugin.category || marketplace.displayName}</span>
        <button type="button" className="plugin-title" aria-haspopup="dialog" onClick={open}>{plugin.displayName}</button>
      </div>
    </header>
    <p>{plugin.description || "No description."}</p>
    {plugin.keywords.length > 0 && <ul className="plugin-keywords">{plugin.keywords.slice(0, 4).map((word) => <li key={word}>{word}</li>)}</ul>}
    <footer>
      {unavailable
        ? <small className="plugin-blocked">{unavailable}</small>
        : <button type="button" className={installed ? "" : "plugin-install"} disabled={busy} onClick={installed ? uninstall : install}>{pending ? "Working…" : installed ? "Remove" : "Install"}</button>}
      {plugin.authentication === "ON_INSTALL" && !installed && !unavailable && <small>Signs in on install</small>}
      {untrusted > 0 && <small className="plugin-untrusted">{untrusted} {untrusted === 1 ? "hook" : "hooks"} not trusted</small>}
      {installed && !untrusted && hooks.some((hook) => hookRuns(hook.event)) && <small>Hooks trusted</small>}
    </footer>
  </article>;
}

function PluginHooksDialog({ plugin, busy, close, trust }: {
  plugin: InstalledPlugin;
  busy: boolean;
  close: () => void;
  trust: (trusted: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);
  const runnable = plugin.hooks.filter((hook) => hookRuns(hook.event));
  const allTrusted = runnable.length > 0 && runnable.every((hook) => hook.trusted);

  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="plugin-hooks-title" onClose={close}
    onCancel={(event) => { event.preventDefault(); close(); }}
    onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="agent-dialog plugin-dialog">
      <header>
        <div>
          <span>{plugin.displayName}</span>
          <h2 id="plugin-hooks-title">Lifecycle hooks<InfoDot>Each command below runs on this Mac, at that moment in a turn, with <code>PLUGIN_ROOT</code> and <code>PLUGIN_DATA</code> in its environment. Trust is pinned to the exact text you see: change a hook on disk and it stops running until you review it again. Nothing runs in Plan.</InfoDot></h2>
        </div>
        <button type="button" onClick={close} aria-label="Close">×</button>
      </header>
      <ul className="plugin-hooks">
        {plugin.hooks.map((hook) => <li key={hook.hash} className={!hookRuns(hook.event) ? "plugin-hook-off" : hook.trusted ? "plugin-hook-trusted" : ""}>
          <div>
            <strong>{hook.event}</strong>
            {hook.matcher && <em>{hook.matcher}</em>}
            {hook.timeout > 0 && <em>{hook.timeout}s</em>}
            <small>{!hookRuns(hook.event) ? "Emma has no such moment" : hook.trusted ? "Trusted" : "Not trusted"}</small>
          </div>
          <code>{hook.command}</code>
          {hook.statusMessage && <p>{hook.statusMessage}</p>}
        </li>)}
      </ul>
      <div className="plugin-dialog-actions">
        <button type="button" onClick={close}>Close</button>
        {allTrusted
          ? <button type="button" disabled={busy} onClick={() => trust(false)}>Turn off</button>
          : <button type="button" className="plugin-install" disabled={busy || !runnable.length} onClick={() => trust(true)}>Trust these hooks</button>}
      </div>
    </section>
  </dialog>;
}

function PluginDetailDialog({ plugin, marketplace, installed, busy, close, install, uninstall }: {
  plugin: MarketplacePlugin;
  marketplace: Marketplace;
  installed: boolean;
  busy: boolean;
  close: () => void;
  install: () => void;
  uninstall: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<PluginDetail | null>(null);
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);
  useEffect(() => {
    let active = true;
    void window.emma.pluginDetail({ marketplace: marketplace.id, plugin: plugin.name })
      .then((found) => { if (active) setDetail(found); })
      .catch(() => { if (active) setDetail(null); });
    return () => { active = false; };
  }, [marketplace.id, plugin.name]);

  const face = detail?.interface;
  const unavailable = blockedReason(plugin);
  const links: [string, string][] = face ? ([["Website", face.websiteURL], ["Privacy", face.privacyPolicyURL], ["Terms", face.termsOfServiceURL]] as [string, string][]).filter(([, url]) => url) : [];

  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="plugin-detail-title" onClose={close}
    onCancel={(event) => { event.preventDefault(); close(); }}
    onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="agent-dialog plugin-dialog">
      <header>
        <PluginMark plugin={{ displayName: plugin.displayName, icon: detail?.icon || detail?.logo || plugin.icon, brandColor: plugin.brandColor }} size="dialog" />
        <div>
          <span>{[face?.developerName, plugin.category || marketplace.displayName].filter(Boolean).join(" · ")}</span>
          <h2 id="plugin-detail-title">{plugin.displayName}</h2>
        </div>
        <button type="button" onClick={close} aria-label="Close">×</button>
      </header>
      <div className="plugin-dialog-body">
        <p>{face?.longDescription || plugin.description || "No description."}</p>
        {!!detail?.screenshots.length && <ul className="plugin-shots">{detail.screenshots.map((shot, index) => <li key={index}><img src={shot} alt={`${plugin.displayName} screenshot ${index + 1}`} /></li>)}</ul>}
        <dl>
          {!!face?.capabilities.length && <div><dt>Capabilities</dt><dd>{face.capabilities.join(", ")}</dd></div>}
          {!!face?.defaultPrompt.length && <div><dt>Prompts</dt><dd><ul className="plugin-prompts">{face.defaultPrompt.map((prompt) => <li key={prompt}>{prompt}</li>)}</ul></dd></div>}
          {!!links.length && <div><dt>Links</dt><dd className="plugin-links">{links.map(([label, url]) => <a key={label} href={url} target="_blank" rel="noreferrer">{label} ↗</a>)}</dd></div>}
          {!!detail?.apps.length && <div><dt>Connections</dt><dd>{detail.apps.map((hosted) => <span key={hosted.id} className="plugin-hosted">Carries a ChatGPT-hosted connection Emma cannot run · {hosted.id}</span>)}</dd></div>}
        </dl>
      </div>
      <div className="plugin-dialog-actions">
        {unavailable && <small className="plugin-blocked">{unavailable}</small>}
        <button type="button" onClick={close}>Close</button>
        {!unavailable && <button type="button" className={installed ? "" : "plugin-install"} disabled={busy} onClick={installed ? uninstall : install}>{installed ? "Remove" : "Install"}</button>}
      </div>
    </section>
  </dialog>;
}

function AddMarketplaceDialog({ busy, close, add }: { busy: boolean; close: () => void; add: (value: { source: string; ref: string; sparse: string }) => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [source, setSource] = useState("");
  const [ref, setRef] = useState("");
  const [sparse, setSparse] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);

  const submit = async () => {
    setSaving(true);
    setError("");
    try { await add({ source: source.trim(), ref: ref.trim(), sparse }); }
    catch (reason) { setError(reasonText(reason)); }
    finally { setSaving(false); }
  };

  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="add-marketplace-title" onClose={close}
    onCancel={(event) => { event.preventDefault(); close(); }}
    onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="agent-dialog marketplace-dialog">
      <header>
        <div>
          <span>GitHub repo, Git URL, or a folder on this Mac</span>
          <h2 id="add-marketplace-title">Add plugin marketplace</h2>
        </div>
        <button type="button" onClick={close} aria-label="Cancel">×</button>
      </header>
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label>
          <span>Source</span>
          <input autoFocus value={source} maxLength={1024} disabled={busy || saving} onChange={(event) => setSource(event.target.value)} placeholder="openai/plugins or git@github.com:org/repo.git" />
        </label>
        <label>
          <span>Git ref</span>
          <input value={ref} maxLength={128} disabled={busy || saving} onChange={(event) => setRef(event.target.value)} placeholder="main" />
        </label>
        <label>
          <span>Sparse paths</span>
          <textarea value={sparse} rows={4} spellCheck={false} disabled={busy || saving} onChange={(event) => setSparse(event.target.value)} placeholder="plugins/codex" />
        </label>
        {error && <p className="dialog-error">{error}</p>}
        <div className="marketplace-actions">
          <button type="button" disabled={saving} onClick={close}>Cancel</button>
          <button type="submit" className="plugin-install" disabled={busy || saving || !source.trim()}>{saving ? "Adding…" : "Add marketplace"}</button>
        </div>
      </form>
    </section>
  </dialog>;
}
