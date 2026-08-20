const features = [
  {
    id: "01",
    title: "Work that keeps its context",
    copy: "Research, write, plan, code, and coordinate in durable Threads. Close Emma, come back later, and the work is still where you left it.",
    label: "GENERAL AGENT WORK",
  },
  {
    id: "02",
    title: "Knowledge, only on purpose",
    copy: "A conversation is not automatically a memory. Save or analyze an artifact explicitly, and Emma turns it into inspectable Knowledge Base material.",
    label: "EXPLICIT CAPTURE",
  },
  {
    id: "03",
    title: "Your models, your choice",
    copy: "Connect local or cloud models through OpenAI-compatible endpoints. Keep fast work nearby and call larger models when the task earns it.",
    label: "MODEL ROUTING",
  },
];

const capabilities = [
  [
    "Skills on demand",
    "Emma searches skills, CLI tools, and MCP servers lazily—loading the right capability when the work asks for it.",
  ],
  [
    "Integrations in context",
    "Bring external tools into a Thread without turning the product into a wall of permanent dashboards.",
  ],
  [
    "Inspectable capture",
    "See what was saved, where it came from, and what Emma derived. Private context stays legible instead of disappearing into a black box.",
  ],
  [
    "Run telemetry",
    "Follow tool calls, model use, timing, and outcomes while work is running—or inspect the trace after it finishes.",
  ],
  [
    "Scheduled synthesis",
    "Ask Emma to revisit saved material on a schedule and produce a brief, digest, or updated view of what changed.",
  ],
  [
    "macOS at the surface",
    "A compact notch surface keeps quick capture close; the full desktop workspace gives deeper work room to breathe.",
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
        <span>EMMA IS READY</span>
        <span className="keys">⌘ ↵</span>
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
            <div className="thread">
              <span>Q3 planning</span>
              <small>2H</small>
            </div>
            <div className="thread">
              <span>Model evaluation</span>
              <small>MON</small>
            </div>
            <div className="thread">
              <span>Reading queue</span>
              <small>FRI</small>
            </div>
          </aside>
          <section className="conversation" aria-label="Thread preview">
            <header>
              <div>
                <small>THREAD 084</small>
                <h3>Launch research</h3>
              </div>
              <span className="model-pill">LOCAL / QWEN</span>
            </header>
            <div className="message user-message">
              Compare the launch notes with our saved positioning and flag
              contradictions.
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
                    <small>KNOWLEDGE SEARCH</small>
                    <p>12 artifacts inspected · 3 cited</p>
                  </div>
                  <b>0.8s</b>
                </div>
              </div>
            </div>
            <div className="composer">
              <span>Ask Emma to continue…</span>
              <kbd>⌘ ↵</kbd>
            </div>
          </section>
          <aside className="knowledge-pane">
            <p className="pane-label">KNOWLEDGE BASE</p>
            <div className="kb-search">⌕ Search saved knowledge</div>
            <p className="mini-label">USED IN THIS THREAD</p>
            <article>
              <span className="file-icon">◇</span>
              <div>
                <h4>Positioning principles</h4>
                <p>ANALYZED NOTE · 8 SOURCES</p>
              </div>
            </article>
            <article>
              <span className="file-icon">□</span>
              <div>
                <h4>Launch notes v4</h4>
                <p>SAVED DOCUMENT · TODAY</p>
              </div>
            </article>
            <div className="capture-note">
              <span>◎</span>
              <p>
                <b>Nothing saves silently.</b>
                <br />
                You choose what enters knowledge.
              </p>
            </div>
          </aside>
        </div>
        <div className="telemetry">
          <span>
            <i /> EXAMPLE RUN
          </span>
          <span>3 TOOLS</span>
          <span>1,842 TOKENS</span>
          <span>12.4s</span>
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
            <a href="#capabilities">CAPABILITIES</a>
            <a href="#principles">PRINCIPLES</a>
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
              <span className="live-dot" /> MACOS-FIRST / BUILT FOR REAL WORK
            </p>
            <h1>
              Your everything agent.
              <br />
              <span>Nothing you didn’t ask for.</span>
            </h1>
            <p className="hero-copy">
              Emma carries work across durable Threads, calls the right tools
              when needed, and builds knowledge only when you explicitly save
              it.
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
            <span>01 / DURABLE THREADS</span>
            <span>02 / EXPLICIT KNOWLEDGE</span>
            <span>03 / INSPECTABLE RUNS</span>
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
              Capture a thought without breaking stride, then open the full
              workspace when the job needs sources, tools, and a durable record.
            </p>
          </div>
          <AppMockup />
        </section>

        <section className="feature-section section shell" id="product">
          <div className="section-heading-row">
            <p className="eyebrow">WHAT EMMA HOLDS</p>
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

        <section className="model-section section" id="principles">
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
                not fused to one inference path.
              </p>
              <div className="endpoint">
                <span>
                  <i /> LOCAL
                </span>
                <b>http://localhost:11434/v1</b>
                <em>PRIVATE / FAST</em>
              </div>
              <div className="endpoint">
                <span>☁ CLOUD</span>
                <b>api.openai.com/v1</b>
                <em>CONNECTED</em>
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

        <section className="synthesis section">
          <div className="shell synthesis-grid">
            <div>
              <p className="eyebrow">
                <span className="live-dot" /> SCHEDULED SYNTHESIS
              </p>
              <h2>
                Let saved knowledge
                <br />
                keep doing work.
              </h2>
              <p>
                Schedule a recurring pass over chosen artifacts. Emma can
                surface changes and connections without quietly expanding what
                it remembers.
              </p>
            </div>
            <div className="schedule-card">
              <div className="schedule-head">
                <span>NEXT SYNTHESIS</span>
                <b>MON / 08:00</b>
              </div>
              <div className="orbit" aria-hidden="true">
                <span>
                  WEEKLY
                  <br />
                  BRIEF
                </span>
              </div>
              <dl>
                <div>
                  <dt>SCOPE</dt>
                  <dd>12 saved artifacts</dd>
                </div>
                <div>
                  <dt>OUTPUT</dt>
                  <dd>Thread + citations</dd>
                </div>
                <div>
                  <dt>STATUS</dt>
                  <dd>
                    <i /> Scheduled
                  </dd>
                </div>
              </dl>
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
            <a href="#capabilities">CAPABILITIES</a>
            <a href="#principles">PRINCIPLES</a>
          </nav>
          <p className="copyright">© {new Date().getFullYear()} EMMA</p>
        </div>
      </footer>
    </>
  );
}

export default App;
