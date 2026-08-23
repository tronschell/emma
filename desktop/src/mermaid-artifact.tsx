import { useEffect, useId, useRef, useState } from "react";
import mermaid from "mermaid";

/* Its own module so mermaid — a parser per diagram grammar — stays out of the
   workspace and overlay bundles: the page loads it only when a diagram artifact
   is actually on screen. */

// Same reading as the chart artifact: tokens, never pasted hex. Mermaid takes its
// palette as a config object rather than as CSS, so it is handed over once here.
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const ink = token("--text");
const rule = token("--border-strong");

mermaid.initialize({
  startOnLoad: false,
  // The diagram is a model's output, so mermaid's own DOMPurify pass is what keeps
  // it a picture: strict also drops the HTML labels and click handlers a diagram
  // can otherwise ask for. It is the default; it is set because it is load-bearing.
  securityLevel: "strict",
  // A bad diagram is expected input, not an exception — mermaid's stick-figure
  // error card is suppressed so the component can show the parser's line instead.
  suppressErrorRendering: true,
  theme: "base",
  fontFamily: token("--font-mono"),
  themeVariables: {
    background: token("--surface"), mainBkg: token("--surface-3"), nodeBorder: rule, lineColor: token("--text-3"),
    primaryColor: token("--surface-3"), primaryTextColor: ink, primaryBorderColor: rule,
    secondaryColor: token("--surface-4"), tertiaryColor: token("--surface-2"), textColor: ink, fontSize: "12px",
  },
});

export default function MermaidArtifact({ text }: { text: string }) {
  const host = useRef<HTMLDivElement>(null);
  // Mermaid puts the id straight into a selector, and useId's delimiters are not
  // valid in one.
  const id = `mmd-${useId().replace(/[^a-z0-9]/gi, "")}`;
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    // Mermaid hands back a finished, sanitised SVG string, so it is assigned
    // rather than built out of elements. It is the one place in the renderer that
    // does — see the security level above for why that is allowed to stand.
    void mermaid.render(id, text)
      .then(({ svg }) => { if (!active) return; setError(""); if (host.current) host.current.innerHTML = svg; })
      .catch((cause: unknown) => { if (!active) return; if (host.current) host.current.innerHTML = ""; setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [id, text]);

  return <figure className="artifact-mermaid">
    {/* The source is shown with the error because the diagram is the only copy of
        it the user has: reading the line the parser named needs the line. */}
    {error && <><p className="dialog-error">{error}</p><pre className="artifact-code">{text}</pre></>}
    <div ref={host} />
  </figure>;
}
