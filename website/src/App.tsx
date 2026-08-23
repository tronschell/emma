const features = [
  {
    id: "01",
    title: "The composer is the agent",
    copy: "Emma reads and writes the folders you attach, searches them with the bundled ripgrep, runs shell commands, keeps long ones alive in the background, calls connected MCP tools, runs your other coding CLIs, and spawns subagents. Type / to name a capability, @ to name a file.",
    label: "EVERY TURN IS AN AGENT TURN",
  },
  {
    id: "02",
    title: "Knowledge, only on purpose",
    copy: "A turn is not a memory. Save & analyze writes one page into the named knowledge base the thread points at, with its category, source thread, model, and token counts. Editing that page is a separate, explicit action.",
    label: "EXPLICIT CAPTURE",
  },
  {
    id: "03",
    title: "Every run leaves a record",
    copy: "Threads are durable Markdown you can close and come back to. The inspector carries the turn as a span waterfall, a ledger of what the prompt actually carried, a Git tab for the connected folder, and a +N −M diff of Emma’s own writes with a revert per file.",
    label: "INSPECTABLE RUNS",
  },
];

const modes = [
  ["PLAN", "Only tools that cannot change this Mac are advertised."],
  ["ASK", "Every write, command, and click asks first. This is the default."],
  [
    "ACCEPT EDITS",
    "Files are written and searched without asking. Commands and the pointer still ask.",
  ],
  [
    "AUTO",
    "A separate verifier model reads each gated call. Anything it will not clear comes back to you.",
  ],
  ["FULL", "Nothing asks. Escape still stops a run."],
];

const capabilities = [
  [
    "The notch surfaces",
    "Quick Ask is one island centered on the real camera housing, opened by a double-tap of the left Option key. While Emma is idle a click-through sliver sits over the housing and reveals a sparkle wave on hover.",
  ],
  [
    "Quick actions, three ways",
    "Three saved actions hang under the island as orbs, orbit the cursor in a ring of up to eight, and run from Command-1, 2, and 3 at any time. Every ring command is validated in the main process against a fixed catalog.",
  ],
  [
    "Save the front page",
    "Emma reads the page out of whichever whitelisted browser is in front, keeps its favicon and lead pictures, and writes it up as a document. It files that page into a category by itself once one of your categories has five examples to learn from.",
  ],
  [
    "Subagents and sub threads",
    "A live subagent gets its own color in the sidebar and its own tab, where you can steer it, stop it, and read its model, rate, tokens, and tool calls. A new thread instead starts a full agent nested under its parent.",
  ],
  [
    "Skills and MCP, imported",
    "Register the skill and MCP locations you already have in Codex, Claude, Cursor, Windsurf, and others, without copying their config. Emma can install a skill or an MCP server for herself mid-turn and use it in that same turn.",
  ],
  [
    "Dictation that stays here",
    "Off until you turn it on. Recording happens locally, a local transcription endpoint does the words, and an optional local model rewrites them as written English. Emma enforces that both endpoints are local.",
  ],
];

function Mark({ small = false }: { small?: boolean }) {
  return (
    <span className={small ? "mark mark-small" : "mark"} aria-hidden="true">
      <svg viewBox="0 0 36 36" fill="none">
        <path d="M7 19.5 18 7l11 12.5L18 29 7 19.5Z" />
        <path d="m7 16.5 11 9.5 11-9.5M18 7v19" />
      </svg>
    </span>
  );
}

