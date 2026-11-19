import type {State, Task} from "./domain.ts";
import {answerPreview} from "./model-response.ts";
import {expandVisibleCitations} from "../packages/research/visible-citations.ts";

/** Provider deltas belong to the task and operation admitted for this call. */
export function bindResearchPreview(task: Task, currentState: () => State, publish: () => void, now = Date.now) {
  const operation = task.modelOperation;
  if (!operation || task.workflow?.phase !== "agent") return;
  const admittedState = currentState();
  let nextUpdate = 0;

  return (text: string) => {
    const at = now();
    if (at < nextUpdate) return;
    nextUpdate = at + 1000;
    if (currentState() !== admittedState || !admittedState.tasks.includes(task) ||
        !task.runOpen || task.status !== "running" || task.pauseRequested || task.modelOperation !== operation ||
        task.workflow?.phase !== "agent" || admittedState.cloudMemory?.invalidatedTurns?.includes(task.id)) return;

    const visible = answerPreview(text);
    if (!visible) return;
    const preview = expandVisibleCitations(visible, task.workflow);
    if (task.preview === preview) return;
    task.preview = preview;
    publish();
  };
}
