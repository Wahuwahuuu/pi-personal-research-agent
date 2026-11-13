import {Miniflare,convertV4MiniflareOptions,Log,LogLevel} from "miniflare";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import assert from "node:assert/strict";
import {freezeWorker} from "./freeze-worker.ts";
const directory=resolve(".local/memory-storage-check",crypto.randomUUID());await mkdir(directory,{recursive:true});
const path=(name:string)=>JSON.stringify(resolve("src",name).replaceAll("\\","/"));
const entry=resolve(directory,"worker.ts");
await writeFile(entry,`
import {DurableObject} from "cloudflare:workers";
import {StateRepository} from ${path("state-store.ts")};
import {MemoryIndex} from ${path("memory-index.ts")};
import {memoryView} from ${path("memory-view.ts")};
export class MemoryStore extends DurableObject {
 check(){
  let records=[];const db={sql:{exec:(query,...args)=>{const cursor=this.ctx.storage.sql.exec(query,...args),rows=cursor.toArray();records.push({query,returned:rows.length,read:cursor.rowsRead,written:cursor.rowsWritten});return{toArray:()=>rows};}},transactionSync:fn=>this.ctx.storage.transactionSync(fn)};
  const store=new StateRepository(db),state=store.load();state.cloudMemory={enabled:true,deletedSlots:[],entries:Array.from({length:1000},(_,i)=>({id:"memory-"+i,kind:"note",content:"Synthetic memory "+i,paper_ids:["paper"],source_session:"conversation",source_turn:"turn-"+i,created_at:"2026-01-01T00:00:00.000Z",updated_at:"2026-01-01T00:00:00.000Z",slot:"note-"+i,edited:false,projectId:"project",sources:[{quote:"synthetic evidence"}]}))};state.memories=memoryView(state.cloudMemory.entries);store.save(state);new MemoryIndex(db).sync(state.cloudMemory.entries);
  const snapshot=()=>({queries:records.length,rowsRead:records.reduce((n,r)=>n+r.read,0),rowsWritten:records.reduce((n,r)=>n+r.written,0),bodyRows:records.filter(r=>r.query.startsWith("SELECT id,parent,position,value FROM pra_data_memory_entries WHERE id=?")).reduce((n,r)=>n+r.returned,0)});
  const cold=new StateRepository(db);records=[];const loaded=cold.load(),index=new MemoryIndex(db);index.sync(loaded.cloudMemory.entries);const startup=snapshot();
  records=[];loaded.memories=memoryView(loaded.cloudMemory.entries);cold.save(loaded);index.sync(loaded.cloudMemory.entries);const unchanged=snapshot();
  records=[];loaded.cloudMemory.entries[42].content="Corrected synthetic conclusion";loaded.cloudMemory.entries[42].sources[0].quote="corrected evidence";loaded.cloudMemory.entries[42].paper_ids.push("second");cold.save(loaded);index.sync(loaded.cloudMemory.entries);const correction=snapshot();
  const revisions=index.revisions("memory-42").length;
  records=[];loaded.cloudMemory.entries=loaded.cloudMemory.entries.filter(e=>e.id!=="memory-43");loaded.memories=memoryView(loaded.cloudMemory.entries);cold.save(loaded);index.sync(loaded.cloudMemory.entries);const deletion=snapshot();
  const counts={canonical:db.sql.exec("SELECT COUNT(*) AS n FROM pra_data_memory_entries").toArray()[0].n,legacy:db.sql.exec("SELECT COUNT(*) AS n FROM pra_data_memories").toArray()[0].n,deletedIndex:db.sql.exec("SELECT COUNT(*) AS n FROM pra_memory_index WHERE id='memory-43'").toArray()[0].n,deletedRevisions:db.sql.exec("SELECT COUNT(*) AS n FROM pra_memory_revisions WHERE id='memory-43'").toArray()[0].n};
  const restored=new StateRepository(db).load(),corrected=restored.cloudMemory.entries.find(e=>e.id==="memory-42");return {startup,unchanged,correction,deletion,revisions,counts,corrected:{content:corrected.content,quote:corrected.sources[0].quote,papers:[...corrected.paper_ids]},compatibility:restored.memories.find(e=>e.id==="memory-42").content};
 }
}
export default {fetch(_r,env){return env.STORE.getByName("memory-storage").check().then(value=>Response.json(value));}};
`);
const original=JSON.parse((await readFile("wrangler.jsonc","utf8")).replace(/,\s*([}\]])/g,"$1"));
const config={name:"memory-storage-check",main:entry,compatibility_date:original.compatibility_date,compatibility_flags:original.compatibility_flags,durable_objects:{bindings:[{name:"STORE",class_name:"MemoryStore"}]},migrations:[{tag:"v1",new_sqlite_classes:["MemoryStore"]}]};
const file=resolve(directory,"wrangler.json");await writeFile(file,JSON.stringify(config));await freezeWorker(file,resolve(directory,"bundle"));let outbound=0;
const mf=new Miniflare(convertV4MiniflareOptions({name:"memory-storage-check",scriptPath:resolve(directory,"bundle/worker.js"),modules:true,compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags,cf:false,port:0,host:"127.0.0.1",durableObjects:{STORE:{className:"MemoryStore",useSQLite:true}},outboundService:async()=>{outbound++;throw Error("EXTERNAL_REQUEST_DENIED");},log:new Log(LogLevel.ERROR)}));
const report:any={started:new Date().toISOString(),kind:"workerd-canonical-memory",paidCalls:0,cloudDeployment:false};
try{const response=await mf.dispatchFetch("http://localhost/check");assert.equal(response.status,200);const m=await response.json() as any;report.measurements=m;assert.equal(m.startup.bodyRows,0);assert.equal(m.startup.rowsWritten,0);assert.equal(m.unchanged.bodyRows,0);assert.equal(m.unchanged.rowsWritten,0);assert.equal(m.correction.bodyRows,1);assert.ok(m.correction.rowsRead<40,"correction must use the FTS rowid");assert.equal(m.deletion.bodyRows,0);assert.ok(m.deletion.rowsRead<40,"deletion must use the FTS rowid");assert.equal(m.revisions,2);assert.deepEqual(m.counts,{canonical:999,legacy:0,deletedIndex:0,deletedRevisions:0});assert.equal(m.corrected.content,"Corrected synthetic conclusion");assert.equal(m.corrected.quote,"corrected evidence");assert.deepEqual(m.corrected.papers,["paper","second"]);assert.equal(m.compatibility,m.corrected.content);assert.equal(outbound,0);report.success=true;}
catch(error){report.success=false;report.failure=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{await mf.dispose();report.finished=new Date().toISOString();report.outboundRequests=outbound;await writeFile(resolve(directory,"report.json"),JSON.stringify(report,null,2));if(report.success)await writeFile("docs/validation/memory-storage-rpc.json",JSON.stringify(report,null,2));console.log(JSON.stringify({...report,directory}));}
