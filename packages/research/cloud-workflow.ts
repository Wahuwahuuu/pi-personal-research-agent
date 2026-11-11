import {MEMORY_SYNTHESIS_INSTRUCTION,validateMemoryDigest,type MemoryDigest} from "./memory.ts";
import {stageObject} from "./internal/agent/p2-stages.ts";
import {TRANSLATION_INSTRUCTION,parseTranslations,type TranslationSource} from "./translation.ts";
import {DomainMemory,type DomainState,type DialogueRecord} from "./internal/agent/domain-memory.ts";
import {parseQuestionPreparation,planPreparedRetrieval,QUESTION_PREPARATION_INSTRUCTION,type PreparedQuestion} from "./internal/agent/question-preparation.ts";
import {TurnExecutionTracker,executionFromOutput,parseTurnExecution,COMPLETION_CHECK_INSTRUCTION,TURN_EXECUTION_INSTRUCTION,type TurnExecution} from "./internal/agent/turn-execution.ts";
import {prepareWorkbenchAnswer,WORKBENCH_ANSWER_INSTRUCTION} from "./internal/agent/workbench-answer.ts";
import {MultiPaperComparison,COMPARISON_CHECK_INSTRUCTION,type ComparisonReport} from "./internal/agent/multi-paper.ts";
import {TaskProgressTracker,GOAL_PROGRESS_INSTRUCTION,type TaskProgress} from "./internal/agent/task-progress.ts";
import type {Chunk,Paper,EvidenceIdentity} from "./internal/agent/contracts.ts";

