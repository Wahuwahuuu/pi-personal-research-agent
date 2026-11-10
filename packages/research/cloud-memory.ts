import {createHash} from "node:crypto";
import {LongTermMemory,type LongMemoryEntry} from "./internal/agent/memory-service.ts";
import type {Paper,WorkerTransport} from "./internal/agent/contracts.ts";
export {memoryProjection} from "./internal/agent/memory-service.ts";
export interface CloudMemoryState {
  entries:LongMemoryEntry[]; deletedSlots:string[]; enabled:boolean; invalidatedTurns?:string[];
}
export const newCloudMemory=():CloudMemoryState=>({entries:[],deletedSlots:[],enabled:true});
/** Cloud host persists this state atomically. Ranking is bounded lexical/recent retrieval, not Qdrant vectors. */
export function cloudMemory(state:CloudMemoryState,papers:readonly Paper[],owner:string,secrets:readonly string[]=[]){
 const save=(input:any):LongMemoryEntry|undefined=>{
  if(!input||typeof input.content!=="string"||!input.content.trim()||input.content.length>4800)throw Error("INVALID_MEMORY");
  const prior=state.entries.find(e=>input.id?e.id===input.id:e.slot===input.slot);
  if(input.id&&!prior)throw Error("UNKNOWN_MEMORY");
  const slot=input.slot??prior?.slot??"manual:"+createHash("sha256").update(input.content).digest("hex");
  if(!input.edited&&(state.deletedSlots.includes(slot)||prior?.edited))return prior;
  if(input.edited)state.deletedSlots=state.deletedSlots.filter(s=>s!==slot);
  if(input.edited&&prior?.source_turn)state.invalidatedTurns=[...new Set([...(state.invalidatedTurns??[]),prior.source_turn])];
  const now=new Date().toISOString();
  const entry:LongMemoryEntry={id:prior?.id??crypto.randomUUID(),kind:input.kind??prior?.kind??"note",content:input.content,paper_ids:input.paper_ids??prior?.paper_ids??[],source_session:input.source_session??prior?.source_session??"",source_turn:input.source_turn??prior?.source_turn??"",created_at:prior?.created_at??now,updated_at:now,slot,edited:input.edited??prior?.edited??false};
  state.entries=state.entries.filter(e=>e.id!==entry.id).concat(entry);
  if(state.entries.length>1000)throw Error("MEMORY_CAPACITY");
  return entry;
 };
 const worker={memoryOperation:async(params:Record<string,unknown>)=>{
  if(params.owner!==owner)throw Error("OWNER_MISMATCH");
  switch(params.action){
   case "list": {
    const sorted=[...state.entries].sort((a,b)=>a.id.localeCompare(b.id)),after=params.cursor?sorted.findIndex(e=>e.id===params.cursor)+1:0,page=sorted.slice(after,after+100);
    return {backend:"cloud-sqlite",entries:page,next_cursor:after+100<sorted.length?page.at(-1)!.id:null,total:sorted.length};
   }
   case "recall":{
    const ids=Array.isArray(params.paper_ids)?params.paper_ids:[],q=String(params.query??"").toLocaleLowerCase(),words=q.match(/[\p{L}\p{N}]{2,}/gu)??[];
    const entries=state.entries.filter(e=>(!params.preferences_only||e.kind==="preference")&&(!ids.length||!e.paper_ids.length||e.paper_ids.some(id=>ids.includes(id))));
    entries.sort((a,b)=>{
      const score=(e:LongMemoryEntry)=>(e.kind==="preference"?100:0)+(params.recent_reading&&e.kind==="reading"?50:0)+words.filter(w=>e.content.toLocaleLowerCase().includes(w)).length;
      return score(b)-score(a)||b.updated_at.localeCompare(a.updated_at);
    });return {entries:entries.slice(0,20)};
   }
   case "upsert": return {entry:save(params.entry)};
   case "upsert_batch":return {entries:(params.entries as unknown[]).slice(0,20).map(save).filter(Boolean)};
   case "delete": case "delete_session": case "clear":{
     const remove=state.entries.filter(e=>params.action==="clear"||params.action==="delete"&&e.id===params.id||params.action==="delete_session"&&e.source_session===params.source_session);
     state.invalidatedTurns=[...new Set([...(state.invalidatedTurns??[]),...remove.map(e=>e.source_turn).filter(Boolean)])];
     state.deletedSlots=[...new Set([...state.deletedSlots,...remove.map(e=>e.slot)])];
     state.entries=state.entries.filter(e=>!remove.includes(e));return {ok:true};
   }
   default:throw Error("INVALID_MEMORY_ACTION");
  }
 }} as WorkerTransport;
 return new LongTermMemory(worker,owner,papers,secrets,state.enabled);
}
