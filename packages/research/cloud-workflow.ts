import {citationLabels,expandVisibleCitations,type VisibleCitations} from "./visible-citations.ts";
import {citationRepairTargets,applyCitationRepairs} from "./citation-repair.ts";
import type {MemoryProvenance} from "./internal/agent/memory-service.ts";
import {citationIds} from "./internal/agent/p2-r2.ts";
import type {ClaimAttribution} from "./internal/agent/citation-attribution.ts";
import {projectToolOutcomes,type ToolOutcomeOperation} from "./tool-outcomes.ts";
import {projectRecentDialogue,readResearchDialogue,recordDialogueTurn,type ContextWindow,type ResearchDialogue} from "./context-window.ts";
import {MEMORY_SYNTHESIS_INSTRUCTION,validateMemoryDigest,type MemoryDigest,type ReadingWriteCounts} from "./memory.ts";
import {stageObject} from "./internal/agent/p2-stages.ts";
import {TRANSLATION_INSTRUCTION,parseTranslations,type TranslationSource} from "./translation.ts";
import {DomainMemory,type DomainState,type DialogueRecord} from "./internal/agent/domain-memory.ts";
import {parseQuestionPreparation,planPreparedRetrieval,QUESTION_PREPARATION_INSTRUCTION,type PreparedQuestion} from "./internal/agent/question-preparation.ts";
import {TurnExecutionTracker,executionFromOutput,parseTurnExecution,COMPLETION_CHECK_INSTRUCTION,TURN_EXECUTION_INSTRUCTION,type TurnExecution} from "./internal/agent/turn-execution.ts";
import {hasWorkbenchProse,readWorkbenchDraft,prepareWorkbenchAnswer,normalizeVisibleCitationGroups,WORKBENCH_ANSWER_INSTRUCTION,type WorkbenchAnswer,type WorkbenchContext} from "./internal/agent/workbench-answer.ts";
import {MultiPaperComparison,COMPARISON_CHECK_INSTRUCTION,type ComparisonReport} from "./internal/agent/multi-paper.ts";
import {TaskProgressTracker,GOAL_PROGRESS_INSTRUCTION,type TaskProgress} from "./internal/agent/task-progress.ts";
import type {Chunk,Paper,EvidenceIdentity} from "./internal/agent/contracts.ts";

