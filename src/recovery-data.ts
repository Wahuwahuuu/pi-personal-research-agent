import {appendChanges} from "./change-feed.ts";
import {createHash} from "node:crypto";
import {Problem,type State} from "./domain.ts";
import {StateRepository,type StateStorage} from "./state-store.ts";
import {DeletionStore,deletePiConversation,deleteConversationState} from "./deletion.ts";
import {deletionImpact,emptyImpact} from "./deletion-lineage.ts";
import {Workspace} from "./workspace.ts";
import {Artifacts} from "./artifacts.ts";
import {LibraryJobs} from "./library-jobs.ts";
import {ResearchBatches} from "./research-batches.ts";
import {ReaderRequests} from "./reader-requests.ts";
import {MemoryIndex} from "./memory-index.ts";
import {RECOVERY_LIMIT} from "./recovery-store.ts";
const protectedTables=[
 "pra_auth","pra_identity","pra_devices","pra_device_pairs","pra_device_indexes",
 "pra_budget_months","pra_budget_days","pra_model_calls","pra_billing_outbox",
 "pra_task_tombstones","pra_deletions","pra_deleted_operations","pra_deletion_lineage","pra_operation_holders","pra_operation_purge_scopes","pra_deleted_readers",
 "pra_project_tombstones","pra_artifact_tombstones","pra_library_tombstones","pra_library_jobs","pra_library_requests",
 "pra_research_batch_tombstones","pra_research_batches","pra_research_candidates","pra_settings","pra_memory_revisions","pra_reader_requests","pra_recovery_requests"
] as const;
type TableData={columns:string[];rows:any[][]};
export interface RecoveryGuard {
 format:1;build:string;schema:string;tables:Partial<Record<typeof protectedTables[number],TableData>>;
 usage:State["usage"];memory:State["cloudMemory"];plans:State["plans"];papers:State["papers"];cursor:number;
 counters:{id:string;requestId:string;calls:number;tools:number;activeMs:number}[];
 mutations:{id:string;operation:string;input:string;created:number}[];
}
export function recoverySchemaDetails(db:StateStorage){
 const objects=db.sql.exec<{type:string;name:string;sql:string|null}>("SELECT type,name,sql FROM sqlite_master WHERE (name GLOB 'pra_*' OR name GLOB 'pi_*') AND name NOT GLOB 'pra_recovery_*' ORDER BY type,name").toArray();
 return {fingerprint:createHash("sha256").update(JSON.stringify(objects)).digest("hex"),objects};
}
export function recoverySchema(db:StateStorage){return recoverySchemaDetails(db).fingerprint;}
export function initRecovery(db:StateStorage){
 db.sql.exec("CREATE TABLE IF NOT EXISTS pra_recovery_state(id INTEGER PRIMARY KEY CHECK(id=1),intent TEXT,applied TEXT)");
 db.sql.exec("CREATE TABLE IF NOT EXISTS pra_recovery_requests(id TEXT PRIMARY KEY)");
}
function exists(db:StateStorage,name:string){return !!db.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name=?",name).toArray().length;}
export function captureRecovery(db:StateStorage,s:State,build:string):RecoveryGuard{
 initRecovery(db);
 const tables:RecoveryGuard["tables"]={};
 for(const name of protectedTables)if(exists(db,name)){
  const columns=db.sql.exec<{name:string}>("PRAGMA table_info("+name+")").toArray().map(c=>c.name);
  tables[name]={columns,rows:db.sql.exec<any>("SELECT * FROM "+name).toArray().map(row=>columns.map(c=>row[c]))};
 }
 const result:RecoveryGuard={format:1,build,schema:recoverySchema(db),tables,usage:structuredClone(s.usage),memory:structuredClone(s.cloudMemory),plans:structuredClone(s.plans),papers:structuredClone(s.papers),
  cursor:db.sql.exec<{seq:number}>("SELECT COALESCE(MAX(seq),0) AS seq FROM pra_changes").toArray()[0].seq,
  counters:s.tasks.map(({id,requestId,calls,tools,activeMs})=>({id,requestId,calls,tools,activeMs})),
  mutations:db.sql.exec<any>("SELECT id,operation,input,created FROM pra_mutations").toArray()};
 if(new TextEncoder().encode(JSON.stringify(result)).length>RECOVERY_LIMIT)throw new Problem("RECOVERY_PROTECTION_TOO_LARGE",413);
 return result;
}
/** Called before lifecycle startup, with the host harness closed. The external guard survives PITR. */
export function applyRecovery(db:StateStorage,guard:RecoveryGuard,id:string,build:string){
 initRecovery(db);
 if(db.sql.exec<{applied:string}>("SELECT applied FROM pra_recovery_state WHERE id=1").toArray()[0]?.applied===id)return new StateRepository(db).load();
 if(guard.format!==1||guard.build!==build||guard.schema!==recoverySchema(db))throw new Problem("RECOVERY_SCHEMA_MISMATCH",503);
 const expected=protectedTables.filter(name=>exists(db,name));
 if(JSON.stringify([...expected].sort())!==JSON.stringify(Object.keys(guard.tables).sort()))throw new Problem("RECOVERY_SCHEMA_MISMATCH",503);
 for(const [name,data]of Object.entries(guard.tables)){
  if(!(protectedTables as readonly string[]).includes(name)||!data)throw new Problem("RECOVERY_SCHEMA_MISMATCH",503);
  const cols=db.sql.exec<{name:string}>("PRAGMA table_info("+name+")").toArray().map(r=>r.name);
  if(JSON.stringify(cols)!==JSON.stringify(data.columns)||data.rows.some(r=>r.length!==cols.length))throw new Problem("RECOVERY_SCHEMA_MISMATCH",503);
 }
 return db.transactionSync(()=>{
  for(const [name,data]of Object.entries(guard.tables)){
   db.sql.exec("DELETE FROM "+name);
   for(const row of data!.rows)db.sql.exec("INSERT INTO "+name+" VALUES("+row.map(()=>"?").join(",")+")",...row);
  }
  const repository=new StateRepository(db),s=repository.load(),workspace=new Workspace(db),artifacts=new Artifacts(db),deletions=new DeletionStore(db),imports=new LibraryJobs(db),batches=new ResearchBatches(db),readers=new ReaderRequests(db);
  s.usage=structuredClone(guard.usage);s.cloudMemory=structuredClone(guard.memory);s.papers=structuredClone(guard.papers);
  const counters=new Map(guard.counters.map(c=>[c.id,c]));
  for(const t of s.tasks){const v=counters.get(t.id);if(v){t.calls=Math.max(t.calls,v.calls);t.tools=Math.max(t.tools,v.tools);t.activeMs=Math.max(t.activeMs,v.activeMs);}}
  for(const t of guard.counters)if(!s.tasks.some(v=>v.id===t.id))db.sql.exec("INSERT OR IGNORE INTO pra_recovery_requests VALUES(?)",t.requestId);
  db.sql.exec("DELETE FROM pra_mutations");
  for(const m of guard.mutations)db.sql.exec("INSERT INTO pra_mutations VALUES(?,?,?,?,?)",m.id,m.operation,m.input,JSON.stringify({_deleted:true}),m.created);
  const projectIds=new Set(db.sql.exec<{id:string}>("SELECT id FROM pra_project_tombstones").toArray().map(r=>r.id));
  for(const c of s.conversations??[])if(projectIds.has(c.projectId)&&!deletions.get(c.id))deletions.request(s,c.id);
  const removedTurns=new Set<string>(),removedConversations=new Set<string>();
  for(const row of db.sql.exec<{id:string}>("SELECT id FROM pra_deletions").toArray()){
   const impact=deletions.capture(s,row.id);
   for(const t of impact.turns)removedTurns.add(t);for(const c of impact.conversations)removedConversations.add(c);
   deleteConversationState(s,row.id,impact);
   readers.removeConversations(impact.conversations,row.id);
   deletions.cloudDone(row.id);
  }
  // Current corrections and invalidated memory inputs must also dominate old answers.
  const correctedEntries=structuredClone(s.cloudMemory?.entries??[]);
  const invalid=deletionImpact(s,"recovery-invalidated:"+id,{...emptyImpact(),turns:s.cloudMemory?.invalidatedTurns??[]});
  deleteConversationState(s,"recovery-invalidated:"+id,invalid);
  if(s.cloudMemory)s.cloudMemory.entries=correctedEntries.filter(e=>e.edited||!invalid.turns.includes(e.source_turn));
  for(const t of invalid.turns)removedTurns.add(t);for(const c of invalid.conversations)removedConversations.add(c);
  const removedArtifacts=artifacts.deleteTasks([...removedTurns]);
  for(const c of removedConversations)batches.clearResearch(c);
  for(const project of projectIds){db.sql.exec("DELETE FROM pra_projects WHERE id=?",project);imports.removeProject(project);}
  artifacts.purgeDeleted();
  const projects=new Set(db.sql.exec<{id:string}>("SELECT id FROM pra_projects").toArray().map(r=>r.id));
  s.plans=structuredClone(guard.plans).filter(p=>projects.has(p.projectId??"default")).map(p=>({...p,enabled:false}));
  for(const p of guard.plans)if(!s.plans.some(v=>v.id===p.id))batches.removePlan(p.id);
  const sessions=exists(db,"pi_conversations")?db.sql.exec<{id:number}>("SELECT id FROM pi_conversations").toArray():[];
  for(const c of sessions)deletePiConversation(db,String(c.id));
  for(const c of s.conversations??[])delete c.sessionId;
  for(const t of s.tasks){
   if(t.proactive)t.proactive.stage="done";
   delete t.sessionId;delete t.modelOperation;delete t.modelPrompt;delete t.modelStarted;delete t.modelAdmitted;t.runOpen=false;
   if(!["completed","failed","cancelled"].includes(t.status)){t.status="cancelled";t.error="RECOVERED_TASK_INTERRUPTED";t.updated=Date.now();}
  }
  for(const op of s.operations)if(!["done","cancelled"].includes(op.state))op.state="cancelled";
  const conversations=new Set((s.conversations??[]).map(c=>c.id));
  // Current reader receipts are retained, including offline cache ownership.
  const orphanReaders=db.sql.exec<{id:string}>("SELECT DISTINCT json_extract(value,'$.conversationId') AS id FROM pra_reader_requests WHERE json_extract(value,'$.conversationId') IS NOT NULL").toArray().filter(r=>!conversations.has(r.id));
  for(const c of orphanReaders){
   db.sql.exec("INSERT OR IGNORE INTO pra_deletions VALUES(?,NULL,'cloud_complete',?,NULL,1)",c.id,Date.now());
   readers.removeConversations([c.id],c.id);deletions.refreshLocal(c.id);
  }
  db.sql.exec("UPDATE pra_reader_requests SET value=json_set(value,'$.status','cancelled','$.error','RECOVERY_REVIEW_REQUIRED') WHERE json_extract(value,'$.status')='queued'");
  if(s.cloudMemory)s.cloudMemory.entries=s.cloudMemory.entries.filter(m=>(!m.projectId||projects.has(m.projectId))&&(!m.source_session||conversations.has(m.source_session)));
  s.memories=(s.cloudMemory?.entries??[]).map(m=>({id:m.id,content:m.content,source:m.source_session||"user",updated:Date.parse(m.updated_at)}));
  const artifactIds=new Set(db.sql.exec<{id:string}>("SELECT id FROM pra_artifacts").toArray().map(r=>r.id));
  s.notices=s.notices.filter(n=>!removedArtifacts.includes(n.artifactId??"")&&(!n.artifactId||artifactIds.has(n.artifactId))).map(n=>({...n,read:true}));
  repository.save(s);
  db.sql.exec("DELETE FROM pra_memory_fts");db.sql.exec("DELETE FROM pra_memory_index");
  db.sql.exec("DELETE FROM pra_memory_revisions WHERE id NOT IN (SELECT value FROM json_each(?))",JSON.stringify((s.cloudMemory?.entries??[]).map(m=>m.id)));
  new MemoryIndex(db).sync(s.cloudMemory?.entries??[]);
  appendChanges(db,[{entity:"recovery",id}],guard.cursor);
  db.sql.exec("INSERT INTO pra_recovery_state VALUES(1,NULL,?) ON CONFLICT(id) DO UPDATE SET intent=NULL,applied=excluded.applied",id);
  return s;
 });
}
