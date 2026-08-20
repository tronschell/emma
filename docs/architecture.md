# Product and behavior contract

## Source of truth

Each knowledge page is one exportable Markdown file. `emma-core` owns parsing,
atomic persistence, and domain invariants. GPUI entities hold a live projection
only. The Zig sidecar owns transient agent runs, tool selection, and usage
accounting; it cannot mutate the library without an explicit host command.

## Capture flow

`Command-Shift-Space` requests the agent surface. Its state machine is:

```text
Hidden -> Capturing -> Ready -> Analyzing -> Saved
                    |         |           -> Failed
                    +---------+------------> Cancelled -> Hidden
```

The surface shows captured app/title/URL/screenshot metadata before submission.
Enter submits from the prompt, Escape cancels the innermost transient state,
and Tab/Shift-Tab visit visible controls. Closing returns focus to the prior
application where the platform permits it. Pointer, keyboard, and accessibility
actions route through the same typed intent.

## Windows and material

The library is a normal resizable window. The agent surface is a transient,
topmost macOS window placed under, left of, or right of the display notch from
one preference. The first implementation may use GPUI whole-window blur where
the backend supports it; it is not described as native Liquid Glass. Reduced
transparency and increased contrast use an opaque surface. Reduced motion
removes travel and spring effects.

## Privacy and failure

Screen context is opt-in, previewed, and removable before a request. Raw
screenshots, clipboard content, document text, URLs, prompts, API keys, and MCP
arguments are excluded from diagnostics. Denied screen-recording or
accessibility permission produces an actionable non-destructive error. Cancelled
or stale analysis cannot overwrite a newer page.

## Agent and extensions

The sidecar uses newline-delimited JSON over stdio so UI and agent lifetimes are
independent. Provider configuration is OpenAI-compatible base URL, model, and a
credential reference supplied by the host; there is no Vercel login surface.
MCP servers remain disconnected until needed. The model first sees server/tool
metadata, calls `mcp_search_tools`, selects one exact tool, and receives only
that schema on the next step.

The first extension mechanism is this command/tool protocol plus skills on
disk. A general UI/plugin SDK is deferred until two concrete extensions prove
the lifecycle, permission, versioning, and rendering contracts.

