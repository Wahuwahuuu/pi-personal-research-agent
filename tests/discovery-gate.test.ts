import {test} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {DiscoveryGate} from "../src/discovery-gate.ts";
import type {StateStorage} from "../src/state-store.ts";
function setup(){
 const db=new DatabaseSync(":memory:");
 const storage:StateStorage={sql:{exec<T>(q:string,...b:any[]){const s=db.prepare(q),v=(s.columns().length?s.all(...b):(s.run(...b),[])) as T[];return{toArray:()=>v};}},transactionSync(fn){db.exec("BEGIN");try{const v=fn();db.exec("COMMIT");return v;}catch(e){db.exec("ROLLBACK");throw e;}}};
 return {db,storage,gate:new DiscoveryGate(storage)};
}
test("concurrent topics and users share one durable discovery lease and a three-second gap",()=>{
 const {db,storage,gate}=setup();try{
  const first=gate.claim("a",100);assert.ok(first.ok);
  for(let i=0;i<100;i++)assert.deepEqual(gate.claim(i%2?"a":"b",101),{ok:false,retryAt:30100});
  const restored=new DiscoveryGate(storage);assert.equal(restored.claim("b",200).ok,false);
  restored.release("b",first.token,300);assert.equal(restored.claim("b",300).ok,false);
  restored.release("a",first.token,400);
  assert.deepEqual(restored.claim("b",3399),{ok:false,retryAt:3400});
  assert.equal(restored.claim("b",3400).ok,true);
 }finally{db.close();}
});
test("a crashed request expires and a late release cannot cancel a newer owner's lease",()=>{
 const {db,storage,gate}=setup();try{
  const first=gate.claim("a",100);assert.ok(first.ok);
  const restored=new DiscoveryGate(storage),second=restored.claim("b",30100);assert.ok(second.ok);
  restored.release("a",first.token,30200);
  assert.deepEqual(restored.claim("a",30201),{ok:false,retryAt:60100});
  restored.release("b",second.token,30300);
  assert.equal(restored.claim("a",33300).ok,true);
 }finally{db.close();}
});
