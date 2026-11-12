import {Problem} from "./domain.ts";
import type {StateStorage} from "./state-store.ts";
export interface ReaderPurge {id:string;deletion_id:string;device_hash:string;purged:number}
export class ReaderPurges {
  readonly db:StateStorage;
  constructor(db:StateStorage){this.db=db;
    db.sql.exec("CREATE TABLE IF NOT EXISTS pra_deleted_readers(id TEXT PRIMARY KEY,deletion_id TEXT NOT NULL,device_hash TEXT NOT NULL,purged INTEGER NOT NULL DEFAULT 0)");
    db.sql.exec("CREATE INDEX IF NOT EXISTS pra_deleted_readers_device ON pra_deleted_readers(device_hash,purged,deletion_id)");
  }
  get(id:string){return this.db.sql.exec<ReaderPurge>("SELECT * FROM pra_deleted_readers WHERE id=?",id).toArray()[0];}
  record(id:string,deletionId:string,hash:string){this.db.sql.exec("INSERT OR IGNORE INTO pra_deleted_readers(id,deletion_id,device_hash) VALUES(?,?,?)",id,deletionId,hash);}
  pending(hash:string,deletionId:string){return this.db.sql.exec<{id:string}>("SELECT id FROM pra_deleted_readers WHERE device_hash=? AND deletion_id=? AND purged=0 LIMIT 200",hash,deletionId).toArray().map(r=>r.id);}
  remaining(deletionId:string){return !!this.db.sql.exec("SELECT id FROM pra_deleted_readers WHERE deletion_id=? AND purged=0 LIMIT 1",deletionId).toArray().length;}
  acknowledge(deletionId:string,ids:unknown,hash:string){
    if(!Array.isArray(ids)||!ids.length||ids.length>200||ids.some(id=>typeof id!=="string"))throw new Problem("INVALID_PURGE_ACK");
    this.db.transactionSync(()=>{
      for(const id of ids){const r=this.get(id);if(!r||r.deletion_id!==deletionId||r.device_hash!==hash)throw new Problem("READER_DEVICE_MISMATCH",403);}
      for(const id of ids)this.db.sql.exec("UPDATE pra_deleted_readers SET purged=1 WHERE id=?",id);
    });
  }
}
