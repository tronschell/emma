import { useEffect, useRef, useState } from "react";
import { VISUAL_HEIGHT_MESSAGE, VISUAL_PICK_MESSAGE, VISUAL_PICKED_MESSAGE, visualFrameUrl, visualPage, type Visual as Drawn } from "../shared/visualize";
import type { ContextPick } from "../shared/folders";
import { reasonText } from "./errors";

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 760;
const DEFAULT_WIDTH = 720;

export function Visual({ id, onKept, onPicked }: { id: string; onKept: (artifactId: string) => void; onPicked: (pick: ContextPick) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [drawn, setDrawn] = useState<Drawn | false | null>(null);
  const [height, setHeight] = useState(MIN_HEIGHT);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    let alive = true;
    void window.emma.readVisual(id)
      .then((visual) => { if (alive) setDrawn(visual); })
      .catch(() => { if (alive) setDrawn(false); });
    return () => { alive = false; };
  }, [id]);

  useEffect(() => {
    const heard = (event: MessageEvent) => {
      const page = frame.current?.contentWindow;
      const said = event.data as { emma?: unknown; height?: unknown; label?: unknown; html?: unknown };
      if (!page || event.source !== page) return;
      if (said?.emma === VISUAL_HEIGHT_MESSAGE && typeof said.height === "number") {
        setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(said.height))));
        return;
      }
      if (said?.emma !== VISUAL_PICKED_MESSAGE || typeof said.label !== "string" || typeof said.html !== "string") return;
      const title = typeof drawn === "object" && drawn ? drawn.title : "Picture";
      onPicked({ kind: "visual", id: `${id}:${said.label}`, title, label: said.label, html: said.html });
      setNote(`${said.label} is attached to your next message.`);
    };
    window.addEventListener("message", heard);
    return () => window.removeEventListener("message", heard);
  }, [id, drawn, onPicked]);

  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ emma: VISUAL_PICK_MESSAGE, on: picking }, "*");
  }, [picking]);

  if (drawn === false) return <p className="visual-missing">That picture belonged to an earlier run of Emma.</p>;
  if (!drawn) return null;

  const run = async (label: string, work: () => Promise<string>) => {
    setBusy(label);
    setNote("");
    try { setNote(await work()); }
    catch (error) { setNote(reasonText(error)); }
    finally { setBusy(""); }
  };

  const exportPng = () => run("Exporting", async () => {
    const saved = await window.emma.exportVisual(id, frame.current?.clientWidth || DEFAULT_WIDTH);
    return saved ? `Saved to ${saved}` : "";
  });

  const keep = () => run("Keeping", async () => {
    const artifact = await window.emma.saveArtifact({ title: drawn.title, kind: "html", content: visualPage(drawn.html) });
    onKept(artifact.id);
    return `Kept as the artifact "${artifact.title}".`;
  });

  return <figure className="visual">
    <header>
      <strong title={drawn.title}>{drawn.title}</strong>
      <span>
        <button type="button" aria-pressed={picking} disabled={!!busy} onClick={() => { setPicking(!picking); setNote(picking ? "" : "Point at a part of the picture to attach it to your next message."); }} title="Point at a part of this to ask for a change">{picking ? "Done" : "Edit"}</button>
        <button type="button" disabled={!!busy} onClick={exportPng} title="Save a PNG of the whole thing">{busy === "Exporting" ? "Exporting…" : "Export"}</button>
        <button type="button" disabled={!!busy} onClick={keep} title="Keep this on the Artifacts page">{busy === "Keeping" ? "Keeping…" : "Keep"}</button>
      </span>
    </header>
    <iframe ref={frame} title={drawn.title} sandbox="allow-scripts" src={visualFrameUrl(id)} style={{ height }} onLoad={() => { if (picking) frame.current?.contentWindow?.postMessage({ emma: VISUAL_PICK_MESSAGE, on: true }, "*"); }} />
    {note && <figcaption>{note}</figcaption>}
  </figure>;
}
