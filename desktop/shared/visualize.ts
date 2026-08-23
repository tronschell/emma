/* A visualization is a picture drawn to explain the answer being given right now.

   Deliberately not an artifact, and the distinction is the whole feature: an
   artifact is a file on disk the user keeps, reopens, edits and hands to a
   scheduled task. This is none of those. Nothing is written, it gets no id in the
   artifact namespace, it never appears in the artifacts list — it lives in the
   thread's timeline and nowhere else, and it dies with the turn's transcript.

   Which is also why the payload travels in the tool call's *arguments* rather
   than in its result. The harness passes on only the first 200 bytes of a tool's
   output, so a chart sent back that way would arrive with its data cut off. The
   result carries one marker instead — the trick `ARTIFACT_MARKER` already plays,
   anchored at the start for the same reason — and the transcript reads the
   picture off the call that drew it. `rawInput` keeps 4096 characters of those
   arguments on the harness path, which the ceilings below stay well inside. */

/** What `chart-artifact.tsx` already draws. No new charting path, no new dependency. */
export const VISUAL_KINDS = ["bar", "line", "area"] as const;
export type VisualKind = (typeof VISUAL_KINDS)[number];

/** Points a reader can tell apart at this size, and what `chart-artifact` slices to anyway. */
export const MAX_VISUAL_POINTS = 12;
export const MAX_VISUAL_LABEL_CHARS = 24;
export const MAX_VISUAL_CAPTION_CHARS = 120;

export interface Visualization {
  kind: VisualKind;
  labels: string[];
  values: number[];
  /** One line under the chart, and the series name in its tooltip. Empty is fine. */
  caption: string;
}

/**
 * How a finished call says it drew one. Leads the result, and is the whole test:
 * the tool's *name* never reaches the renderer — on the harness a bridged call
 * arrives as ACP's `other` — so the output is the one channel both loops carry.
 */
export const VISUAL_MARKER = "[visual]";

/**
 * One call's arguments as a picture, or a refusal written for the model, since a
 * throw here goes back as its tool result and is its next read.
 *
 * The one validator: main runs it at the trust boundary before the call is
 * allowed to have happened, and the renderer runs it again on the way back out of
 * the step, so a payload main would have refused can never become a chart.
 */
export function parseVisualization(value: unknown): Visualization {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool arguments must be a JSON object.");
  const args = value as Record<string, unknown>;
  const kind = VISUAL_KINDS.find((candidate) => candidate === (args.kind ?? "bar"));
  if (!kind) throw new Error(`kind must be one of ${VISUAL_KINDS.join(", ")}.`);
  const labels = Array.isArray(args.labels) ? args.labels : [];
  const values = Array.isArray(args.values) ? args.values : [];
  // Same length, checked before anything else: a chart drawn from mismatched
  // arrays is a picture that quietly says something the numbers do not.
  if (!labels.length || labels.length !== values.length) {
    throw new Error('"labels" and "values" must be non-empty arrays of the same length — one number per label.');
  }
  if (labels.length > MAX_VISUAL_POINTS) throw new Error(`A visualization takes at most ${MAX_VISUAL_POINTS} points. Group the rest, or draw the ones that matter.`);
  if (!labels.every((label) => typeof label === "string" && label.trim() && label.length <= MAX_VISUAL_LABEL_CHARS)) {
    throw new Error(`Every label must be a non-empty string of at most ${MAX_VISUAL_LABEL_CHARS} characters.`);
  }
  // NaN and Infinity are what a formatted string parses to, and both plot as a
  // gap the reader reads as zero.
  if (!values.every((point) => typeof point === "number" && Number.isFinite(point))) {
    throw new Error('Every value must be a finite number. Send the numbers themselves, not formatted strings like "1.2k" or "43%".');
  }
  return {
    kind,
    labels: labels as string[],
    values: values as number[],
    caption: typeof args.caption === "string" ? args.caption.slice(0, MAX_VISUAL_CAPTION_CHARS) : "",
  };
}

/**
 * The picture a finished step drew, read back off the step itself — the marker
 * says one happened, the arguments are what it is. Never throws: a call whose
 * arguments were truncated or aged out of the transcript cache is a step row
 * again, not a broken turn.
 */
export function readVisualization(step: { status: string; output?: string; input?: string }): Visualization | undefined {
  if (step.status !== "completed" || !(step.output ?? "").trimStart().startsWith(VISUAL_MARKER)) return undefined;
  try { return parseVisualization(JSON.parse(step.input ?? "")); } catch { return undefined; }
}
