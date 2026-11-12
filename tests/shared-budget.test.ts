import {test} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {SharedBudget} from "../src/shared-budget.ts";
import {QWEN_PRICE,BudgetLedger} from "../src/budget.ts";
import type {StateStorage} from "../src/state-store.ts";
const now=Date.parse("2026-11-11T12:00:00+08:00");
function setup(){const db=new DatabaseSync(":memory:");let depth=0;const port:StateStorage={sql:{exec<T>(q:string,...b:any[]){const s=db.prepare(q),v=(s.columns().length?s.all(...b):(s.run(...b),[])) as T[];return{toArray:()=>v};}},transactionSync<T>(fn:()=>T){if(depth)return fn();db.exec("BEGIN");depth++;try{const v=fn();db.exec("COMMIT");return v;}catch(e){db.exec("ROLLBACK");throw e;}finally{depth--;}}};const shared=new SharedBudget(port);for(const owner of ["a","b"])shared.validation.import(owner,{requests:0,input:0,output:0});return{db,port,shared};}
const request=(id:string,input=1000000,output=1000000)=>({id,taskId:"task-"+id,input,output,model:QWEN_PRICE.model,baseUrl:QWEN_PRICE.baseUrl});
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

test("500 requests are shared across users, retries and a calendar boundary without new allowance",()=>{
 const {db,port,shared:s}=setup();
 for(let i=0;i<500;i++){
  const owner=i%2?"a":"b",r=s.reserve(owner,request("shared-"+i,1,1),now);
  assert.equal(r.ok,true);if(!r.ok)throw Error("DENIED");
  assert.equal(s.reserve(owner,request("shared-"+i,1,1),now).ok,true);
  s.settle(owner,r.id,{input:1,output:1});s.settle(owner,r.id,{input:100,output:100});
 }
 const reopened=new SharedBudget(port);
 for(let i=0;i<20;i++)assert.deepEqual(reopened.reserve(i%2?"a":"b",request("blocked-"+i,1,1),Date.parse("2026-12-01T00:00:00+08:00")),{ok:false,error:"VALIDATION_BUDGET"});
 assert.equal(reopened.validation.snapshot().requests,500);assert.equal(reopened.validation.snapshot().input,500);
 assert.equal(port.sql.exec("SELECT * FROM pra_model_calls").toArray().length,500);db.close();
});
test("old aggregate usage is imported once, conservatively includes interrupted reservations and cannot reset",()=>{
 const {db,shared:s}=setup();
 s.validation.import("legacy",{requests:499,input:1000,output:500,reservedInput:20,reservedOutput:10});
 s.validation.import("legacy",{requests:0,input:0,output:0});
 const before=s.validation.snapshot();assert.equal(before.requests,499);assert.equal(before.input,1020);assert.equal(before.output,510);
 assert.equal(s.reserve("a",request("last",1,1),now).ok,true);
 const amount=s.ledger.snapshot(now).reserved;s.settle("a","last");s.settle("a","last",{input:0,output:0});
 assert.equal(s.validation.snapshot().input,1021);assert.equal(s.ledger.snapshot(now).estimatedSpent,amount);
 assert.deepEqual(s.reserve("b",request("over",1,1),now),{ok:false,error:"VALIDATION_BUDGET"});db.close();
});
test("input and billing output guards reject without leaking money reservations over repeated attempts",()=>{
 for(const kind of ["input","output"] as const)for(let round=0;round<10;round++){
  const {db,shared:s}=setup();
  s.validation.import("legacy",{requests:20,input:kind==="input"?5999999:0,output:kind==="output"?999999:0});
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
