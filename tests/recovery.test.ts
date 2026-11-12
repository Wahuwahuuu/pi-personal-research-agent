import {test} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync,backup} from "node:sqlite";
import {mkdtemp,copyFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve,sep} from "node:path";
import {Harness,createRegistry} from "@earendil-works/pi-durable";
import {openNodeSqliteStorage} from "@earendil-works/pi-durable/storage/sqlite/node";
import {BACKGROUND_CONTEXT as context} from "@earendil-works/chord/context";
import {liveModels} from "../src/live-model.ts";
import {StateRepository,type StateStorage} from "../src/state-store.ts";
import {initialState,submit} from "../src/domain.ts";
import {Workspace} from "../src/workspace.ts";
import {Artifacts} from "../src/artifacts.ts";
import {DeletionStore,deletePiConversation,deleteConversationState} from "../src/deletion.ts";
import {LibraryJobs} from "../src/library-jobs.ts";
import {ResearchBatches} from "../src/research-batches.ts";
import {ReaderRequests} from "../src/reader-requests.ts";
import {MemoryIndex} from "../src/memory-index.ts";
import {BudgetLedger} from "../src/budget.ts";
import {captureRecovery,applyRecovery,initRecovery,recoverySchema} from "../src/recovery-data.ts";
import {RecoveryStore,RECOVERY_LIMIT} from "../src/recovery-store.ts";
function port(db:DatabaseSync):StateStorage{let depth=0;return{sql:{exec<T>(q:string,...b:any[]){const s=db.prepare(q);const rows=(s.columns().length?s.all(...b):(s.run(...b),[])) as T[];return{toArray:()=>rows};}},transactionSync<T>(f:()=>T){if(depth)return f();db.exec("BEGIN");depth++;try{const r=f();db.exec("COMMIT");return r;}catch(e){db.exec("ROLLBACK");throw e;}finally{depth--;}}};}
function setup(db:DatabaseSync){
 const storage=port(db);initRecovery(storage);const repository=new StateRepository(storage),state=initialState(),workspace=new Workspace(storage);workspace.migrate(state);
 const artifacts=new Artifacts(storage),deletions=new DeletionStore(storage);new LibraryJobs(storage);new ResearchBatches(storage);new ReaderRequests(storage);const memory=new MemoryIndex(storage);new BudgetLedger(storage);
 db.exec("CREATE TABLE pra_auth(hash TEXT PRIMARY KEY,kind TEXT NOT NULL,expires INTEGER NOT NULL);CREATE TABLE pra_devices(id TEXT PRIMARY KEY,hash TEXT UNIQUE NOT NULL,label TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,revoked INTEGER NOT NULL);CREATE TABLE pra_identity(singleton INTEGER PRIMARY KEY,user_id TEXT NOT NULL)");
 db.prepare("INSERT INTO pra_identity VALUES(1,?)").run("owner");db.exec("INSERT INTO pra_auth VALUES('device-hash','device',9999999999999);INSERT INTO pra_devices VALUES('device','device-hash','synthetic',0,9999999999999,0)");
 state.cloudMemory={enabled:true,entries:[],deletedSlots:[]};
 return{db,storage,repository,state,workspace,artifacts,deletions,memory};
}
const schema="a".repeat(64);
test("external recovery store scopes checkpoints and guards; completion purges temporary content",()=>{
 const db=new DatabaseSync(":memory:"),store=new RecoveryStore(port(db)),c={id:"c",requestId:"r",label:"checkpoint",bookmark:"platform-bookmark",build:"build",schema,created:Date.now()};
 try{
  store.add("a",c);assert.equal(store.add("a",{...c,bookmark:"retry"}).bookmark,c.bookmark);assert.throws(()=>store.checkpoint("b",c.id),/NOT_FOUND/);
  assert.throws(()=>store.add("a",{...c,label:"changed"}),/REQUEST_CONFLICT/);
  const guard={format:1,build:"build",schema,content:"PRIVATE_GUARD_CANARY"};
  store.prepare("a","restore","c",guard);assert.equal(store.pending("b"),undefined);
  assert.ok(!JSON.stringify(store.view("a")).includes("PRIVATE_GUARD_CANARY"));
  assert.throws(()=>store.prepare("a","another","c",guard),/IN_PROGRESS/);
  store.fail("a","restore","PITR_UNAVAILABLE");assert.equal(store.pending("a")?.error,"PITR_UNAVAILABLE");
  store.complete("a","restore");store.complete("a","restore");
  assert.equal(store.job("a","restore")?.guard,undefined);assert.equal(store.pending("a"),undefined);
  assert.equal(store.prepare("a","restore","c",guard).status,"completed");
  assert.ok(!JSON.stringify(db.prepare("SELECT * FROM pra_recovery_jobs").all()).includes("PRIVATE_GUARD_CANARY"));
 }finally{db.close();}
});
test("expired, oversized, corrupt and incompatible recovery protection fail before accepting a restore",()=>{
 const db=new DatabaseSync(":memory:"),store=new RecoveryStore(port(db));
 try{
  store.add("a",{id:"expired",requestId:"expired",label:"old",bookmark:"b",build:"build",schema,created:Date.now()-30*86400000});
  assert.throws(()=>store.checkpoint("a","expired"),/EXPIRED/);
  store.add("a",{id:"current",requestId:"current",label:"current",bookmark:"b",build:"build",schema,created:Date.now()});
  const g={format:1,build:"build",schema};
  assert.throws(()=>store.prepare("a","bad","current",{...g,content:"x".repeat(RECOVERY_LIMIT)}),/TOO_LARGE/);
  assert.throws(()=>store.prepare("a","bad","current",{...g,build:"different"}),/SCHEMA_MISMATCH/);
  assert.equal(store.pending("a"),undefined);
  store.prepare("a","ok","current",g);
  db.prepare("UPDATE pra_recovery_jobs SET guard=? WHERE id='ok'").run(JSON.stringify({...g,changed:true}));
  assert.throws(()=>store.pending("a"),/CORRUPT/);
 }finally{db.close();}
});
test("real Pi SQLite checkpoint replay keeps live deletions, corrections, revoked devices, counters and source isolation",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"pra-recovery-")),file=join(dir,"live.sqlite"),snapshot=join(dir,"checkpoint.sqlite");
 const models=liveModels({authorized:"explicitly-authorized",apiKey:"synthetic-key",baseUrl:"https://example.invalid/v1",modelId:"fixture"},()=>{},()=>{},(async()=>Response.json({choices:[{message:{content:"Synthetic response."}}],usage:{prompt_tokens:1,completion_tokens:1}})) as typeof fetch);
 const options={models,registry:createRegistry(),settings:{retry:{maxRetries:0},compaction:{enabled:false}}};
 const harness=await Harness.open(await openNodeSqliteStorage(file,{prefix:"pi_"}),options,context);
 const pi=await harness.createConversation({agent:{model:{provider:"pra",modelId:"fixture"}},ownership:{kind:"ownerless"}},context);
 await(await pi.submit({type:"input",content:"DELETED_PI_RECOVERY_CANARY"},context)).wait(context);await harness.close(context);
 let db=new DatabaseSync(file);
 try{
  const f=setup(db),s=f.state;
  const source=submit(s,"DELETED_SOURCE_CANARY","source-request","chat"),derived=submit(s,"Independent user question","derived-request","chat"),survivor=submit(s,"Survivor question","survivor-request","chat");
  source.conversationId="source";source.status="completed";source.sessionId=String(pi.id);source.calls=1;source.answer="DELETED_ANSWER_CANARY";
  derived.conversationId="derived";derived.status="completed";derived.calls=1;derived.answer="DERIVED_ANSWER_CANARY";
  survivor.conversationId="survivor";survivor.status="completed";survivor.calls=1;survivor.answer="Surviving answer";
  s.conversations=[source,derived,survivor].map(t=>({id:t.conversationId!,title:t.input,projectId:"default",scope:[],created:0,sessionId:t.sessionId,history:[{turn_id:t.id,user_text:t.input,final_answer:t.answer!}]}));
  s.cloudMemory={enabled:true,deletedSlots:[],entries:[
   {id:"source-memory",slot:"source",kind:"note",content:"DELETED_MEMORY_CANARY",paper_ids:[],source_session:"source",source_turn:source.id,created_at:"2026-01-01",updated_at:"2026-01-01",edited:false},
   {id:"manual",slot:"manual",kind:"preference",content:"old preference",paper_ids:[],source_session:"",source_turn:"",created_at:"2026-01-01",updated_at:"2026-01-01",edited:true}
  ],dependencies:{[derived.id]:{memories:["source-memory"],turns:[source.id],lineageVersion:1}}};
  const input={projectId:"default",conversationId:"derived",taskId:derived.id,kind:"reading" as const,title:"Derived",partial:false};
  const derivedArtifact=f.artifacts.create(input,"DERIVED_ARTIFACT_CANARY",[]);
  const manualArtifact=f.artifacts.create({...input,conversationId:"survivor",taskId:survivor.id,kind:"comparison"},"DELETED_ARTIFACT_CANARY",[]);
  const survivingArtifact=f.artifacts.create({...input,conversationId:"survivor",taskId:survivor.id},"Surviving artifact",[]);
  f.repository.save(s);f.memory.sync(s.cloudMemory.entries);await backup(db,snapshot);
  const impact=f.deletions.request(s,"source");const lineage=f.deletions.lineage("source");assert.equal(impact.status,"pending");
  deletePiConversation(f.storage,String(pi.id));deleteConversationState(s,"source",lineage);f.artifacts.deleteTasks(lineage.turns);f.deletions.cloudDone("source");f.artifacts.delete(manualArtifact.id);
  s.cloudMemory!.entries.find(m=>m.id==="manual")!.content="corrected preference";
  s.usage={requests:7,input:900,output:80,reservedInput:0,reservedOutput:0};survivor.calls=4;survivor.tools=3;survivor.activeMs=9000;
  const late=submit(s,"New after checkpoint","late-request","chat");late.status="cancelled";
  db.exec("UPDATE pra_devices SET revoked=1;DELETE FROM pra_auth WHERE kind='device'");
  f.repository.save(s);f.memory.sync(s.cloudMemory!.entries);
  const guard=captureRecovery(f.storage,s,"build"),cursor=guard.cursor;
  db.close();await copyFile(snapshot,file);db=new DatabaseSync(file);const storage=port(db);
  const restored=applyRecovery(storage,guard,"restore","build");
  assert.equal(restored.conversations?.some(c=>c.id==="source"),false);
  assert.equal(db.prepare("SELECT task_id FROM pra_task_tombstones WHERE request_id=?").get(source.requestId)?.task_id,source.id);
  assert.equal(restored.tasks.find(t=>t.id===derived.id)?.answer,undefined);
  assert.equal(restored.tasks.find(t=>t.id===derived.id)?.input,"Independent user question");
  assert.equal(restored.tasks.find(t=>t.id===survivor.id)?.answer,"Surviving answer");
  assert.equal(restored.tasks.find(t=>t.id===survivor.id)?.calls,4);assert.deepEqual(restored.usage,guard.usage);
  assert.equal(restored.cloudMemory?.entries.find(m=>m.id==="manual")?.content,"corrected preference");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM pi_conversations").get()?.n,0);
  assert.equal(db.prepare("SELECT revoked FROM pra_devices").get()?.revoked,1);assert.equal(db.prepare("SELECT COUNT(*) n FROM pra_auth").get()?.n,0);
  assert.equal(db.prepare("SELECT id FROM pra_recovery_requests WHERE id='late-request'").get()?.id,"late-request");
  const a=new Artifacts(storage);assert.throws(()=>a.get(derivedArtifact.id),/NOT_FOUND/);assert.throws(()=>a.get(manualArtifact.id),/NOT_FOUND/);assert.equal(a.get(survivingArtifact.id).content,"Surviving artifact");
  assert.ok(new StateRepository(storage).cursor()>cursor);
  for(const table of ["pra_data_tasks","pra_data_messages","pra_data_memory_entries","pra_artifact_versions","pra_memory_index","pra_memory_revisions","pi_entries"]){
   const rows=JSON.stringify(db.prepare("SELECT * FROM "+table).all());assert.ok(!rows.includes("DELETED_"),table);assert.ok(!rows.includes("DERIVED_ANSWER_CANARY"),table);assert.ok(!rows.includes("DERIVED_ARTIFACT_CANARY"),table);
  }
  const r=new StateRepository(storage),after=r.load();after.usage.requests++;r.save(after);
  assert.equal(applyRecovery(storage,guard,"restore","build").usage.requests,8,"external acknowledgment retry must not rewind an applied restore");
 }finally{db.close();if(!resolve(dir).startsWith(resolve(tmpdir())+sep+"pra-recovery-"))throw Error("UNSAFE_TEST_PATH");await rm(dir,{recursive:true,force:true});}
});
test("restore transaction rolls back all protected changes on a late write failure; unknown schema is refused",()=>{
 const db=new DatabaseSync(":memory:");
 try{
  const f=setup(db);f.repository.save(f.state);const g=captureRecovery(f.storage,f.state,"build");
  g.tables.pra_devices!.rows[0][5]=1;
  const fail:StateStorage={...f.storage,sql:{exec<T>(q:string,...b:any[]){if(q.startsWith("INSERT INTO pra_changes(seq"))throw Error("INJECTED_LATE_WRITE_FAILURE");return f.storage.sql.exec<T>(q,...b);}}};
  assert.throws(()=>applyRecovery(fail,g,"restore","build"),/INJECTED/);
  assert.equal(db.prepare("SELECT revoked FROM pra_devices").get()?.revoked,0);
  assert.equal(db.prepare("SELECT applied FROM pra_recovery_state").get(),undefined);
  db.exec("ALTER TABLE pra_devices ADD COLUMN unknown TEXT");
  assert.throws(()=>applyRecovery(f.storage,g,"restore","build"),/SCHEMA_MISMATCH/);assert.equal(db.prepare("SELECT revoked FROM pra_devices").get()?.revoked,0);
 }finally{db.close();}
});

