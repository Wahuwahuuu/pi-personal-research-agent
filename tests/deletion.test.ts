import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { liveModels } from "../src/live-model.ts";
import { deletePiConversation, deleteConversationState, DeletionStore } from "../src/deletion.ts";
import {deletionImpact} from "../src/deletion-lineage.ts";
import { initialState, submit } from "../src/domain.ts";
import type { StateStorage } from "../src/state-store.ts";
function port(db:DatabaseSync):StateStorage {
 let depth=0;return {sql:{exec<T>(q:string,...b:any[]){const s=db.prepare(q),v=(s.columns().length?s.all(...b):(s.run(...b),[])) as T[];return{toArray:()=>v};}},
 transactionSync<T>(fn:()=>T){if(depth)return fn();db.exec("BEGIN");depth++;try{const r=fn();db.exec("COMMIT");return r;}catch(e){db.exec("ROLLBACK");throw e;}finally{depth--;}}};
}
test("real Pi SQLite transcript is removed; a separate conversation survives and runs after reopen",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"pra-delete-")),path=join(dir,"pi.sqlite");
 const models=liveModels({authorized:"explicitly-authorized",apiKey:"synthetic-key",baseUrl:"https://example.invalid/v1",modelId:"fixture"},()=>{},()=>{},(async()=>Response.json({choices:[{message:{content:"Synthetic response."}}],usage:{prompt_tokens:1,completion_tokens:1}})) as typeof fetch);
 const options={models,registry:createRegistry(),settings:{retry:{maxRetries:0},compaction:{enabled:false}}};
 let harness=await Harness.open(await openNodeSqliteStorage(path,{prefix:"pi_"}),options,context);
 try {
  const agent={model:{provider:"pra",modelId:"fixture"}};
  const a=await harness.createConversation({agent,ownership:{kind:"ownerless"}},context),b=await harness.createConversation({agent,ownership:{kind:"ownerless"}},context);
  await(await a.submit({type:"input",content:"DELETION_CANARY_ALPHA"},context)).wait(context);
  await(await b.submit({type:"input",content:"SURVIVING_BETA"},context)).wait(context);
  const derived=await harness.createConversation({agent,ownership:{kind:"ownerless"}},context);
  await(await derived.submit({type:"input",content:"DERIVED_PRIVATE_CANARY"},context)).wait(context);
  await harness.close(context);
  const db=new DatabaseSync(path),storage=port(db);
  const state=initialState(),root=submit(state,"source","source","chat"),child=submit(state,"follow-up","follow-up","chat");
  root.conversationId="source";root.sessionId=String(a.id);child.conversationId="child";child.sessionId=String(derived.id);
  state.conversations=[{id:"source",sessionId:String(a.id),projectId:"default",title:"source",scope:[],created:0,history:[]},{id:"child",sessionId:String(derived.id),projectId:"default",title:"child",scope:[],created:0,history:[]}];
  state.cloudMemory={enabled:true,entries:[],deletedSlots:[],dependencies:{[child.id]:{memories:[],turns:[root.id],lineageVersion:1}}};
  for(const session of deletionImpact(state,"source").sessions)deletePiConversation(storage,session);
  deletePiConversation(storage,String(a.id));
  assert.equal(db.prepare("SELECT id FROM pi_conversations WHERE id=?").all(derived.id).length,0);
  for(const row of db.prepare("SELECT record FROM pi_entries").all())assert.ok(!String(row.record).includes("DERIVED_PRIVATE_CANARY"));
  assert.equal(db.prepare("SELECT id FROM pi_conversations WHERE id=?").all(Number(a.id)).length,0);
  for(const table of ["pi_entries","pi_tasks","pi_submissions","pi_documents"]) {
    const all=JSON.stringify(db.prepare("SELECT record FROM "+table).all());
    assert.ok(!all.includes("DELETION_CANARY_ALPHA"),table);
  }
  assert.ok(JSON.stringify(db.prepare("SELECT record FROM pi_entries").all()).includes("SURVIVING_BETA"));
  db.exec("ALTER TABLE pi_entries ADD COLUMN unknown_field TEXT");
  assert.throws(()=>deletePiConversation(storage,String(b.id)),/SCHEMA_MISMATCH/);
  assert.equal(db.prepare("SELECT id FROM pi_conversations WHERE id=?").all(Number(b.id)).length,1);
  db.exec("ALTER TABLE pi_entries DROP COLUMN unknown_field");db.close();
  harness=await Harness.open(await openNodeSqliteStorage(path,{prefix:"pi_"}),options,context);
  assert.equal(await harness.conversation(a.id,context),undefined);
  const survivor=await harness.conversation(b.id,context);assert.ok(survivor);
  assert.equal((await(await survivor.submit({type:"input",content:"continue"},context)).wait(context)).status,"done");
 } finally {await harness.close(context);if(!resolve(dir).startsWith(resolve(tmpdir())+sep+"pra-delete-"))throw Error("INVALID_TEST_DIRECTORY");await rm(dir,{recursive:true,force:true});}
});
test("application deletion cancels tasks, removes derived memory and leaves durable operation tombstones until local purge",()=>{
 const db=new DatabaseSync(":memory:"),deletions=new DeletionStore(port(db)),s=initialState(),t=submit(s,"private","req","research");
 t.conversationId="c";s.conversations=[{id:"c",sessionId:"12",title:"private",projectId:"p",scope:[],created:0,history:[]}];
 s.operations=[{id:"op",taskId:t.id,tool:"search_papers",params:{query:"private"},indexVersion:"v",state:"pending",deadline:0}];
 s.cloudMemory={enabled:true,deletedSlots:[],entries:[{id:"m",slot:"reading:p",kind:"reading",content:"private",paper_ids:["p"],source_session:"c",source_turn:t.id,created_at:"",updated_at:"",edited:false}]};
 assert.equal(deletions.request(s,"c").status,"pending");assert.equal(t.status,"cancelled");
 deleteConversationState(s,"c");deletions.cloudDone("c");
 assert.equal(s.tasks.length,0);assert.equal(s.operations.length,0);assert.equal(s.cloudMemory.entries.length,0);
 assert.equal(deletions.get("c")!.status,"cloud_complete");assert.equal(deletions.deletedOperation("op"),true);
 deletions.localDone("c",["op"]);assert.equal(deletions.request(s,"c").status,"completed");db.close();
});
