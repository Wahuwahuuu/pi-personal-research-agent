/** Output allowance shared by admission and validation-budget classification. */
export function modelOutputLimit(task?: {workflow?: {phase: string; cloudOnly?: boolean}}): number {
  const workflow = task?.workflow;
  if (workflow?.phase === "translation" || workflow?.phase === "comparison" || workflow?.phase === "memory" ||
      workflow?.phase === "agent" && !workflow.cloudOnly) return 8192;
  return 2048;
}
