import {test} from "node:test";
import assert from "node:assert/strict";
import {stableEntityPositions} from "../src/row-order.ts";

test("stable ranks preserve sparse legacy positions under deletion and allocate multiple bounded insertions",()=>{
 const saved=new Map([["a",0],["b",100],["c",500],["d",1000]]);
 assert.deepEqual(stableEntityPositions(["a","c"],saved),[0,500]);
 const ids=["start","a","x","y","b","c","d","tail"],ranks=stableEntityPositions(ids,saved);
 for(let i=0;i<ranks.length;i++){assert.ok(Number.isSafeInteger(ranks[i]));if(i)assert.ok(ranks[i]>ranks[i-1]);}
 for(const [id,position]of saved)assert.equal(ranks[ids.indexOf(id)],position);
});

test("explicit reorders and unsafe bounds rebase without changing the requested order",()=>{
 for(const [ids,saved] of [
  [["b","a"],new Map([["a",0],["b",1]])],
  [["a","middle","b"],new Map([["a",0],["b",1]])],
  [["a","next"],new Map([["a",Number.MAX_SAFE_INTEGER]])],
  [["before","a"],new Map([["a",Number.MIN_SAFE_INTEGER]])],
  [["a","b"],new Map([["a",1.5],["b",2]])],
 ] as Array<[string[],Map<string,number>]>){
  const ranks=stableEntityPositions(ids,saved);assert.ok(ranks.every(Number.isSafeInteger));
  assert.deepEqual(ids.map((id,i)=>({id,position:ranks[i]})).sort((a,b)=>a.position-b.position).map(r=>r.id),ids);
  assert.deepEqual(stableEntityPositions(ids,new Map(ids.map((id,i)=>[id,ranks[i]]))),ranks);
 }
});

test("mixed deletion, insertion and reorder sequences remain idempotent across repeated storage reloads",()=>{
 let ids=Array.from({length:150},(_,i)=>"original-"+i),saved=new Map(ids.map((id,i)=>[id,i]));
 for(let n=0;n<100;n++){
  ids=ids.filter((_,i)=>i%11!==n%11);
  ids.splice(n%(ids.length+1),0,"new-"+n);
  if(n%13===0)ids.reverse();
  const positions=stableEntityPositions(ids,saved);
  assert.equal(new Set(positions).size,ids.length);
  assert.deepEqual(ids.map((id,i)=>({id,p:positions[i]})).sort((a,b)=>a.p-b.p).map(v=>v.id),ids);
  saved=new Map(ids.map((id,i)=>[id,positions[i]]));
  assert.deepEqual(stableEntityPositions(ids,saved),positions);
 }
});
