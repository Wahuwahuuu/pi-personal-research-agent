import {createHash} from "node:crypto";
import {Problem,text} from "./domain.ts";
import type {StateStorage} from "./state-store.ts";
export const RECOVERY_LIMIT=750_000;
const hash=(v:unknown)=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
export interface RecoveryCheckpoint {id:string;requestId:string;label:string;bookmark:string;build:string;schema:string;created:number}
export interface RecoveryJob {id:string;checkpointId:string;status:"pending"|"completed";created:number;completed?:number;error?:string;guard?:any;checkpoint?:RecoveryCheckpoint}
export class RecoveryStore {
 readonly db:StateStorage;
 constructor(db:StateStorage){this.db=db;
  db.sql.exec("CREATE TABLE IF NOT EXISTS pra_recovery_checkpoints(owner TEXT NOT NULL,id TEXT NOT NULL,request_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(owner,id),UNIQUE(owner,request_id))");
  db.sql.exec("CREATE TABLE IF NOT EXISTS pra_recovery_jobs(owner TEXT NOT NULL,id TEXT NOT NULL,checkpoint_id TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,completed INTEGER,error TEXT,guard TEXT,signature TEXT NOT NULL,PRIMARY KEY(owner,id))");
 }
 checkpoints(owner:string,now=Date.now()){return this.db.sql.exec<{value:string}>("SELECT value FROM pra_recovery_checkpoints WHERE owner=? ORDER BY rowid DESC LIMIT 30",owner).toArray().map(r=>JSON.parse(r.value) as RecoveryCheckpoint).filter(c=>now-c.created<29*86400000);}
 checkpoint(owner:string,id:string,now=Date.now()){
  const r=this.db.sql.exec<{value:string}>("SELECT value FROM pra_recovery_checkpoints WHERE owner=? AND id=?",owner,id).toArray()[0];
  if(!r)throw new Problem("CHECKPOINT_NOT_FOUND",404);const c=JSON.parse(r.value) as RecoveryCheckpoint;
  if(now-c.created>=29*86400000)throw new Problem("CHECKPOINT_EXPIRED",410);return c;
 }
 byRequest(owner:string,requestId:string){return this.db.sql.exec<{value:string}>("SELECT value FROM pra_recovery_checkpoints WHERE owner=? AND request_id=?",owner,requestId).toArray().map(r=>JSON.parse(r.value) as RecoveryCheckpoint)[0];}
 add(owner:string,c:RecoveryCheckpoint){
  text(c.id,128);text(c.requestId,128);text(c.label,80);text(c.bookmark,512);text(c.build,128);
  if(!/^[a-f0-9]{64}$/.test(c.schema))throw new Problem("INVALID_RECOVERY_SCHEMA");
  const old=this.byRequest(owner,c.requestId);
  if(old){if(old.label!==c.label)throw new Problem("REQUEST_CONFLICT",409);return old;}
  if(this.checkpoints(owner).length>=30)throw new Problem("CHECKPOINT_CAPACITY",409);
  this.db.sql.exec("INSERT INTO pra_recovery_checkpoints VALUES(?,?,?,?)",owner,c.id,c.requestId,JSON.stringify(c));return c;
 }
 job(owner:string,id:string):RecoveryJob|undefined{
  const r=this.db.sql.exec<any>("SELECT * FROM pra_recovery_jobs WHERE owner=? AND id=?",owner,id).toArray()[0];
  if(!r)return;
  if(r.guard&&r.signature!==hash(JSON.parse(r.guard)))throw new Problem("RECOVERY_PROTECTION_CORRUPT",503);
  return{id:r.id,checkpointId:r.checkpoint_id,status:r.status,created:r.created,completed:r.completed??undefined,error:r.error??undefined,guard:r.guard?JSON.parse(r.guard):undefined};
 }
 pending(owner:string){const r=this.db.sql.exec<{id:string}>("SELECT id FROM pra_recovery_jobs WHERE owner=? AND status='pending' LIMIT 1",owner).toArray()[0];if(!r)return;const j=this.job(owner,r.id)!;return{...j,checkpoint:this.checkpoint(owner,j.checkpointId)};}
 prepare(owner:string,id:string,checkpointId:string,guard:any){
  text(id,128);const c=this.checkpoint(owner,checkpointId),encoded=JSON.stringify(guard);
  if(new TextEncoder().encode(encoded).length>RECOVERY_LIMIT)throw new Problem("RECOVERY_PROTECTION_TOO_LARGE",413);
  if(guard?.format!==1||guard.schema!==c.schema||guard.build!==c.build)throw new Problem("RECOVERY_SCHEMA_MISMATCH",409);
  const prior=this.job(owner,id);if(prior){if(prior.checkpointId!==checkpointId)throw new Problem("REQUEST_CONFLICT",409);return prior;}
  if(this.pending(owner))throw new Problem("RECOVERY_IN_PROGRESS",409);
  this.db.sql.exec("INSERT INTO pra_recovery_jobs VALUES(?,?,?,'pending',?,NULL,NULL,?,?)",owner,id,checkpointId,Date.now(),encoded,hash(guard));return this.job(owner,id)!;
 }
 complete(owner:string,id:string){const j=this.job(owner,id);if(!j)throw new Problem("RECOVERY_NOT_FOUND",404);
  this.db.sql.exec("UPDATE pra_recovery_jobs SET status='completed',completed=COALESCE(completed,?),error=NULL,guard=NULL WHERE owner=? AND id=?",Date.now(),owner,id);
 }
 fail(owner:string,id:string,code:string){this.db.sql.exec("UPDATE pra_recovery_jobs SET error=? WHERE owner=? AND id=? AND status='pending'",/^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code:"RECOVERY_FAILED",owner,id);}
 view(owner:string){return{checkpoints:this.checkpoints(owner).map(({bookmark,requestId,schema,...c})=>c),jobs:this.db.sql.exec<any>("SELECT id,checkpoint_id AS checkpointId,status,created,completed,error FROM pra_recovery_jobs WHERE owner=? ORDER BY created DESC LIMIT 20",owner).toArray()};}
}
