import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_TASK_LIST_BYTES, MAX_TASK_LISTS, MAX_TASK_LIST_TITLE_CHARS, parseTaskList, renderTaskList, taskListSlug, type TaskList } from "../shared/task-list";

export const taskListsRoot = (userData: string) => path.join(userData, "task-lists");

export const validTaskListId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value);

function taskListPath(userData: string, id: unknown): string {
  if (!validTaskListId(id)) throw new Error(`"${String(id).slice(0, 64)}" is not a task list id. List task lists with task_list {"action":"read"}.`);
  const root = path.resolve(taskListsRoot(userData));
  const resolved = path.resolve(root, `${id}.md`);
  if (path.dirname(resolved) !== root) throw new Error("That task list id is outside the task-lists folder.");
  return resolved;
}

export async function readTaskList(userData: string, id: string): Promise<TaskList> {
  const file = taskListPath(userData, id);
  const information = await stat(file).catch(() => undefined);
  if (!information?.isFile() || information.size > MAX_TASK_LIST_BYTES) throw new Error(`There is no task list called "${id}".`);
  return parseTaskList(id, await readFile(file, "utf8"), information.mtime.toISOString());
}

export async function listTaskLists(userData: string): Promise<TaskList[]> {
  let entries: string[];
  try {
    entries = (await readdir(taskListsRoot(userData))).slice(0, MAX_TASK_LISTS);
  } catch {
    return [];
  }
  const found: TaskList[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".md"))) {
    try {
      found.push(await readTaskList(userData, entry.slice(0, -3)));
    } catch {
      continue;
    }
  }
  return found.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function saveTaskList(userData: string, list: Omit<TaskList, "id" | "updatedAt"> & { id?: string }): Promise<TaskList> {
  const title = list.title.trim();
  if (!title || title.length > MAX_TASK_LIST_TITLE_CHARS) throw new Error(`A task list needs a title of 1 to ${MAX_TASK_LIST_TITLE_CHARS} characters.`);
  const root = taskListsRoot(userData);
  let taken: string[];
  try {
    taken = (await readdir(root)).filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3));
  } catch {
    taken = [];
  }
  const id = list.id ?? unique(taskListSlug(title), taken);
  if (!taken.includes(id) && taken.length >= MAX_TASK_LISTS) throw new Error(`Emma already holds ${MAX_TASK_LISTS} task lists. Delete one before writing another.`);
  const saved: TaskList = { ...list, id, title, updatedAt: new Date().toISOString() };
  const markdown = renderTaskList(saved);
  if (Buffer.byteLength(markdown, "utf8") > MAX_TASK_LIST_BYTES) throw new Error(`That task list is larger than ${Math.round(MAX_TASK_LIST_BYTES / 1024)}K.`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeAtomic(taskListPath(userData, id), markdown);
  return saved;
}

export async function deleteTaskList(userData: string, id: string): Promise<void> {
  await rm(taskListPath(userData, id), { force: true });
}

let queue: Promise<unknown> = Promise.resolve();

export function editTaskList(userData: string, id: string, change: (list: TaskList) => TaskList): Promise<TaskList> {
  const next = queue.then(async () => {
    const list = await readTaskList(userData, id);
    return await saveTaskList(userData, { ...change(list), id });
  });
  queue = next.catch(() => undefined);
  return next;
}

export function writeTaskList(userData: string, list: Omit<TaskList, "id" | "updatedAt"> & { id?: string }): Promise<TaskList> {
  const next = queue.then(() => saveTaskList(userData, list));
  queue = next.catch(() => undefined);
  return next;
}

function unique(slug: string, taken: readonly string[]): string {
  if (!taken.includes(slug)) return slug;
  const stem = slug.slice(0, 59).replace(/-+$/, "");
  for (let suffix = 2; suffix <= MAX_TASK_LISTS; suffix += 1) {
    if (!taken.includes(`${stem}-${suffix}`)) return `${stem}-${suffix}`;
  }
  throw new Error(`Emma already holds too many task lists called "${slug}".`);
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
