import { useEffect, useRef, useState } from "react";
import { tokenize } from "./highlight";
import { Markdown } from "./markdown";
import { OpenIn } from "./editors";
import { TextIcon } from "./icons";

const PREVIEW_EVENT = "emma:preview-file";

export function openPreview(path: string, name?: string) {
  dispatchEvent(new CustomEvent(PREVIEW_EVENT, { detail: { path, name } }));
}

const extension = (path: string) => path.slice(path.lastIndexOf(".") + 1).toLowerCase();
export const isMarkdown = (path: string) => /^(md|markdown|mdx)$/.test(extension(path));
const isHtml = (path: string) => /^(html?|xhtml)$/.test(extension(path));
const isAbsolutePath = (path: string) => /^(?:[A-Za-z]:[\\/]|[\\/]{2}|\/)/.test(path);
const pathName = (path: string) => path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);

export function ReadMarkdown({ folderId, path, name }: { folderId?: string; path: string; name?: string }) {
  if (!isMarkdown(path)) return null;
  const open = () => {
    if (isAbsolutePath(path) || !folderId) { openPreview(path, name); return; }
    void window.emma.listFolders()
      .then((grants) => {
        const root = grants.find((grant) => grant.id === folderId)?.path;
        if (root) openPreview(`${root.replace(/[\\/]$/, "")}/${path}`, name ?? pathName(path));
      })
      .catch(() => undefined);
  };
  return <button type="button" className="md-read" title={`Read ${path} as Markdown`} aria-label={`Read ${path} as Markdown`}
    onClick={(event) => { event.preventDefault(); open(); }}><TextIcon /></button>;
}

function Body({ path, name, text, image, source }: { path: string; name: string; text: string; image?: string; source: boolean }) {
  if (image) return <img className="preview-image" src={image} alt={name} />;
  if (isMarkdown(path) && !source) return <div className="message-body preview-prose"><Markdown text={text} /></div>;
  if (isHtml(path) && !source) return <iframe className="preview-frame" title={`Preview of ${path}`} sandbox="" srcDoc={text} />;
  return <pre className="preview-code"><code>{tokenize(text, extension(path)).map((token, at) =>
    <span key={at} className={token.kind && `tok-${token.kind}`}>{token.text}</span>)}</code></pre>;
}

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
      .then((found) => { if (!active) return; if (found) setFile(found); else setError("Emma cannot find that file on this computer."); })
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
  const called = asked.name ?? pathName(shown);
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
        {file && <OpenIn path={shown} label />}
        <button type="button" onClick={close} aria-label="Close preview">×</button>
      </header>
      <button type="button" className="preview-location" title="Reveal in the file manager" onClick={() => void window.emma.revealPath(shown)}>{shown}</button>
      {error && <p className="dialog-error">{error}</p>}
      {file && file.text === null && !file.image && !error && <p className="preview-empty">Emma can only read files inside a connected folder or attached to a message, and only text under 256 KB. Open it above, or reveal it in the file manager.</p>}
      {(file?.text != null || file?.image) && <div className="preview-body"><Body path={shown} name={called} text={file.text ?? ""} {...(file.image ? { image: file.image } : {})} source={source} /></div>}
    </section>
  </dialog>;
}
