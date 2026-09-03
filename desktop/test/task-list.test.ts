import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { deleteTaskList, editTaskList, listTaskLists, readTaskList, saveTaskList } from "../main/task-lists";
import { parseToolArgs } from "../main/tools";
import { CONTEXT_WIDGETS, defaultContextPages } from "../shared/context-bar";
import { DEFAULT_SYSTEM_PROMPT } from "../shared/prompts";
import { flattenTaskListTasks, mergeTaskList, parseTaskList, parseTaskListTasks, renderTaskList, taskListProgress, taskListState, updateTaskListStatus, type TaskList } from "../shared/task-list";

const tasks: TaskList["tasks"] = [{
  id: "build",
  title: "Build the feature",
  status: "in_progress",
  subtasks: [
    { id: "store", title: "Write the store", status: "completed", subtasks: [] },
    { id: "widget", title: "Draw the widget", status: "pending", subtasks: [{ id: "dialog", title: "Add the dialog", status: "blocked", subtasks: [] }] },
  ],
}];

const list = (over: Partial<TaskList> = {}): TaskList => ({ id: "ship-tasks", title: "Ship tasks", goal: "Track the work.", tasks, threadId: "thread-7", updatedAt: "2026-08-30T12:00:00.000Z", ...over });

test("a nested task list round-trips through its Markdown file", () => {
  const before = list();
  assert.deepEqual(parseTaskList(before.id, renderTaskList(before), before.updatedAt), before);
  assert.match(renderTaskList(before), /^ {2}- \[x] store · Write the store `completed`$/m);
  assert.deepEqual(flattenTaskListTasks(before.tasks).map(({ task, depth, parentId }) => [task.id, depth, parentId]), [
    ["build", 0, undefined],
    ["store", 1, "build"],
    ["widget", 1, "build"],
    ["dialog", 2, "widget"],
  ]);
});

test("nested task input is bounded and keeps ids unique", () => {
  const parsed = parseTaskListTasks(JSON.stringify([{ id: "root", title: "Root", subtasks: [{ id: "child", title: "Child" }] }]));
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.tasks[0].subtasks[0].id, "child");
  assert.match(parseTaskListTasks(JSON.stringify([{ id: "same", title: "One", subtasks: [{ id: "same", title: "Two" }] }])).errors[0], /repeats/);
  assert.match(parseTaskListTasks("not json").errors[0], /not valid JSON/);
  assert.match(parseTaskListTasks("[]").errors[0], /at least one task/);
});

test("rewriting and updating a task list keep durable progress", () => {
  const previous = list();
  const next = list({ tasks: [{ id: "build", title: "Build it better", status: "pending", subtasks: [{ id: "store", title: "Move the store", status: "pending", subtasks: [] }] }] });
  const merged = mergeTaskList(previous, next);
  assert.equal(merged.tasks[0].status, "in_progress");
  assert.equal(merged.tasks[0].subtasks[0].status, "completed");
  const updated = updateTaskListStatus(merged.tasks, "build", "completed");
  assert.equal(updated.found, true);
  const completed = list({ tasks: updated.tasks });
  assert.deepEqual(taskListProgress(completed), { completed: 2, total: 2 });
  assert.equal(taskListState(completed), "completed");
  assert.equal(updateTaskListStatus(merged.tasks, "missing", "blocked").found, false);
});

test("task list files are isolated, atomic records", async () => {
  const root = path.join(tmpdir(), `emma-task-lists-${randomUUID()}`);
  try {
    const saved = await saveTaskList(root, { title: "Ship tasks", goal: "Track it.", tasks, threadId: "thread-7" });
    assert.equal(saved.id, "ship-tasks");
    await editTaskList(root, saved.id, (current) => ({ ...current, tasks: updateTaskListStatus(current.tasks, "widget", "in_progress").tasks }));
    assert.equal(flattenTaskListTasks((await readTaskList(root, saved.id)).tasks).find(({ task }) => task.id === "widget")?.task.status, "in_progress");
    assert.deepEqual((await listTaskLists(root)).map((item) => item.id), [saved.id]);
    await assert.rejects(() => readTaskList(root, "../../etc/passwd"), /not a task list id/);
    await deleteTaskList(root, saved.id);
    assert.deepEqual(await listTaskLists(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the task list tool and widget are explicit defaults for complex work", () => {
  const parsed = parseToolArgs("task_list", JSON.stringify({ action: "update", id: "ship-tasks", task: "widget", status: "in_progress" }));
  assert.equal(parsed.name, "task_list");
  assert.throws(() => parseToolArgs("task_list", JSON.stringify({ action: "update", id: "ship-tasks", task: "widget" })), /both "task" and "status"/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /`task_list` is the default for complex work/);
  assert.ok(CONTEXT_WIDGETS.some((widget) => widget.type === "tasklist"));
  assert.equal(defaultContextPages.filter((page) => page.widgets.some((widget) => widget.type === "tasklist")).length, 1);
});
