import {test} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createHash} from "node:crypto";
import {MemoryIndex,memoryTokens} from "../src/memory-index.ts";
import {cloudMemory,newCloudMemory,type CloudMemoryEntry} from "../packages/research/cloud-memory.ts";
import {digestEntries,validateMemoryDigest} from "../packages/research/memory.ts";
import type {StateStorage} from "../src/state-store.ts";
import type {Chunk,EvidenceIdentity} from "../packages/research/core.ts";
function setup(){const db=new DatabaseSync(":memory:");let depth=0;const p:StateStorage={sql:{exec<T>(q:string,...b:any[]){const s=db.prepare(q),v=(s.columns().length?s.all(...b):(s.run(...b),[]))as T[];return{toArray:()=>v};}},transactionSync<T>(fn:()=>T){if(depth)return fn();db.exec("BEGIN");depth++;try{const v=fn();db.exec("COMMIT");return v;}catch(e){db.exec("ROLLBACK");throw e;}finally{depth--;}}};return{db,p,index:new MemoryIndex(p)};}
function entry(content:string,projectId="p",category:CloudMemoryEntry["category"]="conclusion"):CloudMemoryEntry{return{id:crypto.randomUUID(),content,kind:category==="preference"?"preference":"reading",category,projectId,paper_ids:["a"],source_session:"c",source_turn:crypto.randomUUID(),slot:crypto.randomUUID(),created_at:"2026-11-11T00:00:00Z",updated_at:"2026-11-11T00:00:00Z",edited:false};}
test("Chinese FTS5 finds substrings without local models and excludes unrelated projects and paper scope",()=>{
 const {db,index}=setup(),rows=[entry("长期记忆需要支持显式纠正"),entry("证据可靠性通过原文位置校验"),entry("长期记忆另一项目的结论","other"),entry("偏好使用中文","","preference")];index.sync(rows);
 assert.ok(memoryTokens("长期记忆").includes("记忆"));assert.equal(index.page({query:"记忆",projectId:"p"}).items.length,1);
 assert.equal(index.recall("可靠性",["a"],"p")[1].id,rows[1].id);
 assert.equal(index.page({query:'" OR * AND 中文',projectId:"p"}).items.length,1);
 assert.equal(index.page({query:"记忆",projectId:"p",paperIds:["b"]}).items.length,0);db.close();
});
test("20 explicit memories survive reopen; 10 corrections and 10 deletions cannot leak through search or revision storage",()=>{
 const {db,p,index}=setup();const rows=Array.from({length:20},(_,i)=>entry("显式记忆 "+i));
 index.sync(rows);assert.equal(new MemoryIndex(p).page({limit:100}).items.length,20);
 const changed=rows.map((r,i)=>i<10?{...r,content:"已纠正 "+i,edited:true}:r);index.sync(changed);
 assert.equal(index.page({query:"已纠正",limit:100}).items.length,10);assert.equal(index.revisions(rows[0].id).length,2);
 const kept=changed.slice(0,10);index.sync(kept);const reopened=new MemoryIndex(p);assert.equal(reopened.page({query:"显式记忆",limit:100}).items.length,0);
 for(const old of rows.slice(10)){assert.throws(()=>reopened.revisions(old.id),/NOT_FOUND/);assert.equal(db.prepare("SELECT count(*) as n FROM pra_memory_fts WHERE id=?").get(old.id)!.n,0);}
 db.close();
});
test("unchanged memory does not amplify writes; a rejected update rolls back index and revision together",()=>{
 const {db,index}=setup(),r=entry("先前证据");index.sync([r]);index.sync([r]);assert.equal(index.revisions(r.id).length,1);
 db.exec("CREATE TRIGGER refuse_memory BEFORE INSERT ON pra_memory_revisions WHEN NEW.revision=2 BEGIN SELECT RAISE(ABORT,'reject'); END");
 assert.throws(()=>index.sync([{...r,content:"新证据"}]),/reject/);assert.equal(index.page({query:"先前"}).items[0].content,"先前证据");
 db.exec("DROP TRIGGER refuse_memory");index.sync([{...r,content:"新证据"}]);assert.equal(index.revisions(r.id).length,2);db.close();
});
test("source-bound consolidation reuses original validator, preserves Unicode locations and rejects invented or stale evidence",()=>{
 const s:Chunk={paper_id:"a",paragraph_id:"p",chunk_id:"c",section:"方法",index_version:"v",start:10,end:18,text:"原文🙂证据可核对"};
 const id:EvidenceIdentity={paper_id:"a",paragraph_id:"p",chunk_id:"c",index_version:"v",start:10,end:18,text_sha256:createHash("sha256").update(s.text).digest("hex")};
 const raw=JSON.stringify({readings:[{paper_id:"a",topic:"方法",progress:"读过原文",key_points:[{text:"有原文依据",chunk_id:"c",quote:"🙂证据"},{text:"臆造",chunk_id:"c",quote:"没有这句话"}],open_questions:["还需检验泛化吗？"]}]});
 const digest=validateMemoryDigest(raw,"v",[id],[s]);assert.equal(digest.readings[0].key_points.length,1);
 const rows=digestEntries(digest,[s],[{paper_id:"a",title:"Synthetic",abstract:""}],"session","turn","project");
 assert.equal(rows[0].sources![0].quote_start,12);assert.equal(rows[0].sources![0].quote_end,15);assert.equal(rows[0].semanticStatus,"unreviewed");assert.equal(rows[1].category,"question");
 assert.throws(()=>validateMemoryDigest(raw,"new",[id],[s]),/Unrelated/);
});
test("paper memory slots are project-scoped; correction preserves provenance and blocks automatic resurrection",async()=>{
 const state=newCloudMemory(),papers=[{paper_id:"a",title:"Synthetic",abstract:""}],a=cloudMemory(state,papers,"owner",[],{projectId:"a"}),b=cloudMemory(state,papers,"owner",[],{projectId:"b"});
 const input={kind:"reading" as const,slot:"reading:v2:a",paper_ids:["a"],content:"原文结论",source_session:"session",source_turn:"turn"};
 await a.save(input);await b.save({...input,content:"另一项目"});assert.equal(state.entries.length,2);
 await a.remove(state.entries.find(e=>e.projectId==="a")!.id);await a.save(input).catch(()=>{});
 assert.equal(state.entries.length,1);assert.equal(state.entries[0].projectId,"b");assert.equal((await b.recall("结论",["a"])).items.length,1);
});