function AppMockup() {
  return (
    <div
      className="mock-wrap"
      aria-label="Illustrative Emma desktop interface preview"
    >
      <div className="notch-card">
        <span className="live-dot" />
        <span>QUICK ASK</span>
        <span className="keys">⌥ ⌥</span>
      </div>
      <div className="window">
        <div className="window-bar">
          <div className="traffic" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <span>EMMA / WORKSPACE</span>
          <span className="run-state">
            <i /> DEMO
          </span>
        </div>
        <div className="window-grid">
          <aside className="thread-list">
            <p className="pane-label">THREADS</p>
            <div className="new-thread">+ NEW THREAD</div>
            <div className="thread active">
              <span>Launch research</span>
              <small>NOW</small>
            </div>
            <div className="thread sub">
              <span>
                <i /> Read the pricing pages
              </span>
              <small>SUBAGENT</small>
            </div>
            <div className="thread">
              <span>Q3 planning</span>
              <small>2H</small>
            </div>
            <div className="thread">
              <span>Tokenizer sweep</span>
              <small>MON</small>
            </div>
          </aside>
          <section className="conversation" aria-label="Thread preview">
            <header>
              <div>
                <small>THREAD 084 / RESEARCH</small>
                <h3>Launch research</h3>
              </div>
              <span className="model-pill">OPENROUTER</span>
            </header>
            <div className="message user-message">
              Compare the launch notes in ~/work/launch with our saved
              positioning and flag contradictions.
            </div>
            <div className="agent-line">
              <Mark small />
              <div>
                <p>
                  I found two meaningful tensions. The strongest is between the
                  “ambient memory” claim and your explicit-capture principle.
                </p>
                <div className="tool-call">
                  <span>↳</span>
                  <div>
                    <small>RIPGREP</small>
                    <p>~/work/launch · 34 matches</p>
                  </div>
                  <b>0.4s</b>
                </div>
                <div className="tool-call">
                  <span>↳</span>
                  <div>
                    <small>TASK / SUBAGENT</small>
                    <p>Read the pricing pages · running</p>
                  </div>
                  <b>0.8s</b>
                </div>
              </div>
            </div>
            <div className="composer">
              <span>Ask Emma to continue…</span>
              <span className="composer-controls">
                <b className="mode-chip">◈ ASK</b>
                <kbd>⌘ ↵</kbd>
              </span>
            </div>
          </section>
          <aside className="knowledge-pane">
            <p className="pane-label">KNOWLEDGE / RESEARCH</p>
            <div className="kb-search">⌕ Search saved pages</div>
            <p className="mini-label">USED IN THIS THREAD</p>
            <article>
              <span className="file-icon">◇</span>
              <div>
                <h4>Positioning principles</h4>
                <p>ANALYZED PAGE · 8 SOURCES</p>
              </div>
            </article>
            <article>
              <span className="file-icon">□</span>
              <div>
                <h4>Launch notes v4</h4>
                <p>SAVED PAGE · TODAY</p>
              </div>
            </article>
            <div className="capture-note">
              <span>◎</span>
              <p>
                <b>Nothing saves silently.</b>
                <br />
                Saved pages mirror to ~/Documents/Emma Knowledge.
              </p>
            </div>
          </aside>
        </div>
        <div className="telemetry">
          <span>
            <i /> EXAMPLE RUN
          </span>
          <span>5 TOOL CALLS</span>
          <span>1 SUBAGENT</span>
          <span>SPAN TRACE</span>
        </div>
      </div>
    </div>
  );
}

