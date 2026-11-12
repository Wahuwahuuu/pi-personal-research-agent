import {test} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initialState,submit} from "../src/domain.ts";
import {deletionImpact,removeConversationContent} from "../src/deletion-lineage.ts";
import {DeletionStore} from "../src/deletion.ts";
import {Artifacts} from "../src/artifacts.ts";
import {StateRepository,type StateStorage} from "../src/state-store.ts";
import {Workspace} from "../src/workspace.ts";
import {DomainMemory} from "../packages/research/internal/agent/domain-memory.ts";
import {cloudMemory,newCloudMemory,recordMemoryInputs} from "../packages/research/cloud-memory.ts";
function setup(){
 const db=new DatabaseSync(":memory:");let depth=0;
 const p:StateStorage={sql:{exec<T>(q:string,...b:any[]){const s=db.prepare(q),v=(s.columns().length?s.all(...b):(s.run(...b),[])) as T[];return{toArray:()=>v};}},transactionSync<T>(fn:()=>T){if(depth)return fn();db.exec("BEGIN");depth++;try{const r=fn();db.exec("COMMIT");return r;}catch(e){db.exec("ROLLBACK");throw e;}finally{depth--;}}};
 return{db,p};
}
test("three-hop deletion removes persisted derived copies and edited artifacts while independent user history survives",()=>{
 const f=setup(),repo=new StateRepository(f.p),s=repo.load(),deletions=new DeletionStore(f.p),artifacts=new Artifacts(f.p),workspace=new Workspace(f.p);
 try{
  const make=(name:string,conversationId:string,sessionId:string)=>{
   const t=submit(s,name,name,"research");Object.assign(t,{conversationId,sessionId,calls:2,status:"completed",answer:"DERIVED_PRIVATE_CANARY",preview:"DERIVED_PRIVATE_CANARY"});
   return t;
  };
  const root=make("SOURCE_PRIVATE_TEXT","root","10"),safe=make("independent user question","child","20"),child=make("follow-up user question","child","20"),leaf=make("third user question","leaf","30"),later=make("later user question","child","20");
  safe.answer="INDEPENDENT_ANSWER";safe.preview=undefined;
  const domain=new DomainMemory("index").state;
  domain.conclusions=[{source_turn:child.id,text:"DERIVED_PRIVATE_CANARY"} as any];
  domain.unresolved_questions=[{source_turn:child.id,text:"DERIVED_PRIVATE_CANARY"} as any];
  domain.pending_inferences=[{source_turn:child.id,text:"DERIVED_PRIVATE_CANARY"} as any];
  domain.reading_notes=[{source_turn:child.id,answer_excerpt:"DERIVED_PRIVATE_CANARY"} as any];
  domain.user_constraints=[{source_turn:child.id,value:"DERIVED_PRIVATE_CANARY"} as any];
  domain.current_paper={paper_id:"paper",source_turn:child.id};domain.object_source_turn=child.id;domain.comparison_dimensions=["DERIVED_PRIVATE_CANARY"];
  s.conversations=[["root","10"],["child","20"],["leaf","30"]].map(([id,sessionId])=>({id,sessionId,projectId:"default",scope:[],title:id,created:0,history:s.tasks.filter(t=>t.conversationId===id).map(t=>({turn_id:t.id,user_text:t.input,final_answer:t.answer!})),...(id==="child"?{domain}:{})}));
  s.cloudMemory=newCloudMemory();
  s.cloudMemory.entries=[root,child,leaf].map((t,i)=>({id:"m"+i,kind:"reading",slot:"slot"+i,projectId:"default",paper_ids:[],content:"DERIVED_PRIVATE_CANARY",source_session:t.conversationId!,source_turn:t.id,created_at:"",updated_at:"",edited:i===2}));
  s.cloudMemory.entries.push({id:"independent",kind:"preference",slot:"independent",paper_ids:[],content:"INDEPENDENT_MEMORY",source_session:"",source_turn:"",created_at:"",updated_at:"",edited:true});
  recordMemoryInputs(s.cloudMemory,child.id,["m0"],[]);
  recordMemoryInputs(s.cloudMemory,leaf.id,["m1"],[]);
  s.memories=s.cloudMemory.entries.map(m=>({id:m.id,content:m.content,source:m.source_session,updated:0}));
  child.workflow={phase:"memory",warnings:[],candidate:"DERIVED_PRIVATE_CANARY",memory:{answer:"DERIVED_PRIVATE_CANARY",status:"completed",state:"saved"}};
  child.goal={maxSegments:4,segments:[{index:1,started:0,calls:0,tools:0,activeMs:0,checkpoint:{saved:0,reason:"done",phase:"memory",answer:"DERIVED_PRIVATE_CANARY",remaining:["DERIVED_PRIVATE_CANARY"],evidenceIds:[]}}]};
  s.operations=[root,child,leaf].map(t=>({deliveryVersion:1,id:"op-"+t.id,taskId:t.id,tool:"retrieve_chunks",params:{query:"DERIVED_PRIVATE_CANARY"},indexVersion:"index",state:"done",deadline:0,result:{text:"DERIVED_PRIVATE_CANARY"}}));
  const a=artifacts.create({projectId:"default",conversationId:"child",taskId:child.id,kind:"reading",title:"Derived result",partial:false},"DERIVED_PRIVATE_CANARY",[]);
  workspace.once("edit","artifact:"+a.id,{content:"DERIVED_PRIVATE_CANARY"},()=>artifacts.revise(a.id,1,"DERIVED_PRIVATE_CANARY"));
  const unrelated=artifacts.create({projectId:"default",conversationId:"child",taskId:safe.id,kind:"reading",title:"Independent",partial:false},"INDEPENDENT_ARTIFACT",[]);
  for(const op of s.operations)deletions.custody.dispatch(op,"original-device");
  repo.save(s);deletions.request(s,"root");
  assert.equal(s.cloudMemory.entries.length,1);assert.equal(deletions.blocksConversation("child"),true);
  deletions.fail("root","PI_DELETE_SCHEMA_MISMATCH");
  assert.equal(deletions.blocksConversation("child"),true);assert.equal(deletions.blocksConversation("independent"),false);
  assert.equal(s.cloudMemory.entries[0].content,"INDEPENDENT_MEMORY");
  deletions.request(s,"root");
  // Reopen the deletion store to prove the closure survives losing its in-memory source.
  const reopened=new DeletionStore(f.p),impact=reopened.capture(s,"root");
  assert.ok(impact.turns.includes(leaf.id)&&impact.turns.includes(later.id));assert.ok(!impact.turns.includes(safe.id));
  assert.deepEqual(new Set(impact.sessions),new Set(["10","20","30"]));
  for(const id of artifacts.deleteTasks(impact.turns))workspace.forgetEntity(id);
  removeConversationContent(s,"root",impact);repo.save(s);reopened.cloudDone("root");
  const persisted=repo.load();
  assert.ok(!JSON.stringify(persisted).includes("DERIVED_PRIVATE_CANARY"));assert.ok(!JSON.stringify(persisted).includes("SOURCE_PRIVATE_TEXT"));
  assert.ok(persisted.conversations!.find(c=>c.id==="child")!.history.some(h=>h.user_text==="follow-up user question"&&h.final_answer===""));
  assert.equal(persisted.tasks.find(t=>t.id===child.id)!.calls,2);assert.equal(persisted.tasks.find(t=>t.id===child.id)!.error,"CONTEXT_SOURCE_DELETED");
  assert.equal(persisted.tasks.find(t=>t.id===safe.id)!.answer,"INDEPENDENT_ANSWER");assert.equal(persisted.conversations!.find(c=>c.id==="child")!.sessionId,undefined);
  assert.equal(persisted.cloudMemory!.entries[0].content,"INDEPENDENT_MEMORY");
  assert.equal(artifacts.get(unrelated.id).content,"INDEPENDENT_ARTIFACT");assert.throws(()=>artifacts.get(a.id));
  assert.ok(!JSON.stringify(f.db.prepare("SELECT * FROM pra_mutations").all()).includes("DERIVED_PRIVATE_CANARY"));
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM pra_artifact_versions WHERE id=?").get(a.id)!.n,0);
  assert.equal(reopened.blocksConversation("child"),false);
  assert.equal(reopened.get("root")!.status,"cloud_complete");for(const id of impact.operations)assert.equal(reopened.deletedOperation(id),true);
  reopened.localDone("root",impact.operations,"original-device");assert.equal(reopened.get("root")!.status,"completed");
  assert.equal(reopened.request(persisted,"root").status,"completed");
 }finally{f.db.close();}
});
test("memory consumption freezes the source turn before its slot is overwritten",async()=>{
 const s=initialState();s.cloudMemory=newCloudMemory();
 const root=submit(s,"root","root","chat"),child=submit(s,"child","child","chat");root.conversationId="a";child.conversationId="b";
 const memory=cloudMemory(s.cloudMemory,[],"owner");
 const first=await memory.save({content:"Original",kind:"note",slot:"shared",source_session:"a",source_turn:root.id});
 recordMemoryInputs(s.cloudMemory,child.id,[first.id],[]);
 await memory.save({content:"Replacement",kind:"note",slot:"shared",source_session:"b",source_turn:child.id});
 assert.ok(s.cloudMemory.dependencies![child.id].turns.includes(root.id));
 assert.equal(s.cloudMemory.entries[0].source_turn,child.id);
 const impact=deletionImpact(s,"a");assert.ok(impact.turns.includes(child.id));assert.ok(impact.memories.includes(first.id));
 removeConversationContent(s,"a",impact);assert.equal(s.cloudMemory.entries.length,0);
 await assert.rejects(memory.save({content:"Replay",kind:"note",slot:"different",source_session:"b",source_turn:child.id}));
 assert.equal(s.cloudMemory.entries.length,0);
});
test("unversioned historical memory dependencies are conservatively removed, not mistaken for independent turns",()=>{
 const s=initialState(),root=submit(s,"root","r","chat",100),legacy=submit(s,"legacy question","l","chat",200),safe=submit(s,"independent question","s","chat",200);
 root.conversationId="a";root.calls=1;legacy.conversationId="b";safe.conversationId="c";legacy.answer="old derived";
 s.cloudMemory={...newCloudMemory(),dependencies:{[legacy.id]:{memories:["overwritten-id"],turns:[]},[safe.id]:{memories:["independent-id"],turns:[],lineageVersion:1}}};
 const impact=deletionImpact(s,"a");assert.ok(impact.turns.includes(legacy.id));assert.ok(!impact.turns.includes(safe.id));
 removeConversationContent(s,"a",impact);assert.equal(legacy.input,"legacy question");assert.equal(legacy.answer,undefined);assert.ok(s.tasks.includes(safe));
});
