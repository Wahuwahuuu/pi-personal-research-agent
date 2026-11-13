import {test} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {StateRepository,type StateStorage} from "../src/state-store.ts";
import {MemoryIndex} from "../src/memory-index.ts";
import {memoryView} from "../src/memory-view.ts";
import {newCloudMemory,type CloudMemoryEntry} from "../packages/research/cloud-memory.ts";
function fixture(){
 const db=new DatabaseSync(":memory:"),queries:Array<{sql:string;rows:number}>=[];let fail="",depth=0;
 const storage:StateStorage={sql:{exec<T>(sql:string,...args:any[]){if(fail&&sql.startsWith(fail))throw Error("INJECTED_MEMORY_FAILURE");const q=db.prepare(sql),rows=(q.columns().length?q.all(...args):(q.run(...args),[])) as T[];queries.push({sql,rows:rows.length});return{toArray:()=>rows};}},transactionSync<T>(fn:()=>T){if(depth)return fn();db.exec("BEGIN");depth++;try{const result=fn();db.exec("COMMIT");return result;}catch(error){db.exec("ROLLBACK");throw error;}finally{depth--;}}};
 return {db,storage,queries,fail:(value:string)=>{fail=value;}};
}
function entry(i:number):CloudMemoryEntry{return{id:"00000000-0000-4000-8000-"+String(i).padStart(12,"0"),kind:"note",content:"Synthetic memory "+i,paper_ids:["paper"],source_session:"c",source_turn:"t"+i,created_at:"2026-01-01T00:00:00.000Z",updated_at:"2026-01-01T00:00:00.000Z",slot:"note:"+i,edited:false,projectId:"p",sources:[{paper_id:"paper",paragraph_id:"paragraph",chunk_id:"chunk",index_version:"index",section:"section",quote:"original evidence",quote_start:0,quote_end:17,source_start:0,source_end:17,source_text_sha256:"a".repeat(64)}]};}
const bodyReads=(f:ReturnType<typeof fixture>)=>f.queries.filter(q=>q.sql.startsWith("SELECT id,parent,position,value FROM pra_data_memory_entries WHERE id=?")).reduce((n,q)=>n+q.rows,0);
function seeded(count:number){const f=fixture(),store=new StateRepository(f.storage),state=store.load();state.cloudMemory={...newCloudMemory(),entries:Array.from({length:count},(_,i)=>entry(i))};state.memories=memoryView(state.cloudMemory.entries);store.save(state);new MemoryIndex(f.storage).sync(state.cloudMemory.entries);return {...f,store,state};}
test("one thousand canonical memories cold-load, save and sync FTS without reading their content or evidence",()=>{
 const f=seeded(1000),store=new StateRepository(f.storage);f.queries.length=0;const state=store.load(),index=new MemoryIndex(f.storage);index.sync(state.cloudMemory!.entries);
 assert.equal(bodyReads(f),0);assert.equal(store.save(state).writes,0);assert.equal(bodyReads(f),0);assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM pra_data_memories").get()!.n,0);
 assert.ok(state.cloudMemory!.entries.every(e=>e.paper_ids.includes("paper")));assert.equal(bodyReads(f),0);
 assert.equal(state.memories[42].content,"Synthetic memory 42");assert.equal(bodyReads(f),1);assert.equal(state.memories[42].source,"c");assert.equal(store.save(state).writes,0);index.sync(state.cloudMemory!.entries);assert.equal(bodyReads(f),1);assert.equal(index.revisions(entry(42).id).length,1);f.db.close();
});
test("memory metadata arrays and nested evidence mutations hydrate only the modified record and keep FTS revisions",()=>{
 const f=seeded(5),store=new StateRepository(f.storage),state=store.load(),index=new MemoryIndex(f.storage);f.queries.length=0;
 const e=state.cloudMemory!.entries[2],ids=e.paper_ids;assert.ok(Array.isArray(ids));assert.deepEqual([...ids],["paper"]);assert.deepEqual(Object.keys(ids),["0"]);assert.equal(bodyReads(f),0);
 ids.push("second");assert.equal(bodyReads(f),1);e.sources![0].quote="corrected evidence";e.content="Corrected synthetic memory";e.edited=true;
 assert.equal(store.save(state).writes,1);index.sync(state.cloudMemory!.entries);assert.equal(index.revisions(e.id).length,2);assert.equal(bodyReads(f),1);
 const reopened=new StateRepository(f.storage).load();assert.deepEqual([...reopened.cloudMemory!.entries[2].paper_ids],["paper","second"]);assert.equal(reopened.cloudMemory!.entries[2].sources![0].quote,"corrected evidence");assert.equal(reopened.memories[2].content,e.content);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM pra_data_memories").get()!.n,0);f.db.close();
});
test("a held metadata array keeps its original reference after the parent field is replaced",()=>{
 const f=seeded(1),store=new StateRepository(f.storage),state=store.load(),e=state.cloudMemory!.entries[0],old=e.paper_ids;e.paper_ids=["replacement"];old.push("old-only");assert.deepEqual([...old],["paper","old-only"]);assert.deepEqual(e.paper_ids,["replacement"]);store.save(state);assert.deepEqual([...new StateRepository(f.storage).load().cloudMemory!.entries[0].paper_ids],["replacement"]);f.db.close();
});
test("schema three memory migration preserves exact canonical records, clears duplicate projections and rolls back failures",()=>{
 const f=seeded(3),canonical=f.db.prepare("SELECT id,parent,position,value FROM pra_data_memory_entries ORDER BY id").all();
 for(const [i,m]of f.state.memories.entries())f.db.prepare("INSERT INTO pra_data_memories VALUES(?,?,?,?)").run(m.id,"",i,JSON.stringify(m));
 f.db.exec("UPDATE pra_app_schema SET version=3; ALTER TABLE pra_data_memory_entries DROP COLUMN header");f.fail("UPDATE pra_data_memory_entries SET header=");
 assert.throws(()=>new StateRepository(f.storage),/INJECTED_MEMORY_FAILURE/);assert.equal(f.db.prepare("SELECT version FROM pra_app_schema").get()!.version,3);assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM pra_data_memories").get()!.n,3);assert.ok(!f.db.prepare("PRAGMA table_info(pra_data_memory_entries)").all().some(r=>r.name==="header"));
 f.fail("");const store=new StateRepository(f.storage),state=store.load();assert.equal(f.db.prepare("SELECT version FROM pra_app_schema").get()!.version,4);assert.deepEqual(f.db.prepare("SELECT id,parent,position,value FROM pra_data_memory_entries ORDER BY id").all(),canonical);assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM pra_data_memories").get()!.n,0);assert.equal(state.memories[0].content,"Synthetic memory 0");assert.equal(store.save(state).writes,0);f.db.close();
});
test("deleting an unloaded memory removes canonical data, compatibility projection, FTS and revisions without loading others",()=>{
 const f=seeded(5),store=new StateRepository(f.storage),state=store.load(),index=new MemoryIndex(f.storage);f.queries.length=0;state.cloudMemory!.entries=state.cloudMemory!.entries.filter(e=>e.id!==entry(2).id);state.memories=memoryView(state.cloudMemory!.entries);assert.equal(store.save(state).writes,1);index.sync(state.cloudMemory!.entries);
 assert.equal(bodyReads(f),0);assert.equal(state.memories.length,4);assert.ok(!index.page({limit:100}).items.some(e=>e.id===entry(2).id));assert.throws(()=>index.revisions(entry(2).id),/NOT_FOUND/);assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM pra_memory_revisions WHERE id=?").get(entry(2).id)!.n,0);assert.equal(new StateRepository(f.storage).load().memories.length,4);f.db.close();
});
test("legacy-only memory is preserved until host conversion, and malformed canonical metadata never deletes it",()=>{
 const f=fixture(),store=new StateRepository(f.storage),state=store.load();state.memories=[{id:"legacy",content:"retained",source:"user",updated:1}];store.save(state);assert.equal(new StateRepository(f.storage).load().memories[0].content,"retained");
 f.db.exec("UPDATE pra_app_schema SET version=3; ALTER TABLE pra_data_memory_entries DROP COLUMN header; INSERT INTO pra_meta VALUES('cloudMemory','null')");assert.throws(()=>new StateRepository(f.storage),/INVALID_MEMORY_STATE/);assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM pra_data_memories").get()!.n,1);assert.equal(f.db.prepare("SELECT version FROM pra_app_schema").get()!.version,3);f.db.close();
});
test("failed memory save retains the prior canonical hash and a retry persists the correction",()=>{
 const f=seeded(2),store=new StateRepository(f.storage),state=store.load();state.cloudMemory!.entries[0].content="changed";f.fail("INSERT INTO pra_changes");assert.throws(()=>store.save(state),/INJECTED_MEMORY_FAILURE/);assert.equal(new StateRepository(f.storage).load().memories[0].content,"Synthetic memory 0");f.fail("");assert.equal(store.save(state).writes,1);const restored=new StateRepository(f.storage).load();new MemoryIndex(f.storage).sync(restored.cloudMemory!.entries);assert.equal(restored.memories[0].content,"changed");f.db.close();
});
