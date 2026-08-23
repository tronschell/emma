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

/** One button per editor this Mac has, wearing that app's own icon. With no `path`
    it hands over the granted folder itself, which is what an editor wants for a
    project; with one, that file. Draws nothing when no known editor is installed,
    so the bar it sits on is unchanged for someone who has none. */
export function OpenIn({ folderId, path, label }: { folderId: string; path?: string; label?: boolean }) {
  const editors = useEditors();
  if (!editors.length) return null;
  const named = path ?? "this folder";
  return <span className={`open-in${label ? " boxed" : ""}`}>
    {label && <small>Open in</small>}
    {editors.map((editor) => <button
      type="button" key={editor.id} title={`Open ${named} in ${editor.label}`} aria-label={`Open ${named} in ${editor.label}`}
      onClick={(event) => { event.preventDefault(); void window.emma.openInEditor({ folderId, path: path ?? ".", editorId: editor.id }).catch(() => undefined); }}>
      {editor.icon ? <img src={editor.icon} alt="" /> : <b>{editor.label.slice(0, 1)}</b>}
    </button>)}
  </span>;
}
