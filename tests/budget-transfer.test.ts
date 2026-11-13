import {test} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {SharedBudget} from "../src/shared-budget.ts";
import {QWEN_PRICE} from "../src/budget.ts";
import {parseCarryover,parseBudgetDeployment,readBudgetDeployment,budgetDeploymentVariables,type BudgetCarryover} from "../src/budget-transfer.ts";
import type {StateStorage} from "../src/state-store.ts";
const now=Date.parse("2026-11-13T12:00:00+08:00");
function setup(){
 const db=new DatabaseSync(":memory:");let depth=0;
 const port:StateStorage={sql:{exec<T>(q:string,...b:any[]){const s=db.prepare(q),v=(s.columns().length?s.all(...b):(s.run(...b),[])) as T[];return{toArray:()=>v};}},transactionSync<T>(fn:()=>T){if(depth)return fn();db.exec("BEGIN");depth++;try{const v=fn();db.exec("COMMIT");return v;}catch(e){db.exec("ROLLBACK");throw e;}finally{depth--;}}};
 const shared=new SharedBudget(port);for(const owner of ["a","b"])shared.validation.import(owner,{requests:0,input:0,output:0});return{db,port,shared};
}
const request=(id:string,background=false)=>({id,taskId:"task-"+id,input:1000,output:100,background,model:QWEN_PRICE.model,baseUrl:QWEN_PRICE.baseUrl});
const receipt=(source="ledger:previous",requests=127):BudgetCarryover=>({version:1,source,sealedAt:now,validation:{requests,input:500000,output:40000},months:[{month:"2026-11",spent:900000,background:100000,days:[{day:"2026-11-12",spent:100000}]}]});

test("carryover is a bounded numeric deployment contract, rejecting unknown fields and invalid dates",()=>{
 assert.deepEqual(readBudgetDeployment(undefined),{frozen:false,carryovers:[]});
 const valid={frozen:false,carryovers:[receipt()]};assert.deepEqual(readBudgetDeployment(budgetDeploymentVariables(valid).BUDGET_DEPLOYMENT),valid);
 for(const bad of [{...valid,key:"synthetic-secret"},{frozen:"false",carryovers:[]},{frozen:false,carryovers:[receipt(),receipt()]},null])assert.throws(()=>parseBudgetDeployment(bad),/BUDGET_CARRYOVER_INVALID/);
 for(const raw of ["", "null", "{", " ".repeat(9000)])assert.throws(()=>readBudgetDeployment(raw),/BUDGET_CARRYOVER_INVALID/);
 for(const alter of [(r:any)=>r.validation.requests=-1,(r:any)=>r.validation.output=Infinity,(r:any)=>r.sealedAt=NaN,(r:any)=>r.extra="hidden",(r:any)=>r.months[0].days[0].day="2026-11-31",(r:any)=>r.months[0].background=1,(r:any)=>r.months.push(r.months[0])]){const r=receipt();alter(r);assert.throws(()=>parseCarryover(r),/BUDGET_CARRYOVER_INVALID/);}
});

test("identical replay and restart retain one imported charge and one lifetime baseline",()=>{
 const {db,port,shared:s}=setup(),r=receipt();s.transfer.apply([r]);const before=s.snapshot(now);
 s.transfer.apply([r]);const opened=new SharedBudget(port);opened.transfer.apply([r]);assert.deepEqual(opened.snapshot(now),before);
 assert.equal(before.validation.requests,127);assert.equal(before.estimatedSpent,0.9);assert.equal(before.backgroundSpent,0.1);assert.equal(before.importedBudgetSources,1);
 assert.equal(s.calls("a").items.length,0);db.close();
});

test("a changed source cannot decrease or increase the accepted receipt and rolls back the entire batch",()=>{
 const {db,shared:s}=setup();s.transfer.apply([receipt()]);const before=s.snapshot(now),changed=receipt();changed.validation.requests=0;
 assert.throws(()=>s.transfer.apply([receipt("ledger:second"),changed]),/BUDGET_CARRYOVER_CONFLICT/);
 assert.deepEqual(s.snapshot(now),before);assert.equal(s.validation.imported("external-budget:ledger:second"),false);
 changed.validation.requests=499;assert.throws(()=>s.transfer.apply([changed]),/BUDGET_CARRYOVER_CONFLICT/);db.close();
});

test("own origin cannot be imported as fresh external use",()=>{
 const {db,shared:s}=setup();assert.throws(()=>s.transfer.apply([receipt(s.transfer.view().source)]),/BUDGET_CARRYOVER_SELF/);
 assert.equal(s.snapshot(now).validation.requests,0);db.close();
});

test("imported 499-request use admits one request across accounts and survives another calendar month",()=>{
 const {db,port,shared:s}=setup();s.transfer.apply([receipt("legacy:old-deployment",499)]);
 assert.equal(s.reserve("a",request("last"),now).ok,true);s.settle("a","last",{input:2,output:1});
 const reopened=new SharedBudget(port);for(let i=0;i<20;i++)assert.deepEqual(reopened.reserve("b",request("over"+i),Date.parse("2026-12-01T00:00:00+08:00")),{ok:false,error:"VALIDATION_BUDGET"});
 assert.equal(reopened.validation.snapshot().requests,500);db.close();
});

test("carryover preserves original money months and daily background totals",()=>{
 const {db,shared:s}=setup(),r=receipt();r.months[0].spent=49_999_999;r.months[0].background=20_000_000;r.months[0].days[0].spent=20_000_000;s.transfer.apply([r]);
 assert.deepEqual(s.reserve("a",request("foreground"),now),{ok:false,error:"MONTHLY_BUDGET"});
 const december=Date.parse("2026-12-01T00:00:00+08:00");assert.equal(s.snapshot(december).estimatedSpent,0);assert.equal(s.snapshot(december).validation.requests,127);
 assert.equal(s.reserve("b",request("next-month"),december).ok,true);db.close();
});

