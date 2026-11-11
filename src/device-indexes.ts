import {Problem,text} from "./domain.ts";
import type {StateStorage} from "./state-store.ts";
/** Device-advertised immutable snapshots. Keep the list in SQLite, not the small WebSocket attachment. */
export class DeviceIndexes {
 storage:StateStorage;
 constructor(storage:StateStorage){
  this.storage=storage;
  storage.sql.exec("CREATE TABLE IF NOT EXISTS pra_device_indexes(device_hash TEXT NOT NULL,version TEXT NOT NULL,PRIMARY KEY(device_hash,version))");
 }
 declare(hash:string,active:string,retained:unknown){
  const values=retained===undefined?[active]:retained;
  if(!Array.isArray(values)||values.length>200||!values.includes(active))throw new Problem("INVALID_INDEX_INVENTORY");
  const wanted=new Set(values.map(v=>text(v,256)));
  this.storage.transactionSync(()=>{
   const prior=new Set(this.storage.sql.exec<{version:string}>("SELECT version FROM pra_device_indexes WHERE device_hash=?",hash).toArray().map(r=>r.version));
   for(const version of prior)if(!wanted.has(version))this.storage.sql.exec("DELETE FROM pra_device_indexes WHERE device_hash=? AND version=?",hash,version);
   for(const version of wanted)if(!prior.has(version))this.storage.sql.exec("INSERT INTO pra_device_indexes VALUES(?,?)",hash,version);
  });
 }
 supports(hash:string,version:string,active?:string){
  if(this.storage.sql.exec("SELECT 1 FROM pra_device_indexes WHERE device_hash=? AND version=?",hash,version).toArray().length===1)return true;
  return version===active&&this.storage.sql.exec("SELECT 1 FROM pra_device_indexes WHERE device_hash=? LIMIT 1",hash).toArray().length===0;
 }
 revoke(hash:string){this.storage.sql.exec("DELETE FROM pra_device_indexes WHERE device_hash=?",hash);}
}
