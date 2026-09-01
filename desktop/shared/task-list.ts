export const TASK_LIST_STATUSES = ["pending", "in_progress", "completed", "blocked"] as const;
export type TaskListStatus = (typeof TASK_LIST_STATUSES)[number];

export const MAX_TASK_LISTS = 64;
export const MAX_TASK_LIST_BYTES = 128 * 1024;
export const MAX_TASK_LIST_TITLE_CHARS = 200;
export const MAX_TASK_TITLE_CHARS = 500;
export const MAX_TASK_LIST_TASKS = 100;
export const MAX_TASK_LIST_DEPTH = 8;

export type TaskListTask = {
  id: string;
  title: string;
  status: TaskListStatus;
  subtasks: TaskListTask[];
};

export type TaskList = {
  id: string;
  title: string;
  goal: string;
  tasks: TaskListTask[];
  updatedAt: string;
  threadId?: string;
};

export type FlatTaskListTask = {
  task: TaskListTask;
  parentId?: string;
  depth: number;
};

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const THREAD = /^thread:\s*(\S+)$/i;
const TASK = /^(\s*)-\s*\[([ xX])]\s*([a-z0-9][a-z0-9-]{0,31})\s+[·—-]\s+(.+)$/;
const STATUS = /\s+`(pending|in_progress|completed|blocked)`\s*$/;

const clean = (value: string, max: number) => value.replace(/\s+/g, " ").trim().slice(0, max);

export const isTaskListStatus = (value: unknown): value is TaskListStatus =>
  typeof value === "string" && (TASK_LIST_STATUSES as readonly string[]).includes(value);

export function taskListSlug(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "");
  return slug || "tasks";
}

export function flattenTaskListTasks(tasks: readonly TaskListTask[]): FlatTaskListTask[] {
  const flat: FlatTaskListTask[] = [];
  const visit = (items: readonly TaskListTask[], depth: number, parentId?: string) => {
    for (const task of items) {
      flat.push({ task, parentId, depth });
      visit(task.subtasks, depth + 1, task.id);
    }
  };
  visit(tasks, 0);
  return flat;
}

export function taskListProgress(list: TaskList): { completed: number; total: number } {
  const tasks = flattenTaskListTasks(list.tasks);
  return { completed: tasks.filter(({ task }) => task.status === "completed").length, total: tasks.length };
}

export function taskListState(list: TaskList): TaskListStatus {
  const tasks = flattenTaskListTasks(list.tasks).map(({ task }) => task);
  if (tasks.some((task) => task.status === "in_progress")) return "in_progress";
  if (tasks.some((task) => task.status === "blocked")) return "blocked";
  if (tasks.length > 0 && tasks.every((task) => task.status === "completed")) return "completed";
  return "pending";
}

export function parseTaskList(id: string, markdown: string, updatedAt = ""): TaskList {
  const lines = markdown.split("\n");
  const tasks: TaskListTask[] = [];
  const stack: TaskListTask[] = [];
  const seen = new Set<string>();
  const goal: string[] = [];
  let title = "";
  let threadId = "";
  let started = false;
  for (const line of lines) {
    if (!title && line.startsWith("# ")) {
      title = clean(line.slice(2), MAX_TASK_LIST_TITLE_CHARS);
      continue;
    }
    const owner = THREAD.exec(line.trim());
    if (!started && owner) {
      threadId = clean(owner[1], 128);
      continue;
    }
    const found = TASK.exec(line.replace(/\t/g, "  "));
    if (!found || seen.has(found[3]) || seen.size >= MAX_TASK_LIST_TASKS) {
      if (title && !started) goal.push(line);
      continue;
    }
    started = true;
    seen.add(found[3]);
    const suffix = STATUS.exec(found[4]);
    const task: TaskListTask = {
      id: found[3],
      title: clean(found[4].replace(STATUS, ""), MAX_TASK_TITLE_CHARS) || found[3],
      status: found[2] !== " " ? "completed" : isTaskListStatus(suffix?.[1]) ? suffix[1] : "pending",
      subtasks: [],
    };
    const requestedDepth = Math.min(Math.floor(found[1].length / 2), MAX_TASK_LIST_DEPTH - 1);
    const depth = Math.min(requestedDepth, stack.length);
    if (depth === 0) tasks.push(task);
    else stack[depth - 1].subtasks.push(task);
    stack[depth] = task;
    stack.length = depth + 1;
  }
  return {
    id,
    title: title || id,
    goal: goal.join("\n").trim(),
    tasks,
    updatedAt,
    ...(threadId ? { threadId } : {}),
  };
}

