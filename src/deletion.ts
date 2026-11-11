import { Problem, cancel, type State } from "./domain.ts";
import type { StateStorage } from "./state-store.ts";

export interface Deletion {
  id:string; session_id:string|null; status:"pending"|"cloud_complete"|"completed"|"failed";
  created:number; error:string|null; local_pending:number;
}
export class DeletionStore {
  storage:StateStorage;
  constructor(storage:StateStorage) {
    this.storage=storage;
    storage.sql.exec("CREATE TABLE IF NOT EXISTS pra_deletions(id TEXT PRIMARY KEY,session_id TEXT,status TEXT NOT NULL,created INTEGER NOT NULL,error TEXT,local_pending INTEGER NOT NULL)");
    storage.sql.exec("CREATE TABLE IF NOT EXISTS pra_deleted_operations(id TEXT PRIMARY KEY,deletion_id TEXT NOT NULL,purged INTEGER NOT NULL DEFAULT 0)");
    storage.sql.exec("CREATE INDEX IF NOT EXISTS pra_deleted_operations_deletion ON pra_deleted_operations(deletion_id)");
  }
  get(id:string) {return this.storage.sql.exec<Deletion>("SELECT * FROM pra_deletions WHERE id=?",id).toArray()[0];}
  pending() {return this.storage.sql.exec<Deletion>("SELECT * FROM pra_deletions WHERE status='pending' ORDER BY created").toArray();}
  localPending() {return this.storage.sql.exec<Deletion>("SELECT * FROM pra_deletions WHERE local_pending=1 AND status IN ('cloud_complete','completed')").toArray();}
  operationIds(id:string) {return this.storage.sql.exec<{id:string}>("SELECT id FROM pra_deleted_operations WHERE deletion_id=? AND purged=0 LIMIT 200",id).toArray().map(r=>r.id);}
  deletedOperation(id:string) {return this.storage.sql.exec("SELECT id FROM pra_deleted_operations WHERE id=?",id).toArray().length>0;}
  request(state:State,id:string) {
    const prior=this.get(id);if(prior&&prior.status!=="failed")return prior;
    const c=state.conversations?.find(c=>c.id===id);if(!c)throw new Problem("UNKNOWN_CONVERSATION",404);
    const tasks=state.tasks.filter(t=>t.conversationId===id),ids=new Set(tasks.map(t=>t.id));
    const operations=state.operations.filter(o=>ids.has(o.taskId));
    this.storage.sql.exec("INSERT INTO pra_deletions VALUES(?,?, 'pending',?,NULL,?) ON CONFLICT(id) DO UPDATE SET status='pending',error=NULL",id,c.sessionId??null,Date.now(),operations.length?1:0);
    for(const op of operations)this.storage.sql.exec("INSERT OR IGNORE INTO pra_deleted_operations(id,deletion_id) VALUES(?,?)",op.id,id);
    for(const t of tasks)cancel(state,t.id);
    return this.get(id)!;
  }
  cloudDone(id:string) {
    this.storage.sql.exec("UPDATE pra_deletions SET status=CASE WHEN local_pending=1 THEN 'cloud_complete' ELSE 'completed' END,error=NULL WHERE id=?",id);
  }
  localDone(id:string,ids:string[]) {
    if(ids.length>200||ids.some(id=>typeof id!=="string"))throw new Problem("INVALID_PURGE_ACK");
    this.storage.transactionSync(()=>{
      for(const op of ids)this.storage.sql.exec("UPDATE pra_deleted_operations SET purged=1 WHERE id=? AND deletion_id=?",op,id);
      if(!this.operationIds(id).length)this.storage.sql.exec("UPDATE pra_deletions SET local_pending=0,status='completed' WHERE id=? AND status='cloud_complete'",id);
    });
  }
  fail(id:string,code:string) {this.storage.sql.exec("UPDATE pra_deletions SET status='failed',error=? WHERE id=?",code,id);}
}

const columns:Record<string,string[]>={
  pi_durable_schema:["singleton","version"],pi_durable_metadata:["singleton","next_id","next_seq"],
  pi_record_ids:["id","record_type"],pi_conversations:["id","owner_conversation_id","owner_task_id","record"],
  pi_entries:["id","conversation_id","head","commit_seq","record"],
  pi_tasks:["id","conversation_id","kind","status","abort_requested","background","record"],
  pi_submissions:["id","conversation_id","request_id","status","record"],
  pi_documents:["id","kind","family","key_value","scope_kind","owner_id","created_at","retired_at","record"],
  pi_document_revisions:["document_id","seq","kind","version","content"],
};
/** Application-owned adapter for the exact Pi Durable 1.5.0 / SQLite schema 2.
 * Call only after the entire host harness has drained and been disposed. Never renumber IDs. */
