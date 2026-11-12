import type {Task} from "./domain.ts";
export const SCOPED_RESEARCH_CAPABILITY="scoped-search-v1";
export const SCOPED_RESEARCH_UPDATE="NODE_SCOPE_UPDATE_REQUIRED";
/** Stop before another generation; old nodes cannot perform filtering before ranking. */
export function requireScopedResearchNode(task:Task,scope:readonly string[],capabilities:readonly string[]|undefined):boolean {
  if(!scope.length||task.workflow?.cloudOnly||!["prepare","agent"].includes(task.workflow?.phase??"agent"))return true;
  if(!capabilities?.includes(SCOPED_RESEARCH_CAPABILITY)){
    task.status="waiting_device";task.error=SCOPED_RESEARCH_UPDATE;
    return false;
  }
  if(task.error===SCOPED_RESEARCH_UPDATE)task.error=undefined;
  return true;
}
