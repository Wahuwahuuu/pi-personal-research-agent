import {test} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {PlatformResources,PLATFORM_LIMITS,applyPlatformWait} from "../src/platform-resources.ts";
import {initialState,submit,operation} from "../src/domain.ts";
import type {StateStorage} from "../src/state-store.ts";
const now=Date.parse("2026-11-12T10:00:00Z");
function fixture(){
 const db=new DatabaseSync(":memory:");
 const port:StateStorage={sql:{exec<T>(q:string,...b:any[]){const s=db.prepare(q);const r=(s.columns().length?s.all(...b):(s.run(...b),[])) as T[];return{toArray:()=>r};}},transactionSync<T>(f:()=>T){db.exec("BEGIN");try{const result=f();db.exec("COMMIT");return result;}catch(e){db.exec("ROLLBACK");throw e;}}};
 return{db,guard:new PlatformResources(port)};
}
function report(at=now,value=10){
 return{version:1,source:"Cloudflare GraphQL Analytics API",accountScope:"a".repeat(64),scriptName:"research",observedAt:new Date(at).toISOString(),
  window:{day:new Date(at).toISOString().slice(0,10),timezone:"UTC",start:new Date(at).toISOString().slice(0,10)+"T00:00:00.000Z",end:new Date(at).toISOString()},
  account:Object.fromEntries(Object.keys(PLATFORM_LIMITS).map(k=>[k,{status:"observed",value}])),
  project:Object.fromEntries(Object.keys(PLATFORM_LIMITS).map(k=>[k,{status:"observed",value}])),backgroundRecommendation:"within-observed-targets"};
}
test("first fresh report enables shared guard; server thresholds override client suggestions and fake limits",()=>{
 const f=fixture();try{
  assert.equal(f.guard.status(now).enabled,false);
  const r=report();r.project.sqliteRowsRead.value=500000;(r.project.sqliteRowsRead as any).projectTarget=999999999;
  const result=f.guard.record("r",r,"research",now);
  assert.equal(result.blocked,true);assert.equal(result.reason,"PLATFORM_RESOURCE_LIMIT");
  assert.equal(result.automaticPauseApplied,true);
  f.guard.record("safe",report(now+1),"research",now+1);assert.equal(f.guard.status(now+1).blocked,false);
  assert.equal(f.guard.status(now+76*60000).reason,"PLATFORM_METRICS_STALE");
 }finally{f.db.close();}
});
test("unknown statistics stop background admission, while stale and cross-day reports cannot re-enable it",()=>{
 const f=fixture();try{
  const r=report();r.project.sqliteRowsRead={status:"no_data",value:0};
  f.guard.record("unknown",r,"research",now);assert.equal(f.guard.status(now).reason,"PLATFORM_METRICS_UNAVAILABLE");
  assert.equal(f.guard.snapshot()?.project.sqliteRowsRead,null);
  assert.throws(()=>f.guard.record("stale",report(now-11*60000),"research",now),/STALE_PLATFORM_REPORT/);
  const midnight=Date.parse("2026-11-13T00:00:00Z");
  f.guard.record("before",report(midnight-1),"research",midnight-1);
  assert.equal(f.guard.status(midnight).reason,"PLATFORM_METRICS_STALE");
 }finally{f.db.close();}
});
test("idempotent imports, account binding and timestamp ordering prevent old low usage from reopening work",()=>{
 const f=fixture();try{
  const r=report();f.guard.record("once",r,"research",now);
  assert.deepEqual(f.guard.record("once",r,"research",now),f.guard.view(now));
  assert.throws(()=>f.guard.record("once",report(now,11),"research",now),/REQUEST_CONFLICT/);
  assert.throws(()=>f.guard.record("older",report(now-1),"research",now),/OUT_OF_ORDER/);
  const foreign=report(now+1);foreign.accountScope="b".repeat(64);
  assert.throws(()=>f.guard.record("foreign",foreign,"research",now+1),/ACCOUNT_MISMATCH/);
 }finally{f.db.close();}
});
test("report validation rejects wrong worker, missing/negative fields and future timestamps; extra private fields are dropped",()=>{
 const f=fixture();try{
  assert.throws(()=>f.guard.record("wrong",report(),"other",now),/INVALID_PLATFORM_REPORT/);
  const r=report();r.account.workerRequests.value=-1;
  assert.throws(()=>f.guard.record("negative",r,"research",now),/INVALID_PLATFORM_REPORT/);
  assert.throws(()=>f.guard.record("future",report(now+31000),"research",now),/STALE_PLATFORM_REPORT/);
  const safe={...report(),extra:"PRIVATE_METRICS_CANARY"};f.guard.record("safe",safe,"research",now);
  assert.equal(JSON.stringify(f.db.prepare("SELECT * FROM pra_platform_snapshot").all()).includes("PRIVATE_METRICS_CANARY"),false);
  assert.equal(JSON.stringify(f.guard.view(now)).includes("a".repeat(64)),false);
 }finally{f.db.close();}
});
test("task hold keeps IDs, total allowances and operations; recovery never cancels a manual pause",()=>{
 const s=initialState(),t=submit(s,"background","task","research");t.origin="schedule";t.calls=5;t.tools=3;
 const foreground=submit(s,"chat","front","chat");
 const block={enabled:true,blocked:true,reason:"PLATFORM_RESOURCE_LIMIT",nextCheck:now+60000};
 assert.equal(applyPlatformWait(s,block),true);assert.equal(t.status,"waiting_user");assert.equal(foreground.status,"queued");
 const id=t.id;assert.equal(applyPlatformWait(s,block),false);
 assert.equal(applyPlatformWait(s,{enabled:true,blocked:false,nextCheck:now+60000}),true);
 assert.equal(t.id,id);assert.equal(t.status,"queued");assert.equal(t.calls,5);assert.equal(t.tools,3);
 applyPlatformWait(s,block);t.status="paused";t.pauseRequested=true;
 applyPlatformWait(s,{enabled:true,blocked:false,nextCheck:now+60000});assert.equal(t.status,"paused");assert.equal(t.pauseRequested,true);
});
test("active model/tool steps settle before holding, and other human decisions are not auto-resumed",()=>{
 const s=initialState(),t=submit(s,"background","task","research");t.origin="schedule";
 const block={enabled:true,blocked:true,reason:"PLATFORM_RESOURCE_LIMIT",nextCheck:now+60000};
 t.runOpen=true;applyPlatformWait(s,block);assert.equal(t.platformWait,undefined);
 t.runOpen=false;const op=operation(s,t,"index","search_papers",{query:"q"});op.state="sent";
 applyPlatformWait(s,block);assert.equal(t.platformWait,undefined);
 op.state="done";t.status="queued";applyPlatformWait(s,block);assert.equal(t.status,"waiting_user");
 t.error="CONTEXT_CHANGED";applyPlatformWait(s,{enabled:true,blocked:false,nextCheck:now+60000});assert.equal(t.status,"waiting_user");assert.equal(t.error,"CONTEXT_CHANGED");
});
