import {createHash} from "node:crypto";
import {Problem,text,type State,type Task} from "./domain.ts";
import type {StateStorage} from "./state-store.ts";
export const PLATFORM_LIMITS={
 workerRequests:[100000,10000],doRequestUpperEstimate:[100000,10000],doDuration:[13000,6500],
 sqliteRowsRead:[5000000,500000],sqliteRowsWritten:[100000,50000],sqliteStoredBytes:[5000000000,500000000]
} as const;
export const PLATFORM_STOPS=new Set(["PLATFORM_RESOURCE_LIMIT","PLATFORM_METRICS_STALE","PLATFORM_METRICS_UNAVAILABLE"]);
export interface PlatformStatus {enabled:boolean;blocked:boolean;reason?:string;nextCheck:number;observedAt?:number}
type Counts=Record<keyof typeof PLATFORM_LIMITS,number|null>;
interface Snapshot {accountScope:string;scriptName:string;observedAt:number;day:string;account:Counts;project:Counts}
const day=(now:number)=>new Date(now).toISOString().slice(0,10);
function counts(raw:any):Counts{
 const result={} as Counts;
 for(const key of Object.keys(PLATFORM_LIMITS) as (keyof Counts)[]){
  const item=raw?.[key];
  if(!item||!["observed","no_data","unavailable","truncated","invalid"].includes(item.status))throw new Problem("INVALID_PLATFORM_REPORT");
  if(item.status!=="observed"){result[key]=null;continue;}
  if(typeof item.value!=="number"||!Number.isFinite(item.value)||item.value<0||item.value>Number.MAX_SAFE_INTEGER)throw new Problem("INVALID_PLATFORM_REPORT");
  result[key]=item.value;
 }
 return result;
}
export class PlatformResources{
 readonly db:StateStorage;
 constructor(db:StateStorage){this.db=db;
  db.sql.exec("CREATE TABLE IF NOT EXISTS pra_platform_snapshot(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL)");
  db.sql.exec("CREATE TABLE IF NOT EXISTS pra_platform_requests(id TEXT PRIMARY KEY,hash TEXT NOT NULL,created INTEGER NOT NULL)");
 }
 knownRequest(id:string){return this.db.sql.exec("SELECT id FROM pra_platform_requests WHERE id=?",id).toArray().length>0;}
 snapshot(){return this.db.sql.exec<{value:string}>("SELECT value FROM pra_platform_snapshot WHERE id=1").toArray().map(r=>JSON.parse(r.value) as Snapshot)[0];}
 record(id:unknown,raw:any,scriptName:string|undefined,now=Date.now()){
  const requestId=text(id,128);
  if(!scriptName||raw?.scriptName!==scriptName||raw?.version!==1||raw?.source!=="Cloudflare GraphQL Analytics API"||!/^[a-f0-9]{64}$/.test(raw?.accountScope??""))throw new Problem("INVALID_PLATFORM_REPORT");
  const observedAt=Date.parse(raw.observedAt),start=Date.parse(raw.window?.start),end=Date.parse(raw.window?.end);
  if(!Number.isFinite(observedAt)||observedAt>now+30000||now-observedAt>600000||raw.window?.timezone!=="UTC"||raw.window?.day!==day(now)||start!==Date.parse(day(now)+"T00:00:00Z")||!Number.isFinite(end)||end>observedAt||observedAt-end>60000)throw new Problem("STALE_PLATFORM_REPORT",409);
  const snapshot:Snapshot={accountScope:raw.accountScope,scriptName,observedAt,day:day(now),account:counts(raw.account),project:counts(raw.project)};
  const value=JSON.stringify(snapshot),hash=createHash("sha256").update(value).digest("hex");
  return this.db.transactionSync(()=>{
   const replay=this.db.sql.exec<{hash:string}>("SELECT hash FROM pra_platform_requests WHERE id=?",requestId).toArray()[0];
   if(replay){if(replay.hash!==hash)throw new Problem("REQUEST_CONFLICT",409);return this.view(now);}
   const current=this.snapshot();
   if(current?.accountScope&&current.accountScope!==snapshot.accountScope)throw new Problem("PLATFORM_ACCOUNT_MISMATCH",409);
   if(current&&current.observedAt>=observedAt)throw new Problem("PLATFORM_REPORT_OUT_OF_ORDER",409);
   this.db.sql.exec("INSERT INTO pra_platform_snapshot VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",value);
   this.db.sql.exec("INSERT INTO pra_platform_requests VALUES(?,?,?)",requestId,hash,now);
   this.db.sql.exec("DELETE FROM pra_platform_requests WHERE id NOT IN (SELECT id FROM pra_platform_requests ORDER BY created DESC,id LIMIT 100)");
   return this.view(now);
  });
 }
 status(now=Date.now()):PlatformStatus{
  const s=this.snapshot(),nextCheck=now+60000;
  if(!s)return{enabled:false,blocked:false,nextCheck};
  if(s.day!==day(now)||now-s.observedAt>75*60000)return{enabled:true,blocked:true,reason:"PLATFORM_METRICS_STALE",nextCheck,observedAt:s.observedAt};
  const all=[...Object.values(s.account),...Object.values(s.project)];
  const limit=(Object.keys(PLATFORM_LIMITS) as (keyof Counts)[]).some(k=>(s.account[k]!==null&&s.account[k]!>=PLATFORM_LIMITS[k][0]*0.8)||(s.project[k]!==null&&s.project[k]!>=PLATFORM_LIMITS[k][1]));
  return{enabled:true,blocked:limit||all.includes(null),reason:limit?"PLATFORM_RESOURCE_LIMIT":all.includes(null)?"PLATFORM_METRICS_UNAVAILABLE":undefined,nextCheck,observedAt:s.observedAt};
 }
 view(now=Date.now()){const s=this.snapshot();return{...this.status(now),snapshot:s?{...s,accountScope:undefined}:null,automaticPauseApplied:this.status(now).blocked};}
}
export function applyPlatformWait(s:State,status:PlatformStatus){
 let changed=false;
 for(const t of s.tasks.filter(t=>t.origin==="schedule"&&!["completed","failed","cancelled"].includes(t.status))){
  if(status.blocked){
   if(t.platformWait&&t.status==="waiting_user"&&PLATFORM_STOPS.has(t.error??"")&&t.error!==status.reason){t.error=status.reason;changed=true;}
   if(!t.platformWait&&!t.pauseRequested&&!t.runOpen&&["queued","waiting_device"].includes(t.status)&&!s.operations.some(o=>o.taskId===t.id&&o.state==="sent")){
    t.platformWait=t.status as "queued"|"waiting_device";t.status="waiting_user";t.error=status.reason??"PLATFORM_METRICS_UNAVAILABLE";t.updated=Date.now();changed=true;
   }
  }else if(t.platformWait){
   const previous=t.platformWait;delete t.platformWait;changed=true;
   if(PLATFORM_STOPS.has(t.error??"")){
    t.error=undefined;
    if(t.status==="waiting_user"&&!t.pauseRequested)t.status=previous;
   }
  }
 }
 return changed;
}
