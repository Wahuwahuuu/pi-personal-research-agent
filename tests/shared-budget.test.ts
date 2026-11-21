import {VALIDATION_LIMITS} from "../src/validation-limits.ts";
import {test} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {SharedBudget} from "../src/shared-budget.ts";
import {ValidationBudget} from "../src/validation-budget.ts";
import {QWEN_PRICE,BudgetLedger} from "../src/budget.ts";
import type {StateStorage} from "../src/state-store.ts";
const now=Date.parse("2026-11-11T12:00:00+08:00");
function storage(){const db=new DatabaseSync(":memory:");let depth=0;const port:StateStorage={sql:{exec<T>(q:string,...b:any[]){const s=db.prepare(q),v=(s.columns().length?s.all(...b):(s.run(...b),[])) as T[];return{toArray:()=>v};}},transactionSync<T>(fn:()=>T){if(depth)return fn();db.exec("BEGIN");depth++;try{const v=fn();db.exec("COMMIT");return v;}catch(e){db.exec("ROLLBACK");throw e;}finally{depth--;}}};return {db,port};}
function setup(){const {db,port}=storage();const shared=new SharedBudget(port);for(const owner of ["a","b"])shared.validation.import(owner,{requests:0,input:0,output:0});return{db,port,shared};}
const request=(id:string,input=1000000,output=1000000)=>({id,taskId:"task-"+id,input,output,model:QWEN_PRICE.model,baseUrl:QWEN_PRICE.baseUrl});
test("shared task admission counts an unacknowledged reservation and does not charge a seventh",()=>{
 const {db,port,shared}=setup();
 const call=(id:string,used=0,limit=6)=>({...request(id,10,5),taskId:"root",taskBudget:{used,limit}});
 for(let i=0;i<5;i++){const r=shared.reserve("a",call("a"+i,i),now);assert.ok(r.ok);shared.settle("a",r.id,{input:2,output:1});}
 const missing=shared.reserve("a",call("unacknowledged",5),now);assert.ok(missing.ok);assert.equal(missing.taskCalls,6);
 const reopened=new SharedBudget(port),repeat=reopened.reserve("a",call("unacknowledged",5),now);
 assert.ok(repeat.ok);assert.equal(repeat.taskCalls,6);assert.equal(reopened.validation.snapshot().requests,6);
 const denied=reopened.reserve("a",call("retry",5),now+181000);assert.deepEqual(denied,{ok:false,error:"MODEL_BUDGET",taskCalls:6});
 assert.equal(reopened.taskCalls("a","root"),6);assert.equal(reopened.validation.snapshot().requests,6);
 assert.equal(reopened.calls("a").items.find(r=>r.id==="unacknowledged").status,"unknown");
 const other=reopened.reserve("b",call("another-owner"),now+181000);assert.ok(other.ok);assert.equal(other.taskCalls,1);
 assert.equal(reopened.taskCalls("a","root"),6);assert.equal(reopened.taskCalls("b","root"),1);db.close();
});

