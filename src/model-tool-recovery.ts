import type {Task} from "./domain.ts";
import {segmentUsage} from "./task-control.ts";

/** An invalid provider tool envelope was settled and rejected before any tool executed. */
export function scheduleRejectedToolRepair(task:Task):boolean {
  if(task.status!=="running"||task.runOpen||task.pauseRequested||task.researchWaiting||
     task.workflow?.phase!=="agent"||task.modelFailure!=="INVALID_TOOL_CALL"||
     task.modelFailureDetail!=="undeclared_tool"||task.modelToolRepairs?.length)return false;
  const usage=segmentUsage(task);
  if(usage.calls>=6||usage.tools>=10||usage.activeMs>=180000)return false;
  task.modelToolRepairs=[{call:task.calls,detail:"undeclared_tool"}];
  task.workflow.warnings.push("The previous tool call was rejected without execution because that tool was not declared. Use only a tool actually declared in this step, with its exact name and schema. The research tools are search_papers and retrieve_chunks; do not invent namespaces or alternative names. If no tools are declared, answer from visible evidence and state the actual gap. The rejected call already consumed budget; it was not a successful action.");
  task.status="queued";
  task.error=undefined;
  return true;
}