export function renderTaskList(list: TaskList): string {
  const out = [`# ${list.title}`, ""];
  if (list.threadId) out.push(`thread: ${list.threadId}`, "");
  if (list.goal.trim()) out.push(list.goal.trim(), "");
  const write = (tasks: readonly TaskListTask[], depth: number) => {
    for (const task of tasks) {
      out.push(`${"  ".repeat(depth)}- [${task.status === "completed" ? "x" : " "}] ${task.id} · ${task.title} \`${task.status}\``);
      write(task.subtasks, depth + 1);
    }
  };
  write(list.tasks, 0);
  return `${out.join("\n").trimEnd()}\n`;
}

export function parseTaskListTasks(json: string): { tasks: TaskListTask[]; errors: string[] } {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { tasks: [], errors: ["tasks is not valid JSON. Send a JSON array of nested tasks, as a string."] };
  }
  if (!Array.isArray(value)) return { tasks: [], errors: ["tasks must be a JSON array."] };
  if (!value.length) return { tasks: [], errors: ["A task list needs at least one task."] };
  const errors: string[] = [];
  const seen = new Set<string>();
  let count = 0;
  const take = (items: unknown[], depth: number, path: string): TaskListTask[] => {
    const tasks: TaskListTask[] = [];
    for (const [index, raw] of items.entries()) {
      const at = `${path}${index + 1}`;
      if (count >= MAX_TASK_LIST_TASKS) {
        if (!errors.some((error) => error.includes(`${MAX_TASK_LIST_TASKS} tasks`))) errors.push(`A task list cannot have more than ${MAX_TASK_LIST_TASKS} tasks.`);
        break;
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        errors.push(`Task ${at} is not an object.`);
        continue;
      }
      count += 1;
      const task = raw as Record<string, unknown>;
      const id = typeof task.id === "string" ? task.id : "";
      if (!ID.test(id)) {
        errors.push(`Task ${at} needs an id of lowercase letters, digits and dashes.`);
        continue;
      }
      if (seen.has(id)) {
        errors.push(`Task ${at} repeats the id "${id}".`);
        continue;
      }
      seen.add(id);
      const title = typeof task.title === "string" ? clean(task.title, MAX_TASK_TITLE_CHARS) : "";
      if (!title) errors.push(`Task "${id}" needs a title.`);
      if (task.status !== undefined && !isTaskListStatus(task.status)) errors.push(`Task "${id}" has an invalid status.`);
      const nested = task.subtasks === undefined ? [] : task.subtasks;
      if (!Array.isArray(nested)) errors.push(`Task "${id}" subtasks must be an array.`);
      if (depth + 1 >= MAX_TASK_LIST_DEPTH && Array.isArray(nested) && nested.length) errors.push(`Task "${id}" is deeper than ${MAX_TASK_LIST_DEPTH} levels.`);
      tasks.push({
        id,
        title: title || id,
        status: isTaskListStatus(task.status) ? task.status : "pending",
        subtasks: Array.isArray(nested) && depth + 1 < MAX_TASK_LIST_DEPTH ? take(nested, depth + 1, `${at}.`) : [],
      });
    }
    return tasks;
  };
  return { tasks: take(value, 0, ""), errors };
}

export function mergeTaskList(previous: TaskList | undefined, next: TaskList): TaskList {
  if (!previous) return next;
  const before = new Map(flattenTaskListTasks(previous.tasks).map(({ task }) => [task.id, task]));
  const merge = (tasks: readonly TaskListTask[]): TaskListTask[] => tasks.map((task) => ({
    ...task,
    status: task.status === "pending" ? before.get(task.id)?.status ?? task.status : task.status,
    subtasks: merge(task.subtasks),
  }));
  return { ...next, threadId: previous.threadId ?? next.threadId, tasks: merge(next.tasks) };
}

export function updateTaskListStatus(tasks: readonly TaskListTask[], id: string, status: TaskListStatus): { tasks: TaskListTask[]; found: boolean } {
  let found = false;
  const update = (items: readonly TaskListTask[]): TaskListTask[] => items.map((task) => {
    if (task.id === id) {
      found = true;
      return { ...task, status };
    }
    const subtasks = update(task.subtasks);
    return subtasks === task.subtasks ? task : { ...task, subtasks };
  });
  return { tasks: update(tasks), found };
}
