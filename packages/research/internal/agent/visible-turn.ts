import type { ControlledTurnRecord } from "./main-controls.ts";
export function visibleTurn(record:ControlledTurnRecord){
  return {version:1,turn_id:record.user_turn_id,status:record.status,answer_policy:record.answer_policy,final_answer:record.final_answer,final_structure:record.final_structure,final_request_id:record.final_request_id,
    answer_adjustments:(record.reliability_adaptations??[]).map(({stage,request_id,kind})=>({stage,request_id,kind})),
    citation_attribution:record.citation_attribution,comparison:record.comparison,execution:record.execution,tasks:record.tasks,
    elapsed_ms:record.elapsed_ms,failure_code:record.failure_code,error:record.error,citation_validity:record.citation_validity,
    requests:record.requests.map(r=>({request_id:r.request_id,admitted:r.admitted,phase:r.phase,stage:r.stage,status:r.status,http_attempts:r.http_attempts,
      http_status:r.http_status,elapsed_ms:r.elapsed_ms,usage:r.usage,usage_status:r.usage_status,pricing_status:"unknown",tool_context:r.tool_context})),
    tools:record.tools,stages:record.pipeline_trace?.stages.map(s=>({stage:s.stage,status:s.status,elapsed_ms:s.elapsed_ms})),
    preparation:record.question_preparation.result,compaction_events:record.compaction_events,session_recovery:record.session_recovery,
    runtime_controls:record.runtime_controls,actual_billing:"unknown",server_weights_revision:"unknown"};
}
