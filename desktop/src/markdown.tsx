/* A message rendered as what it says instead of how it was typed. Every node is
   a React element built from parsed data — never dangerouslySetInnerHTML — so
   nothing a model writes can become markup. Parsing lives in ./markdown-parse
   (see the note there: the test compile does not take JSX).

   The blocks come out as a fragment, so they land as direct children of
   .message-body and inherit the prose rules conversation.css already owns. */

import { useEffect, useMemo, useState } from "react";
import { FileMark } from "./git";
import { GlobeIcon } from "./icons";
import { parseBlocks, type Item, type Row, type Span } from "./markdown-parse";
import { openPreview } from "./preview";
import { CodeBlock } from "./run-block";

function PathSpan({ path, text }: { path: string; text: string }) {
  return <code className="md-path" role="button" tabIndex={0} title={`Open ${path}`}
    onClick={() => openPreview(path)}
    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openPreview(path); } }}
  ><FileMark path={path} />{text || path}</code>;
}

function Picture({ path, alt }: { path: string; alt: string }) {
  const [source, setSource] = useState("");
  useEffect(() => {
    let live = true;
    void window.emma.previewPath(path)
      .then((found) => { if (live) setSource(found?.image ?? ""); })
      .catch(() => { if (live) setSource(""); });
    return () => { live = false; };
  }, [path]);
  if (!source) return <PathSpan path={path} text={alt} />;
  return <img className="md-image" src={source} alt={alt} title={path} onClick={() => openPreview(path, alt || undefined)} />;
}

function Spans({ spans }: { spans: Span[] }) {
  return <>{spans.map((span, index) => {
    // Links open through the window-open handler in main.ts, same as every
    // other link in the app; nothing here opens anything by itself.
    if (span.href) return <a key={index} href={span.href} target="_blank" rel="noreferrer"><span className="git-type" aria-hidden="true"><GlobeIcon /></span>{span.text}</a>;
    if (span.image && span.path) return <Picture key={index} path={span.path} alt={span.text} />;
    // Opens the file in Emma, with its location and a reveal in the header.
    if (span.path) return <PathSpan key={index} path={span.path} text={span.text} />;
    if (span.code) return <code key={index}>{span.text}</code>;
    if (span.bold) return <strong key={index}>{span.text}</strong>;
    if (span.strike) return <del key={index}>{span.text}</del>;
    if (span.italic) return <em key={index}>{span.text}</em>;
    return <span key={index}>{span.text}</span>;
  })}</>;
}

function Items({ ordered, items }: { ordered: boolean; items: Item[] }) {
  const List = ordered ? "ol" : "ul";
  return <List>{items.map((item, index) => <li key={index} className={item.checked === undefined ? undefined : "md-task"}>
    {item.checked !== undefined && <input type="checkbox" checked={item.checked} disabled aria-label={item.checked ? "Done" : "Not done"} />}
    <Spans spans={item.spans} />
    {item.sub && <Items ordered={item.sub.ordered} items={item.sub.items} />}
  </li>)}</List>;
}

function Cells({ row, head }: { row: Row; head?: true }) {
  const Cell = head ? "th" : "td";
  return <tr>{row.map((cell, index) => <Cell key={index}><Spans spans={cell} /></Cell>)}</tr>;
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return <>{blocks.map((block, index) => {
    switch (block.kind) {
      case "heading": {
        // Demoted like an artifact's headings: a message is embedded content
        // and must not outrank the app's own outline.
        const Heading = `h${Math.min(block.level + 2, 6)}` as "h3";
        return <Heading key={index}><Spans spans={block.spans} /></Heading>;
      }
      case "code":
        // Highlighting, copy, and — for a shell fence inside a thread — a play
        // button and the terminal it opens. See ./run-block.
        return <CodeBlock key={index} text={block.text} language={block.language} />;
      case "list":
        return <Items key={index} ordered={block.ordered} items={block.items} />;
      case "table":
        return <div key={index} className="md-table"><table>
          <thead><Cells row={block.head} head /></thead>
          <tbody>{block.rows.map((row, rowIndex) => <Cells key={rowIndex} row={row} />)}</tbody>
        </table></div>;
      case "quote":
        return <blockquote key={index}><Spans spans={block.spans} /></blockquote>;
      case "rule":
        return <hr key={index} />;
      default:
        return <p key={index}><Spans spans={block.spans} /></p>;
    }
  })}</>;
}
