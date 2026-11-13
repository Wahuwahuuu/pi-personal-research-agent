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

test("legacy unscoped tombstones do not suppress independent project memories, while original source turns and global preferences stay deleted",async()=>{
 const state=newCloudMemory();state.deletedSlots=["default:shared-reading","shared-reading","preference:language"];state.invalidatedTurns=["deleted-source"];
 const original=cloudMemory(state,papers,"owner",[],{projectId:"default"}),independent=cloudMemory(state,papers,"owner",[],{projectId:"new-project"});
 await assert.rejects(original.save({kind:"reading",slot:"shared-reading",content:"Old project",source_session:"old-session",source_turn:"fresh-default",paper_ids:["a"]}));
 await assert.rejects(independent.save({kind:"reading",slot:"different-slot",content:"Attempted replay",source_session:"old-session",source_turn:"deleted-source",paper_ids:["a"]}));
 const fresh=await independent.save({kind:"reading",slot:"shared-reading",content:"Independent new project evidence",source_session:"new-session",source_turn:"independent-source",paper_ids:["a"]});
 assert.equal(state.entries.find(e=>e.id===fresh.id)!.projectId,"new-project");
 await assert.rejects(independent.save({kind:"preference",slot:"preference:language",content:"Old preference",source_turn:"different-source"}));
 assert.equal(state.entries.length,1);assert.ok(state.deletedSlots.includes("shared-reading"));
});

test("new explicit preference instructions override edited values while stale replay remains blocked",async()=>{
 const state=newCloudMemory(),m=cloudMemory(state,papers,"owner"),d=new DomainMemory("v");
 const prior=await m.save({kind:"preference",slot:"preference:language",content:"回答语言：中文",edited:true,source_session:"c1",source_turn:"old-turn"});
 const {recordMemoryInputs}=await import("../packages/research/cloud-memory.ts");
 recordMemoryInputs(state,"derived",[prior.id],[]);
 await m.save({kind:"note",content:"Derived with old language",source_session:"c2",source_turn:"derived"});
 recordMemoryInputs(state,"new-turn",[prior.id],["old-turn"]);
 await m.remember("c3","new-turn","以后用英文回答",d.state,"completed",undefined,undefined,{explicitInstructions:true});
 assert.equal(state.entries.find(e=>e.id===prior.id)?.content,"回答语言：英文");
 assert.equal(state.entries.find(e=>e.id===prior.id)?.edited,true);
 assert.ok(state.invalidatedTurns?.includes("derived"));
 assert.ok(!state.entries.some(e=>e.source_turn==="derived"));
 await m.remember("c3","new-turn","以后用英文回答",d.state,"completed",undefined,undefined,{explicitInstructions:true});
 assert.ok(!state.invalidatedTurns?.includes("new-turn"),"idempotent confirmation must not invalidate itself");
 await m.remove(prior.id);
 await m.remember("c3","new-turn","以后用英文回答",d.state,"completed",undefined,undefined,{explicitInstructions:true});
 assert.equal(state.entries.length,0,"deleted explicit source cannot resurrect through replay");
 await m.remember("c4","fresh-turn","请记住：以后用中文回答",d.state,"completed",undefined,undefined,{explicitInstructions:true});
 assert.equal(state.entries.length,1);
 assert.equal(state.entries[0].content,"回答语言：中文");
});
test("quoted and hypothetical preference statements do not replace an edited user preference",async()=>{
 for(const question of ["例如以后用英文回答","假如以后用英文回答","记住这句话怎么翻译：以后用英文回答？","不要记住：以后用英文回答","“以后用英文回答”是什么意思？"]){
  const state=newCloudMemory(),m=cloudMemory(state,papers,"owner"),d=new DomainMemory("v");
  const prior=await m.save({kind:"preference",slot:"preference:language",content:"回答语言：中文",edited:true,source_session:"c",source_turn:"old"});
  await m.remember("c","new",question,d.state,"completed",undefined,undefined,{explicitInstructions:true});
  assert.equal(state.entries.find(e=>e.id===prior.id)?.content,"回答语言：中文",question);
 }
});
