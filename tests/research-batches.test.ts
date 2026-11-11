import {test} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {ResearchBatches} from "../src/research-batches.ts";
import {type Plan,type Paper} from "../src/domain.ts";
import {StateRepository,type StateStorage} from "../src/state-store.ts";
function fixture(){
 const db=new DatabaseSync(":memory:");let depth=0,fail=false;
 const storage:StateStorage={sql:{exec<T>(q:string,...b:any[]){if(fail&&q.startsWith("INSERT INTO pra_research_candidates"))throw Error("INJECTED_WRITE_FAILURE");const s=db.prepare(q);const rows=s.columns().length?s.all(...b) as T[]:(s.run(...b),[] as T[]);return{toArray:()=>rows};}},transactionSync(fn){if(depth)return fn();db.exec("BEGIN");depth++;try{const v=fn();db.exec("COMMIT");return v;}catch(e){db.exec("ROLLBACK");throw e;}finally{depth--;}}};
 return{db,storage,batches:new ResearchBatches(storage),inject:()=>{fail=true;}};
}
const plan=(id="topic"):Plan=>({id,query:"agents",objective:"Study source-grounded agents",projectId:"project",enabled:true,autoProcess:true,revision:1,maxPapers:3,cursor:86400000*14,next:0});
const paper=(i:number):Paper=>({id:"2601."+String(i).padStart(5,"0"),version:"v1",title:"Public metadata "+i,summary:"Summary",published:"2026-01-01T00:00:00Z",updated:"2026-01-02T00:00:00Z",url:"https://arxiv.org/abs/2601."+String(i).padStart(5,"0")+"v1"});
test("1000 records, repeated pages and a late record retain independent discovery and processing checkpoints",()=>{
 const f=fixture(),p=plan(),start=p.cursor;try{
  const b=f.batches.start(p,86400000*15);assert.equal(b.from,86400000*7);
  const all=Array.from({length:1000},(_,i)=>paper(i));
  for(let offset=0;offset<1000;offset+=200){
   f.batches.commit(p,b.id,offset,all.slice(offset,offset+200),false);
   assert.equal(f.batches.commit(p,b.id,offset,all.slice(offset,offset+200),false),false);
   assert.equal(p.cursor,start);
  }
  f.batches.commit(p,b.id,1000,[all[0]],true);assert.equal(p.cursor,b.until);
  assert.equal(f.batches.get(b.id).status,"screening");assert.equal(f.batches.counts(b.id).discovered,1000);
  const restored=new ResearchBatches(f.storage);assert.equal(restored.candidates(b.id,800,200).items.length,200);
  const next=restored.start(p,86400000*16);restored.commit(p,next.id,0,[all[0],paper(1001)],true);
  assert.equal(restored.counts(next.id).discovered,1);assert.equal(restored.get(next.id).discovered,1);
  assert.equal(restored.get(b.id).status,"screening"); // Discovery completion never says analysis completed.
 }finally{f.db.close();}
});
test("each topic keeps its own seen set, while unchanged cycles produce no work or notification",()=>{
 const f=fixture(),a=plan("a"),b=plan("b");try{
  for(const p of[a,b]){const batch=f.batches.start(p,5000000000);f.batches.commit(p,batch.id,0,[paper(1)],true);}
  assert.equal(f.batches.page().items.length,2);assert.equal(f.batches.pending().length,2);
  for(const c of f.batches.backlog(a.id,1))f.batches.updateCandidate(c.id,{phase:"skipped",reason:"No relevant change"});
  const repeated=f.batches.start(a,5000001000);f.batches.commit(a,repeated.id,0,[paper(1)],true);
  assert.equal(f.batches.get(repeated.id).status,"completed");assert.deepEqual(f.batches.counts(repeated.id),{});
  const topics=f.batches.pending();assert.equal(topics.length,2);assert.equal(topics.every(v=>v.discovered===1),true);
 }finally{f.db.close();}
});
test("source failure and database interruption do not advance a successful discovery cursor",()=>{
 const f=fixture(),p=plan();try{
  const b=f.batches.start(p,5000000000),original=structuredClone(p);
  f.batches.sourceFailure(p,b.id,"SOURCE_UNAVAILABLE",5000000100);
  assert.equal(p.cursor,original.cursor);assert.equal(p.sourceError,"SOURCE_UNAVAILABLE");assert.equal(p.next,5000900100);
  f.inject();assert.throws(()=>f.batches.commit(p,b.id,0,[paper(1)],true),/INJECTED/);
  assert.equal(p.cursor,original.cursor);assert.equal(p.batch!.offset,0);assert.equal(f.batches.get(b.id).offset,0);
  assert.deepEqual(f.batches.candidates(b.id).items,[]);
 }finally{f.db.close();}
});
test("page commit and application checkpoint can be rolled back as one transaction",()=>{
 const f=fixture(),repo=new StateRepository(f.storage),s=repo.load(),p=plan();try{
  s.plans.push(p);const b=f.batches.start(p,5000000000);repo.save(s);
  assert.throws(()=>f.storage.transactionSync(()=>{f.batches.commit(p,b.id,0,[paper(1)],true);repo.save(s);throw Error("CRASH");}),/CRASH/);
  const recovered=repo.load().plans[0];assert.equal(recovered.cursor,86400000*14);assert.equal(recovered.batch!.offset,0);
  assert.deepEqual(f.batches.candidates(b.id).items,[]);
  f.storage.transactionSync(()=>{f.batches.commit(recovered,b.id,0,[paper(1)],true);const state=repo.load();state.plans=[recovered];repo.save(state);});
  assert.equal(repo.load().plans[0].cursor,b.until);assert.equal(f.batches.counts(b.id).discovered,1);
 }finally{f.db.close();}
});
test("legacy topics remain metadata-only and revision changes can inspect a source again explicitly",()=>{
 const f=fixture(),p=plan();delete p.autoProcess;try{
  const b=f.batches.start(p,5000000000);f.batches.commit(p,b.id,0,[paper(1)],true);
  assert.equal(f.batches.get(b.id).status,"metadata_only");assert.deepEqual(f.batches.pending(),[]);
  p.autoProcess=true;p.revision=2;
  const next=f.batches.start(p,5000000001);f.batches.commit(p,next.id,0,[paper(1)],true);
  assert.equal(f.batches.get(next.id).status,"screening");
 }finally{f.db.close();}
});
test("source identity and page bounds are validated before anything is saved",()=>{
 const f=fixture(),p=plan();try{
  const b=f.batches.start(p,5000000000),bad={...paper(1),url:"https://attacker.invalid/document"};
  assert.throws(()=>f.batches.commit(p,b.id,0,[bad],true),/INVALID_DISCOVERY_SOURCE/);
  assert.throws(()=>f.batches.commit(p,b.id,1,[paper(1)],true),/INVALID_DISCOVERY_PAGE/);
  assert.throws(()=>f.batches.commit(p,b.id,0,Array.from({length:201},(_,i)=>paper(i)),true),/INVALID_DISCOVERY_PAGE/);
  assert.equal(p.batch!.offset,0);assert.deepEqual(f.batches.candidates(b.id).items,[]);
 }finally{f.db.close();}
});
test("topic deletion removes metadata and checkpoints but preserves minimal replay tombstones",()=>{
 const f=fixture(),p=plan();try{
  const b=f.batches.start(p,5000000000);f.batches.commit(p,b.id,0,[paper(1)],false);
  assert.deepEqual(f.batches.removePlan(p.id),[b.id]);assert.deepEqual(f.batches.page().items,[]);
  assert.throws(()=>f.batches.start(p,5000000000),/BATCH_DELETED/);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM pra_research_candidates").get()!.n,0);
  const tombstone=f.db.prepare("SELECT * FROM pra_research_batch_tombstones").get();assert.deepEqual(Object.keys(tombstone!),["id"]);
 }finally{f.db.close();}
});

test("an unfinished legacy page restarts the same discovery window instead of dropping unjournaled rows",()=>{
 const f=fixture(),p=plan();p.batch={from:100,until:200,offset:200,count:200};
 try{const b=f.batches.start(p,300);assert.equal(b.from,100);assert.equal(b.until,200);assert.equal(b.offset,0);assert.equal(p.batch!.offset,0);}
 finally{f.db.close();}
});
