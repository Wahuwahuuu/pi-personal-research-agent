import type {Operation, State, Task} from "./domain.ts";

export interface ModelMeasurement {
  status: "response_received" | "interrupted" | "not_dispatched";
  elapsedMs: number | null;
}
export interface ModelCallTiming {
  call: number;
  mode: "mock" | "live";
  status: ModelMeasurement["status"] | "pending";
  elapsedMs: number | null;
  stage?: "prepare" | "agent" | "completion" | "comparison" | "translation" | "memory" | "select" | "assess" | "unknown";
  segment?: number;
}
export interface ToolTiming {
  dispatches: number;
  firstDispatchedAt: number;
  receivedAt?: number;
  localExecutionMs?: number;
}
export const elapsed = (start: number, end: number): number | null =>
  Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;

export function beginModelTiming(task: Task, mode: ModelCallTiming["mode"]) {
  task.modelTimings ??= [];
  const phase=task.proactive?.stage;
  const workflow=task.workflow?.phase;
  const stage:ModelCallTiming["stage"]=phase==="select"||phase==="assess"?phase:workflow&&workflow!=="finished"?workflow:"unknown";
  if (!task.modelTimings.some(row => row.call === task.calls))
    task.modelTimings.push({call: task.calls, mode, status: "pending", elapsedMs: null,stage,segment:task.goal?.segments.at(-1)?.index??1});
  return task.calls;
}
export function finishModelTiming(task: Task, call: number, measurement?: ModelMeasurement) {
  const row = task.modelTimings?.find(row => row.call === call);
  if (!row || row.status !== "pending" || !measurement) return;
  row.status = measurement.status;
  row.elapsedMs = measurement.status === "not_dispatched" ? null :
    measurement.elapsedMs !== null && Number.isFinite(measurement.elapsedMs) && measurement.elapsedMs >= 0
      ? measurement.elapsedMs : null;
}
export function markToolDispatch(op: Operation, now = Date.now()) {
  if (!op.timing) op.timing = {dispatches: 1, firstDispatchedAt: now};
  else op.timing.dispatches++;
}
export function toolMeasurement(op: Operation) {
  const timing = op.timing;
  const single = timing?.dispatches === 1 && timing.receivedAt !== undefined;
  const roundTripMs = single ? elapsed(timing.firstDispatchedAt, timing.receivedAt!) : null;
  const localExecutionMs = op.state === "done" ? timing?.localExecutionMs ?? null : null;
  const transportAndSchedulingMs = roundTripMs !== null && localExecutionMs !== null
    ? elapsed(localExecutionMs, roundTripMs) : null;
  return {
    operationId: op.id, tool: op.tool, state: op.state,
    dispatches: timing?.dispatches ?? 0,
    sample: op.state !== "done" ? "unfinished" : !timing ? "unavailable" :
      timing.dispatches > 1 ? "redelivered" : roundTripMs === null ? "unavailable" : "single_delivery",
    roundTripMs, localExecutionMs, transportAndSchedulingMs,
  };
}
export function taskTimings(state: State, task: Task) {
  const stages=new Map<string,{stage:string;calls:number;measured:number;elapsedMs:number;pending:number}>();
  for(const row of task.modelTimings??[]){
    const stage=row.stage??"unknown",value=stages.get(stage)??{stage,calls:0,measured:0,elapsedMs:0,pending:0};
    value.calls++;if(row.status==="pending")value.pending++;
    if(row.elapsedMs!==null){value.measured++;value.elapsedMs+=row.elapsedMs;}
    stages.set(stage,value);
  }
  return {
    taskId: task.id,
    model: task.modelTimings ?? [],
    modelStages:[...stages.values()],
    modelCallsWithoutTiming: Math.max(0, task.calls - (task.modelTimings?.length ?? 0)),
    tools: state.operations.filter(op => op.taskId === task.id).map(toolMeasurement),
    clock: "cloud-io-wall",
    networkMeasure: "transport-and-scheduling-residual",
    modelMeasure: "provider-round-trip-or-labelled-mock",
  };
}
/** Cloud clocks advance at I/O boundaries. This is not CPU time or a pure network measurement. */
export function apiTiming(response: Response, start: number, end = Date.now()) {
  if (response.status === 101) return response;
  const ms = elapsed(start, end);
  if (ms === null) return response;
  const result = new Response(response.body, response);
  result.headers.append("Server-Timing", 'pra_gateway;dur=' + ms + ';desc="Cloud routing and I/O wall time"');
  return result;
}
