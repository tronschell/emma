/* A file the model named, opened where it was named: click the path in a reply
   and the file itself comes up in Emma rather than in whatever app owns the
   extension. Markdown renders, HTML renders in a sandboxed frame with its source
   a click away, everything else is highlighted code. The full path sits in the
   header and reveals in Finder, because "where is this" is half the question.

   The opener is a window event rather than a prop: every path span in every
   rendered reply, table cell and knowledge page would otherwise have to thread a
   callback up to App for the same one modal. */

import { useEffect, useRef, useState } from "react";
import { tokenize } from "./highlight";
import { Markdown } from "./markdown";
import { OpenIn } from "./editors";

const PREVIEW_EVENT = "emma:preview-file";

/** `name` is for a file whose path is not what to call it: a pasted attachment is
    stored under its id, and "shot.png" is the only name anyone recognises it by. */
export function openPreview(path: string, name?: string) {
  dispatchEvent(new CustomEvent(PREVIEW_EVENT, { detail: { path, name } }));
}

const extension = (path: string) => path.slice(path.lastIndexOf(".") + 1).toLowerCase();
const isMarkdown = (path: string) => /^(md|markdown|mdx)$/.test(extension(path));
const isHtml = (path: string) => /^(html?|xhtml)$/.test(extension(path));

function Body({ path, name, text, image, source }: { path: string; name: string; text: string; image?: string; source: boolean }) {
  // A picture is the one file that is already its own preview.
  if (image) return <img className="preview-image" src={image} alt={name} />;
  if (isMarkdown(path) && !source) return <div className="message-body preview-prose"><Markdown text={text} /></div>;
  // No scripts, no network, no same-origin: a preview renders the page, it does
  // not run it. The frame is the only place in Emma that takes model-adjacent
  // markup, and sandbox="" is what keeps it a picture of the file.
  if (isHtml(path) && !source) return <iframe className="preview-frame" title={`Preview of ${path}`} sandbox="" srcDoc={text} />;
  return <pre className="preview-code"><code>{tokenize(text, extension(path)).map((token, at) =>
    <span key={at} className={token.kind && `tok-${token.kind}`}>{token.text}</span>)}</code></pre>;
}

/** Mounted once, next to the rest of the app's dialogs. */
export function PreviewHost() {
  const [asked, setAsked] = useState<{ path: string; name?: string } | null>(null);
  const [file, setFile] = useState<{ path: string; text: string | null; image?: string | null } | null>(null);
  const [error, setError] = useState("");
  const [source, setSource] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const open = (event: Event) => { setAsked((event as CustomEvent<{ path: string; name?: string }>).detail); setSource(false); setError(""); setFile(null); };
    addEventListener(PREVIEW_EVENT, open);
    return () => removeEventListener(PREVIEW_EVENT, open);
  }, []);

  useEffect(() => {
    if (!asked) return;
    let active = true;
    void window.emma.previewPath(asked.path)
      .then((found) => { if (!active) return; if (found) setFile(found); else setError("Emma cannot find that file on this Mac."); })
      .catch(() => { if (active) setError("That file could not be read."); });
    return () => { active = false; };
  }, [asked]);

  useEffect(() => {
    if (asked && !dialog.current?.open) dialog.current?.showModal();
    if (!asked && dialog.current?.open) dialog.current?.close();
  }, [asked]);

  if (!asked) return null;
  const close = () => setAsked(null);
  const shown = file?.path ?? asked.path;
  // The name it was attached under, when it has one, and its own otherwise.
  const called = asked.name ?? shown.slice(shown.lastIndexOf("/") + 1);
  const toggleable = !!file?.text && (isMarkdown(shown) || isHtml(shown));

  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="preview-title" onClose={close}
    onCancel={(event) => { event.preventDefault(); close(); }}
    onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="agent-dialog preview-dialog">
      <header>
        <div>
          <span>File preview</span>
          <h2 id="preview-title">{called}</h2>
        </div>
        {toggleable && <button type="button" className="preview-toggle" onClick={() => setSource((current) => !current)}>{source ? "Rendered" : "Source"}</button>}
        {/* Handed off rather than read: whatever Emma shows of a file, editing it
            belongs in an editor, and this is the row that already knows which. */}
        {file && <OpenIn path={shown} label />}
        <button type="button" onClick={close} aria-label="Close preview">×</button>
      </header>
      <button type="button" className="preview-location" title="Reveal in Finder" onClick={() => void window.emma.revealPath(shown)}>{shown}</button>
      {error && <p className="dialog-error">{error}</p>}
      {file && file.text === null && !file.image && !error && <p className="preview-empty">Emma can only read files inside a connected folder or attached to a message, and only text under 256 KB. Open it above, or reveal it in Finder.</p>}
      {(file?.text != null || file?.image) && <div className="preview-body"><Body path={shown} name={called} text={file.text ?? ""} {...(file.image ? { image: file.image } : {})} source={source} /></div>}
    </section>
  </dialog>;
}
