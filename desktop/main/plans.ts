/* The plans folder: one markdown file per plan under `<userData>/plans`, named
 * after the plan. The file is the record — there is no meta.json beside it and
 * nothing in a database — so a plan opens in any editor, survives Emma, and is
 * the same document the thread's inspector draws.
 *
 * Nothing here is Electron. The tool dispatch, the IPC handlers and the tests all
 * run the same functions, which is what keeps the id checks in one place.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_PLAN_BYTES, MAX_PLANS, MAX_PLAN_TITLE_CHARS, parsePlan, planSlug, renderPlan, type Plan } from "../shared/plan";

export const plansRoot = (userData: string) => path.join(userData, "plans");

/** True for an id that may name a file. Anything else is refused before any I/O. */
export const validPlanId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value);

/**
 * One plan's file, or a refusal. The same two checks an artifact's directory gets:
 * the id shape rejects `../evil` before any I/O, and the resolved-parent check is
 * the belt to that pair of braces.
 */
function planPath(userData: string, id: unknown): string {
  if (!validPlanId(id)) throw new Error(`"${String(id).slice(0, 64)}" is not a plan id. Ids are lowercase letters, digits and dashes — list the plans to see them.`);
  const root = path.resolve(plansRoot(userData));
  const resolved = path.resolve(root, `${id}.md`);
  if (path.dirname(resolved) !== root) throw new Error("That plan id is outside the plans folder.");
  return resolved;
}

export async function readPlan(userData: string, id: string): Promise<Plan> {
  const file = planPath(userData, id);
  const information = await stat(file).catch(() => undefined);
  if (!information?.isFile() || information.size > MAX_PLAN_BYTES) throw new Error(`There is no plan called "${id}". List them with plan {"action":"read"}.`);
  return parsePlan(id, await readFile(file, "utf8"), information.mtime.toISOString());
}

/** Newest first, which is the order the section shows and the order the model reads. */
export async function listPlans(userData: string): Promise<Plan[]> {
  let entries: string[];
  try { entries = (await readdir(plansRoot(userData))).slice(0, MAX_PLANS); } catch { return []; }
  const found: Plan[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".md"))) {
    // A file that is half-written or not a plan at all is skipped: one bad file
    // must not take the whole section down with it.
    try { found.push(await readPlan(userData, entry.slice(0, -3))); } catch { /* not a plan */ }
  }
  return found.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * Writes a plan whole. An id that is already there is rewritten; without one the id
 * is minted from the title, so two plans called the same thing do not eat each other.
 */
export async function savePlan(userData: string, plan: Omit<Plan, "id" | "updatedAt"> & { id?: string }): Promise<Plan> {
  const title = plan.title.trim();
  if (!title || title.length > MAX_PLAN_TITLE_CHARS) throw new Error(`A plan needs a title of 1 to ${MAX_PLAN_TITLE_CHARS} characters.`);
  const root = plansRoot(userData);
  let taken: string[] = [];
  try { taken = (await readdir(root)).filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3)); } catch { /* the first plan makes the folder */ }
  const id = plan.id ?? unique(planSlug(title), taken);
  if (!taken.includes(id) && taken.length >= MAX_PLANS) throw new Error(`Emma already holds the maximum of ${MAX_PLANS} plans. Delete one before writing another.`);
  const written: Plan = { ...plan, id, title, updatedAt: new Date().toISOString() };
  const markdown = renderPlan(written);
  if (Buffer.byteLength(markdown, "utf8") > MAX_PLAN_BYTES) throw new Error(`That plan is larger than ${Math.round(MAX_PLAN_BYTES / 1024)}K. Shorten the briefs, or split it into two plans.`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeAtomic(planPath(userData, id), markdown);
  return written;
}

export async function deletePlan(userData: string, id: string): Promise<void> {
  await rm(planPath(userData, id), { force: true });
}

/* One plan is written by several agents at once — every subagent of a wave ticks
   its own step off as it works — and a read-modify-write with an await in the
   middle is a lost update waiting to happen. Every mutation goes through here, in
   order.

   ponytail: one queue for every plan, not one per plan. A wave is eight subagents
   writing a few kilobytes; give it a queue per id if plans ever get hot. */
let queue: Promise<unknown> = Promise.resolve();

/** Reads a plan, hands it to `change`, and writes back whatever comes out. */
export function editPlan(userData: string, id: string, change: (plan: Plan) => Plan): Promise<Plan> {
  const next = queue.then(async () => {
    const plan = await readPlan(userData, id);
    return await savePlan(userData, { ...change(plan), id });
  });
  // The chain must not break on a failed edit, or every later write is rejected
  // with someone else's error.
  queue = next.catch(() => undefined);
  return next;
}

/** The same lock around a whole-plan write, so a rewrite cannot cross a tick. */
export function writePlan(userData: string, plan: Omit<Plan, "id" | "updatedAt"> & { id?: string }): Promise<Plan> {
  const next = queue.then(() => savePlan(userData, plan));
  queue = next.catch(() => undefined);
  return next;
}

/**
 * Told to the model on every root turn that is offered the `plan` tool, the way
 * `MEMORY_PROTOCOL` is told to one offered `memory`.
 *
 * The tool's own description says what the actions do. This is the part a schema
 * cannot say, because a model only reads the `plan` schema once it is already
 * thinking about planning: that a job of this size is broken up before any of it
 * is done. Root turns only — a subagent is told what it is by `stepBrief`, and a
 * plan of its own would be a plan inside a plan.
 */
export const PLANNING_PROTOCOL = [
  "PLANNING:",
  "Work bigger than one agent's worth — a feature across several files, an app built from nothing, a migration, an audit of a whole folder — starts with a plan, before any of it is done.",
  "1. Break it up with plan write: one step per piece of work, each naming what it needs. Cut it by what can go at the same time rather than by what happens first — steps that need nothing are the first wave, and a wave runs at once, one subagent per step.",
  "2. Run it a wave at a time with plan run, and read what came back before calling again. A step's result line is all the steps waiting on it will ever know about it.",
  "3. Rewrite it with plan write when what came back changes the shape of the job. Finished steps and ticked tasks survive a rewrite, so restructuring halfway is safe.",
  "Not everything needs one: task for a single self-contained job, and no plan at all for work you can finish in this turn.",
].join("\n");

function unique(slug: string, taken: readonly string[]) {
  if (!taken.includes(slug)) return slug;
  const stem = slug.slice(0, 59).replace(/-+$/, "");
  for (let suffix = 2; suffix <= MAX_PLANS; suffix += 1) {
    if (!taken.includes(`${stem}-${suffix}`)) return `${stem}-${suffix}`;
  }
  throw new Error(`Emma already holds too many plans called "${slug}". Rewrite one of them instead.`);
}

async function writeAtomic(file: string, content: string) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
