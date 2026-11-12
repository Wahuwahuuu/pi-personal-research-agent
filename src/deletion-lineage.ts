import type { State, Task } from "./domain.ts";
export interface DeletionImpact {
  turns:string[]; memories:string[]; conversations:string[]; sessions:string[]; operations:string[];
}
export const emptyImpact=():DeletionImpact=>({turns:[],memories:[],conversations:[],sessions:[],operations:[]});
/** IDs only. Keep the closure durable before any source content is removed. */
export function deletionImpact(state:State,id:string,seed:DeletionImpact=emptyImpact()):DeletionImpact {
  const turns=new Set(seed.turns),memories=new Set(seed.memories),conversations=new Set([...seed.conversations,id]);
  const source=state.conversations?.find(c=>c.id===id);
  for(const t of state.tasks)if(t.conversationId===id)turns.add(t.id);
  for(const h of source?.history??[])turns.add(h.turn_id);
  // Older records stored mutable memory IDs without their source turns. They cannot
  // prove independence after an upsert, so conservatively redact later memory consumers.
  const sourceTimes=state.tasks.filter(t=>t.conversationId===id).map(t=>t.created);
  const since=sourceTimes.length?Math.min(...sourceTimes):source?.created??0;
  const hasSource=state.tasks.some(t=>t.conversationId===id&&t.calls>0)||!!source?.history.length||(state.cloudMemory?.entries??[]).some(m=>m.source_session===id);
  for(const [turn,input] of Object.entries(state.cloudMemory?.dependencies??{})){
    const task=state.tasks.find(t=>t.id===turn);
    if(hasSource&&input.lineageVersion!==1&&input.memories.length&&(!task||task.created>=since))turns.add(turn);
  }
  const entries=state.cloudMemory?.entries??[];
  for(const m of entries)if(m.source_session===id){memories.add(m.id);if(m.source_turn)turns.add(m.source_turn);}
  let changed=true;
  while(changed){
    changed=false;
    const add=(set:Set<string>,value:string)=>{if(value&&!set.has(value)){set.add(value);changed=true;}};
    for(const [turn,input] of Object.entries(state.cloudMemory?.dependencies??{}))
      if(input.memories.some(m=>memories.has(m))||input.turns.some(t=>turns.has(t)))add(turns,turn);
    for(const m of entries)if(turns.has(m.source_turn))add(memories,m.id);
    // Pi's transcript outlives the recent application projection. Later started turns
    // in that session are derived even when an older turn fell out of the recall window.
    for(const c of state.conversations??[]){
      const tasks=state.tasks.filter(t=>t.conversationId===c.id);
      const known=new Set(tasks.map(t=>t.id));
      let contaminated=c.history.some(h=>turns.has(h.turn_id)&&!known.has(h.turn_id));
      for(const t of tasks){
        if(turns.has(t.id))contaminated=true;
        if(contaminated&&(t.calls>0||t.sessionId||t.runOpen||c.history.some(h=>h.turn_id===t.id)))add(turns,t.id);
      }
      let historyContaminated=false;
      for(const h of c.history){if(turns.has(h.turn_id))historyContaminated=true;if(historyContaminated)add(turns,h.turn_id);}
    }
  }
  for(const c of state.conversations??[])if(c.history.some(h=>turns.has(h.turn_id))||state.tasks.some(t=>t.conversationId===c.id&&turns.has(t.id)))conversations.add(c.id);
  const sessions=new Set(seed.sessions),operations=new Set(seed.operations);
  for(const c of state.conversations??[])if(conversations.has(c.id)&&c.sessionId)sessions.add(c.sessionId);
  for(const t of state.tasks)if(t.conversationId&&conversations.has(t.conversationId)&&t.sessionId)sessions.add(t.sessionId);
  for(const o of state.operations)if(turns.has(o.taskId))operations.add(o.id);
  return {turns:[...turns],memories:[...memories],conversations:[...conversations],sessions:[...sessions],operations:[...operations]};
}
function redactTask(t:Task){
  const {id,requestId,input,kind,origin,created,calls,tools,activeMs,engine,conversationId,priority,amendments,goal}=t;
  // Whitelist user input and accounting; do not leave hidden copies in a new workflow field.
  for(const key of Object.keys(t))delete (t as any)[key];
  Object.assign(t,{id,requestId,input,kind,origin,created,calls,tools,activeMs,engine,conversationId,priority,amendments,
    updated:Date.now(),status:"cancelled",error:"CONTEXT_SOURCE_DELETED"});
  if(goal)t.goal={maxSegments:4,segments:goal.segments.map(({checkpoint,...s})=>s)};
}
/** Disable recall as soon as deletion is requested, including a later schema failure. */
export function invalidateDeletedSources(state:State,id:string,impact:DeletionImpact){
  const turns=new Set(impact.turns),memoryIds=new Set(impact.memories);
  if(state.cloudMemory){
    const removed=state.cloudMemory.entries.filter(m=>memoryIds.has(m.id)||turns.has(m.source_turn));
    state.cloudMemory.entries=state.cloudMemory.entries.filter(m=>!removed.includes(m));
    for(const m of removed)memoryIds.add(m.id);
    state.cloudMemory.deletedSlots=[...new Set([...state.cloudMemory.deletedSlots,...removed.map(m=>(m.projectId?m.projectId+":":"")+m.slot)])];
    state.cloudMemory.invalidatedTurns=[...new Set([...(state.cloudMemory.invalidatedTurns??[]),...turns])];
  }
  state.memories=state.memories.filter(m=>!memoryIds.has(m.id)&&m.source!==id);
}
/** Source conversation disappears; independent user messages in other conversations survive. */
export function removeConversationContent(state:State,id:string,impact=deletionImpact(state,id)){
  const turns=new Set(impact.turns),conversations=new Set(impact.conversations);
  const sourceTaskIds=new Set(state.tasks.filter(t=>t.conversationId===id).map(t=>t.id));
  const batchIds=new Set(state.tasks.filter(t=>turns.has(t.id)).map(t=>t.proactive?.batchId).filter(Boolean));
  invalidateDeletedSources(state,id,impact);
  state.conversations=state.conversations?.filter(c=>c.id!==id);
  for(const c of state.conversations??[]){
    if(conversations.has(c.id))delete c.sessionId;
    for(const h of c.history)if(turns.has(h.turn_id))h.final_answer="";
    const d=c.domain;if(!d)continue;
    d.user_constraints=d.user_constraints.filter(v=>!turns.has(v.source_turn));
    d.reading_notes=d.reading_notes?.filter(v=>!turns.has(v.source_turn));
    d.conclusions=d.conclusions.filter(v=>!turns.has(v.source_turn));
    d.pending_inferences=d.pending_inferences.filter(v=>!turns.has(v.source_turn));
    d.unresolved_questions=d.unresolved_questions.filter(v=>!turns.has(v.source_turn));
    if(d.current_paper&&turns.has(d.current_paper.source_turn))d.current_paper=null;
    if(d.object_source_turn&&turns.has(d.object_source_turn)){
      d.current_paper=null;d.object_source_turn=null;d.comparison_order=[];d.comparison_dimensions=[];
    }
  }
  state.tasks=state.tasks.filter(t=>!sourceTaskIds.has(t.id));
  for(const t of state.tasks){
    if(turns.has(t.id))redactTask(t);
    else if(t.conversationId&&conversations.has(t.conversationId))delete t.sessionId;
  }
  state.operations=state.operations.filter(o=>!turns.has(o.taskId));
  state.notices=state.notices.filter(n=>![...turns].some(t=>n.id==="task:"+t||n.id==="budget:"+t)&&!batchIds.has(n.batchId));
  return impact;
}
