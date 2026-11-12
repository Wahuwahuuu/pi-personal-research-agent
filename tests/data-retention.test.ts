import {test} from "node:test";import assert from "node:assert/strict";
import {initialState,submit} from "../src/domain.ts";
import {retentionCandidates,retentionPreview,confirmRetention} from "../src/data-retention.ts";
const now=400*86400000;
function setup(){const s=initialState(),t=submit(s,"source","source","research");Object.assign(t,{conversationId:"source",status:"completed",created:1,updated:2,calls:1});s.conversations=[{id:"source",title:"Archived research",projectId:"p",scope:[],created:1,updated:2,archived:true,history:[{turn_id:t.id,user_text:"q",final_answer:"a"}]}];return{s,t};}
test("retention lists only aged archived finished conversations without reading task or history bodies",()=>{
 const {s,t}=setup();Object.defineProperty(t,"answer",{get(){throw Error("BODY_READ");}});Object.defineProperty(s.conversations![0],"history",{get(){throw Error("HISTORY_READ");}});
 assert.equal(retentionCandidates(s,{days:180},()=>false,now).items.length,1);
 for(const status of ["queued","waiting_device","waiting_user","paused","running"] as const){t.status=status;assert.equal(retentionCandidates(s,{},()=>false,now).eligible,0);}t.status="completed";
 s.conversations![0].pinned=true;assert.equal(retentionCandidates(s,{},()=>false,now).eligible,0);s.conversations![0].pinned=false;
 assert.equal(retentionCandidates(s,{},()=>true,now).eligible,0);t.updated=now;assert.equal(retentionCandidates(s,{},()=>false,now).eligible,0);
});
test("retention cursor is stable for equal dates, excludes newer activity and rejects malformed paging",()=>{
 const {s}=setup();s.tasks=[];s.conversations=Array.from({length:53},(_,i)=>({id:String(i).padStart(3,"0"),title:"Archived",projectId:"p",scope:[],created:1,archived:true,history:[]}));
 const seen:string[]=[];let after:string|undefined;do{const p=retentionCandidates(s,{days:180,after,limit:7},()=>false,now);seen.push(...p.items.map(x=>x.id));after=p.nextCursor??undefined;}while(after);assert.equal(new Set(seen).size,53);assert.deepEqual(seen,[...seen].sort());
 for(const options of [{days:-1},{days:NaN},{limit:0},{after:"[0]"}])assert.throws(()=>retentionCandidates(s,options,()=>false,now));
});
test("deletion preview uses existing lineage and requires a fresh unchanged fingerprint",()=>{
 const {s,t}=setup(),p=retentionPreview(s,"source",180,()=>false,now);
 assert.equal(p.tasks,1);assert.equal(p.relatedConversations,0);assert.deepEqual(confirmRetention(s,"source",180,p.fingerprint,()=>false,now),p);
 t.updated=3;assert.throws(()=>confirmRetention(s,"source",180,p.fingerprint,()=>false,now),/RETENTION_CHANGED/);
 s.conversations![0].archived=false;assert.throws(()=>retentionPreview(s,"source",180,()=>false,now),/RETENTION_NOT_ELIGIBLE/);
});
test("a derived conversation with unfinished work or a pin blocks retention, completed derived data is disclosed",()=>{
 const {s,t}=setup(),derived=submit(s,"derived","derived","research");Object.assign(derived,{conversationId:"child",created:3,updated:4,status:"completed",calls:1});
 s.conversations!.push({id:"child",title:"Other research",projectId:"p",scope:[],created:3,history:[{turn_id:derived.id,user_text:"followup",final_answer:"derived answer"}]});
 s.cloudMemory={enabled:true,entries:[],deletedSlots:[],dependencies:{[derived.id]:{memories:[],turns:[t.id],lineageVersion:1}}};
 assert.equal(retentionPreview(s,"source",180,()=>false,now).relatedConversations,1);
 derived.status="waiting_user";assert.throws(()=>retentionPreview(s,"source",180,()=>false,now),/RETENTION_RELATED_BUSY/);derived.status="completed";
 s.conversations![1].pinned=true;assert.throws(()=>retentionPreview(s,"source",180,()=>false,now),/RETENTION_RELATED_BUSY/);
});
test("capacity reports actual task count and manual policy without changing any stored state",()=>{
 const {s}=setup();s.tasks=Array.from({length:4000},(_,i)=>({...s.tasks[0],id:String(i),requestId:String(i)}));
 const before=JSON.stringify(s),page=retentionCandidates(s,{},()=>false,now);
 assert.equal(page.usage.nearTaskLimit,true);assert.equal(page.usage.taskLimit,5000);assert.equal(page.policy,"manual-archived-conversations");assert.equal(JSON.stringify(s),before);
});

test("legacy explicit memories are included in impact counts and stale-preview protection",()=>{
 const {s}=setup();s.memories.push({id:"legacy",source:"source",content:"Explicit note",updated:1});
 const p=retentionPreview(s,"source",180,()=>false,now);assert.equal(p.memories,1);
 s.memories[0].content="Corrected note";s.memories[0].updated=2;
 assert.throws(()=>confirmRetention(s,"source",180,p.fingerprint,()=>false,now),/RETENTION_CHANGED/);
});