test("background carryover cannot borrow a new daily allowance",()=>{
 const {db,shared:s}=setup(),r=receipt();r.months[0].spent=1_000_000;r.months[0].background=1_000_000;r.months[0].days=[{day:"2026-11-13",spent:1_000_000}];s.transfer.apply([r]);
 assert.equal(s.reserve("a",request("small-bg",true),now).ok,true);s.settle("a","small-bg",{input:1,output:1});
 // Nineteen million on the same day is already far above the remaining-day pacing limit.
 const r2=receipt("ledger:other",0);r2.validation={requests:0,input:0,output:0};r2.months[0]={month:"2026-11",spent:18_000_000,background:18_000_000,days:[{day:"2026-11-13",spent:18_000_000}]};s.transfer.apply([r2]);
 assert.deepEqual(s.reserve("b",request("paced",true),now),{ok:false,error:"BACKGROUND_DAILY_BUDGET"});db.close();
});

test("sealed output contains only new native calls, excluding prior account baselines and imported origins",()=>{
 const {db,shared:s}=setup();s.validation.import("original",{requests:12,input:100,output:10});s.transfer.apply([receipt()]);
 assert.equal(s.reserve("a",request("native"),now).ok,true);s.settle("a","native",{input:100,output:10});
 const out=s.sealTransfer(now+1000);assert.equal(out.validation.requests,1);assert.equal(out.validation.input,100);assert.equal(out.months[0].spent,28);
 assert.equal(s.snapshot(now).validation.requests,140);assert.ok(!JSON.stringify(out).includes("task-native"));assert.ok(!JSON.stringify(out).includes("previous"));
 const target=setup();target.shared.transfer.apply([out]);assert.equal(target.shared.snapshot(now).validation.requests,1);assert.equal(target.shared.snapshot(now).estimatedSpent,0.000028);
 target.db.close();db.close();
});

test("active requests block sealing; stale unknown requests are charged once and late usage cannot refund",()=>{
 const {db,shared:s}=setup();s.reserve("a",request("pending"),now);
 assert.throws(()=>s.sealTransfer(now+90_000),/BUDGET_IN_FLIGHT/);assert.equal(s.transfer.view().sealed,false);
 const out=s.sealTransfer(now+180_001);assert.deepEqual(out.validation,{requests:1,input:1000,output:100});assert.equal(out.months[0].spent,280);
 s.settle("a","pending",{input:0,output:0});assert.deepEqual(s.sealTransfer(now+999_999),out);assert.equal(s.snapshot(now).estimatedSpent,0.00028);db.close();
});

test("sealing survives restart and denies new admissions even after deployment freeze is removed",()=>{
 const {db,port,shared:s}=setup();const out=s.sealTransfer(now),reopened=new SharedBudget(port);
 for(let i=0;i<20;i++)assert.deepEqual(reopened.reserve(i%2?"a":"b",request("denied"+i),now),{ok:false,error:"BUDGET_TRANSFER_SEALED"});
 assert.deepEqual(reopened.sealTransfer(now+1),out);assert.equal(reopened.validation.snapshot().requests,0);
 assert.throws(()=>reopened.transfer.apply([receipt()]),/BUDGET_TRANSFER_SEALED/);db.close();
});

test("already accepted imports remain idempotent after sealing",()=>{
 const {db,shared:s}=setup();s.transfer.apply([receipt()]);const out=s.sealTransfer(now);s.transfer.apply([receipt()]);assert.deepEqual(s.sealTransfer(),out);db.close();
});

test("incomplete paired ledgers refuse export without sealing or fabricating zero charges",()=>{
 const {db,shared:s}=setup();s.reserve("a",request("lost"),now);s.settle("a","lost",{input:100,output:10});db.prepare("DELETE FROM pra_model_calls WHERE id=?").run("lost");
 assert.throws(()=>s.sealTransfer(now+1),/BUDGET_LEDGER_INCOMPLETE/);assert.equal(s.transfer.view().sealed,false);db.close();
});

test("transaction failure cannot import the validation count without its monetary history",()=>{
 const {db,port,shared:s}=setup();db.exec("CREATE TRIGGER fail_carryover BEFORE INSERT ON pra_budget_carryovers BEGIN SELECT RAISE(ABORT,'injected'); END");
 assert.throws(()=>s.transfer.apply([receipt()]),/injected/);assert.equal(s.validation.snapshot().requests,0);assert.equal(s.snapshot(now).estimatedSpent,0);
 db.exec("DROP TRIGGER fail_carryover");new SharedBudget(port).transfer.apply([receipt()]);assert.equal(s.validation.snapshot().requests,127);db.close();
});

test("multi-month native receipts preserve per-call month and background day",()=>{
 const {db,shared:s}=setup(),dec=Date.parse("2026-12-01T00:00:00+08:00");
 s.reserve("a",request("nov",true),now);s.settle("a","nov",{input:100,output:10});s.reserve("b",request("dec",true),dec);s.settle("b","dec",{input:200,output:20});
 const out=s.sealTransfer(dec+1000);assert.deepEqual(out.months.map(m=>[m.month,m.spent,m.background,m.days[0].day]),[["2026-11",28,28,"2026-11-13"],["2026-12",56,56,"2026-12-01"]]);
 assert.equal(out.validation.requests,2);db.close();
});
