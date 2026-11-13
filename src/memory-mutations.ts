import {Problem,text,type State} from "./domain.ts";
import type {Workspace} from "./workspace.ts";
import type {cloudMemory} from "../packages/research/cloud-memory.ts";
type MemoryService=ReturnType<typeof cloudMemory>;
export type MemoryMutation={kind:"save";body:Record<string,unknown>}|{kind:"delete";id:string;body:Record<string,unknown>};
interface Ports {workspace:Workspace;state:State;service:(projectId?:string)=>MemoryService;save:()=>void}
/** The host must serialize this short in-memory operation and reload its caches on failure.
 * The reused service performs validation without network I/O. SQL commits stay synchronous. */
export async function mutateMemory(p:Ports,action:MemoryMutation){
 const b=action.body,key=b.requestId===undefined?crypto.randomUUID():text(b.requestId,128);
 const operation=action.kind==="save"?"memory:save":"memory:delete:"+text(action.id,128);
 const current=(id:string)=>{const e=p.state.cloudMemory!.entries.find(e=>e.id===id);if(!e)throw new Problem("RESOURCE_DELETED",410);return e;};
 const old=p.workspace.replay<{id:string}|{ok:true}>(key,operation,b);
 if(old)return "id" in old.value?current(old.value.id):old.value;
 const before=new Set(p.state.cloudMemory!.entries.map(e=>e.id));
 const commit=()=>{
  const remaining=new Set(p.state.cloudMemory!.entries.map(e=>e.id));
  for(const id of before)if(!remaining.has(id))p.workspace.forgetEntity(id);
  p.save();
 };
 if(action.kind==="delete"){
  if(!before.has(action.id))throw new Problem("NOT_FOUND",404);
  await p.service().remove(action.id);
  return p.workspace.once(key,operation,b,()=>{commit();return{ok:true as const};});
 }
 const id=b.id===undefined?undefined:text(b.id,128),prior=id?p.state.cloudMemory!.entries.find(e=>e.id===id):undefined;
 if(id&&!prior)throw new Problem("NOT_FOUND",404);
 const projectId=prior?.projectId??(typeof b.projectId==="string"?p.workspace.getProject(b.projectId).id:undefined);
 if(b.category!==undefined&&!["preference","constraint","conclusion","question"].includes(b.category as string))throw new Problem("INVALID_MEMORY_CATEGORY");
 if(b.category==="conclusion"&&!prior?.sources?.length)throw new Problem("EVIDENCE_REQUIRED");
 const saved=await p.service(projectId).save({id,kind:prior?.kind??(b.category==="preference"?"preference":"note"),category:b.category??prior?.category??"constraint",paper_ids:prior?.paper_ids??[],content:text(b.content,1200),edited:true} as Parameters<MemoryService["save"]>[0]);
 const receipt=p.workspace.once(key,operation,b,()=>{commit();return{id:saved.id};});
 // Receipts never retain old content. Replays expose the latest value or a deletion marker.
 return current(receipt.id);
}
