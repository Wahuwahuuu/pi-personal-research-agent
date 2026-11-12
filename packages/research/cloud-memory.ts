import {createHash} from "node:crypto";
import {LongTermMemory,type LongMemoryEntry} from "./internal/agent/memory-service.ts";
import type {Paper,WorkerTransport} from "./internal/agent/contracts.ts";
export {memoryProjection} from "./internal/agent/memory-service.ts";
export interface MemorySource {paper_id:string;paragraph_id:string;chunk_id:string;index_version:string;section:string;quote:string;quote_start:number;quote_end:number;source_start:number;source_end:number;source_text_sha256:string}
export interface CloudMemoryEntry extends LongMemoryEntry {
 projectId?:string;category?:"preference"|"constraint"|"conclusion"|"question"|"reading";
 sources?:MemorySource[];sourceStatus?:"verified"|"stale"|"unavailable"|"needs_review";semanticStatus?:"unreviewed"|"user_modified";active?:boolean;
}
export interface CloudMemoryOptions {projectId?:string;recall?:(query:string,papers:readonly string[],preferencesOnly:boolean,recent:boolean)=>CloudMemoryEntry[]}
const tombstoneSlot=(e:{slot:string;projectId?:string})=>(e.projectId?e.projectId+":":"")+e.slot;
export interface CloudMemoryState {
  entries:CloudMemoryEntry[]; deletedSlots:string[]; enabled:boolean; invalidatedTurns?:string[];
  dependencies?:Record<string,{memories:string[];turns:string[];lineageVersion?:1}>;
}
export const newCloudMemory=():CloudMemoryState=>({entries:[],deletedSlots:[],enabled:true});
/** Conservative lineage tracks inputs, never hidden reasoning or a second copy of content. */
export function recordMemoryInputs(state:CloudMemoryState,turn:string,ids:readonly string[],turns:readonly string[]){
 const d=state.dependencies??={};const prior=d[turn];
 const sources=state.entries.filter(e=>ids.includes(e.id)).map(e=>e.source_turn).filter(Boolean);
 d[turn]={memories:[...new Set([...(prior?.memories??[]),...ids])],turns:[...new Set([...(prior?.turns??[]),...turns,...sources].filter(id=>id!==turn))],lineageVersion:prior&&prior.lineageVersion!==1?undefined:1};
}
export function invalidateMemoryInputs(state:CloudMemoryState,memoryIds:readonly string[],sourceTurns:readonly string[],preserve:readonly string[]=[]){
 const ids=new Set(memoryIds),turns=new Set([...(state.invalidatedTurns??[]),...sourceTurns]),keep=new Set(preserve);
 let changed=true;while(changed){changed=false;
  for(const [turn,input]of Object.entries(state.dependencies??{}))if(!turns.has(turn)&&(input.memories.some(id=>ids.has(id))||input.turns.some(id=>turns.has(id)))){turns.add(turn);changed=true;}
  for(const entry of state.entries)if(!keep.has(entry.id)&&!entry.edited&&turns.has(entry.source_turn)&&!sourceTurns.includes(entry.source_turn)&&!ids.has(entry.id)){ids.add(entry.id);changed=true;}
 }
 const removed=state.entries.filter(e=>ids.has(e.id)&&!keep.has(e.id));
 state.entries=state.entries.filter(e=>!removed.includes(e));state.invalidatedTurns=[...turns];
 state.deletedSlots=[...new Set([...state.deletedSlots,...removed.map(tombstoneSlot)])];
 return removed.map(e=>e.id);
}
/** Cloud host persists this state atomically. Ranking is bounded lexical/recent retrieval, not Qdrant vectors. */
export function cloudMemory(state:CloudMemoryState,papers:readonly Paper[],owner:string,secrets:readonly string[]=[],options:CloudMemoryOptions={}){
 const save=(input:any):CloudMemoryEntry|undefined=>{
  if(!input||typeof input.content!=="string"||!input.content.trim()||input.content.length>4800)throw Error("INVALID_MEMORY");
  const projectId=input.kind==="preference"?undefined:input.projectId??options.projectId;
  const prior=state.entries.find(e=>input.id?e.id===input.id:e.slot===input.slot&&e.projectId===projectId);
  if(input.id&&!prior)throw Error("UNKNOWN_MEMORY");
  const slot=input.slot??prior?.slot??"manual:"+createHash("sha256").update(input.content).digest("hex");
  if(!input.edited&&((state.deletedSlots.includes(slot)||state.deletedSlots.includes(tombstoneSlot({slot,projectId:prior?.projectId??projectId})))||prior?.edited))return prior;
  if(input.edited)state.deletedSlots=state.deletedSlots.filter(s=>s!==tombstoneSlot({slot,projectId:prior?.projectId??projectId}));
  if(input.edited&&prior)invalidateMemoryInputs(state,[prior.id],prior.source_turn?[prior.source_turn]:[],[prior.id]);
  if(!input.edited&&input.source_turn&&state.invalidatedTurns?.includes(input.source_turn))return prior;
  const now=new Date().toISOString();
  const entry:CloudMemoryEntry={id:prior?.id??crypto.randomUUID(),kind:input.kind??prior?.kind??"note",content:input.content,paper_ids:input.paper_ids??prior?.paper_ids??[],source_session:input.source_session??prior?.source_session??"",source_turn:input.source_turn??prior?.source_turn??"",created_at:prior?.created_at??now,updated_at:now,slot,edited:input.edited??prior?.edited??false,
   projectId:prior?.projectId??projectId,category:input.category??prior?.category??(input.kind==="preference"?"preference":input.kind==="reading"?"reading":"constraint"),
   sources:input.sources??prior?.sources,sourceStatus:input.edited&&prior?.sources?.length?"needs_review":input.sourceStatus??prior?.sourceStatus,
   semanticStatus:input.edited&&prior?.sources?.length?"user_modified":input.semanticStatus??prior?.semanticStatus,active:input.active??prior?.active??true};
  if(!prior&&state.entries.length>=1000)throw Error("MEMORY_CAPACITY");
  state.entries=state.entries.filter(e=>e.id!==entry.id).concat(entry);
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
    if(options.recall)return {entries:options.recall(String(params.query??""),Array.isArray(params.paper_ids)?params.paper_ids as string[]:[],Boolean(params.preferences_only),Boolean(params.recent_reading))};
    const ids=Array.isArray(params.paper_ids)?params.paper_ids:[],q=String(params.query??"").toLocaleLowerCase(),words=q.match(/[\p{L}\p{N}]{2,}/gu)??[];
    const entries=state.entries.filter(e=>e.active!==false&&(!options.projectId||!e.projectId||e.projectId===options.projectId)&&(!params.preferences_only||e.kind==="preference")&&(!ids.length||!e.paper_ids.length||e.paper_ids.some(id=>ids.includes(id))));
    entries.sort((a,b)=>{
      const score=(e:LongMemoryEntry)=>(e.kind==="preference"?100:0)+(params.recent_reading&&e.kind==="reading"?50:0)+words.filter(w=>e.content.toLocaleLowerCase().includes(w)).length;
      return score(b)-score(a)||b.updated_at.localeCompare(a.updated_at);
    });return {entries:entries.slice(0,20)};
   }
   case "upsert": return {entry:save(params.entry)};
   case "upsert_batch":return {entries:(params.entries as unknown[]).slice(0,20).map(save).filter(Boolean)};
   case "delete": case "delete_session": case "clear":{
     const remove=state.entries.filter(e=>params.action==="clear"||params.action==="delete"&&e.id===params.id||params.action==="delete_session"&&e.source_session===params.source_session);
     invalidateMemoryInputs(state,remove.map(e=>e.id),remove.map(e=>e.source_turn).filter(Boolean));return {ok:true};
   }
   default:throw Error("INVALID_MEMORY_ACTION");
  }
 }} as WorkerTransport;
 return new LongTermMemory(worker,owner,papers,secrets,state.enabled);
}
