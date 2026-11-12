import {Problem,type Operation} from "./domain.ts";
import type {StateStorage} from "./state-store.ts";
/** Persist every possible cache holder before delivery. Receipts prove only that device's cleanup. */
export class OperationCustody {
  readonly db:StateStorage;
  constructor(db:StateStorage) {
    this.db=db;
    db.sql.exec("CREATE TABLE IF NOT EXISTS pra_operation_holders(id TEXT NOT NULL,device_hash TEXT NOT NULL,purged INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(id,device_hash))");
    db.sql.exec("CREATE TABLE IF NOT EXISTS pra_operation_purge_scopes(id TEXT PRIMARY KEY,verified INTEGER NOT NULL)");
    db.sql.exec("CREATE INDEX IF NOT EXISTS pra_operation_holders_device ON pra_operation_holders(device_hash,purged,id)");
  }
  has(id:string,hash:string){return !!this.db.sql.exec("SELECT id FROM pra_operation_holders WHERE id=? AND device_hash=?",id,hash).toArray().length;}
  dispatch(op:Operation,hash:string) {
    if(this.db.sql.exec("SELECT id FROM pra_deleted_operations WHERE id=?",op.id).toArray().length)throw new Problem("OPERATION_DELETED",410);
    this.db.sql.exec("INSERT OR IGNORE INTO pra_operation_holders(id,device_hash) VALUES(?,?)",op.id,hash);
  }
  receive(op:Operation,hash:string) {
    if(op.deliveryVersion===1&&!this.has(op.id,hash))throw new Problem("OPERATION_DEVICE_MISMATCH",403);
    // Old operations may prove one holder, never the completeness of their lost delivery history.
    if(op.deliveryVersion!==1)this.dispatch(op,hash);
  }
  capture(id:string,deletionId:string,op:Operation|undefined) {
    this.db.sql.exec("INSERT OR IGNORE INTO pra_deleted_operations(id,deletion_id) VALUES(?,?)",id,deletionId);
    this.db.sql.exec("INSERT OR IGNORE INTO pra_operation_purge_scopes(id,verified) VALUES(?,?)",id,Number(op?.deliveryVersion===1));
    this.recompute(id);
  }
  recompute(id:string) {
    this.db.sql.exec("UPDATE pra_deleted_operations SET purged=CASE WHEN EXISTS(SELECT 1 FROM pra_operation_purge_scopes s WHERE s.id=? AND s.verified=1) AND NOT EXISTS(SELECT 1 FROM pra_operation_holders h WHERE h.id=? AND h.purged=0) THEN 1 ELSE 0 END WHERE id=?",id,id,id);
  }
  pending(deletionId:string,hash?:string) {
    return hash===undefined
      ? this.db.sql.exec<{id:string}>("SELECT o.id FROM pra_deleted_operations o LEFT JOIN pra_operation_purge_scopes s ON s.id=o.id WHERE o.deletion_id=? AND (o.purged=0 OR COALESCE(s.verified,0)=0) LIMIT 200",deletionId).toArray().map(r=>r.id)
      : this.db.sql.exec<{id:string}>("SELECT o.id FROM pra_deleted_operations o JOIN pra_operation_holders h ON h.id=o.id WHERE o.deletion_id=? AND h.device_hash=? AND h.purged=0 LIMIT 200",deletionId,hash).toArray().map(r=>r.id);
  }
  unknown(deletionId:string) {
    return !!this.db.sql.exec("SELECT o.id FROM pra_deleted_operations o LEFT JOIN pra_operation_purge_scopes s ON s.id=o.id WHERE o.deletion_id=? AND COALESCE(s.verified,0)=0 LIMIT 1",deletionId).toArray().length;
  }
  late(id:string,hash:string) {
    const row=this.db.sql.exec<{deletion_id:string;verified:number}>("SELECT o.deletion_id,COALESCE(s.verified,0) AS verified FROM pra_deleted_operations o LEFT JOIN pra_operation_purge_scopes s ON s.id=o.id WHERE o.id=?",id).toArray()[0];
    if(!row)return;
    if(row.verified&&!this.has(id,hash))throw new Problem("OPERATION_DEVICE_MISMATCH",403);
    if(!row.verified)this.db.sql.exec("INSERT OR IGNORE INTO pra_operation_holders(id,device_hash) VALUES(?,?)",id,hash);
    this.recompute(id);return row.deletion_id;
  }
  acknowledge(deletionId:string,ids:unknown,hash:string) {
    if(!Array.isArray(ids)||!ids.length||ids.length>200||ids.some(id=>typeof id!=="string"||!id||id.length>512))throw new Problem("INVALID_PURGE_ACK");
    this.db.transactionSync(()=>{
      for(const id of ids){
        const row=this.db.sql.exec<{deletion_id:string}>("SELECT deletion_id FROM pra_deleted_operations WHERE id=?",id).toArray()[0];
        if(row?.deletion_id!==deletionId||!this.has(id,hash))throw new Problem("OPERATION_DEVICE_MISMATCH",403);
      }
      for(const id of ids){
        this.db.sql.exec("UPDATE pra_operation_holders SET purged=1 WHERE id=? AND device_hash=?",id,hash);this.recompute(id);
      }
    });
  }
}
