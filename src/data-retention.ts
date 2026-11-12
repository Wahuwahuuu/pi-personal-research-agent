import {createHash} from "node:crypto";
import {Problem,TASK_CAPACITY,type State} from "./domain.ts";
import {deletionImpact,type DeletionImpact} from "./deletion-lineage.ts";
const finished=new Set(["completed","failed","cancelled"]);
export interface RetentionCandidate {id:string;title:string;lastActivity:number;tasks:number;}
export interface RetentionPreview {id:string;title:string;days:number;fingerprint:string;tasks:number;memories:number;relatedConversations:number;localOperations:number;}
function daysValue(days:number){if(!Number.isSafeInteger(days)||days<0||days>3650)throw new Problem("INVALID_RETENTION_PERIOD");}
function metadata(state:State){
 const activity=new Map<string,{last:number;tasks:number;unfinished:boolean}>();
 for(const t of state.tasks){if(!t.conversationId)continue;const v=activity.get(t.conversationId)??{last:0,tasks:0,unfinished:false};v.last=Math.max(v.last,t.updated??t.created);v.tasks++;v.unfinished ||= !finished.has(t.status)||!!t.runOpen;activity.set(t.conversationId,v);}
 return activity;
}
export function retentionCandidates(state:State,options:{days?:number;after?:string;limit?:number}={},blocked:(id:string)=>boolean=()=>false,now=Date.now()){
 const days=options.days??180,limit=options.limit??20;daysValue(days);
 if(!Number.isInteger(limit)||limit<1||limit>50)throw new Problem("INVALID_PAGE");
 let cursor:[number,string]|undefined;
 if(options.after){try{const v=JSON.parse(options.after);if(!Array.isArray(v)||v.length!==2||!Number.isSafeInteger(v[0])||v[0]<0||typeof v[1]!=="string"||v[1].length>512)throw Error();cursor=[v[0],v[1]];}catch{throw new Problem("INVALID_CURSOR");}}
 const activity=metadata(state),cutoff=now-days*86400000,items:RetentionCandidate[]=[];
 for(const c of state.conversations??[]){
  if(!c.archived||c.pinned)continue;const t=activity.get(c.id),lastActivity=Math.max(c.updated??c.created,t?.last??0);
  if(lastActivity>=cutoff||t?.unfinished||blocked(c.id))continue;
  items.push({id:c.id,title:c.title,lastActivity,tasks:t?.tasks??0});
 }
 items.sort((a,b)=>a.lastActivity-b.lastActivity||(a.id<b.id?-1:a.id>b.id?1:0));
 const remaining=cursor?items.filter(v=>v.lastActivity>cursor![0]||v.lastActivity===cursor![0]&&v.id>cursor![1]):items,page=remaining.slice(0,limit),last=page.at(-1);
 return {items:page,nextCursor:remaining.length>limit&&last?JSON.stringify([last.lastActivity,last.id]):null,days,eligible:items.length,
  usage:{tasks:state.tasks.length,taskLimit:TASK_CAPACITY,nearTaskLimit:state.tasks.length>=4000,conversations:state.conversations?.length??0},policy:"manual-archived-conversations" as const};
}
export function retentionPreview(state:State,id:string,days:number,blocked:(id:string)=>boolean=()=>false,now=Date.now()):RetentionPreview{
 daysValue(days);
 const c=state.conversations?.find(c=>c.id===id),m=metadata(state).get(id);
 if(!c||!c.archived||c.pinned||Math.max(c.updated??c.created,m?.last??0)>=now-days*86400000||m?.unfinished||blocked(id))throw new Problem("RETENTION_NOT_ELIGIBLE",409);
 const impact=deletionImpact(state,id);
 if((state.conversations??[]).some(v=>impact.conversations.includes(v.id)&&(v.pinned||blocked(v.id)))||
 state.tasks.some(t=>impact.conversations.includes(t.conversationId??"")&&(!finished.has(t.status)||t.runOpen)))throw new Problem("RETENTION_RELATED_BUSY",409);
 return {id,title:c.title,days,fingerprint:impactFingerprint(state,c,impact),tasks:impact.turns.length,memories:new Set([...impact.memories,...state.memories.filter(m=>m.source===id).map(m=>m.id)]).size,relatedConversations:impact.conversations.filter(v=>v!==id).length,localOperations:impact.operations.length};
}
function impactFingerprint(state:State,c:NonNullable<State["conversations"]>[number],impact:DeletionImpact){
 return createHash("sha256").update(JSON.stringify({id:c.id,title:c.title,updated:c.updated??c.created,scope:c.scope,project:c.projectId,impact,
  tasks:state.tasks.filter(t=>impact.conversations.includes(t.conversationId??"")).map(t=>[t.id,t.updated??t.created,t.status,t.calls,t.sessionId]),
  legacyMemories:state.memories.filter(m=>m.source===c.id).map(m=>[m.id,m.updated,m.content]),
  memories:(state.cloudMemory?.entries??[]).filter(m=>impact.memories.includes(m.id)).map(m=>[m.id,m.updated_at,m.content])
 })).digest("hex");
}
export function confirmRetention(state:State,id:string,days:number,fingerprint:string,blocked:(id:string)=>boolean=()=>false,now=Date.now()){
 const preview=retentionPreview(state,id,days,blocked,now);if(preview.fingerprint!==fingerprint)throw new Problem("RETENTION_CHANGED",409);return preview;
}
