import {test} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {appendChanges,CHANGE_WINDOW,CHANGE_CLEANUP_BATCH,readChanges} from "../src/change-feed.ts";
import {StateRepository,type StateStorage} from "../src/state-store.ts";
import {submit} from "../src/domain.ts";
import {Artifacts} from "../src/artifacts.ts";

function fixture(){
 const db=new DatabaseSync(":memory:");
 let failCleanup=false;
 const storage:StateStorage={
  sql:{exec<T>(q:string,...b:any[]){
   const stmt=db.prepare(q),rows=(stmt.columns().length?stmt.all(...b):(stmt.run(...b),[])) as T[];
   if(failCleanup&&q.startsWith("DELETE FROM pra_changes"))throw Error("INJECTED_CLEANUP_FAILURE");
   return{toArray:()=>rows};
  }},
  transactionSync<T>(fn:()=>T){db.exec("BEGIN");try{const value=fn();db.exec("COMMIT");return value;}catch(e){db.exec("ROLLBACK");throw e;}}
 };
 const repository=new StateRepository(storage);
 const count=()=>Number(db.prepare("SELECT COUNT(*) n FROM pra_changes").get()!.n);
 const seed=(n:number)=>storage.transactionSync(()=>{
  const stmt=db.prepare("INSERT INTO pra_changes(created,value) VALUES(1,?)");
  for(let i=0;i<n;i++)stmt.run(JSON.stringify([{entity:"tasks",id:String(i)}]));
 });
 return{db,storage,repository,count,seed,setFailure:(v:boolean)=>{failCleanup=v;}};
}

test("ongoing invalidations stay bounded without removing research records or resetting the cursor",()=>{
 const f=fixture();
 try{
  const s=f.repository.load();submit(s,"Retain this question","original","chat");f.repository.save(s);
  const before=JSON.stringify(f.repository.page("tasks"));
  f.storage.transactionSync(()=>{for(let i=0;i<CHANGE_WINDOW+15;i++)appendChanges(f.storage,[{entity:"tasks",id:"task"}]);});
  assert.equal(f.count(),CHANGE_WINDOW);
  const cursor=f.repository.cursor();assert.equal(cursor,CHANGE_WINDOW+16);
  assert.deepEqual(f.repository.changes(0),{events:[],cursor,latest:cursor,oldestCursor:16,resetRequired:true,reason:"retention"});
  assert.equal(JSON.stringify(f.repository.page("tasks")),before);
  assert.equal(f.repository.changes(16,1).events[0].seq,17);
  const reopened=new StateRepository(f.storage);const state=reopened.load();
  state.tasks[0].status="cancelled";reopened.save(state);
  assert.equal(reopened.cursor(),cursor+1);assert.equal(f.count(),CHANGE_WINDOW);
 }finally{f.db.close();}
});

test("legacy backlog drains in bounded batches and is logically expired before physical deletion completes",()=>{
 const f=fixture();
 try{
  f.seed(CHANGE_WINDOW+4*CHANGE_CLEANUP_BATCH);
  const initial=f.count(),page=f.repository.changes(0);
  assert.equal(initial-f.count(),CHANGE_CLEANUP_BATCH);
  assert.equal(page.resetRequired,true);assert.equal(page.oldestCursor,4*CHANGE_CLEANUP_BATCH);assert.deepEqual(page.events,[]);
  const valid=f.repository.changes(page.oldestCursor,100);
  assert.equal(initial-f.count(),2*CHANGE_CLEANUP_BATCH);
  assert.equal(valid.resetRequired,false);assert.equal(valid.events[0].seq,page.oldestCursor+1);assert.equal(valid.events.length,100);
  f.repository.changes(valid.cursor);f.repository.changes(page.latest);
  assert.equal(f.count(),CHANGE_WINDOW);
  assert.equal(f.repository.changes(page.latest).events.length,0);
 }finally{f.db.close();}
});

