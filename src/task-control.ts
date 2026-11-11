import {
  Problem,
  text,
  taskAllowance,
  type State,
  type Task,
  type Status,
} from "./domain.ts";
import { newWorkflow } from "../packages/research/cloud-workflow.ts";

export interface GoalSegment {
  index: number;
  started: number;
  calls: number;
  tools: number;
  activeMs: number;
  checkpoint?: {
    saved: number;
    reason: string;
    phase: string;
    answer?: string;
    remaining: string[];
    evidenceIds: string[];
  };
}
export interface LongGoal {
  maxSegments: 4;
  segments: GoalSegment[];
}
export const segmentUsage = (t: Task) => {
  const s = t.goal?.segments.at(-1);
  return {
    calls: t.calls - (s?.calls ?? 0),
    tools: t.tools - (s?.tools ?? 0),
    activeMs: t.activeMs - (s?.activeMs ?? 0),
  };
};
export const currentInstruction = (t: Task) =>
  t.input +
  (t.amendments?.length
    ? "\n\nUser amendments (latest takes precedence):\n" +
      t.amendments.map((a) => a.text).join("\n")
    : "");
export function configureTask(t: Task, mode: unknown, priority: unknown) {
  if (mode !== undefined && mode !== "normal" && mode !== "long")
    throw new Problem("INVALID_TASK_MODE");
  if (priority !== undefined && ![0, 1, 2].includes(priority as number))
    throw new Problem("INVALID_PRIORITY");
  if ((t.calls || t.tools) && (mode === "long") !== !!t.goal)
    throw new Problem("TASK_ALREADY_STARTED", 409);
  t.priority = (priority as 0 | 1 | 2 | undefined) ?? 1;
  if (mode === "long" && !t.goal)
    t.goal = {
      maxSegments: 4,
      segments: [
        { index: 1, started: Date.now(), calls: 0, tools: 0, activeMs: 0 },
      ],
    };
}
export function checkpoint(t: Task, reason: string) {
  if (!t.goal) return;
  t.goal.segments.at(-1)!.checkpoint = {
    saved: Date.now(),
    reason,
    phase: t.workflow?.phase ?? "prepare",
    ...(t.answer
      ? { answer: Array.from(t.answer).slice(0, 4000).join("") }
      : {}),
    remaining: t.workflow?.execution?.remaining_needs ?? [],
    evidenceIds: (t.researchEvidence ?? []).map((e) => e.chunk_id),
  };
}
/** One business task accumulates every segment; an explicit user clarification never auto-continues. */
export function nextSegment(t: Task, reason: string): boolean {
  if (!t.goal) return false;
  checkpoint(t, reason);
  if (
    t.goal.segments.length >= 4 ||
    t.calls >= 24 ||
    t.tools >= 40 ||
    t.activeMs >= 720000
  ) {
    t.status = "paused";
    t.pauseRequested = true;
    t.error = "GOAL_BUDGET";
    return false;
  }
  if (t.workflow?.execution?.stop_reason === "no_execution_progress")
    return false;
  t.goal.segments.push({
    index: t.goal.segments.length + 1,
    started: Date.now(),
    calls: t.calls,
    tools: t.tools,
    activeMs: t.activeMs,
  });
  const previous = t.workflow;
  t.workflow = {
    ...newWorkflow(),
    automatic: previous?.automatic,
    cloudOnly: previous?.cloudOnly,
    prepared: previous?.prepared,
    preparedIndex: previous?.preparedIndex,
    phase: previous?.prepared ? "agent" : "prepare",
    warnings: [],
    execution: previous?.execution,
    tracker: previous?.tracker,
    progress: previous?.progress,
  };
  t.status = t.pauseRequested ? "paused" : "queued";
  t.error = undefined;
  return true;
}
export function pauseTask(t: Task) {
  if (["completed", "failed", "cancelled"].includes(t.status))
    throw new Problem("TASK_CLOSED", 409);
  if (t.status === "paused") return;
  t.pausedFrom = t.status;
  t.pauseRequested = true;
  t.status = "paused";
  t.updated = Date.now();
  checkpoint(t, "user_pause");
}
export function settledForControl(s: State, t: Task) {
  return (
    !t.runOpen &&
    !s.operations.some((o) => o.taskId === t.id && o.state === "sent")
  );
}
export function resumeTask(s: State, t: Task) {
  if (!settledForControl(s, t)) throw new Problem("PAUSE_PENDING", 409);
  if (t.status !== "paused" && t.status !== "waiting_user")
    throw new Problem("TASK_NOT_PAUSED", 409);
  if (
    t.error === "CONTEXT_CHANGED" ||
    s.cloudMemory?.invalidatedTurns?.includes(t.id)
  )
    throw new Problem("NEW_TASK_REQUIRED", 409);
  const a = taskAllowance(t);
  if (a.calls <= 0 || a.activeMs <= 0) {
    if (!nextSegment(t, "user_continue"))
      throw new Problem(t.goal ? "GOAL_BUDGET" : "MODEL_BUDGET", 429);
  }
  if (t.workflow?.phase === "finished") {
    t.workflow.phase = "agent";
    t.workflow.memory = undefined;
  }
  t.pauseRequested = false;
  t.pausedFrom = undefined;
  t.status = s.operations.some(
    (o) => o.taskId === t.id && ["pending", "sent"].includes(o.state),
  )
    ? "waiting_device"
    : "queued";
  t.error = undefined;
  t.modelFailure = undefined;
  t.updated = Date.now();
}
export function amendTask(s: State, t: Task, value: unknown) {
  if (t.status !== "paused" || !settledForControl(s, t))
    throw new Problem("PAUSE_REQUIRED", 409);
  const amendment = text(value, 2000);
  if (
    (t.amendments ?? []).reduce((n, a) => n + a.text.length, 0) +
      amendment.length >
    6000
  )
    throw new Problem("AMENDMENT_LIMIT", 429);
  for (const op of s.operations.filter(
    (o) => o.taskId === t.id && o.state === "pending",
  ))
    op.state = "cancelled";
  t.operationId = undefined;
  t.amendments ??= [];
  t.amendments.push({ text: amendment, at: Date.now() });
  checkpoint(t, "direction_changed");
  t.workflow = {
    ...newWorkflow(),
    automatic: t.kind === "auto",
    cloudOnly: t.kind !== "research",
  };
  t.updated = Date.now();
}
export function taskOrder(a: Task, b: Task) {
  return (
    Number(a.origin === "schedule") - Number(b.origin === "schedule") ||
    (b.priority ?? 1) - (a.priority ?? 1) ||
    a.created - b.created ||
    a.id.localeCompare(b.id)
  );
}
export function orderedTasks(s: State) {
  return [...s.tasks].sort(taskOrder);
}
