import { useEffect, useMemo, useRef, useState } from "react";
import { PLAN_ROW, planLayout, planRows, type PlanStatus, type PlanStep } from "../shared/plan";
import { flattenTaskListTasks, taskListProgress, taskListState, type FlatTaskListTask, type TaskList, type TaskListStatus } from "../shared/task-list";
import { CaretIcon, ExpandIcon } from "./icons";
import { Markdown } from "./markdown";
import { PlanGraph, type PlanShape } from "./plan";
import { plural } from "./plural";

const MAP_ROW = 56;

const visualState = (status: TaskListStatus) => status === "completed" ? "done" : status === "in_progress" ? "running" : status === "blocked" ? "failed" : "ready";

const planStatus = (status: TaskListStatus): PlanStatus => status === "completed" ? "done" : status === "in_progress" ? "running" : status === "blocked" ? "failed" : "todo";

function graphSteps(flat: readonly FlatTaskListTask[]): PlanStep[] {
  return flat.map(({ task, parentId }) => ({ id: task.id, title: task.title, status: planStatus(task.status), needs: parentId ? [parentId] : [], brief: "", tasks: [] }));
}

function useTaskListShape(flat: readonly FlatTaskListTask[], row = PLAN_ROW): { steps: PlanStep[]; shape: PlanShape } {
  return useMemo(() => {
    const steps = graphSteps(flat);
    const waves = planRows(steps);
    const { spots, height } = planLayout(waves, steps, row);
    const statuses = new Map(flat.map(({ task }) => [task.id, task.status]));
    return { steps, shape: { waves, spots, height, row, state: (step) => visualState(statuses.get(step.id) ?? "pending") } };
  }, [flat, row]);
}

function useTaskLists(threadId: string, sample?: TaskList[]): TaskList[] {
  const [lists, setLists] = useState<TaskList[]>([]);
  useEffect(() => {
    if (sample) return;
    const load = () => void window.emma.listTaskLists().then(setLists).catch(() => undefined);
    load();
    return window.emma.onTaskListsChanged(load);
  }, [sample]);
  return useMemo(() => sample ?? lists.filter((list) => list.threadId === threadId), [lists, sample, threadId]);
}

function TaskKey({ flat }: { flat: readonly FlatTaskListTask[] }) {
  const states = ["in_progress", "pending", "completed", "blocked"] as const;
  const shown = states.filter((status) => flat.some(({ task }) => task.status === status));
  return <div className="plan-key">
    {shown.map((status) => <span key={status} data-status={visualState(status)}><i aria-hidden="true" />{status.replace("_", " ")}</span>)}
  </div>;
}

function currentTask(flat: readonly FlatTaskListTask[], picked: string): FlatTaskListTask | undefined {
  return flat.find(({ task }) => task.id === picked)
    ?? [...flat].reverse().find(({ task }) => task.status === "in_progress")
    ?? flat.find(({ task }) => task.status === "pending")
    ?? flat.find(({ task }) => task.status === "blocked")
    ?? flat[0];
}

function TaskSummary({ entry, at }: { entry: FlatTaskListTask; at: number }) {
  const { task, parentId } = entry;
  return <div className="plan-tasks">
    <p className="plan-step-title"><b>{at}</b><span>{task.title}</span></p>
    <p className="plan-result">{task.status.replace("_", " ")}{parentId ? ` · subtask of ${parentId}` : " · top level"}</p>
    <ol className="plan-list">
      {task.subtasks.map((subtask) => <li key={subtask.id} className={subtask.status === "completed" ? "done" : ""}>
        <i aria-hidden="true">{subtask.status === "completed" ? "▣" : "▢"}</i>
        <span>{subtask.title}</span>
      </li>)}
      {!task.subtasks.length && <li className="plan-none">No subtasks — this node is one action.</li>}
    </ol>
  </div>;
}

export function TaskListRail({ threadId, sample }: { threadId: string; sample?: TaskList[] }) {
  const lists = useTaskLists(threadId, sample);
  const [selectedList, setSelectedList] = useState("");
  const [selectedTask, setSelectedTask] = useState("");
  const [reading, setReading] = useState(false);
  const shown = useMemo(() => [...lists].sort((left, right) => left.id.localeCompare(right.id)), [lists]);
  const list = lists.find((item) => item.id === selectedList)
    ?? lists.find((item) => taskListState(item) === "in_progress")
    ?? lists[0];
  const flat = useMemo(() => list ? flattenTaskListTasks(list.tasks) : [], [list]);
  const { steps, shape } = useTaskListShape(flat);
  const entry = currentTask(flat, selectedTask);
  const progress = list ? taskListProgress(list) : undefined;

  if (!list || !progress) {
    return <section className="plan-widget task-list-widget">
      <span>Tasks</span>
      <p className="subagent-empty">Nothing tracked yet — Emma writes one per <code>task_list write</code>.</p>
    </section>;
  }

  return <section className="plan-widget task-list-widget">
    <span><span className="context-title">Tasks · {progress.completed} of {progress.total} {plural(progress.total, "task")}<button type="button" className="context-expand" aria-haspopup="dialog" aria-label="Read the task list file" title={`Read ${list.id}.md`} onClick={() => setReading(true)}><ExpandIcon /></button></span></span>
    {shown.length > 1 && <div className="plan-switch">
      {shown.map((item) => {
        const state = taskListState(item);
        const at = taskListProgress(item);
        const said = `${item.title} — ${state.replace("_", " ")}, ${at.completed} of ${at.total} ${plural(at.total, "task")}`;
        return <button key={item.id} type="button" data-status={visualState(state)} className={item.id === list.id ? "active" : ""} aria-current={item.id === list.id || undefined} aria-label={said} title={said} onClick={() => { setSelectedList(item.id); setSelectedTask(""); }}>
          <i aria-hidden="true" /><span>{item.title}</span>
        </button>;
      })}
    </div>}
    <div className="plan-head">
      <strong title={list.goal || list.title}>{list.title}</strong>
      <em>{progress.completed}/{progress.total}</em>
    </div>
    <PlanGraph
      steps={steps}
      shape={shape}
      at={entry?.task.id}
      describe={(step) => {
        const task = flat.find((item) => item.task.id === step.id)!.task;
        return { label: `${task.title} — ${task.status.replace("_", " ")}`, title: `${task.title} — ${task.status.replace("_", " ")} · ${task.subtasks.length} ${plural(task.subtasks.length, "subtask")}` };
      }}
      onPick={(step) => setSelectedTask(step.id === entry?.task.id ? "" : step.id)}
    />
    <TaskKey flat={flat} />
    {entry && <TaskSummary entry={entry} at={flat.indexOf(entry) + 1} />}
    {reading && <TaskListFile list={list} initial={entry?.task.id} close={() => setReading(false)} />}
  </section>;
}

