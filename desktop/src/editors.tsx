/* Handing something to a real editor. Main owns the detection and the `open`; this
   is the row of app marks, drawn wherever the UI names a code file — or the project
   the thread is working in. */

import { useEffect, useState } from "react";
import type { EditorApp } from "../shared/folders";

/* Asked for once per launch and shared by every row that draws it: main caches the
   answer anyway, and a file list would otherwise ask the same question per file. */
let asked: Promise<EditorApp[]> | undefined;

function useEditors(): EditorApp[] {
  const [editors, setEditors] = useState<EditorApp[]>([]);
  useEffect(() => {
    let active = true;
    asked ??= window.emma.listEditors();
    void asked.then((value) => { if (active) setEditors(value); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  return editors;
}

/* The chosen editor is one preference shared by every row on screen, so it lives
   beside them rather than inside one of them — picking a default in a diff row
   moves the marks in the preview header with it. */
const DEFAULT_KEY = "emma.default-editor";
let preferred = localStorage.getItem(DEFAULT_KEY) ?? "";
const watching = new Set<(id: string) => void>();

function usePreferred(): [string, (id: string) => void] {
  const [id, setId] = useState(preferred);
  useEffect(() => { watching.add(setId); return () => { watching.delete(setId); }; }, []);
  return [id, (next) => {
    preferred = next;
    localStorage.setItem(DEFAULT_KEY, next);
    for (const tell of watching) tell(next);
  }];
}

/** One chip per place a file or folder can be handed off, wearing the icons of the
    editors this Mac has. With no `path` it hands over the granted folder itself,
    which is what an editor wants for a project; with one, that file. With no
    `folderId` the path stands on its own — the preview names a file without knowing
    which folder, if any, holds it, and main decides whether it is one Emma may open.
    Draws nothing when no known editor is installed, so the bar it sits on is
    unchanged for someone who has none. With several, the marks overlap into one
    stack and the choice moves into a menu; once an editor is the default the stack
    opens it outright and the caret still reaches the others. */
export function OpenIn({ folderId, path, label }: { folderId?: string; path?: string; label?: boolean }) {
  const editors = useEditors();
  const [chosenId, choose] = usePreferred();
  const [open, setOpen] = useState(false);
  const [stick, setStick] = useState(false);
  if (!editors.length) return null;
  const named = path ?? "this folder";
  const send = (editor: EditorApp) => {
    void window.emma.openInEditor({ ...(folderId ? { folderId } : {}), path: path ?? ".", editorId: editor.id }).catch(() => undefined);
  };
  const mark = (editor: EditorApp) => editor.icon ? <img src={editor.icon} alt="" /> : <b>{editor.label.slice(0, 1)}</b>;

  if (editors.length === 1) {
    const [only] = editors;
    return <span className={`open-in${label ? " boxed" : ""}`}>
      <button type="button" title={`Open ${named} in ${only.label}`} aria-label={`Open ${named} in ${only.label}`} onClick={(event) => { event.preventDefault(); send(only); }}>
        {/* The words belong to the button rather than the row, so the whole chip is
            the target and the mark inside it is not a second one. */}
        {label && <small>Open in</small>}
        {mark(only)}
      </button>
    </span>;
  }

  const chosen = editors.find((editor) => editor.id === chosenId);
  const stacked = chosen ? [chosen, ...editors.filter((editor) => editor !== chosen)] : editors;
  return <span className={`open-in stacked${label ? " boxed" : ""}`}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}
    onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>
    <button type="button" className="open-in-stack"
      title={chosen ? `Open ${named} in ${chosen.label}` : `Open ${named} in an editor`}
      aria-label={chosen ? `Open ${named} in ${chosen.label}` : `Open ${named} in an editor`}
      aria-haspopup={chosen ? undefined : "menu"} aria-expanded={chosen ? undefined : open}
      onClick={(event) => { event.preventDefault(); if (chosen) send(chosen); else setOpen((was) => !was); }}>
      {label && <small>Open in</small>}
      {/* Front to back: each mark sits behind the one before it, so the stack nests
          rather than the last drawn winning. */}
      {stacked.map((editor, index) => <span className="open-in-mark" key={editor.id} style={{ zIndex: stacked.length - index }}>{mark(editor)}</span>)}
    </button>
    {chosen && <button type="button" className="open-in-more" title={`Open ${named} in another editor`} aria-label={`Open ${named} in another editor`}
      aria-haspopup="menu" aria-expanded={open} onClick={(event) => { event.preventDefault(); setOpen((was) => !was); }}>▾</button>}
    {open && <span className="open-in-menu" role="menu">
      {editors.map((editor) => <button type="button" role="menuitem" key={editor.id}
        onClick={(event) => {
          event.preventDefault();
          setOpen(false);
          if (stick) choose(editor.id);
          send(editor);
        }}>{mark(editor)}{editor.label}{editor === chosen && <em>default</em>}</button>)}
      <label><input type="checkbox" checked={stick} onChange={(event) => setStick(event.currentTarget.checked)} />Make this selection the default</label>
    </span>}
  </span>;
}