export interface ResearchConversation {
  id:string; title:string; projectId:string; scope:string[]; created:number; updated?:number; pinned?:boolean; archived?:boolean;
  sessionId?:string; domain?:DomainState; history:DialogueRecord[];
}
export interface ResearchWorkflow extends VisibleCitations {
  contextWindow?:ContextWindow;
  phase:"prepare"|"agent"|"completion"|"comparison"|"translation"|"memory"|"finished";
  memory?:{answer:string;status:"completed"|"waiting_user";digest?:MemoryDigest;state:"pending"|"saved"|"unchanged"|"disabled"|"failed"|"budget_exhausted";written?:ReadingWriteCounts;failure?:"format"|"model"|"storage";visibleSourceIds?:string[]};
  cloudOnly?:boolean; automatic?:boolean; preparedIndex?:string;
  translation?:{sources:TranslationSource[];items?:TranslationSource[]};
  prepared?:PreparedQuestion; candidate?:string; execution?:TurnExecution;
  candidateWindow?:{taskId:string;indexVersion:string;sourceIds:string[]};
  tracker?:ReturnType<TurnExecutionTracker["snapshot"]>;
  comparison?:ComparisonReport; comparisonRevision?:string; progress?:TaskProgress;
  citationRepair?:{answer:string;claims:ClaimAttribution[]};
  answerRepairAttempts?:number;answerRepairPending?:boolean;
  warnings:string[];
}
export interface WorkflowContext {
  id:string; input:string; calls:number; evidence:readonly Chunk[]; invalidatedMemoryTurns?:readonly string[];
  catalog:{papers:readonly Paper[];indexVersion:string;evidence:readonly EvidenceIdentity[]};
  conversation:ResearchConversation; memories:readonly (MemoryProvenance & {content:string;kind?:string;edited?:boolean;updated_at?:string;paper_ids?:string[]})[];
  memoryStatus?:"ready"|"disabled"|"unavailable";
  project?:{id:string;title:string;goal:string};researchDirection?:string;
  goal?:{segment:number;maximum:number;calls:number;tools:number;activeMs:number;remaining:string[]};
  operations:readonly ToolOutcomeOperation[];
}
const PERSONAL_CONTEXT_ROUTING = "For this personal agent, classify what the user is asking to do, not the research vocabulary in the message. Use intent=session_update for ordinary conversation and for recalling, explaining or correcting the user's saved preferences, project scope, decisions, constraints and unresolved questions. Answer those from the visible project, dialogue and personal memory; missing personal context calls for clarification, not literature discovery. Do not expand a question about the user's own decisions into questions about standard scientific practice. Use research intents when the user requests new papers, paper originals or verification of scientific claims; remembered findings never replace source evidence. A request about the length, detail, language or structure of your reply is a conversation update. Respect the latest instruction for this turn. When choosing find_papers, include discovery_request_quote, an exact substring of the current message asking to find sources or naming the subject the user wants literature about. Format instructions alone do not name a literature topic. If no topic is available, acknowledge the instruction or ask for the missing subject. Do not require a manual chat/research mode.";
const automaticRouting=(w:ResearchWorkflow)=>w.automatic&&w.phase==="prepare"?PERSONAL_CONTEXT_ROUTING+"\n":"";
const ANSWER_FORMAT_REPAIR_INSTRUCTION="Rewrite the response as ordinary Markdown with exact citations. Do not use a JSON envelope or execution metadata. Answer the original question from the visible evidence and state actual gaps.";
const VISIBLE_CITATION_INSTRUCTION="When a visible excerpt has answer_citation, copy that short marker exactly for that excerpt in your answer. Copy its source_ref for execution.goal_updates.source_ids, exact_quotes.chunk_id and paper_coverage.citations. The host resolves both to the permanent source ID. Do not manually retype a long chunk_id when its short source_ref is available. Paper IDs remain unchanged. Use only excerpts actually visible in this step. Preserve the source's numerical notation and units: a bare number is not permission to append a percent sign. Report only metrics needed to answer the user's request, with their experimental conditions.";
const CITATION_REPAIR_INSTRUCTION="This step repairs a rejected draft. The draft is not authoritative evidence. Resolve every item in citation_repair before returning it: verify the value AND its unit in the cited original, or remove an unnecessary numerical detail while retaining the requested explanation. If a required fact cannot be verified, state that specific gap without asserting the unsupported value. Never copy unresolved_references; locate the needed original with the available tools or use a currently visible source that actually supports the claim. Archived references not visible in this step are not usable evidence. Keep the answer focused on all parts of the original request; do not add unrequested benchmark numbers. Return actual corrections with honest execution status, not a plan to fix the draft.";
const CITATION_EDIT_CONTRACT='For a targeted correction, return JSON {"execution":{"state":"complete|partial|working","remaining_needs":[],"needs_sources":true},"citation_repairs":[{"target":"exact repair_id","replacement":"corrected text including its supporting citation"}]}. Each replacement changes only that numbered claim or reference in the stored draft; leave supported parts untouched. A reference replacement must itself be an exact visible citation marker. An empty replacement removes an unnecessary detail, never a requested answer. Do not repeat the whole draft when these edits suffice. If the required correction has no repair_id or the answer needs wider revision, return the ordinary full answer envelope instead.';
const agentInstruction=(w:ResearchWorkflow)=>WORKBENCH_ANSWER_INSTRUCTION+"\n"+VISIBLE_CITATION_INSTRUCTION+"\n"+(w.citationRepair?CITATION_REPAIR_INSTRUCTION+"\n"+CITATION_EDIT_CONTRACT:w.answerRepairPending?ANSWER_FORMAT_REPAIR_INSTRUCTION:TURN_EXECUTION_INSTRUCTION+"\n"+GOAL_PROGRESS_INSTRUCTION);
export function workflowInstruction(w:ResearchWorkflow):string{
 const instruction=w.phase==="memory"?MEMORY_SYNTHESIS_INSTRUCTION:w.phase==="prepare"?QUESTION_PREPARATION_INSTRUCTION+" For comparisons include comparison_dimensions for the requested axes.":w.phase==="comparison"?COMPARISON_CHECK_INSTRUCTION+" Copy paper_id and dimension exactly from response_template; do not rename them.":w.phase==="completion"?COMPLETION_CHECK_INSTRUCTION:w.phase==="translation"?TRANSLATION_INSTRUCTION:agentInstruction(w);
 return automaticRouting(w)+(w.cloudOnly&&!(w.automatic&&w.phase==="prepare")?"Cloud-only conversation: use visible conversation and personal memory; local paper tools are unavailable. Do not claim to have read new paper originals. For greetings and capabilities, answer briefly without citation markers or made-up source examples.\n":"")+"The host is executing the "+w.phase+" stage. Follow this stage's output contract, not a previous stage's answer contract.\n"+instruction;
}
export const newWorkflow=():ResearchWorkflow=>({phase:"prepare",warnings:[]});
export const workflowDialogue = (c: WorkflowContext): ResearchDialogue =>
  readResearchDialogue(c.conversation, c.invalidatedMemoryTurns);
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
  const byId=new Map(c.evidence.map(source=>[source.chunk_id,source]));
  const unassigned=new Map(byId);
  const retrievals=c.operations.filter(op=>op.tool==="retrieve_chunks").map(op=>{
    const ids=Array.isArray(op.params.paper_ids)?op.params.paper_ids as string[]:[];
    const rows=(op.result as {chunks?:unknown}|undefined)?.chunks;
    const chunks:Chunk[]=[];
    if(op.state==="done"&&Array.isArray(rows)){
      for(const row of rows){
        const source=byId.get(row?.chunk_id);
        if(!source||source.paper_id!==row.paper_id||!ids.includes(source.paper_id))continue;
        chunks.push(source);
        unassigned.delete(source.chunk_id);
      }
    }
    return {op,ids,chunks};
  });
  // Old task records can contain validated passages without the original per-call results.
  // Keep their previous recency order behind known retrievals without attributing them to each call.
  if(unassigned.size)m.observe([], [...unassigned.values()].reverse());
  for(const {op,ids,chunks} of retrievals){
    m.claimQuery(String(op.params.query??""),ids,op.params);
    if(op.state==="done")m.observe(ids,chunks);
  }
  if(w.comparison){m.applyCheck(w.comparison,new Map(c.evidence.map(e=>[e.chunk_id,e])));}
  return m;
}
/** Check coverage as soon as every target has returned text, leaving time to repair the eventual answer. */
export function reserveComparisonCheck(workflow: ResearchWorkflow, context: WorkflowContext): void {
  if (context.calls < 2 || context.calls > 4 || workflow.phase !== "agent" || workflow.cloudOnly ||
      workflow.comparison || workflow.citationRepair || workflow.answerRepairPending) return;
  const workspace = comparison(workflow, context);
  if (!workspace || workspace.baselineMissing.length) return;
  const papersWithText = new Set(context.evidence.filter(chunk => chunk.text.trim()).map(chunk => chunk.paper_id));
  if (workspace.papers.every(id => papersWithText.has(id))) workflow.phase = "comparison";
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
function repairAnswerFormat(w:ResearchWorkflow,c:WorkflowContext):{answer?:string;status?:"waiting_user"}{
  if(c.calls<6&&(w.answerRepairAttempts??0)<1){
    w.answerRepairAttempts=(w.answerRepairAttempts??0)+1;w.answerRepairPending=true;w.phase="agent";
    w.warnings.push("The previous reply had no complete readable answer. Rewrite it once as ordinary Markdown from the visible evidence and original question, with exact citations. Do not use a JSON envelope or execution metadata. This repair uses the same remaining task budget.");
    return {};
  }
  w.phase="finished";w.answerRepairPending=undefined;w.execution={state:"partial",remaining_needs:["恢复完整可读的回答"],needs_sources:!nonFactual(w),origin:"host"};
  const answer="本轮回答的格式未能恢复，任务进度已保留。"+(c.evidence.length?"已取得的原文证据仍可查看。":"");
  progress(w,c,w.execution,answer);return {answer,status:"waiting_user"};
}
const byteSize=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v)).length;
function boundedItems<T>(items:readonly T[],maximum:number):T[]{const result:T[]=[];let used=2;for(const item of items){const n=byteSize(item)+1;if(used+n<=maximum){result.push(item);used+=n;}}return result;}
const READING_AVAILABILITY_RULE="Independent abstract metadata and indexed paper text are separate capabilities. If independent_abstract=false and indexed_text=true, read the existing paper with retrieve_chunks(query, paper_ids), omitting section; do not request an unavailable abstract, infer the body is absent, or invent abstract citation IDs. Empty section results are not proof the whole paper is unavailable. Catalog metadata is navigation, not source evidence. Use the catalog title for paper identity; project and conversation titles are user workspace labels, never paper titles.";
function readingAvailability(w:ResearchWorkflow,c:WorkflowContext){
 const indexed=new Set(c.catalog.evidence.map(e=>e.paper_id)),selected=new Set(targets(w));
 return c.catalog.papers.filter(p=>(!c.conversation.scope.length||c.conversation.scope.includes(p.paper_id))&&(!selected.size||selected.has(p.paper_id)))
  .map(p=>({paper_id:p.paper_id,title:Array.from(p.title).slice(0,200).join(""),independent_abstract:!!p.abstract.trim(),indexed_text:indexed.has(p.paper_id)}));
}
export function workflowPrompt(w:ResearchWorkflow,c:WorkflowContext,observations?:unknown,options:{systemInstructionProvided?:boolean}={}):string{
  if(w.phase==="memory"){
    const used=new Set([...w.memory!.answer.matchAll(/\[cite:([^\]\n]+)\]/g)].map(m=>m[1]));
    const sources=boundedItems(c.evidence.filter(e=>used.has(e.chunk_id)),22000);w.memory!.visibleSourceIds=sources.map(s=>s.chunk_id);
    return JSON.stringify({stage:"memory",projection:"pra-context-v1",instruction:MEMORY_SYNTHESIS_INSTRUCTION,completed_answer:w.memory!.answer,question:c.input,prior_memory:boundedItems(c.memories,4000),sources});
  }
  if(w.phase==="translation")return JSON.stringify({stage:"translation",projection:"pra-context-v1",instruction:TRANSLATION_INSTRUCTION,excerpts:w.translation!.sources});
  const d=memory(c);
  d.revalidate(c.catalog.indexVersion,new Map(c.catalog.evidence.map(e=>[e.chunk_id,e])),new Map(c.evidence.map(e=>[e.chunk_id,e])));
  c.conversation.domain=d.state;
  const dialogue=workflowDialogue(c);
  const summary=JSON.parse(d.summary(dialogue.recent,true));
  const domain=summary.domain_memory;
  domain.conclusion_candidates=[]; // Prior claims are never reintroduced as source evidence.
  domain.reading_notes=(domain.reading_notes??[]).slice(-2).map((n:any)=>({...n,answer_excerpt:Array.from(n.answer_excerpt??"").slice(0,400).join(""),excerpt_truncated:true}));
  domain.user_constraints=boundedItems([...domain.user_constraints.slice(-12)].reverse(),2500).reverse();
  domain.unresolved_questions=boundedItems([...domain.unresolved_questions.slice(-6)].reverse(),1500).reverse();
  domain.pending_inferences=[];
  const answersIncluded=!d.state.reading_notes;
  const recent=projectRecentDialogue(dialogue.recent,answersIncluded),memories=boundedItems(c.memories.slice(0,20).map(({kind,content,edited,updated_at,category,sourceStatus,semanticStatus,paper_ids})=>({kind,content,user_confirmed:edited===true,updated_at,category,sourceStatus,semanticStatus,paper_ids})),4000);
  summary.conversation_only=recent.items;
  w.contextWindow={version:1,stage:w.phase,stored_turns:dialogue.stored,
    visible_recent_turns:recent.items.map(h=>h.turn_id),omitted_valid_turns:dialogue.stored-dialogue.excluded-recent.items.length,
    invalidated_turns_excluded:dialogue.excluded,truncated_recent_turns:recent.truncated,
    history_bytes:recent.bytes,constraints:domain.user_constraints.length,unresolved_questions:domain.unresolved_questions.length,
    reading_notes:domain.reading_notes?.length??0,memories:memories.length,answers_included:answersIncluded};
  summary.context_rule="Only conversation_only is included as recent discussion. Some fields are explicitly truncated. Other archived turns are not visible here; ask for missing context rather than claiming to remember it.";
  const shared={projection:"pra-context-v1",long_goal:c.goal,project:c.project,research_direction:c.researchDirection,context_manifest:{...w.contextWindow,archived_turns:dialogue.stored},automatic:!!w.automatic,cloud_only:!!w.cloudOnly,request:c.input,conversation:summary,memory:memories,memory_status:c.memoryStatus??"ready",memory_rule:"These are the currently recalled personal records, separate from this conversation history. Empty conversation history does not mean memory is empty. User-confirmed preferences and project constraints describe prior user decisions; apply current corrections first. For questions about those decisions, use the actual memory content and say it comes from saved personal context, without [cite:] markers. Reading notes and conclusions remain fallible and never replace paper evidence. sourceStatus=verified means only that the stored source text and location were checked; it is NOT semantic proof. stale, needs_review, unavailable or missing provenance cannot support a new paper claim. semanticStatus=unreviewed is not a reviewed conclusion; user_modified means a user edit that still needs original evidence verification. Preserve these distinctions when explaining remembered research findings. If neither visible dialogue nor memory supports a claimed past agreement, say it cannot be confirmed from available records; never invent one or assert it never existed. A question that presupposes a preference does not establish that preference. Do not print internal field names, counters or diagnostic data. Do not claim persistence before the host confirms it.",remaining_model_requests:6-c.calls};
  const available=readingAvailability(w,c),availableByPaper=new Map(available.map(a=>[a.paper_id,a])),visibleAvailability=boundedItems(available,2500);
  if(w.phase==="prepare")return JSON.stringify({stage:"prepare",instruction:automaticRouting(w)+QUESTION_PREPARATION_INSTRUCTION+" For a comparison, always include comparison_dimensions naming only the dimensions explicitly requested by the user.",...shared,catalog:boundedItems(c.catalog.papers.filter(p=>!c.conversation.scope.length||c.conversation.scope.includes(p.paper_id)).map(p=>({...availableByPaper.get(p.paper_id),paper_id:p.paper_id,title:p.title})),18000),reading_rule:READING_AVAILABILITY_RULE});
  if(w.phase==="completion")return JSON.stringify({stage:"completion",instruction:COMPLETION_CHECK_INSTRUCTION,...shared,candidate:w.candidate,...projectToolOutcomes(c.operations),visible_source_ids:w.visibleSourceIds??[]});
  const m=comparison(w,c);
  if(w.phase==="comparison"){
    const evidence=boundedItems(m?.window(18000,"retrieval_rank")??[],18000);w.visibleSourceIds=evidence.map(e=>e.chunk_id);
    const comparison_papers=m!.papers.map(paper_id=>{
      const title=c.catalog.papers.find(p=>p.paper_id===paper_id)?.title??paper_id;
      const characters=Array.from(title);
      return {paper_id,title:characters.length>200?characters.slice(0,199).join("")+"…":title};
    });
    return JSON.stringify({stage:"comparison",comparison_papers,instruction:COMPARISON_CHECK_INSTRUCTION+" Copy paper_id and dimension EXACTLY from response_template. Do not rename or split dimensions. Assess only the full user request, without adding unrelated experimental details or limitations.",...shared,workspace:m?.report(),response_template:{cells:m!.report().cells.map(cell=>({paper_id:cell.paper_id,dimension:cell.dimension,status:"supported|partial|missing",summary:"finding or actual gap",citations:[]}))},evidence});
  }
  progress(w,c);
  // Results remain complete in durable storage. The model sees each whole source at most once.
  const delivered=(observations as any)?.observations??[];
  const projected=delivered.map((o:any)=>({...o,result:{...o.result,...(o.result?.chunks?{chunks:undefined,chunk_ids:o.result.chunks.map((e:any)=>e.chunk_id)}:{})}}));
  const payload:any={stage:"agent",instruction:options.systemInstructionProvided?undefined:agentInstruction(w),...shared,frame:w.prepared?.frame,retrieval_suggestions:w.prepared?.retrieval_plan,answer_contract:w.answerRepairPending?ANSWER_FORMAT_REPAIR_INSTRUCTION:"Return a single JSON object with execution and answer fields. Execution describes visible task status only, never hidden reasoning. Copy the matching excerpt answer_citation (or [cite:chunk_id] only when no short marker is provided) directly after EACH numerical result in prose, bullets and table cells; a separate quotation at the end does not cite earlier claims.",reading_availability:visibleAvailability,reading_availability_omitted:available.length-visibleAvailability.length,reading_rule:READING_AVAILABILITY_RULE,citation_feedback:w.warnings,progress:w.progress,execution:w.execution,comparison:m?.instruction(c.calls>=5,c.catalog.papers),observations:projected,
    ...(c.calls===4&&!w.citationRepair?{draft_instruction:"Produce the full answer now from the visible originals, covering the user's requirements and stating actual gaps. One request remains after this draft for checking or correction; do not spend this step narrating future work."}:{}),
    ...(c.calls>=5?{final_instruction:w.answerRepairPending?"No allowance remains for tools or a separate completion check. Give the supported answer and actual gaps as plain Markdown; do not add JSON metadata.":"No allowance remains for further tools or a separate completion check. Return JSON {execution:{state,remaining_needs,needs_sources},answer} with an honest complete or partial state. Answer from actual visible evidence and state gaps explicitly."}:{})};
  const freshIds=delivered.flatMap((o:any)=>(o.result?.chunks??[]).map((e:any)=>e.chunk_id));
  const byId=new Map(c.evidence.map(e=>[e.chunk_id,e]));
  const checkedFinal=m && w.comparison && c.calls>=5 ? m : undefined;
  const ordered=m?m.window(30000,checkedFinal?"checked_first":"retrieval_rank"):[...new Set([...freshIds,...c.evidence.map(e=>e.chunk_id)])].map(id=>byId.get(id)!).filter(Boolean);
  // Present the originals as possible sources. Only the model can select a citation for its claim.
  const firstCandidates = new Set<string>();
  const candidates = new Map<string, {values:Set<string>; units:Set<string>; lists:string[][]}>();
  const repair = w.citationRepair?{...w.citationRepair,answer:readWorkbenchDraft(w.citationRepair.answer)??w.citationRepair.answer}:undefined;
  const repairTargets=repair?citationRepairTargets(repair.answer,repair.claims,new Set(byId.keys())):[];
  const repairClaims = (repair?.claims ?? []).map(check => {
    const visibleCandidates: Record<string,string[]> = {};
    const unitSources: Record<string,string[]> = {};
    for (const value of check.unmatched_values ?? []) {
      if (check.unit_unconfirmed_values?.includes(value)) {
        const visibleUnits: string[] = [];
        unitSources[value] = visibleUnits;
        for (const id of [...new Set(check.citations)].filter(id => byId.has(id))) {
          firstCandidates.add(id);
          const candidate = candidates.get(id) ?? {values:new Set<string>(), units:new Set<string>(), lists:[] as string[][]};
          candidate.units.add(value);
          candidate.lists.push(visibleUnits);
          candidates.set(id, candidate);
        }
      }
      const visibleIds: string[] = [];
      visibleCandidates[value] = visibleIds;
      const ids = [...new Set(check.candidate_sources?.[value] ?? [])].filter(id => byId.has(id));
      if (ids.length) firstCandidates.add(ids[0]);
      for (const id of ids) {
        const candidate = candidates.get(id) ?? {values:new Set<string>(), units:new Set<string>(), lists:[] as string[][]};
        candidate.values.add(value);
        candidate.lists.push(visibleIds);
        candidates.set(id, candidate);
      }
    }
    return {...check, repair_id:repairTargets.find(t=>t.kind==="claim"&&t.original===check.claim)?.id, candidate_sources:visibleCandidates, unit_check_sources:unitSources};
  });
  if (repair) {
    payload.answer_contract=CITATION_EDIT_CONTRACT;
    if(c.calls>=5)payload.final_instruction="No requests remain after this one. Do not call tools. Return actual citation_repairs with honest execution status, or a corrected full answer only when targeted edits cannot express it. Preserve the user's required answers and state real unresolved gaps.";
    payload.citation_repair = {answer:repair.answer, claims:repairClaims,reference_targets:repairTargets.filter(t=>t.kind==="reference").map(t=>({repair_id:t.id,marker:t.original})),
      instruction:"The previous answer contains unverified references. First inspect the cited originals tagged units_to_verify: the number may occur there, but this is not permission to add a percent sign. Preserve their original notation and experimental conditions, retrieve the missing unit definition if needed, or omit an unnecessary metric. Do not repeat the same unverified percentage. Then inspect values_to_verify candidates, checking the paper, metric, unit and conditions before copying their answer_citation. A matching number elsewhere cannot support a claim. Address the user's actual question and state any remaining gap; do not expand the answer with unrelated benchmark numbers."};
  }
  const cited = repair ? citationIds(normalizeVisibleCitationGroups(repair.answer,byId)) : [];
  const preferred = new Set([...firstCandidates, ...cited.filter(id=>byId.has(id)), ...candidates.keys()]);
  const repairSources = [...preferred].map(id=>byId.get(id)!);
  // Count the prompt as the JSON string actually nested in the provider request.
  // The remaining 8 KB is reserved for the locked Pi system/tool envelope; the
  // adapter still validates the entire request against its unchanged 48 KB limit.
  const labels = citationLabels(c.id, c.catalog.indexVersion, new Set(byId.keys()));
  const evidence:(Chunk & {answer_citation?:string;source_ref?:string})[]=[];
  const window={archived:c.evidence.length,visible:0,omitted:c.evidence.length,instruction:"Only whole visible sources support new citations. Omitted sources remain archived. Refine the query or paginate to read needed omitted passages; do not pretend all archived sources are visible."};
  payload.evidence=evidence;payload.evidence_window=window;
  // Persist the complete coverage record. Project its references against the same window as the answer.
  const projectCheckedReferences=()=>{
    if(!checkedFinal)return;
    const visible=new Set(evidence.map(source=>source.chunk_id));
    payload.comparison=checkedFinal.instruction(true,c.catalog.papers,visible);
    const inWindow=<T extends {source_ids:string[]}>(item:T)=>({...item,source_ids:item.source_ids.filter(id=>visible.has(id))});
    if(w.progress)payload.progress={...w.progress,items:w.progress.items.map(inWindow)};
    if(w.execution?.goal_updates)payload.execution={...w.execution,goal_updates:w.execution.goal_updates.map(inWindow)};
  };
  const fits=()=>{
    projectCheckedReferences();
    if(repair){
      const visible=new Set(evidence.map(source=>source.chunk_id));
      const normalized=normalizeVisibleCitationGroups(repair.answer,byId),markers=citationIds(normalized);
      payload.citation_repair.unresolved_references=[...new Set(markers.filter(id=>!byId.has(id)))];
      payload.citation_repair.archived_references=[...new Set(markers.filter(id=>byId.has(id)&&!visible.has(id)))];
      payload.citation_repair.answer=normalized.replace(/\[cite:([^\]\n]+)\]/g,(marker,id:string)=>visible.has(id)&&labels.has(id)?"[cite:"+labels.get(id)+"]":marker);
    }
    return byteSize(JSON.stringify(payload))<=40000;
  };
  if(!fits())throw Error("CONTEXT_LIMIT"); // Never silently shorten the user's request or corrections.
  let evidenceBytes=2;
  for(const source of [...repairSources,...ordered.filter(e=>!preferred.has(e.chunk_id))]){
    const label = labels.get(source.chunk_id), candidate = candidates.get(source.chunk_id);
    const projectedSource = {...source, ...(label ? {answer_citation:"[cite:"+label+"]",source_ref:label} : {}),
      ...(candidate?.values.size ? {values_to_verify:[...candidate.values]} : {}),
      ...(candidate?.units.size ? {units_to_verify:[...candidate.units]} : {})};
    const size=byteSize(projectedSource)+1;if(evidenceBytes+size>22000)continue;
    const candidateLists = candidate?.lists ?? [];
    for (const ids of candidateLists) ids.push(source.chunk_id);
    evidence.push(projectedSource);window.visible=evidence.length;window.omitted=c.evidence.length-evidence.length;
    if(fits())evidenceBytes+=size;
    else {
      evidence.pop();window.visible=evidence.length;window.omitted=c.evidence.length-evidence.length;
      for (const ids of candidateLists) ids.pop();
    }
  }
  // Reproject after a rejected candidate was popped from the evidence window.
  if(!fits())throw Error("CONTEXT_LIMIT");
  w.visibleSourceIds=evidence.map(e=>e.chunk_id);
  w.citationLabels=evidence.some(e=>e.answer_citation) ? w.visibleSourceIds.map(id=>labels.get(id)??"") : undefined;
  return JSON.stringify(payload);
}
/** Leave the final request for checking the first answer; known source repairs may use the penultimate step to reread. */
export function workflowTools(w:ResearchWorkflow,calls:number){return !w.cloudOnly&&w.phase==="agent"&&(calls<4||calls===4&&!!w.citationRepair)?["search_papers","retrieve_chunks"]:[];}
/** Keep an earlier complete response when Pi interrupts a later step. A streamed preview is never a candidate. */
export function interruptWorkflow(w:ResearchWorkflow,c:WorkflowContext):{status:"waiting_user";answer?:string}{
  const needsSources=!nonFactual(w);
  const remaining=[...new Set([...(w.execution?.remaining_needs??[]),"完成中断的步骤并核对本轮要求"])];
  const decision:TurnExecution={state:"partial",remaining_needs:remaining,needs_sources:needsSources,origin:"host",stop_reason:"model_interrupted"};
  const scope=w.candidateWindow;
  let answer:string|undefined;
  if(w.candidate&&scope?.taskId===c.id&&scope.indexVersion===c.catalog.indexVersion&&
      !c.invalidatedMemoryTurns?.includes(c.id)&&!/<\/?(?:think|thinking|analysis)>/i.test(w.candidate)){
    const ids=new Set(scope.sourceIds);
    const visible=c.evidence.filter(s=>ids.has(s.chunk_id)&&s.index_version===scope.indexVersion);
    const prior=prepareWorkbenchAnswer(w.candidate,{evidence:new Map(visible.map(s=>[s.chunk_id,s])),
      allowAnswer:true,requiredPapers:targets(w),papers:c.catalog.papers,
      expectedKind:needsSources?"paper_fact":w.prepared?.frame.intent==="session_control"?"session_control":"catalog",execution:decision});
    if(prior&&!prior.citationIssues.length&&hasWorkbenchProse(prior)&&
       (!needsSources||prior.visibleCitationCount>0))answer=prior.value.answer;
  }
  w.execution=decision;
  progress(w,c,decision,answer??"");
  return answer?{status:"waiting_user",answer}:{status:"waiting_user"};
}
interface ResearchOutcome {
  answer?: string;
  status?: "completed" | "waiting_user";
  userWait?: "RESEARCH_CLARIFICATION" | "RESEARCH_REFUSAL";
}
function finishReadableTurn(w:ResearchWorkflow,c:WorkflowContext,answer:WorkbenchAnswer,decision:TurnExecution):ResearchOutcome {
  w.phase="finished";
  w.execution=decision;
  const {answer:text,status}=answer.value;
  progress(w,c,decision,text);
  const reading=status!=="clarification"&&status!=="refusal";
  // Keep questions in the dialogue without turning them into paper reading records.
  const d=memory(c);
  const sources=reading?[...text.matchAll(/\[cite:([^\]\n]+)\]/g)].map(m=>m[1]):[];
  d.rememberAnswer(c.id,c.input,text,reading?targets(w):[],sources,status,decision.state);
  c.conversation.domain=d.state;
  recordDialogueTurn(c.conversation,{turn_id:c.id,user_text:c.input,final_answer:text});
  return {answer:text,status:decision.state==="complete"?"completed":"waiting_user"};
}
export function advanceWorkflow(w:ResearchWorkflow,c:WorkflowContext,output:string):ResearchOutcome{
  if (w.phase === "memory") {
    const memory = w.memory!;
    try {
      const visible = c.evidence.filter(source => memory.visibleSourceIds?.includes(source.chunk_id));
      memory.digest = validateMemoryDigest(output, c.catalog.indexVersion, c.catalog.evidence, visible);
      memory.state = "pending";
    } catch {
      delete memory.digest;
      memory.state = "failed";
      memory.failure = "format";
      w.warnings.push("MEMORY_SYNTHESIS_FAILED");
    }
    w.phase = "finished";
    return {answer: memory.answer, status: memory.status};
  }
  if(w.phase==="translation"){
    w.translation!.items=parseTranslations(output,w.translation!.sources);
    w.phase="finished";return {status:"completed",answer:w.translation!.items.map(i=>i.text).join("\n\n")};
  }
  if(w.phase==="prepare"){
    const d=memory(c),allowed=new Set(c.catalog.papers.filter(p=>!c.conversation.scope.length||c.conversation.scope.includes(p.paper_id)).map(p=>p.paper_id));
    const preparationContext={original:c.input,allowed,publicPapers:c.catalog.papers,frameId:c.id,history:workflowDialogue(c).recent,activeConstraints:d.activeConstraints(),priorObjects:{targets:d.state.comparison_order.length?d.state.comparison_order:d.state.current_paper?[d.state.current_paper.paper_id]:[],comparison_dimensions:d.state.comparison_dimensions},personalMemory:true,preferResolvedPaper:true,groundDiscovery:w.automatic===true};
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
  const checkingCompletion=w.phase==="completion";
  let declared:TurnExecution|undefined;
  if(checkingCompletion){
    try{declared=parseTurnExecution(stageObject(output),"completion_check");}catch{}
    if(!declared){declared={state:"partial",remaining_needs:["完成状态未能确认"],origin:"host"};w.warnings.push("COMPLETION_CHECK_INCOMPLETE");}
    output=w.candidate??"";
  }else{
    output=expandVisibleCitations(output,w);
    if(w.citationRepair){
      let raw:Record<string,unknown>|undefined;
      try{raw=stageObject(output);}catch{}
      if(raw&&Object.hasOwn(raw,"citation_repairs")){
        const repair=w.citationRepair;
        try{
          const answer=applyCitationRepairs(repair.answer,citationRepairTargets(repair.answer,repair.claims,new Set(c.evidence.map(e=>e.chunk_id))),raw.citation_repairs);
          output=JSON.stringify({execution:raw.execution,answer});
        }catch{
          w.warnings.push("INVALID_CITATION_REPAIR: use each supplied repair_id once; otherwise return a corrected full answer.");
          output=JSON.stringify({execution:{state:"working",remaining_needs:["修正引用编辑格式并核对依据"],needs_sources:true},answer:readWorkbenchDraft(repair.answer)??repair.answer});
        }
      }
    }
    declared=executionFromOutput(output);
  }
  if(w.cloudOnly&&declared)declared.needs_sources=false;
  const visible=c.evidence.filter(e=>!w.visibleSourceIds||w.visibleSourceIds.includes(e.chunk_id));
  const answerContext:WorkbenchContext={evidence:new Map(visible.map(e=>[e.chunk_id,e])),allowAnswer:true,
    requiredPapers:targets(w),papers:c.catalog.papers,expectedKind:nonFactual(w)?w.prepared?.frame.intent==="session_control"?"session_control":"catalog":"paper_fact"};
  let answer=prepareWorkbenchAnswer(output,{...answerContext,execution:declared});
  const disposition=answer?.value.status;
  const userReply=disposition==="clarification"||disposition==="refusal";
  if(answer&&userReply){
    if(!hasWorkbenchProse(answer))return repairAnswerFormat(w,c);
    if(!answer.citationIssues.length){
      const asking=disposition==="clarification";
      const decision:TurnExecution={state:asking?"clarification":"partial",needs_sources:false,
        remaining_needs:declared?.remaining_needs??[],origin:declared?.origin??"model"};
      w.answerRepairPending=undefined;
      w.citationRepair=undefined;
      return {...finishReadableTurn(w,c,answer,decision),userWait:asking?"RESEARCH_CLARIFICATION":"RESEARCH_REFUSAL"};
    }
    declared={state:"working",needs_sources:true,remaining_needs:["核对回复中引用的原文"],origin:"host"};
  }
  if(!checkingCompletion){
    if(answer&&!userReply){
      w.candidate=output;
      w.candidateWindow=w.visibleSourceIds
        ? {taskId:c.id,indexVersion:c.catalog.indexVersion,sourceIds:[...w.visibleSourceIds]}
        : undefined;
    }
    if(declared?.state!=="working"&&!answer)return repairAnswerFormat(w,c);
    w.answerRepairPending=undefined;
    // A known invalid source needs repair, not a paid semantic check to rediscover the failure.
    // Missing citations alone can be a legitimate bounded gap; keep its normal completion path.
    const sourceRepair=!userReply&&answer&&visible.length>0&&answer.citationIssues.some(issue=>issue!=="missing_visible_citation");
    if(sourceRepair&&answer&&!declared)declared={state:"working",remaining_needs:[answer.citationIssues.some(issue=>issue.startsWith("metric_source_mismatch:"))?"核对回答中的数值、单位及其原文依据":"定位回答引用的真实原文"],needs_sources:true,origin:"host"};
    const m=comparison(w,c),revision=c.evidence.map(e=>e.chunk_id).sort().join(",");
    if(!sourceRepair&&!userReply&&m&&c.evidence.length&&c.calls<=4&&w.comparisonRevision!==revision){w.phase="comparison";return {};}
    if(!declared&&c.calls<6){w.phase="completion";return {};}
  }
  if(!declared){
    declared={state:"partial",remaining_needs:["模型额度耗尽，完成状态未确认"],origin:"host",...(w.cloudOnly?{needs_sources:false}:{})};
    if(answer)answer=prepareWorkbenchAnswer(output,{...answerContext,execution:declared});
  }
  if(!answer){
    if(declared.state==="working"){
      const tracker=new TurnExecutionTracker(w.tracker);
      const decision=tracker.decide(declared,{progress_key:c.evidence.map(e=>e.chunk_id).sort().join(","),source_count:c.evidence.length,retrieval_attempts:c.operations.filter(o=>o.tool==="retrieve_chunks").length,successful_retrievals:c.operations.filter(o=>o.tool==="retrieve_chunks"&&o.state==="done").length,running_tools:0,can_continue:c.calls<6,requires_sources:!nonFactual(w),cited_source_count:0});
      w.tracker=tracker.snapshot();w.execution=decision;
      if(decision.state==="working"){w.phase="agent";w.warnings.push("A working declaration is not an action. Invoke the actual research tool now; do not return an empty answer describing a planned action.");return {};}
      w.phase="finished";const text="本轮没有完成所需原文读取。尚待处理："+decision.remaining_needs.join("；");progress(w,c,decision,text);
      return {answer:text,status:"waiting_user"};
    }
    return repairAnswerFormat(w,c);
  }
  const tracker=new TurnExecutionTracker(w.tracker);
  const retrievals=c.operations.filter(o=>o.tool==="retrieve_chunks");
  const decision=tracker.decide(declared,{progress_key:c.evidence.map(e=>e.chunk_id).sort().join(","),source_count:c.evidence.length,retrieval_attempts:retrievals.length,successful_retrievals:retrievals.filter(o=>o.state==="done").length,running_tools:0,can_continue:c.calls<6,requires_sources:!nonFactual(w),cited_source_count:answer.visibleCitationCount,citation_issues:answer.citationIssues});
  if(!nonFactual(w))decision.needs_sources=true;
  const m=comparison(w,c);
  if(decision.state==="complete"&&m&&(m.baselineMissing.length||!w.comparison||!m.complete)){decision.state=c.calls<6?"working":"partial";decision.remaining_needs=["比较范围仍有未确认的论文或维度"];}
  w.tracker=tracker.snapshot();w.execution=decision;
  if(decision.state==="working"){w.phase="agent";w.citationRepair=answer.citationIssues.length?{answer:answer.original,claims:answer.attribution.filter(a=>a.unmatched_values.length).slice(0,12)}:undefined;w.warnings=[...new Set([...w.warnings,...answer.citationIssues])];if(answer.citationIssues.length)w.warnings.push("Attach each numerical claim or original block quote to its own valid citation. A cited source must contain the reported value; revise unsupported claims or state the gap.");return {};}
  return finishReadableTurn(w,c,answer,decision);
}


/** Reserve no extra budget; consolidation uses only the current task's remaining allowance. */
export function beginMemory(w:ResearchWorkflow,outcome:{answer?:string;status?:"completed"|"waiting_user"},calls:number,evidence:readonly Chunk[],enabled=true):boolean{
 if(w.memory||w.translation||w.cloudOnly||outcome.status!=="completed"||!outcome.answer||!evidence.length)return false;
 const cited=new Set([...outcome.answer.matchAll(/\[cite:([^\]\n]+)\]/g)].map(m=>m[1]));
 if(!evidence.some(s=>cited.has(s.chunk_id)))return false;
 w.memory={answer:outcome.answer,status:outcome.status,state:!enabled?"disabled":calls<6?"pending":"budget_exhausted"};
 if(!enabled||calls>=6)return false;w.phase="memory";return true;
}

/** Optional consolidation may fail without undoing a previously completed research answer. */
export function skipMemory(w:ResearchWorkflow,state:"failed"|"budget_exhausted"){if(w.phase!=="memory"||!w.memory)return;w.memory.state=state;w.phase="finished";return {answer:w.memory.answer,status:w.memory.status};}