test("current evidence-backed memory correction survives while old dependent answers are redacted",()=>{
 const db=new DatabaseSync(":memory:");
 try{
  const f=setup(db),s=f.state,t=submit(s,"Independent question","question","chat");
  t.conversationId="conversation";t.status="completed";t.answer="STALE_ANSWER_CANARY";t.calls=1;
  s.conversations=[{id:"conversation",title:"Question",projectId:"default",scope:[],created:0,history:[{turn_id:t.id,user_text:t.input,final_answer:t.answer}]}];
  s.cloudMemory!.entries=[{id:"edited",slot:"conclusion",kind:"note",content:"Old conclusion",paper_ids:[],source_session:"conversation",source_turn:t.id,created_at:"2026-01-01",updated_at:"2026-01-01",edited:false}];
  f.repository.save(s);f.memory.sync(s.cloudMemory!.entries);
  s.cloudMemory!.entries[0].content="User corrected conclusion";s.cloudMemory!.entries[0].edited=true;s.cloudMemory!.invalidatedTurns=[t.id];f.memory.sync(s.cloudMemory!.entries);
  const guard=captureRecovery(f.storage,s,"build"),restored=applyRecovery(f.storage,guard,"correction-restore","build");
  assert.equal(restored.cloudMemory?.entries.find(m=>m.id==="edited")?.content,"User corrected conclusion");
  assert.equal(restored.conversations?.[0].history[0].final_answer,"");
  assert.equal(restored.tasks[0].answer,undefined);assert.equal(restored.tasks[0].input,"Independent question");
  assert.equal(new MemoryIndex(f.storage).recall("corrected",[],"default")[0]?.content,"User corrected conclusion");
 }finally{db.close();}
});
