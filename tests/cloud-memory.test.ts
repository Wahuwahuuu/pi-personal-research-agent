import {test} from "node:test";
import assert from "node:assert/strict";
import {cloudMemory,newCloudMemory} from "../packages/research/cloud-memory.ts";
import {DomainMemory} from "../packages/research/internal/agent/domain-memory.ts";
const papers=[{paper_id:"a",title:"Synthetic paper",abstract:"Abstract."}];
test("cloud memory reuses automatic preference and reading rules and survives restoration",async()=>{
 const state=newCloudMemory(),m=cloudMemory(state,papers,"owner");
 const d=new DomainMemory("v");
 await m.remember("conversation","turn","以后用中文回答",d.state,"completed");
 assert.equal(state.entries.length,1);assert.equal(state.entries[0].kind,"preference");
 const restored=cloudMemory(JSON.parse(JSON.stringify(state)),papers,"owner");
 assert.equal((await restored.recall("你好",[])).items[0].content,"回答语言：中文");
 assert.equal((await restored.list()).backend,"cloud-sqlite");
});
test("manual correction survives automatic extraction; deleted slots cannot resurrect from replay",async()=>{
 const state=newCloudMemory(),m=cloudMemory(state,papers,"owner"),d=new DomainMemory("v");
 await m.remember("c","t1","以后用中文回答",d.state,"completed");
 const entry=state.entries[0];
 await m.save({id:entry.id,kind:"preference",content:"回答语言：英文",edited:true});
 await m.remember("c","t2","以后用中文回答",d.state,"completed");
 assert.equal(state.entries[0].content,"回答语言：英文");
 assert.deepEqual(state.invalidatedTurns,["t1"]);
 await m.remove(entry.id);
 await cloudMemory(JSON.parse(JSON.stringify(state)),papers,"owner").remember("c","t1","以后用中文回答",d.state,"completed");
 assert.equal(state.entries.length,0);
 assert.deepEqual((await m.recall("language",[])).items,[]);
});
test("memory rejects credentials, source findings do not become truth, paused memory stays inactive",async()=>{
 const state=newCloudMemory(),m=cloudMemory(state,papers,"owner",["synthetic-secret"]);
 await assert.rejects(()=>m.save({kind:"note",content:"synthetic-secret"}));
 await assert.rejects(()=>m.save({kind:"note",content:"密码：unsafe"}));
 const d=new DomainMemory("v");
 d.rememberAnswer("t","解释方法","Unsupported claim",["a"],["source"],"answer","complete");
 await m.remember("c","t","解释方法",d.state,"completed");
 assert.equal(state.entries[0].kind,"reading");assert.ok(!state.entries[0].content.includes("Unsupported claim"));
 state.enabled=false;
 const paused=cloudMemory(state,papers,"owner");
 assert.equal((await paused.recall("论文",[])).status,"disabled");
 await paused.remember("c","t2","以后详细回答",d.state,"completed");
 assert.equal(state.entries.length,1);
});

test("correction invalidates transitive cross-conversation derivations and replay cannot resurrect them",async()=>{
 const {recordMemoryInputs}=await import("../packages/research/cloud-memory.ts");
 const state=newCloudMemory(),m=cloudMemory(state,papers,"owner");
 const first=await m.save({kind:"note",content:"Original constraint",source_session:"one",source_turn:"t0"});
 recordMemoryInputs(state,"t1",[first.id],[]);
 const second=await m.save({kind:"reading",content:"Derived record",paper_ids:["a"],source_session:"two",source_turn:"t1"});
 recordMemoryInputs(state,"t2",[second.id],["t1"]);
 await m.save({kind:"note",content:"Further derivation",source_session:"three",source_turn:"t2"});
 await m.save({id:first.id,kind:"note",content:"Corrected constraint",edited:true});
 assert.deepEqual(state.entries.map(e=>e.content),["Corrected constraint"]);assert.ok(state.invalidatedTurns?.includes("t2"));
 await m.save({kind:"note",content:"Replay under a new slot",source_turn:"t2"}).catch(()=>{});
 assert.equal(state.entries.length,1);
 const restored=cloudMemory(JSON.parse(JSON.stringify(state)),papers,"owner");await restored.remove(first.id);assert.equal((await restored.recall("constraint",[])).items.length,0);
});
