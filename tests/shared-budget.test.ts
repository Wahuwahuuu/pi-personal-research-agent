import {test} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {SharedBudget} from "../src/shared-budget.ts";
import {QWEN_PRICE,BudgetLedger} from "../src/budget.ts";
import type {StateStorage} from "../src/state-store.ts";
const now=Date.parse("2026-11-11T12:00:00+08:00");
function setup(){const db=new DatabaseSync(":memory:");let depth=0;const port:StateStorage={sql:{exec<T>(q:string,...b:any[]){const s=db.prepare(q),v=(s.columns().length?s.all(...b):(s.run(...b),[])) as T[];return{toArray:()=>v};}},transactionSync<T>(fn:()=>T){if(depth)return fn();db.exec("BEGIN");depth++;try{const v=fn();db.exec("COMMIT");return v;}catch(e){db.exec("ROLLBACK");throw e;}finally{depth--;}}};return{db,port,shared:new SharedBudget(port)};}
const request=(id:string,input=1000000,output=1000000)=>({id,taskId:"task-"+id,input,output,model:QWEN_PRICE.model,baseUrl:QWEN_PRICE.baseUrl});
test("two accounts share one application ceiling instead of receiving separate 50 CNY allowances",()=>{
 const {db,shared:s}=setup();let admitted=0;
 for(let i=0;i<20;i++){const owner=i%2?"a":"b",r=s.reserve(owner,request(String(i)),now);if(r.ok){admitted++;s.settle(owner,r.id);}else assert.equal(r.error,"MONTHLY_BUDGET");}
 assert.equal(admitted,8);assert.equal(s.ledger.snapshot(now).estimatedSpent,48);
 assert.equal(s.calls("a").items.length,4);assert.equal(s.calls("b").items.length,4);
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
