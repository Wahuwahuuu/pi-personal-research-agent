import {Miniflare,convertV4MiniflareOptions,Log,LogLevel} from "miniflare";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import assert from "node:assert/strict";
import {freezeWorker} from "./freeze-worker.ts";
const directory=resolve(".local/task-storage-check",crypto.randomUUID());await mkdir(directory,{recursive:true});
const modulePath=(name:string)=>JSON.stringify(resolve("src",name).replaceAll("\\","/"));
const entry=resolve(directory,"worker.ts");
await writeFile(entry,`
import {DurableObject} from "cloudflare:workers";
import {StateRepository} from ${modulePath("state-store.ts")};
import {initialState} from ${modulePath("domain.ts")};
import {activeTasks,queryTaskPage,taskByRequest} from ${modulePath("task-queries.ts")};
export class TaskStore extends DurableObject {
 check(tied=false){
  let records=[];
  const db={sql:{exec:(query,...args)=>{const cursor=this.ctx.storage.sql.exec(query,...args),rows=cursor.toArray();records.push({query,returned:rows.length,read:cursor.rowsRead,written:cursor.rowsWritten});return{toArray:()=>rows};}},transactionSync:fn=>this.ctx.storage.transactionSync(fn)};
  const store=new StateRepository(db),state=store.load();
  state.tasks=Array.from({length:1000},(_,i)=>({id:"task-"+String(i).padStart(5,"0"),requestId:"request-"+i,input:"synthetic task",kind:"chat",status:i===998?"queued":"completed",created:tied?1000:i,updated:i,calls:0,tools:0,activeMs:0}));
  store.save(state);
  const snapshot=()=>({queries:records.length,rowsRead:records.reduce((n,r)=>n+r.read,0),rowsWritten:records.reduce((n,r)=>n+r.written,0),headerRows:records.filter(r=>r.query.startsWith("SELECT header FROM pra_data_tasks")).reduce((n,r)=>n+r.returned,0),bodyRows:records.filter(r=>r.query.startsWith("SELECT id,parent,position,value FROM pra_data_tasks")).reduce((n,r)=>n+r.returned,0)});
  const cold=new StateRepository(db);records=[];const loaded=cold.load();const startup=snapshot();records=[];cold.save(loaded);const unchanged=snapshot();
  records=[];const active=activeTasks(loaded).map(t=>t.id);const scheduling=snapshot();
  records=[];const page=queryTaskPage(loaded,{before:(tied?1000:200)+":task-00200",limit:10});const ids=page.items.map(t=>t.id),paging=snapshot();
  records=[];const repeated=taskByRequest(loaded,"request-999")?.id;const request=snapshot();
  records=[];loaded.tasks[998].status="cancelled";cold.save(loaded);const mutation=snapshot();
  const probe=query=>{records=[];db.sql.exec(query,tied?1000:200,"task-00200").toArray();return snapshot();};
  const tuple=probe("SELECT id FROM pra_data_tasks WHERE (json_extract(header,'$.created'),id)<(?,?) ORDER BY json_extract(header,'$.created') DESC,id DESC LIMIT 11");
  return {startup,unchanged,scheduling,paging,request,mutation,tuple,active,ids,repeated,nextCursor:page.nextCursor};
 }
}
export default {fetch(r,env){const tied=new URL(r.url).searchParams.has("tied");return env.STORE.getByName(tied?"task-storage-tied":"task-storage").check(tied).then(value=>Response.json(value));}};
`);
const original=JSON.parse((await readFile("wrangler.jsonc","utf8")).replace(/,\s*([}\]])/g,"$1"));
const config={name:"task-storage-check",main:entry,compatibility_date:original.compatibility_date,compatibility_flags:original.compatibility_flags,durable_objects:{bindings:[{name:"STORE",class_name:"TaskStore"}]},migrations:[{tag:"v1",new_sqlite_classes:["TaskStore"]}]};
const file=resolve(directory,"wrangler.json");await writeFile(file,JSON.stringify(config));await freezeWorker(file,resolve(directory,"bundle"));
let outbound=0;
const mf=new Miniflare(convertV4MiniflareOptions({name:"task-storage-check",scriptPath:resolve(directory,"bundle/worker.js"),modules:true,compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags,cf:false,port:0,host:"127.0.0.1",durableObjects:{STORE:{className:"TaskStore",useSQLite:true}},outboundService:async()=>{outbound++;throw Error("EXTERNAL_REQUEST_DENIED");},log:new Log(LogLevel.ERROR)}));
const report:any={started:new Date().toISOString(),kind:"workerd-sql-task-views",paidCalls:0,cloudDeployment:false};
try{
 const response=await mf.dispatchFetch("http://localhost/check");assert.equal(response.status,200);const checks=await response.json() as any;report.measurements=checks;
 assert.equal(checks.startup.headerRows,0);assert.equal(checks.startup.bodyRows,0);assert.equal(checks.unchanged.rowsWritten,0);assert.equal(checks.unchanged.headerRows,0);
 assert.deepEqual(checks.active,["task-00998"]);assert.equal(checks.scheduling.bodyRows,0);assert.equal(checks.scheduling.headerRows,0);assert.ok(checks.scheduling.rowsRead<=5);
 assert.deepEqual(checks.ids,Array.from({length:10},(_,i)=>"task-"+String(199-i).padStart(5,"0")));assert.equal(checks.nextCursor,"190:task-00190");assert.ok(checks.paging.rowsRead<=40,"deep cursor must not scan the preceding history");assert.equal(checks.repeated,"task-00999");assert.equal(checks.request.bodyRows,0);
 const tiedResponse=await mf.dispatchFetch("http://localhost/check?tied");assert.equal(tiedResponse.status,200);const tied=await tiedResponse.json() as any;report.tiedMeasurements=tied;assert.deepEqual(tied.ids,checks.ids);assert.equal(tied.nextCursor,"1000:task-00190");assert.ok(tied.paging.rowsRead<=40,"same-time cursor must seek by ID");
 assert.equal(outbound,0);report.success=true;
}catch(error){report.success=false;report.failure=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{await mf.dispose();report.finished=new Date().toISOString();report.outboundRequests=outbound;await writeFile(resolve(directory,"report.json"),JSON.stringify(report,null,2));if(report.success)await writeFile("docs/validation/sql-task-views-rpc.json",JSON.stringify(report,null,2));console.log(JSON.stringify({...report,directory}));}