function App() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <nav className="nav shell" aria-label="Primary navigation">
          <a className="brand" href="#top" aria-label="Emma home">
            <Mark small />
            <span>EMMA</span>
          </a>
          <div className="nav-links">
            <a href="#product">PRODUCT</a>
            <a href="#control">CONTROL</a>
            <a href="#capabilities">CAPABILITIES</a>
          </div>
          <a className="nav-cta" href="#preview">
            EXPLORE EMMA <span>↗</span>
          </a>
        </nav>
      </header>

      <main id="main">
        <section className="hero" id="top">
          <div className="blueprint" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className="shell hero-content">
            <p className="eyebrow">
              <span className="live-dot" /> MACOS-FIRST / ONE LOOP, EVERY
              SURFACE
            </p>
            <h1>
              Your everything agent.
              <br />
              <span>Nothing you didn’t ask for.</span>
            </h1>
            <p className="hero-copy">
              Emma is a macOS agent workspace and an exportable knowledge base.
              The composer, the notch, a quick action, and a scheduled job all
              run the same agent loop, under a permission mode you choose.
            </p>
            <div className="actions">
              <a className="primary" href="#preview">
                EXPLORE THE WORKSPACE <span>↗</span>
              </a>
              <a className="secondary" href="#product">
                SEE HOW EMMA THINKS <span>↓</span>
              </a>
            </div>
          </div>
          <div className="shell status-strip" aria-label="Product principles">
            <span>01 / PERMISSION MODES</span>
            <span>02 / EXPLICIT KNOWLEDGE</span>
            <span>03 / PLAIN MARKDOWN</span>
          </div>
        </section>

        <section className="preview section shell" id="preview">
          <div className="section-intro">
            <p className="eyebrow">THE WORKSPACE</p>
            <h2>
              Quick at the notch.
              <br />
              Deep on the desktop.
            </h2>
            <p>
              Double-tap the left Option key and Quick Ask opens on the real
              notch. Open the full workspace when the job needs folders, tools,
              subagents, and a durable record.
            </p>
          </div>
          <AppMockup />
        </section>

        <section className="feature-section section shell" id="product">
          <div className="section-heading-row">
            <p className="eyebrow">WHAT A TURN CAN DO</p>
            <p>ONE SYSTEM / THREE CLEAR BOUNDARIES</p>
          </div>
          <div className="feature-grid">
            {features.map((feature) => (
              <article className="feature-card" key={feature.id}>
                <div className="card-top">
                  <span>{feature.id}</span>
                  <Mark small />
                </div>
                <div>
                  <p className="mini-label">{feature.label}</p>
                  <h3>{feature.title}</h3>
                  <p>{feature.copy}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="section" id="control">
          <div className="shell split">
            <div>
              <p className="eyebrow">PERMISSION MODES</p>
              <h2>
                You decide how much
                <br />
                Emma does alone.
              </h2>
              <div className="mode-list">
                {modes.map(([name, copy]) => (
                  <div className="mode-row" key={name}>
                    <span>{name}</span>
                    <p>{copy}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="model-copy">
              <p>
                One table decides what each mode advertises and what it stops to
                ask about, so the picker beside ＋ and the check that enforces
                it cannot drift. A scheduled job fires under the mode it was
                saved with. The terminal command reads the same names.
              </p>
              <div className="schedule-card">
                <div className="schedule-head">
                  <span>CONTROL THIS MAC</span>
                  <b>＋ MENU</b>
                </div>
                <dl>
                  <div>
                    <dt>APPROVAL</dt>
                    <dd>Per run, before it starts</dd>
                  </div>
                  <div>
                    <dt>CEILINGS</dt>
                    <dd>20 steps / 10 minutes</dd>
                  </div>
                  <div>
                    <dt>STOP</dt>
                    <dd>Escape, from anywhere</dd>
                  </div>
                  <div>
                    <dt>BANNER</dt>
                    <dd>
                      <i /> Above every app
                    </dd>
                  </div>
                </dl>
              </div>
            </div>
          </div>
        </section>

        <section className="model-section section" id="models">
          <div className="shell split">
            <div>
              <p className="eyebrow">MODEL FREEDOM</p>
              <h2>
                Local when you want it.
                <br />
                Cloud when you need it.
              </h2>
            </div>
            <div className="model-copy">
              <p>
                Emma speaks the OpenAI-compatible protocol, so the workspace is
                not fused to one inference path. A pasted key is encrypted with
                the OS keychain and reaches the agent through its spawn
                environment; the interface only ever gets a mask back.
              </p>
              <div className="endpoint">
                <span>
                  <i /> LOCAL
                </span>
                <b>http://127.0.0.1:1234/v1</b>
                <em>BASE URL / MODEL / KEY NAME</em>
              </div>
              <div className="endpoint">
                <span>☁ OPENROUTER</span>
                <b>Live tool-capable catalog</b>
                <em>BROWSING NEEDS NO KEY</em>
              </div>
              <div className="endpoint">
                <span>◈ ZERO RETENTION</span>
                <b>Fail closed, never fall back</b>
                <em>OFF BY DEFAULT</em>
              </div>
            </div>
          </div>
        </section>

        <section className="capability-section section shell" id="capabilities">
          <div className="section-intro compact">
            <p className="eyebrow">CAPABILITIES</p>
            <h2>
              Power that appears
              <br />
              when the work calls for it.
            </h2>
          </div>
          <div className="capability-grid">
            {capabilities.map(([title, copy], index) => (
              <article key={title}>
                <div className="cap-icon" aria-hidden="true">
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <svg viewBox="0 0 48 48" fill="none">
                    <circle cx="24" cy="24" r="15" />
                    <path d="M12 24h24M24 12v24" />
                  </svg>
                </div>
                <h3>{title}</h3>
                <p>{copy}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="synthesis section" id="jobs">
          <div className="shell synthesis-grid">
            <div>
              <p className="eyebrow">
                <span className="live-dot" /> JOBS THAT RUN WITHOUT YOU
              </p>
              <h2>
                Schedule a workflow.
                <br />
                Or run an experiment.
              </h2>
              <p>
                A scheduled job is a workflow: one trigger — UTC cron, manual,
                after another job, or an app event — and a graph of agent, set,
                and branch nodes. It opens a normal thread under the mode it was
                saved with, and never saves knowledge or writes a skill
                silently. An autoresearch job points at a git project instead:
                Emma proposes one change, runs your eval command, reads the
                metric, and keeps or reverts the commit until a budget stops it.
                The metric cannot be edited while the job lives.
              </p>
            </div>
            <div className="schedule-card">
              <div className="schedule-head">
                <span>AUTORESEARCH</span>
                <b>ITERATION 24</b>
              </div>
              <div className="orbit" aria-hidden="true">
                <span>
                  METRIC
                  <br />
                  LOCKED
                </span>
              </div>
              <dl>
                <div>
                  <dt>EVAL</dt>
                  <dd>uv run train.py</dd>
                </div>
                <div>
                  <dt>BUDGET</dt>
                  <dd>Time / tokens / spend</dd>
                </div>
                <div>
                  <dt>LAST</dt>
                  <dd>
                    <i /> Kept the commit
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        </section>

        <section className="section shell" id="knowledge">
          <div className="split">
            <div>
              <p className="eyebrow">PLAIN MARKDOWN</p>
              <h2>
                A knowledge base you
                <br />
                can read without Emma.
              </h2>
            </div>
            <div className="model-copy">
              <p>
                Every thread points at one named knowledge base. Each saved page
                is mirrored as ordinary Markdown — YAML front matter and the
                document Emma built — into your Documents folder, where you and
                any other agent on this Mac can read it without knowing Emma’s
                storage format. The mirror is derived: Emma never reads it back.
              </p>
              <div className="endpoint">
                <span>◇ MIRROR</span>
                <b>~/Documents/Emma Knowledge</b>
                <em>MOVE IT OR TURN IT OFF</em>
              </div>
              <div className="endpoint">
                <span>▸ TERMINAL</span>
                <b>emma-cli ask “your prompt”</b>
                <em>SAME AGENT, HEADLESS</em>
              </div>
              <div className="endpoint">
                <span>◈ MODE</span>
                <b>every call gated on the tty</b>
                <em>SAME GATES, NO WINDOW</em>
              </div>
            </div>
          </div>
        </section>

        <section className="final-cta section shell">
          <p className="eyebrow">A QUIETER KIND OF POWER</p>
          <h2>
            Do the work.
            <br />
            <span>Keep what matters.</span>
          </h2>
          <p>
            Emma is an everything agent built around boundaries you can see.
          </p>
          <a className="primary" href="#preview">
            EXPLORE EMMA <span>↗</span>
          </a>
        </section>
      </main>

      <footer>
        <div className="shell footer-grid">
          <a className="brand" href="#top">
            <Mark small />
            <span>EMMA</span>
          </a>
          <p>A macOS-first everything agent.</p>
          <nav aria-label="Footer navigation">
            <a href="#product">PRODUCT</a>
            <a href="#control">CONTROL</a>
            <a href="#capabilities">CAPABILITIES</a>
            <a href="#knowledge">KNOWLEDGE</a>
          </nav>
          <p className="copyright">© {new Date().getFullYear()} EMMA</p>
        </div>
      </footer>
    </>
  );
}

export default App;