export interface ResearchConversation {
  id:string; title:string; projectId:string; scope:string[]; created:number; updated?:number; pinned?:boolean; archived?:boolean;
  sessionId?:string; domain?:DomainState; history:DialogueRecord[];
}
export interface ResearchWorkflow {
  phase:"prepare"|"agent"|"completion"|"comparison"|"translation"|"memory"|"finished";
  memory?:{answer:string;status:"completed"|"waiting_user";digest?:MemoryDigest;state:"pending"|"saved"|"failed"|"budget_exhausted";visibleSourceIds?:string[]};
  cloudOnly?:boolean; automatic?:boolean; preparedIndex?:string;
  translation?:{sources:TranslationSource[];items?:TranslationSource[]};
  prepared?:PreparedQuestion; candidate?:string; execution?:TurnExecution;
  tracker?:ReturnType<TurnExecutionTracker["snapshot"]>;
  comparison?:ComparisonReport; comparisonRevision?:string; progress?:TaskProgress;
  visibleSourceIds?:string[];
  citationRepair?:{answer:string;claims:unknown[]};
  warnings:string[];
}
export interface WorkflowContext {
  id:string; input:string; calls:number; evidence:readonly Chunk[]; invalidatedMemoryTurns?:readonly string[];
  catalog:{papers:readonly Paper[];indexVersion:string;evidence:readonly EvidenceIdentity[]};
  conversation:ResearchConversation; memories:readonly {content:string}[];
  project?:{id:string;title:string;goal:string};researchDirection?:string;
  operations:readonly {tool:string;params:Record<string,unknown>;state:string}[];
}
export function workflowInstruction(w:ResearchWorkflow):string{
 const instruction=w.phase==="memory"?MEMORY_SYNTHESIS_INSTRUCTION:w.phase==="prepare"?QUESTION_PREPARATION_INSTRUCTION+" For comparisons include comparison_dimensions for the requested axes.":w.phase==="comparison"?COMPARISON_CHECK_INSTRUCTION+" Copy paper_id and dimension exactly from response_template; do not rename them.":w.phase==="completion"?COMPLETION_CHECK_INSTRUCTION:w.phase==="translation"?TRANSLATION_INSTRUCTION:WORKBENCH_ANSWER_INSTRUCTION+"\n"+TURN_EXECUTION_INSTRUCTION+"\n"+GOAL_PROGRESS_INSTRUCTION;
 return (w.automatic&&w.phase==="prepare"?"Classify the current request using the conversation. Use intent=session_control for ordinary conversation, preferences and capabilities. Use the research intent appropriate to requests needing paper originals. Do not require a manual chat/research mode.\n":"")+(w.cloudOnly&&!(w.automatic&&w.phase==="prepare")?"Cloud-only conversation: use visible conversation and personal memory; local paper tools are unavailable. Do not claim to have read new paper originals. For greetings and capabilities, answer briefly without citation markers or made-up source examples.\n":"")+"The host is executing the "+w.phase+" stage. Follow this stage's output contract, not a previous stage's answer contract.\n"+instruction;
}
export const newWorkflow=():ResearchWorkflow=>({phase:"prepare",warnings:[]});
const history=(c:WorkflowContext)=>c.conversation.history.filter(h=>!c.invalidatedMemoryTurns?.includes(h.turn_id));
const memory=(c:WorkflowContext)=>{
 const d=new DomainMemory(c.catalog.indexVersion,c.conversation.domain),invalid=new Set(c.invalidatedMemoryTurns??[]);
 d.state.user_constraints=d.state.user_constraints.filter(e=>!invalid.has(e.source_turn));
 d.state.reading_notes=d.state.reading_notes?.filter(e=>!invalid.has(e.source_turn));
 d.state.conclusions=d.state.conclusions.filter(e=>!invalid.has(e.source_turn));
 d.state.pending_inferences=d.state.pending_inferences.filter(e=>!invalid.has(e.source_turn));
 d.state.unresolved_questions=d.state.unresolved_questions.filter(e=>!invalid.has(e.source_turn));
 return d;
};
const targets=(w:ResearchWorkflow)=>w.prepared?.frame.ordered_targets??[];
const nonFactual=(w:ResearchWorkflow)=>w.cloudOnly||["session_control","paper_discovery"].includes(w.prepared?.frame.intent??"");
function comparison(w:ResearchWorkflow,c:WorkflowContext){
  if(targets(w).length<2)return;
  const m=new MultiPaperComparison(c.input,targets(w),{requests:6,retrievals:10,searches:2,checks:1},w.prepared?.frame.comparison_dimensions.length?w.prepared.frame.comparison_dimensions:["用户要求的比较内容"]);
  for(const op of c.operations.filter(o=>o.tool==="retrieve_chunks")){
    const ids=Array.isArray(op.params.paper_ids)?op.params.paper_ids as string[]:[];
    m.claimQuery(String(op.params.query??""),ids,op.params);
    if(op.state==="done")m.observe(ids,c.evidence.filter(e=>ids.includes(e.paper_id)));
  }
  if(w.comparison){m.applyCheck(w.comparison,new Map(c.evidence.map(e=>[e.chunk_id,e])));}
  return m;
}
function progress(w:ResearchWorkflow,c:WorkflowContext,execution?:TurnExecution,answer=""){
  const p=new TaskProgressTracker(c.input);
  p.plan(c.input,w.prepared?.frame.information_needs??[],targets(w),nonFactual(w));
  // Rebuild from durable facts; never infer success from a model assertion.
  for(const [i,op] of c.operations.entries()){
    const base={id:String(i),kind:"tool" as const,tool:op.tool,phase:"agent",timestamp:0,input:op.params};
    p.event({...base,status:"running"} as any);
    if(op.state==="done")p.event({...base,status:"completed",output:{text:JSON.stringify({chunks:c.evidence.filter(e=>(op.params.paper_ids as string[]|undefined)?.includes(e.paper_id))})}} as any);
  }
  if(w.comparison)p.comparison(w.comparison);
  p.update(execution?.goal_updates,new Map(c.evidence.map(e=>[e.chunk_id,e])),!nonFactual(w));
  w.progress=execution?p.finish(execution,answer,[...answer.matchAll(/\[cite:([^\]\n]+)\]/g)].map(m=>m[1])):p.snapshot();
}
const byteSize=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v)).length;
function boundedItems<T>(items:readonly T[],maximum:number):T[]{const result:T[]=[];let used=2;for(const item of items){const n=byteSize(item)+1;if(used+n<=maximum){result.push(item);used+=n;}}return result;}
export function workflowPrompt(w:ResearchWorkflow,c:WorkflowContext,observations?:unknown):string{
  if(w.phase==="memory"){
    const used=new Set([...w.memory!.answer.matchAll(/\[cite:([^\]\n]+)\]/g)].map(m=>m[1]));
    const sources=boundedItems(c.evidence.filter(e=>used.has(e.chunk_id)),22000);w.memory!.visibleSourceIds=sources.map(s=>s.chunk_id);
    return JSON.stringify({stage:"memory",projection:"pra-context-v1",instruction:MEMORY_SYNTHESIS_INSTRUCTION,completed_answer:w.memory!.answer,question:c.input,prior_memory:boundedItems(c.memories,4000),sources});
  }
  if(w.phase==="translation")return JSON.stringify({stage:"translation",projection:"pra-context-v1",instruction:TRANSLATION_INSTRUCTION,excerpts:w.translation!.sources});
  const d=memory(c);
  d.revalidate(c.catalog.indexVersion,new Map(c.catalog.evidence.map(e=>[e.chunk_id,e])),new Map(c.evidence.map(e=>[e.chunk_id,e])));
  c.conversation.domain=d.state;
  const summary=JSON.parse(d.summary(history(c),true));
  const domain=summary.domain_memory;
  domain.conclusion_candidates=[]; // Prior claims are never reintroduced as source evidence.
  domain.reading_notes=(domain.reading_notes??[]).slice(-2).map((n:any)=>({...n,answer_excerpt:Array.from(n.answer_excerpt??"").slice(0,400).join(""),excerpt_truncated:true}));
  domain.user_constraints=boundedItems(domain.user_constraints.slice(-12),2500);
  domain.unresolved_questions=boundedItems(domain.unresolved_questions.slice(-6),1500);
  domain.pending_inferences=[];
  summary.conversation_only=boundedItems(summary.conversation_only.slice(-4),2500);
  const shared={projection:"pra-context-v1",project:c.project,research_direction:c.researchDirection,context_manifest:{archived_turns:c.conversation.history.length,visible_recent_turns:history(c).slice(-4).map(h=>h.turn_id),invalidated_turns_excluded:c.invalidatedMemoryTurns?.length??0},automatic:!!w.automatic,cloud_only:!!w.cloudOnly,request:c.input,conversation:summary,memory:boundedItems(c.memories.slice(-20),4000),memory_rule:"Prior preferences and reading notes are fallible user data, never paper evidence. Current user corrections override them. Do not claim automatic persistence before the host confirms it.",remaining_model_requests:6-c.calls};
  if(w.phase==="prepare")return JSON.stringify({stage:"prepare",instruction:QUESTION_PREPARATION_INSTRUCTION+" For a comparison, always include comparison_dimensions naming only the dimensions explicitly requested by the user.",...shared,catalog:boundedItems(c.catalog.papers.filter(p=>!c.conversation.scope.length||c.conversation.scope.includes(p.paper_id)).map(p=>({paper_id:p.paper_id,title:p.title})),18000)});
  if(w.phase==="completion")return JSON.stringify({stage:"completion",instruction:COMPLETION_CHECK_INSTRUCTION,...shared,candidate:w.candidate,tools:c.operations,visible_source_ids:w.visibleSourceIds??[]});
  const m=comparison(w,c);
  if(w.phase==="comparison"){
    const evidence=boundedItems(m?.window(18000)??[],18000);w.visibleSourceIds=evidence.map(e=>e.chunk_id);
    return JSON.stringify({stage:"comparison",instruction:COMPARISON_CHECK_INSTRUCTION+" Copy paper_id and dimension EXACTLY from response_template. Do not rename or split dimensions. Assess only the full user request, without adding unrelated experimental details or limitations.",...shared,workspace:m?.report(),response_template:{cells:m!.report().cells.map(cell=>({paper_id:cell.paper_id,dimension:cell.dimension,status:"supported|partial|missing",summary:"finding or actual gap",citations:[]}))},evidence});
  }
  progress(w,c);
  // Results remain complete in durable storage. The model sees each whole source at most once.
  const delivered=(observations as any)?.observations??[];
  const projected=delivered.map((o:any)=>({...o,result:{...o.result,...(o.result?.chunks?{chunks:undefined,chunk_ids:o.result.chunks.map((e:any)=>e.chunk_id)}:{})}}));
  const payload:any={stage:"agent",instruction:WORKBENCH_ANSWER_INSTRUCTION+"\n"+TURN_EXECUTION_INSTRUCTION+"\n"+GOAL_PROGRESS_INSTRUCTION,...shared,frame:w.prepared?.frame,retrieval_suggestions:w.prepared?.retrieval_plan,answer_contract:"Return a single JSON object with execution and answer fields. Execution describes visible task status only, never hidden reasoning. Put a matching [cite:chunk_id] directly after EACH numerical result in prose, bullets and table cells; a separate quotation at the end does not cite earlier claims.",citation_feedback:w.warnings,citation_repair:w.citationRepair,progress:w.progress,execution:w.execution,comparison:m?.instruction(c.calls>=5,c.catalog.papers),observations:projected,
    ...(c.calls>=5?{final_instruction:"No allowance remains for further tools or a separate completion check. Return JSON {execution:{state,remaining_needs,needs_sources},answer} with an honest complete or partial state. Answer from actual visible evidence and state gaps explicitly."}:{})};
  const freshIds=delivered.flatMap((o:any)=>(o.result?.chunks??[]).map((e:any)=>e.chunk_id));
  const byId=new Map(c.evidence.map(e=>[e.chunk_id,e]));
  const ordered=m?m.window(30000):[...new Set([...freshIds,...c.evidence.map(e=>e.chunk_id)])].map(id=>byId.get(id)!).filter(Boolean);
  const evidence=boundedItems(ordered,Math.max(0,Math.min(22000,40000-byteSize(payload))));
  w.visibleSourceIds=evidence.map(e=>e.chunk_id);
  payload.evidence=evidence;
  payload.evidence_window={archived:c.evidence.length,visible:evidence.length,omitted:c.evidence.length-evidence.length,instruction:"Only whole visible sources support new citations. Omitted sources remain archived. Refine the query or paginate to read needed omitted passages; do not pretend all archived sources are visible."};
  return JSON.stringify(payload);
}
export function workflowTools(w:ResearchWorkflow,calls:number){return !w.cloudOnly&&w.phase==="agent"&&calls<5?["search_papers","retrieve_chunks"]:[];}
export function advanceWorkflow(w:ResearchWorkflow,c:WorkflowContext,output:string):{answer?:string;status?:"completed"|"waiting_user"}{
  if(w.phase==="memory"){
    try{w.memory!.digest=validateMemoryDigest(output,c.catalog.indexVersion,c.catalog.evidence,c.evidence.filter(e=>w.memory!.visibleSourceIds?.includes(e.chunk_id)));w.memory!.state="saved";}
    catch{w.memory!.state="failed";w.warnings.push("MEMORY_SYNTHESIS_FAILED");}
    w.phase="finished";return {answer:w.memory!.answer,status:w.memory!.status};
  }
  if(w.phase==="translation"){
    w.translation!.items=parseTranslations(output,w.translation!.sources);
    w.phase="finished";return {status:"completed",answer:w.translation!.items.map(i=>i.text).join("\n\n")};
  }
  if(w.phase==="prepare"){
    const d=memory(c),allowed=new Set(c.catalog.papers.filter(p=>!c.conversation.scope.length||c.conversation.scope.includes(p.paper_id)).map(p=>p.paper_id));
    const preparationContext={original:c.input,allowed,publicPapers:c.catalog.papers,frameId:c.id,history:history(c).slice(-8),activeConstraints:d.activeConstraints(),priorObjects:{targets:d.state.comparison_order.length?d.state.comparison_order:d.state.current_paper?[d.state.current_paper.paper_id]:[],comparison_dimensions:d.state.comparison_dimensions},personalMemory:true,preferResolvedPaper:true};
    try{
      w.prepared=parseQuestionPreparation(output,preparationContext);
      if(w.cloudOnly&&!w.automatic){w.prepared.frame.intent="session_control";w.prepared.frame.ordered_targets=[];w.prepared.frame.queries=[];w.prepared.frame.comparison_dimensions=[];}
      w.prepared.retrieval_plan=planPreparedRetrieval(w.prepared,allowed,2);
      d.applyFrame(w.prepared.frame,c.id);c.conversation.domain=d.state;
    }catch{
      w.warnings.push("QUESTION_PREPARATION_FALLBACK");
      try{
        const parsed=stageObject(output),raw=(parsed.preparation??parsed) as Record<string,unknown>;
        w.prepared=parseQuestionPreparation(JSON.stringify({...raw,constraints:[]}),preparationContext);
        w.warnings.push("INVALID_CONSTRAINTS_NOT_SAVED");
      }catch{
        w.prepared=parseQuestionPreparation(JSON.stringify({intent:"answer",targets:[],rewrite:c.input,queries:[],constraints:[],comparison_dimensions:["用户要求的比较内容"]}),preparationContext);
      }
      if(w.cloudOnly&&!w.automatic){w.prepared.frame.intent="session_control";w.prepared.frame.ordered_targets=[];w.prepared.frame.queries=[];w.prepared.frame.comparison_dimensions=[];}
      w.prepared.retrieval_plan=planPreparedRetrieval(w.prepared,allowed,2);
      d.applyFrame(w.prepared.frame,c.id);c.conversation.domain=d.state;
    }
    if(w.cloudOnly&&!w.automatic){w.prepared!.frame.intent="session_control";w.prepared!.frame.ordered_targets=[];w.prepared!.frame.comparison_dimensions=[];}
    if(w.automatic)w.cloudOnly=w.prepared!.frame.intent==="session_control";
    w.preparedIndex=c.catalog.indexVersion;
    w.phase="agent";progress(w,c);return {};
  }
  if(w.phase==="comparison"){
    const m=comparison(w,c)!;
    try{m.applyCheck(stageObject(output),new Map(c.evidence.filter(e=>!w.visibleSourceIds||w.visibleSourceIds.includes(e.chunk_id)).map(e=>[e.chunk_id,e])));}
    catch{m.checkFailed();w.warnings.push("COMPARISON_CHECK_INCOMPLETE");}
    w.comparison=m.report();w.comparisonRevision=c.evidence.map(e=>e.chunk_id).sort().join(",");
    w.phase="agent";return {};
  }
  let declared:TurnExecution|undefined;
  if(w.phase==="completion"){
    try{declared=parseTurnExecution(stageObject(output),"completion_check");}catch{}
    if(!declared){declared={state:"partial",remaining_needs:["完成状态未能确认"],origin:"host"};w.warnings.push("COMPLETION_CHECK_INCOMPLETE");}
    output=w.candidate??"";
  }else{
    w.candidate=output;
    declared=executionFromOutput(output);
    const m=comparison(w,c),revision=c.evidence.map(e=>e.chunk_id).sort().join(",");
    if(m&&c.evidence.length&&c.calls<=4&&w.comparisonRevision!==revision){w.phase="comparison";return {};}
    if(!declared&&c.calls<6){w.phase="completion";return {};}
    if(!declared)declared={state:"partial",remaining_needs:["模型额度耗尽，完成状态未确认"],origin:"host"};
  }
  if(w.cloudOnly)declared.needs_sources=false;
  const visible=c.evidence.filter(e=>!w.visibleSourceIds||w.visibleSourceIds.includes(e.chunk_id));
  const answer=prepareWorkbenchAnswer(output,{evidence:new Map(visible.map(e=>[e.chunk_id,e])),allowAnswer:true,requiredPapers:targets(w),papers:c.catalog.papers,expectedKind:nonFactual(w)?w.prepared?.frame.intent==="session_control"?"session_control":"catalog":"paper_fact",execution:declared});
  if(!answer){
    if(declared.state==="working"){
      const tracker=new TurnExecutionTracker(w.tracker);
      const decision=tracker.decide(declared,{progress_key:c.evidence.map(e=>e.chunk_id).sort().join(","),source_count:c.evidence.length,retrieval_attempts:c.operations.filter(o=>o.tool==="retrieve_chunks").length,successful_retrievals:c.operations.filter(o=>o.tool==="retrieve_chunks"&&o.state==="done").length,running_tools:0,can_continue:c.calls<6,requires_sources:!nonFactual(w),cited_source_count:0});
      w.tracker=tracker.snapshot();w.execution=decision;
      if(decision.state==="working"){w.phase="agent";w.warnings.push("A working declaration is not an action. Invoke the actual research tool now; do not return an empty answer describing a planned action.");return {};}
      w.phase="finished";const text="本轮没有完成所需原文读取。尚待处理："+decision.remaining_needs.join("；");progress(w,c,decision,text);
      return {answer:text,status:"waiting_user"};
    }
    throw Error("EMPTY_RESEARCH_ANSWER");
  }
  const tracker=new TurnExecutionTracker(w.tracker);
  const retrievals=c.operations.filter(o=>o.tool==="retrieve_chunks");
  const decision=tracker.decide(declared,{progress_key:c.evidence.map(e=>e.chunk_id).sort().join(","),source_count:c.evidence.length,retrieval_attempts:retrievals.length,successful_retrievals:retrievals.filter(o=>o.state==="done").length,running_tools:0,can_continue:c.calls<6,requires_sources:!nonFactual(w),cited_source_count:answer.visibleCitationCount,citation_issues:answer.citationIssues});
  if(!nonFactual(w))decision.needs_sources=true;
  const m=comparison(w,c);
  if(decision.state==="complete"&&m&&(m.baselineMissing.length||!w.comparison||!m.complete)){decision.state=c.calls<6?"working":"partial";decision.remaining_needs=["比较范围仍有未确认的论文或维度"];}
  w.tracker=tracker.snapshot();w.execution=decision;
  if(decision.state==="working"){w.phase="agent";w.citationRepair=answer.citationIssues.length?{answer:answer.original,claims:answer.attribution.filter(a=>a.unmatched_values.length).slice(0,12)}:undefined;w.warnings=[...new Set([...w.warnings,...answer.citationIssues])];if(answer.citationIssues.length)w.warnings.push("Attach each numerical claim or original block quote to its own valid citation. A cited source must contain the reported value; revise unsupported claims or state the gap.");return {};}
  w.phase="finished";progress(w,c,decision,answer.value.answer);
  const d=memory(c);
  d.rememberAnswer(c.id,c.input,answer.value.answer,targets(w),[...answer.value.answer.matchAll(/\[cite:([^\]\n]+)\]/g)].map(m=>m[1]),answer.value.status,decision.state);
  c.conversation.domain=d.state;
  c.conversation.history=c.conversation.history.filter(h=>h.turn_id!==c.id).concat({turn_id:c.id,user_text:c.input,final_answer:answer.value.answer});
  return {answer:answer.value.answer,status:decision.state==="complete"?"completed":"waiting_user"};
}


/** Reserve no extra budget; consolidation uses only the current task's remaining allowance. */
export function beginMemory(w:ResearchWorkflow,outcome:{answer?:string;status?:"completed"|"waiting_user"},calls:number,evidence:readonly Chunk[]):boolean{
 if(w.memory||w.translation||w.cloudOnly||outcome.status!=="completed"||!outcome.answer||!evidence.length)return false;
 const cited=new Set([...outcome.answer.matchAll(/\[cite:([^\]\n]+)\]/g)].map(m=>m[1]));
 if(!evidence.some(s=>cited.has(s.chunk_id)))return false;
 w.memory={answer:outcome.answer,status:outcome.status,state:calls<6?"pending":"budget_exhausted"};
 if(calls>=6)return false;w.phase="memory";return true;
}

/** Optional consolidation may fail without undoing a previously completed research answer. */
export function skipMemory(w:ResearchWorkflow,state:"failed"|"budget_exhausted"){if(w.phase!=="memory"||!w.memory)return;w.memory.state=state;w.phase="finished";return {answer:w.memory.answer,status:w.memory.status};}