test("legacy task counts, imported receipts, translation and later segments keep a single cumulative allowance",()=>{
 const {db,port,shared}=setup();
 // The import source is a distinct historical ledger.
 const source=storage(),old=new BudgetLedger(source.port);
 const first={...request("historical",10,2),taskId:"goal"};old.reserve(first,now);old.settle(first.id,{input:4,output:1});
 shared.import("a",source.port.sql.exec("SELECT * FROM pra_model_calls").toArray());source.db.close();
 const bill=(id:string,used:number,limit:number)=>({...request(id,10,2),taskId:"goal",taskBudget:{used,limit}});
 const r=shared.reserve("a",bill("translation",4,6),now);assert.ok(r.ok);assert.equal(r.taskCalls,5);shared.settle("a",r.id,{input:3,output:1});
 const nextMonth=Date.parse("2026-12-01T02:00:00+08:00"),reopened=new SharedBudget(port);
 const last=reopened.reserve("a",bill("after-month",4,6),nextMonth);assert.ok(last.ok);assert.equal(last.taskCalls,6);reopened.settle("a",last.id,{input:3,output:1});
 assert.deepEqual(reopened.reserve("a",bill("more-than-segment",4,6),nextMonth),{ok:false,error:"MODEL_BUDGET",taskCalls:6});
 for(let n=6;n<24;n++){
  const admitted=reopened.reserve("a",bill("later-"+n,n,Math.min(24,(Math.floor(n/6)+1)*6)),nextMonth);
  assert.ok(admitted.ok);assert.equal(admitted.taskCalls,n+1);reopened.settle("a",admitted.id,{input:2,output:1});
 }
 assert.deepEqual(reopened.reserve("a",bill("beyond-goal",20,24),nextMonth),{ok:false,error:"MODEL_BUDGET",taskCalls:24});
 assert.throws(()=>reopened.reserve("a",bill("invalid",20,25),nextMonth),/INVALID_TASK_BUDGET/);
 assert.equal(reopened.snapshot(nextMonth).reserved,0);assert.equal(reopened.taskCalls("a","goal"),24);db.close();
});

test("two accounts share one application ceiling instead of receiving separate 50 CNY allowances",()=>{
 const {db,shared:s}=setup();let admitted=0;
 db.prepare("INSERT INTO pra_budget_months(month,spent) VALUES(?,?)").run("2026-11",49998000);
 for(let i=0;i<20;i++){const owner=i%2?"a":"b",r=s.reserve(owner,request(String(i),1000,100),now);if(r.ok){admitted++;s.settle(owner,r.id);}else assert.equal(r.error,"MONTHLY_BUDGET");}
 assert.equal(admitted,7);assert.equal(s.ledger.snapshot(now).estimatedSpent,49.99996);
 assert.equal(s.calls("a").items.length,3);assert.equal(s.calls("b").items.length,4);
 assert.equal(s.validation.snapshot().requests,7);
 assert.throws(()=>s.settle("b","1",{input:0,output:0}),/UNKNOWN_RESERVATION/);db.close();
});
test("budget migration is atomic, preserves prior month charges, and is applied once per owner",()=>{
 const source=setup(),dest=setup();source.shared.ledger.importLegacy({input:1000000,output:100000},now);
 const rows=source.port.sql.exec("SELECT * FROM pra_model_calls").toArray();dest.shared.import("a",rows);dest.shared.import("a",rows);dest.shared.import("b",rows);
 assert.equal(dest.shared.ledger.snapshot(now).estimatedSpent,3.36);
 const next=Date.parse("2026-12-01T12:00:00+08:00");assert.equal(dest.shared.ledger.snapshot(next).estimatedSpent,0);
 assert.throws(()=>dest.shared.import("c",[{...rows[0],charged:-1}]),/INVALID_BUDGET_IMPORT/);
 assert.equal(dest.port.sql.exec("SELECT * FROM pra_budget_imports WHERE owner='c'").toArray().length,0);source.db.close();dest.db.close();
});
test("registry restart leaves live reservations intact; stale attempts remain conservatively charged",()=>{
 const {db,port,shared:s}=setup();s.reserve("a",request("live",52000,2048),now);
 const reopened=new SharedBudget(port);assert.ok(reopened.ledger.snapshot(now).reserved>0);
 reopened.reserve("b",request("later",1,1),now+181000);
 const before=reopened.ledger.snapshot(now);assert.ok(before.estimatedSpent>0);
 reopened.settle("a","live",{input:1,output:1});assert.equal(reopened.ledger.snapshot(now).estimatedSpent,before.estimatedSpent);db.close();
});