test("future cursors force a full refresh, while live pagination preserves every event exactly once",()=>{
 const f=fixture();
 try{
  assert.equal(readChanges(f.storage).resetRequired,false);
  assert.equal(readChanges(f.storage,1).reason,"cursor_ahead");
  f.seed(241);
  const seen:number[]=[];let cursor=0;
  do{const p=readChanges(f.storage,cursor,37);assert.equal(p.resetRequired,false);seen.push(...p.events.map(e=>e.seq));cursor=p.cursor;}while(cursor<241);
  assert.deepEqual(seen,Array.from({length:241},(_,i)=>i+1));
  assert.deepEqual(readChanges(f.storage,242),{events:[],cursor:241,latest:241,oldestCursor:0,resetRequired:true,reason:"cursor_ahead"});
  for(const args of [[-1,10],[NaN,10],[0,0],[0,101],[1.1,10],[Number.MAX_SAFE_INTEGER+1,10]]){
   assert.throws(()=>readChanges(f.storage,...args as [number,number]),/INVALID_CURSOR/);
  }
  assert.equal(f.count(),241);
 }finally{f.db.close();}
});

test("cleanup failure rolls back business data, append and deletion, and a retry uses the original clean cache",()=>{
 const f=fixture();
 try{
  f.seed(CHANGE_WINDOW);const s=f.repository.load();
  submit(s,"Atomic retained input","new","chat");f.setFailure(true);
  assert.throws(()=>f.repository.save(s),/INJECTED_CLEANUP/);
  assert.equal(f.repository.cursor(),CHANGE_WINDOW);assert.equal(f.count(),CHANGE_WINDOW);
  assert.equal(f.db.prepare("SELECT MIN(seq) n FROM pra_changes").get()!.n,1);
  assert.deepEqual(f.repository.page("tasks").items,[]);
  f.setFailure(false);const result=f.repository.save(s);
  assert.equal(result.cursor,CHANGE_WINDOW+1);assert.equal(f.count(),CHANGE_WINDOW);
  assert.equal(f.repository.page("tasks").items[0].input,"Atomic retained input");
 }finally{f.db.close();}
});

test("recovery cursor jumps invalidate obsolete windows and the following append remains monotonic",()=>{
 const f=fixture();
 try{
  f.seed(5);const guardCursor=2*CHANGE_WINDOW;
  f.storage.transactionSync(()=>appendChanges(f.storage,[{entity:"recovery",id:"restore"}],guardCursor));
  assert.equal(f.count(),1);assert.equal(f.repository.cursor(),guardCursor+1);
  assert.equal(f.repository.changes(5).reason,"retention");
  const p=f.repository.changes(guardCursor);
  assert.equal(p.resetRequired,false);assert.equal(p.events[0].changes[0].entity,"recovery");
  const reopened=new StateRepository(f.storage);
  f.storage.transactionSync(()=>appendChanges(f.storage,[{entity:"tasks",id:"next"}]));
  assert.equal(reopened.cursor(),guardCursor+2);
  assert.throws(()=>appendChanges(f.storage,[{entity:"recovery",id:"bad"}],Number.MAX_SAFE_INTEGER),/INVALID_CURSOR/);
 }finally{f.db.close();}
});

test("artifact-only workloads use the same retention window without losing revisions",()=>{
 const f=fixture();
 try{
  const artifacts=new Artifacts(f.storage);f.seed(CHANGE_WINDOW+10);
  const saved=artifacts.create({projectId:"p",conversationId:"c",taskId:"t",kind:"reading",title:"Saved evidence",partial:false},"Retain the artifact",[]);
  assert.equal(f.count(),CHANGE_WINDOW);assert.equal(f.repository.changes(0).resetRequired,true);
  artifacts.revise(saved.id,1,"Corrected evidence");
  assert.equal(artifacts.get(saved.id,1).content,"Retain the artifact");assert.equal(artifacts.get(saved.id).content,"Corrected evidence");
  assert.equal(f.count(),CHANGE_WINDOW);
 }finally{f.db.close();}
});
