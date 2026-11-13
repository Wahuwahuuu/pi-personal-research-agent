import {test} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {StateRepository,type StateStorage} from "../src/state-store.ts";
import {Workspace} from "../src/workspace.ts";
import {MemoryIndex} from "../src/memory-index.ts";
import {memoryView} from "../src/memory-view.ts";
import {mutateMemory,type MemoryMutation} from "../src/memory-mutations.ts";
import {cloudMemory,newCloudMemory,recordMemoryInputs} from "../packages/research/cloud-memory.ts";
function fixture(){
 const db=new DatabaseSync(":memory:");let depth=0,fail="";
 const storage:StateStorage={sql:{exec<T>(sql:string,...args:any[]){if(fail&&sql.startsWith(fail))throw Error("INJECTED_FAILURE");const q=db.prepare(sql),rows=(q.columns().length?q.all(...args):(q.run(...args),[])) as T[];return{toArray:()=>rows};}},transactionSync<T>(fn:()=>T){if(depth)return fn();db.exec("BEGIN");depth++;try{const v=fn();db.exec("COMMIT");return v;}catch(e){db.exec("ROLLBACK");throw e;}finally{depth--;}}};
 let repository=new StateRepository(storage),workspace=new Workspace(storage),index=new MemoryIndex(storage),state=repository.load();state.cloudMemory??=newCloudMemory();workspace.migrate(state);
 const save=()=>{state.memories=memoryView(state.cloudMemory!.entries);repository.save(state);index.sync(state.cloudMemory!.entries);};save();
 const reopen=()=>{repository=new StateRepository(storage);workspace=new Workspace(storage);state=repository.load();index=new MemoryIndex(storage);};
 const service=(projectId?:string)=>cloudMemory(state.cloudMemory!,[],"owner",[],{projectId});let serial:Promise<unknown>=Promise.resolve();
 const run=(action:MemoryMutation)=>{const result=serial.then(async()=>{try{return await mutateMemory({workspace,state,service,save},action);}catch(e){state=repository.load();index=new MemoryIndex(storage);throw e;}});serial=result.catch(()=>{});return result;};
 return{db,run,reopen,save,service,get state(){return state;},get index(){return index;},fail:(sql:string)=>{fail=sql;}};
}
const saving=(body:Record<string,unknown>):MemoryMutation=>({kind:"save",body});
const removing=(id:string,requestId:string):MemoryMutation=>({kind:"delete",id,body:{requestId}});
const idOf=(value:any)=>{assert.equal(typeof value.id,"string");return value.id as string;};
test("repeated saves retain one identity and old requests never undo a newer correction",async()=>{
 const f=fixture(),input={requestId:"create",category:"preference",content:"Original preference"};
 const values=await Promise.all(Array.from({length:10},()=>f.run(saving(input)))),id=idOf(values[0]);assert.equal(new Set(values.map(idOf)).size,1);assert.equal(f.state.cloudMemory!.entries.length,1);
 await assert.rejects(f.run(saving({...input,content:"conflicting"})),/REQUEST_CONFLICT/);
 await f.run(saving({requestId:"correct",id,content:"Corrected preference"}));f.reopen();
 assert.equal((await f.run(saving(input)) as any).content,"Corrected preference");assert.equal(f.index.revisions(id).length,2);
 const receipts=JSON.stringify(f.db.prepare("SELECT * FROM pra_mutations").all());assert.ok(!receipts.includes("Original preference")&&!receipts.includes("Corrected preference"));f.db.close();
});
test("duplicate deletion survives reopening and no old save revives the removed content",async()=>{
 const f=fixture(),input={requestId:"save",content:"Deletion canary"},id=idOf(await f.run(saving(input)));
 for(let i=0;i<5;i++)assert.deepEqual(await f.run(removing(id,"delete")),{ok:true});f.reopen();
 assert.deepEqual(await f.run(removing(id,"delete")),{ok:true});await assert.rejects(f.run(saving(input)),/RESOURCE_DELETED/);
 assert.equal(f.state.cloudMemory!.entries.length,0);assert.equal(f.index.page().items.length,0);assert.throws(()=>f.index.revisions(id),/NOT_FOUND/);
 for(const name of ["pra_mutations","pra_data_memory_entries","pra_memory_index","pra_memory_revisions"]){assert.ok(!JSON.stringify(f.db.prepare("SELECT * FROM "+name).all()).includes("Deletion canary"));}f.db.close();
});
test("receipt failure rolls back canonical memory, FTS and revisions and permits the same request to retry",async()=>{
 const f=fixture(),input={requestId:"save",content:"Initial constraint"},id=idOf(await f.run(saving(input))),edit={requestId:"edit",id,content:"New constraint"};
 f.fail("INSERT INTO pra_mutations");await assert.rejects(f.run(saving(edit)),/INJECTED_FAILURE/);assert.equal(f.state.cloudMemory!.entries[0].content,"Initial constraint");assert.equal(f.index.revisions(id).length,1);assert.equal(f.index.page().items[0].content,"Initial constraint");
 f.fail("");await f.run(saving(edit));assert.equal(f.index.page().items[0].content,"New constraint");assert.equal(f.index.revisions(id).length,2);
 f.fail("INSERT INTO pra_mutations");await assert.rejects(f.run(removing(id,"delete")),/INJECTED_FAILURE/);f.fail("");f.reopen();assert.equal(f.index.page().items[0].content,"New constraint");assert.equal(idOf(await f.run(saving(input))),id);await f.run(removing(id,"delete"));assert.equal(f.index.page().items.length,0);f.db.close();
});
test("correcting a source invalidates derived memory and its receipt without retaining content",async()=>{
 const f=fixture(),source=idOf(await f.run(saving({requestId:"source",content:"Source claim"}))),derivedInput={requestId:"derived",content:"Derived claim"},derived=idOf(await f.run(saving(derivedInput)));
 const entry=f.state.cloudMemory!.entries.find(e=>e.id===derived)!;entry.edited=false;entry.source_turn="derived-turn";recordMemoryInputs(f.state.cloudMemory!,entry.source_turn,[source],[]);f.save();
 await f.run(saving({requestId:"correction",id:source,content:"Corrected source"}));await assert.rejects(f.run(saving(derivedInput)),/RESOURCE_DELETED/);assert.ok(!f.state.cloudMemory!.entries.some(e=>e.id===derived));assert.throws(()=>f.index.revisions(derived),/NOT_FOUND/);f.db.close();
});
test("legacy requests remain usable and invalid memory edits do not change existing state",async()=>{
 const f=fixture(),id=idOf(await f.run(saving({content:"Legacy memory"})));
 await assert.rejects(f.run(saving({requestId:"bad-category",id,category:"made-up",content:"invalid"})),/INVALID_MEMORY_CATEGORY/);
 await assert.rejects(f.run(saving({requestId:"missing",id:crypto.randomUUID(),content:"unknown"})),/NOT_FOUND/);
 await f.run(saving({id,content:"Updated legacy"}));await f.run({kind:"delete",id,body:{}});assert.equal(f.state.cloudMemory!.entries.length,0);f.db.close();
});