test("lifetime request limit is shared across users, retries and a calendar boundary without new allowance",()=>{
 const {db,port,shared:s}=setup();
 for(let i=0;i<VALIDATION_LIMITS.requests;i++){
  const owner=i%2?"a":"b",r=s.reserve(owner,request("shared-"+i,1,1),now);
  assert.equal(r.ok,true);if(!r.ok)throw Error("DENIED");
  assert.equal(s.reserve(owner,request("shared-"+i,1,1),now).ok,true);
  s.settle(owner,r.id,{input:1,output:1});s.settle(owner,r.id,{input:100,output:100});
 }
 const reopened=new SharedBudget(port);
 for(let i=0;i<20;i++)assert.deepEqual(reopened.reserve(i%2?"a":"b",request("blocked-"+i,1,1),Date.parse("2026-12-01T00:00:00+08:00")),{ok:false,error:"VALIDATION_BUDGET"});
 assert.equal(reopened.validation.snapshot().requests,VALIDATION_LIMITS.requests);assert.equal(reopened.validation.snapshot().input,VALIDATION_LIMITS.requests);
 assert.equal(port.sql.exec("SELECT * FROM pra_model_calls").toArray().length,VALIDATION_LIMITS.requests);db.close();
});
test("old aggregate usage is imported once, conservatively includes interrupted reservations and cannot reset",()=>{
 const {db,shared:s}=setup();
 s.validation.import("legacy",{requests:VALIDATION_LIMITS.requests-1,input:1000,output:500,reservedInput:20,reservedOutput:10});
 s.validation.import("legacy",{requests:0,input:0,output:0});
 const before=s.validation.snapshot();assert.equal(before.requests,VALIDATION_LIMITS.requests-1);assert.equal(before.input,1020);assert.equal(before.output,510);
 assert.equal(s.reserve("a",request("last",1,1),now).ok,true);
 const amount=s.ledger.snapshot(now).reserved;s.settle("a","last");s.settle("a","last",{input:0,output:0});
 assert.equal(s.validation.snapshot().input,1021);assert.equal(s.ledger.snapshot(now).estimatedSpent,amount);
 assert.deepEqual(s.reserve("b",request("over",1,1),now),{ok:false,error:"VALIDATION_BUDGET"});db.close();
});
test("input and billing output guards reject without leaking money reservations over repeated attempts",()=>{
 for(const kind of ["input","output"] as const)for(let round=0;round<10;round++){
  const {db,shared:s}=setup();
  s.validation.import("legacy",{requests:20,input:kind==="input"?VALIDATION_LIMITS.input-1:0,output:kind==="output"?VALIDATION_LIMITS.output-1:0});
  assert.equal(s.reserve("a",request("last",1,1),now).ok,true);
  for(let i=0;i<5;i++)assert.deepEqual(s.reserve("b",request("over"+i,1,1),now),{ok:false,error:"VALIDATION_BUDGET"});
  assert.equal(s.calls("b").items.length,0);assert.equal(s.validation.snapshot().requests,21);
  s.settle("a","last");const v=s.validation.snapshot();assert.equal(v.blocked,true);
  assert.equal(v.reservedInput,0);assert.equal(v.reservedOutput,0);
  assert.deepEqual(s.reserve("b",request("zero",0,0),now),{ok:false,error:"VALIDATION_BUDGET"});db.close();
 }
});
test("unmigrated accounts cannot reserve and invalid migration leaves no imported marker",()=>{
 const {db,shared:s}=setup();
 assert.deepEqual(s.reserve("new",request("blocked",1,1),now),{ok:false,error:"VALIDATION_MIGRATION_REQUIRED"});
 assert.throws(()=>s.validation.import("new",{requests:-1,input:0,output:0}),/INVALID_VALIDATION_USAGE/);
 assert.equal(s.validation.imported("new"),false);assert.equal(s.ledger.snapshot(now).reserved,0);db.close();
});