export function deletePiConversation(storage:StateStorage,sessionId:string) {
  const id=Number(sessionId);if(!Number.isSafeInteger(id)||id<1)throw new Problem("INVALID_PI_SESSION");
  const tables=storage.sql.exec<{name:string}>("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'pi_%'").toArray().map(r=>r.name).sort();
  if(!tables.length)return;
  if(JSON.stringify(tables)!==JSON.stringify(Object.keys(columns).sort()))throw new Problem("PI_DELETE_SCHEMA_MISMATCH",503);
  for(const [name,expected] of Object.entries(columns)) {
    const actual=storage.sql.exec<{name:string}>("PRAGMA table_info("+name+")").toArray().map(r=>r.name);
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Problem("PI_DELETE_SCHEMA_MISMATCH",503);
  }
  const version=storage.sql.exec<{version:number}>("SELECT version FROM pi_durable_schema WHERE singleton=1").toArray()[0]?.version;
  if(version!==2)throw new Problem("PI_DELETE_SCHEMA_MISMATCH",503);
  storage.transactionSync(()=>{
    const conversations=storage.sql.exec<{id:number;owner_conversation_id:number|null;owner_task_id:number|null}>("SELECT id,owner_conversation_id,owner_task_id FROM pi_conversations").toArray();
    const tasks=storage.sql.exec<{id:number;conversation_id:number}>("SELECT id,conversation_id FROM pi_tasks").toArray();
    const doomed=new Set([id]);let changed=true;
    while(changed) {
      changed=false;const ownedTasks=new Set(tasks.filter(t=>doomed.has(t.conversation_id)).map(t=>t.id));
      for(const c of conversations)if(!doomed.has(c.id)&&(doomed.has(c.owner_conversation_id!)||ownedTasks.has(c.owner_task_id!))){doomed.add(c.id);changed=true;}
    }
    const ids=JSON.stringify([...doomed]),taskIds=JSON.stringify(tasks.filter(t=>doomed.has(t.conversation_id)).map(t=>t.id));
    const docWhere="(scope_kind='conversation' AND owner_id IN (SELECT value FROM json_each(?))) OR (scope_kind='task' AND owner_id IN (SELECT value FROM json_each(?)))";
    const docs=storage.sql.exec<{id:number}>("SELECT id FROM pi_documents WHERE "+docWhere,ids,taskIds).toArray().map(r=>r.id),docIds=JSON.stringify(docs);
    storage.sql.exec("DELETE FROM pi_document_revisions WHERE document_id IN (SELECT value FROM json_each(?))",docIds);
    storage.sql.exec("DELETE FROM pi_record_ids WHERE id IN (SELECT value FROM json_each(?))",docIds);
    storage.sql.exec("DELETE FROM pi_documents WHERE id IN (SELECT value FROM json_each(?))",docIds);
    for(const name of ["pi_entries","pi_submissions","pi_tasks"]) {
      storage.sql.exec("DELETE FROM pi_record_ids WHERE id IN (SELECT id FROM "+name+" WHERE conversation_id IN (SELECT value FROM json_each(?)))",ids);
      storage.sql.exec("DELETE FROM "+name+" WHERE conversation_id IN (SELECT value FROM json_each(?))",ids);
    }
    storage.sql.exec("DELETE FROM pi_record_ids WHERE id IN (SELECT value FROM json_each(?))",ids);
    storage.sql.exec("DELETE FROM pi_conversations WHERE id IN (SELECT value FROM json_each(?))",ids);
  });
}
/** Remove application-owned conversation content; immutable paper-library originals are not conversations. */
export function deleteConversationState(state:State,id:string) {
  const tasks=state.tasks.filter(t=>t.conversationId===id),ids=new Set(tasks.map(t=>t.id));
  const c=state.conversations?.find(c=>c.id===id),turns=new Set([...(c?.history.map(h=>h.turn_id)??[]),...ids]);
  const removed=state.cloudMemory?.entries.filter(m=>m.source_session===id||turns.has(m.source_turn))??[];
  if(state.cloudMemory) {
    state.cloudMemory.entries=state.cloudMemory.entries.filter(m=>!removed.includes(m));
    state.cloudMemory.deletedSlots=[...new Set([...state.cloudMemory.deletedSlots,...removed.map(m=>m.slot)])];
    state.cloudMemory.invalidatedTurns=[...new Set([...(state.cloudMemory.invalidatedTurns??[]),...turns])];
  }
  state.memories=state.memories.filter(m=>!removed.some(r=>r.id===m.id)&&m.source!==id);
  state.conversations=state.conversations?.filter(c=>c.id!==id);
  for(const other of state.conversations??[])if(other.domain) {
    other.domain.user_constraints=other.domain.user_constraints.filter(v=>!turns.has(v.source_turn));
    other.domain.reading_notes=other.domain.reading_notes?.filter(v=>!turns.has(v.source_turn));
    other.domain.conclusions=other.domain.conclusions.filter(v=>!turns.has(v.source_turn));
  }
  state.tasks=state.tasks.filter(t=>!ids.has(t.id));
  state.operations=state.operations.filter(o=>!ids.has(o.taskId));
  state.notices=state.notices.filter(n=>![...ids].some(t=>n.id==="task:"+t||n.id==="budget:"+t));
}
