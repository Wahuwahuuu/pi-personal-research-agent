import {OperationCustody} from "./operation-custody.ts";
import {ReaderPurges} from "./reader-purges.ts";
import {deletionImpact,emptyImpact,removeConversationContent,invalidateDeletedSources,type DeletionImpact} from "./deletion-lineage.ts";
import { Problem, cancel, type State } from "./domain.ts";
import type { StateStorage } from "./state-store.ts";

export interface Deletion {
  id:string; session_id:string|null; status:"pending"|"cloud_complete"|"completed"|"failed";
  created:number; error:string|null; local_pending:number;
}
export interface DeletionRecord {
  id:string; status:Deletion["status"]; created:number; error:string|null;
  pendingDevices:number; pendingResults:number; pendingReaders:number; unverifiedOperations:number;
}
export class DeletionStore {
  storage:StateStorage;
  readers:ReaderPurges;
  custody:OperationCustody;
  constructor(storage:StateStorage) {
    this.storage=storage;
    this.readers=new ReaderPurges(storage);
    storage.sql.exec("CREATE TABLE IF NOT EXISTS pra_deletions(id TEXT PRIMARY KEY,session_id TEXT,status TEXT NOT NULL,created INTEGER NOT NULL,error TEXT,local_pending INTEGER NOT NULL)");
    storage.sql.exec("CREATE TABLE IF NOT EXISTS pra_deleted_operations(id TEXT PRIMARY KEY,deletion_id TEXT NOT NULL,purged INTEGER NOT NULL DEFAULT 0)");
    storage.sql.exec("CREATE INDEX IF NOT EXISTS pra_deleted_operations_deletion ON pra_deleted_operations(deletion_id)");
    storage.sql.exec("CREATE TABLE IF NOT EXISTS pra_deletion_lineage(deletion_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(deletion_id,kind,id))");
    this.custody=new OperationCustody(storage);
    storage.sql.exec("CREATE INDEX IF NOT EXISTS pra_deletions_created ON pra_deletions(created DESC,id DESC)");
    storage.sql.exec("CREATE INDEX IF NOT EXISTS pra_deleted_readers_deletion ON pra_deleted_readers(deletion_id,purged,device_hash)");
    // Legacy global acknowledgments do not prove which offline devices were actually cleared.
    for(const r of storage.sql.exec<{id:string}>("SELECT d.id FROM pra_deletions d WHERE d.status='completed' AND EXISTS(SELECT 1 FROM pra_deleted_operations o LEFT JOIN pra_operation_purge_scopes s ON s.id=o.id WHERE o.deletion_id=d.id AND COALESCE(s.verified,0)=0)").toArray())this.refreshLocal(r.id);
  }
  get(id:string) {return this.storage.sql.exec<Deletion>("SELECT * FROM pra_deletions WHERE id=?",id).toArray()[0];}
  records(options:{limit?:number;after?:string}={}) {
    const limit=options.limit??20,after=options.after??"";
    if(!Number.isInteger(limit)||limit<1||limit>50||after.length>700)throw new Problem("INVALID_PAGE");
    let cursor:[number,string]|undefined;
    if(after){
      try{const v=JSON.parse(after);
        if(!Array.isArray(v)||v.length!==2||!Number.isSafeInteger(v[0])||v[0]<0||typeof v[1]!=="string"||!v[1]||v[1].length>512)throw Error();
        cursor=[v[0],v[1]];
      }catch{throw new Problem("INVALID_CURSOR");}
    }
    const rows=this.storage.sql.exec<Pick<DeletionRecord,"id"|"status"|"created"|"error">>(
      "SELECT id,status,created,error FROM pra_deletions"+(cursor?" WHERE created<? OR (created=? AND id<?)":"")+" ORDER BY created DESC,id DESC LIMIT ?",
      ...(cursor?[cursor[0],cursor[0],cursor[1]]:[]),limit+1).toArray();
    const items:DeletionRecord[]=rows.slice(0,limit).map(r=>{
      const count=(q:string,...b:(string|number)[])=>this.storage.sql.exec<{n:number}>(q,...b).toArray()[0].n;
      return {...r,
        error:r.error&&/^[A-Z][A-Z0-9_]{0,79}$/.test(r.error)?r.error:r.error?"DELETION_FAILED":null,
        pendingDevices:count("SELECT COUNT(*) AS n FROM (SELECT h.device_hash FROM pra_operation_holders h JOIN pra_deleted_operations o ON o.id=h.id WHERE o.deletion_id=? AND h.purged=0 UNION SELECT device_hash FROM pra_deleted_readers WHERE deletion_id=? AND purged=0)",r.id,r.id),
        pendingResults:count("SELECT COUNT(*) AS n FROM pra_operation_holders h JOIN pra_deleted_operations o ON o.id=h.id WHERE o.deletion_id=? AND h.purged=0",r.id),
        pendingReaders:count("SELECT COUNT(*) AS n FROM pra_deleted_readers WHERE deletion_id=? AND purged=0",r.id),
        unverifiedOperations:count("SELECT COUNT(*) AS n FROM pra_deleted_operations o LEFT JOIN pra_operation_purge_scopes s ON s.id=o.id WHERE o.deletion_id=? AND COALESCE(s.verified,0)=0",r.id),
      };
    });
    const last=items.at(-1);
    return {items,nextCursor:rows.length>limit&&last?JSON.stringify([last.created,last.id]):null};
  }
  pending() {return this.storage.sql.exec<Deletion>("SELECT * FROM pra_deletions WHERE status='pending' ORDER BY created").toArray();}
  localPending() {return this.storage.sql.exec<Deletion>("SELECT * FROM pra_deletions WHERE local_pending=1 AND status IN ('cloud_complete','completed')").toArray();}
  operationIds(id:string,hash?:string) {return this.custody.pending(id,hash);}
  deletedOperation(id:string) {return this.storage.sql.exec("SELECT id FROM pra_deleted_operations WHERE id=?",id).toArray().length>0;}
  request(state:State,id:string) {
    const prior=this.get(id);if(prior&&prior.status!=="failed")return prior;
    const c=state.conversations?.find(c=>c.id===id);if(!c)throw new Problem("UNKNOWN_CONVERSATION",404);
    this.storage.sql.exec("INSERT INTO pra_deletions VALUES(?,?, 'pending',?,NULL,0) ON CONFLICT(id) DO UPDATE SET status='pending',error=NULL",id,c.sessionId??null,Date.now());
    this.capture(state,id);
    return this.get(id)!;
  }
  lineage(id:string) {
    const impact=emptyImpact();
    for(const r of this.storage.sql.exec<{kind:keyof DeletionImpact;id:string}>("SELECT kind,id FROM pra_deletion_lineage WHERE deletion_id=?",id).toArray())
      if(r.kind in impact)impact[r.kind].push(r.id);
    return impact;
  }
  blocksConversation(id:string){
    return !!this.storage.sql.exec("SELECT l.id FROM pra_deletion_lineage l JOIN pra_deletions d ON d.id=l.deletion_id WHERE l.kind='conversations' AND l.id=? AND d.status IN ('pending','failed') LIMIT 1",id).toArray().length;
  }
  capture(state:State,id:string){
    const prior=this.lineage(id),impact=deletionImpact(state,id,prior);
    for(const kind of Object.keys(impact) as (keyof DeletionImpact)[]){
      const known=new Set(prior[kind]);
      for(const value of impact[kind])if(!known.has(value))this.storage.sql.exec("INSERT OR IGNORE INTO pra_deletion_lineage VALUES(?,?,?)",id,kind,value);
    }
    for(const op of impact.operations)if(!this.deletedOperation(op))this.custody.capture(op,id,state.operations.find(o=>o.id===op));
    if(this.operationIds(id).length)this.storage.sql.exec("UPDATE pra_deletions SET local_pending=1 WHERE id=? AND local_pending=0",id);
    for(const t of state.tasks)if(impact.turns.includes(t.id))cancel(state,t.id);
    invalidateDeletedSources(state,id,impact);
    return impact;
  }
  refreshLocal(id:string){
    const pending=this.operationIds(id).length>0||this.readers.remaining(id);
    this.storage.sql.exec("UPDATE pra_deletions SET local_pending=?,status=CASE WHEN status IN ('cloud_complete','completed') THEN ? ELSE status END WHERE id=?",Number(pending),pending?"cloud_complete":"completed",id);
    if(this.get(id)?.status==="cloud_complete"&&this.custody.unknown(id))this.storage.sql.exec("UPDATE pra_deletions SET error=\'LEGACY_DEVICE_OWNERSHIP_UNKNOWN\' WHERE id=?",id);
  }
  cloudDone(id:string) {
    this.storage.sql.exec("UPDATE pra_deletions SET status='cloud_complete',error=NULL WHERE id=?",id);
    this.refreshLocal(id);
  }
  localDone(id:string,ids:unknown,hash:string) {
    this.storage.transactionSync(()=>{this.custody.acknowledge(id,ids,hash);this.refreshLocal(id);});
  }
  lateOperation(id:string,hash:string){
    const deletionId=this.custody.late(id,hash);if(deletionId)this.refreshLocal(deletionId);
  }
  readersDone(id:string,ids:unknown,hash:string){
    this.storage.transactionSync(()=>{this.readers.acknowledge(id,ids,hash);this.refreshLocal(id);});
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
/** Immutable paper-library originals are not conversation content. */
export const deleteConversationState = removeConversationContent;