test("approved request ceiling preserves an exhausted historical counter instead of granting a fresh quota",()=>{
 const {db,port,shared:s}=setup();s.validation.import('legacy-ceiling',{requests:500,input:1200000,output:100000,reservedInput:52000,reservedOutput:2048});
 s.ledger.importLegacy({input:1200000,output:100000},now);const before=s.snapshot(now),priorRows=port.sql.exec('SELECT * FROM pra_validation_imports ORDER BY owner').toArray();
 const reopened=new SharedBudget(port);assert.deepEqual(reopened.snapshot(now).validation,before.validation);assert.equal(reopened.snapshot(now).estimatedSpent,before.estimatedSpent);
 assert.equal(reopened.reserve('a',request('continuation',1,1),now).ok,true);reopened.settle('a','continuation',{input:1,output:1});
 const after=reopened.snapshot(now);assert.equal(after.validation.requests,501);assert.equal(after.validation.input,1252001);assert.equal(after.validation.output,102049);
 assert.deepEqual(after.validation.limits,{requests:1500,input:12000000,output:2000000});assert.equal(after.limit,50);assert.equal(after.backgroundLimit,20);
 assert.deepEqual(port.sql.exec('SELECT * FROM pra_validation_imports ORDER BY owner').toArray(),priorRows);assert.ok(after.estimatedSpent>=before.estimatedSpent);db.close();
});

test("lifetime totals migrate once, roll back on failure and follow older writers",()=>{
 const {db,port}=storage();
 db.exec(`
  CREATE TABLE pra_validation_imports(owner TEXT PRIMARY KEY,requests INTEGER NOT NULL,input INTEGER NOT NULL,output INTEGER NOT NULL);
  CREATE TABLE pra_validation_calls(id TEXT PRIMARY KEY,owner TEXT NOT NULL,task TEXT NOT NULL,input_bound INTEGER NOT NULL,output_bound INTEGER NOT NULL,input INTEGER,output INTEGER,status TEXT NOT NULL,created INTEGER NOT NULL);
  INSERT INTO pra_validation_imports VALUES('legacy',7,100,10);
  INSERT INTO pra_validation_calls VALUES('finished','legacy','t',50,10,20,4,'settled',1),
   ('unknown','legacy','t',70,5,70,5,'unknown',2),('pending','legacy','t',80,8,NULL,NULL,'reserved',3);
 `);
 const failing:StateStorage={...port,sql:{exec(query,...bindings){
  if(query.includes("CREATE TRIGGER pra_validation_total_settle"))throw Error("migration interrupted");
  return port.sql.exec(query,...bindings);
 }}};
 assert.throws(()=>new ValidationBudget(failing),/migration interrupted/);
 assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='pra_validation_totals'").get(),undefined);
 const ledger=new ValidationBudget(port);
 const counts=(v:ValidationBudget)=>{const {requests,input,output,reservedInput,reservedOutput}=v.snapshot();return {requests,input,output,reservedInput,reservedOutput};};
 assert.deepEqual(counts(ledger),{requests:10,input:190,output:19,reservedInput:80,reservedOutput:8});
 const insert=db.prepare("INSERT INTO pra_validation_calls VALUES(?, 'legacy','t',9,3,NULL,NULL,'reserved',4)");
 const before=counts(ledger);
 assert.throws(()=>port.transactionSync(()=>{insert.run("rollback");ledger.settle("legacy","pending");throw Error("abort");}),/abort/);
 assert.deepEqual(counts(ledger),before);
 insert.run("older-version");
 db.prepare("UPDATE pra_validation_calls SET input=?,output=?,status='settled' WHERE id=?").run(5,2,"older-version");
 db.prepare("INSERT INTO pra_validation_imports VALUES(?,?,?,?)").run("later-account",2,3,4);
 ledger.settle("legacy","pending");ledger.settle("legacy","pending",{input:1,output:0});
 const expected={requests:13,input:278,output:33,reservedInput:0,reservedOutput:0};
 assert.deepEqual(counts(ledger),expected);
 const reopened=new ValidationBudget(port);reopened.import("legacy",{requests:0,input:0,output:0});
 assert.deepEqual(counts(reopened),expected);db.close();
});