function TaskListFile({ list, initial, close }: { list: TaskList; initial?: string; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const doc = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState(initial ?? "");
  const flat = useMemo(() => flattenTaskListTasks(list.tasks), [list]);
  const { steps, shape } = useTaskListShape(flat, MAP_ROW);
  const progress = taskListProgress(list);
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);
  useEffect(() => {
    if (picked) doc.current?.querySelector(`[data-task="${CSS.escape(picked)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [picked]);
  const dismiss = () => dialog.current?.close();
  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="task-list-file-title" onClose={close} onCancel={(event) => { event.preventDefault(); dismiss(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) dismiss(); }}>
    <section className="agent-dialog plan-dialog">
      <header><div><span>{list.id}.md</span><h2 id="task-list-file-title">{list.title}</h2></div><button type="button" onClick={dismiss} aria-label="Close the task list file">×</button></header>
      <div className="plan-split">
        <aside className="plan-map">
          <div className="plan-head"><strong>{progress.completed} of {progress.total} {plural(progress.total, "task")}</strong><em>{taskListState(list).replace("_", " ")}</em></div>
          <PlanGraph steps={steps} shape={shape} at={picked} describe={(step) => ({ label: `${step.title}, show it in the task list`, title: step.title })} onPick={(step) => setPicked(step.id)} />
          <TaskKey flat={flat} />
        </aside>
        <div className="plan-doc" ref={doc}>
          {list.goal.trim() && <div className="message-body plan-goal"><Markdown text={list.goal} /></div>}
          {flat.map((entry, index) => <TaskEntry key={entry.task.id} entry={entry} at={index + 1} active={entry.task.id === picked} onPick={() => setPicked(entry.task.id)} />)}
        </div>
      </div>
    </section>
  </dialog>;
}

function TaskEntry({ entry, at, active, onPick }: { entry: FlatTaskListTask; at: number; active: boolean; onPick: () => void }) {
  const { task, parentId, depth } = entry;
  return <section data-task={task.id} className={`plan-entry ${active ? "active" : ""}`} style={{ marginLeft: `${depth * 18}px` }}>
    <h3 className="plan-entry-title">
      <b>{at}</b>
      <button type="button" onClick={onPick}>{task.title}</button>
      <span className="plan-key"><span data-status={visualState(task.status)}><i aria-hidden="true" />{task.status.replace("_", " ")}</span></span>
    </h3>
    <p className="plan-entry-needs"><code>{task.id}</code>{parentId ? <>subtask of <code>{parentId}</code></> : <em>top-level task</em>}</p>
  </section>;
}

export function TaskListBar({ threadId, sample }: { threadId: string; sample?: TaskList[] }) {
  const lists = useTaskLists(threadId, sample);
  const [open, setOpen] = useState(false);
  const list = lists.find((item) => taskListState(item) === "in_progress") ?? lists[0];
  if (!list?.tasks.length) return null;
  const tasks = list.tasks;
  const done = tasks.filter((task) => task.status === "completed").length;
  const said = `${list.title} — ${done} of ${tasks.length} ${plural(tasks.length, "task")} done`;
  return <div className="task-bar">
    <button type="button" className="task-bar-head" aria-expanded={open} title={said} aria-label={said} onClick={() => setOpen((was) => !was)}>
      <span className="task-bar-label">Tasks</span>
      <strong>{list.title}</strong>
      <em>{done}/{tasks.length}</em>
      <span className="task-bar-track">
        {tasks.map((task) => <i key={task.id} data-status={visualState(task.status)} title={`${task.title} — ${task.status.replace("_", " ")}`}>
          {task.subtasks.length > 0 && <span>{task.subtasks.map((subtask) => <b key={subtask.id} data-status={visualState(subtask.status)} />)}</span>}
        </i>)}
      </span>
      <CaretIcon />
    </button>
    {open && <ol className="task-bar-list">
      {flattenTaskListTasks(tasks).map(({ task, depth }) => <li key={task.id} data-status={visualState(task.status)} style={{ marginLeft: `calc(${depth} * var(--s-4))` }}>
        <i aria-hidden="true" /><span>{task.title}</span><em>{task.status.replace("_", " ")}</em>
      </li>)}
    </ol>}
  </div>;
}
