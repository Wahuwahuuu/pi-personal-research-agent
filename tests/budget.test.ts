import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BudgetLedger, billingTime, costMicro, QWEN_PRICE } from "../src/budget.ts";
import type { StateStorage } from "../src/state-store.ts";
const now=Date.parse("2026-11-11T12:00:00+08:00");
function fixture() {
 const db=new DatabaseSync(":memory:");let depth=0;
 const storage:StateStorage={sql:{exec<T>(q:string,...b:any[]){const s=db.prepare(q),r=(s.columns().length?s.all(...b):(s.run(...b),[])) as T[];return{toArray:()=>r};}},
 transactionSync<T>(fn:()=>T){if(depth)return fn();db.exec("BEGIN");depth++;try{const v=fn();db.exec("COMMIT");return v;}catch(e){db.exec("ROLLBACK");throw e;}finally{depth--;}}};
 const ledger=new BudgetLedger(storage);
 const reserve=(id:string,input=52000,output=2048,background=false,time=now)=>ledger.reserve({id,taskId:"task",input,output,background,model:QWEN_PRICE.model,baseUrl:QWEN_PRICE.baseUrl},time);
 return {db,ledger,reserve};
}
test("price bands and Shanghai month boundaries use integer money without discounts",()=>{
 assert.equal(costMicro(QWEN_PRICE,{input:32000,output:1000}),7200);
 assert.equal(costMicro(QWEN_PRICE,{input:32001,output:1000}),21601);
 assert.equal(billingTime(Date.parse("2026-11-30T16:00:00Z")).month,"2026-12");
 assert.throws(()=>costMicro(QWEN_PRICE,{input:NaN,output:2}));
});
test("reservation, actual settlement and duplicate callback cannot double bill",()=>{
 const {db,ledger,reserve}=fixture();reserve("a");reserve("a");
 assert.ok(ledger.snapshot(now).reserved>0);
 ledger.settle("a",{input:1000,output:100});
 const first=ledger.snapshot(now);ledger.settle("a",{input:9000,output:100});
 assert.deepEqual(ledger.snapshot(now),first);assert.equal(first.estimatedSpent,0.00028);assert.equal(first.reserved,0);
 assert.throws(()=>reserve("a"),/ALREADY_SETTLED/);db.close();
});
test("20 looping workloads cannot admit new paid calls beyond monthly cap",()=>{
 for(let i=0;i<20;i++){
  const {db,ledger,reserve}=fixture();let admitted=0;
  for(let k=0;k<20;k++){try{reserve("a"+k,1000000,1000000);ledger.settle("a"+k);admitted++;}catch(e){assert.match(String(e),/MONTHLY_BUDGET/);}}
  assert.equal(admitted,8);assert.equal(ledger.snapshot(now).estimatedSpent,48);
  assert.throws(()=>reserve("more",1000000,1000000),/MONTHLY_BUDGET/);db.close();
 }
});
test("unknown usage after process loss charges reservation once, retaining original month",()=>{
 const {db,ledger,reserve}=fixture();reserve("a");
 const reserved=ledger.snapshot(now).reserved;
 const reboot=new BudgetLedger(ledger.storage);assert.equal(reboot.recoverInterrupted(),1);assert.equal(reboot.recoverInterrupted(),0);
 assert.equal(reboot.snapshot(now).estimatedSpent,reserved);
 reboot.settle("a",{input:1,output:1});assert.equal(reboot.snapshot(now).estimatedSpent,reserved);
 assert.equal(reboot.snapshot(Date.parse("2026-12-01T00:00:00+08:00")).estimatedSpent,0);db.close();
});
test("background daily pacing protects interactive budget and cannot borrow unlimited month balance",()=>{
 const {db,ledger,reserve}=fixture();
 assert.throws(()=>reserve("big",1000000,1000000,true),/DAILY/);
 reserve("foreground",1000000,1000000);ledger.settle("foreground");
 for(let i=0;i<7;i++){reserve("f"+i,1000000,1000000);ledger.settle("f"+i);}
 assert.equal(ledger.snapshot(now).backgroundPaused,true);
 assert.throws(()=>reserve("bg",1000,100,true),/BACKGROUND_BUDGET/);db.close();
});
test("reservation and price identity are strict; settlement cannot erase overrun",()=>{
 const {db,ledger,reserve}=fixture();reserve("a",100,10);
 assert.throws(()=>reserve("a",101,10),/CONFLICT/);
 assert.equal(ledger.settle("a",{input:1000,output:100}).status,"overrun");
 assert.throws(()=>ledger.reserve({id:"b",taskId:"t",input:1,output:1,model:"other",baseUrl:QWEN_PRICE.baseUrl},now),/PRICE_NOT_CONFIGURED/);
 assert.throws(()=>reserve("old",1,1,false,now+40*86400000),/PRICE_REVIEW/);db.close();
});

test("legacy token usage is conservatively imported once without resetting earlier spending",()=>{
 const {db,ledger}=fixture();ledger.importLegacy({input:1000000,output:100000},now);
 ledger.importLegacy({input:1000000,output:100000},now);
 assert.equal(ledger.snapshot(now).estimatedSpent,1.68);assert.equal(ledger.calls("",50,now).items.length,1);db.close();
});
