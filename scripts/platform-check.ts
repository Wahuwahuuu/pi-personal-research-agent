import {Miniflare,convertV4MiniflareOptions,Log,LogLevel} from "miniflare";
import {mkdir,readFile,writeFile,readdir} from "node:fs/promises";
import {resolve} from "node:path";
import assert from "node:assert/strict";
import {freezeWorker} from "./freeze-worker.ts";
const directory=resolve(".local/platform-check",crypto.randomUUID());await mkdir(directory,{recursive:true});
const source=JSON.stringify(resolve("src/worker.ts").replaceAll("\\","/")),entry=resolve(directory,"entry.ts");
await writeFile(entry,[
 "import app,{PersonalAgent,IdentityRegistry} from "+source+";",
 "export {PersonalAgent,IdentityRegistry};",
 "export default {async fetch(r,env,ctx){",
 " if(new URL(r.url).pathname==='/__fixture/cron'){const pending=[];await app.scheduled({},env,{waitUntil:p=>pending.push(p)});await Promise.all(pending);return Response.json(await env.IDENTITIES.getByName('accounts:owner').platformStatus());}",
 " if(new URL(r.url).pathname==='/__fixture/discovery')return Response.json(await env.IDENTITIES.getByName('accounts:owner').claimDiscovery('owner'));",
 " if(new URL(r.url).pathname==='/__fixture/background-budget')return Response.json(await env.IDENTITIES.getByName('accounts:owner').reserveBudget('owner',{id:'no-admission',taskId:'fixture',input:1,output:1,background:true,model:'qwen3.7-flash',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1'}));",
 " return app.fetch(r,env,ctx);}};"
].join("\n"));
const config=JSON.parse((await readFile("wrangler.jsonc","utf8")).replace(/,\s*([}\]])/g,"$1"));config.main=entry;delete config.assets;
const configFile=resolve(directory,"wrangler.json");await writeFile(configFile,JSON.stringify(config));await freezeWorker(configFile,resolve(directory,"bundle"));
let high=false,denied=false,reads=0;
const modelCredential="METRICS_PRIVATE_CANARY_"+crypto.randomUUID().replaceAll("-",""),admin=crypto.randomUUID()+crypto.randomUUID();
const options=convertV4MiniflareOptions({name:"platform-check",scriptPath:resolve(directory,"bundle/entry.js"),modules:true,
 compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags,cf:false,port:0,host:"127.0.0.1",
 bindings:{ADMIN_TOKEN:admin,OWNER_ID:"owner",MODEL_MODE:"mock",RESEARCH_ENGINE:"durable",RESOURCE_WORKER_NAME:"platform-check",CLOUDFLARE_ACCOUNT_ID:"a".repeat(32),CLOUDFLARE_METRICS_TOKEN:modelCredential},
 durableObjects:{AGENTS:{className:"PersonalAgent",useSQLite:true},IDENTITIES:{className:"IdentityRegistry",useSQLite:true}},
 outboundService:async r=>{
  const u=new URL(r.url);assert.equal(u.hostname,"api.cloudflare.com");assert.equal(r.headers.get("Authorization"),"Bearer "+modelCredential);reads++;
  if(denied)return Response.json({success:false},{status:403});
  if(u.pathname.endsWith("/namespaces"))return Response.json({success:true,result_info:{page:1,total_count:1},result:[{id:"fixture",script:"platform-check",use_sqlite:true}]});
  assert.equal(u.pathname,"/client/v4/graphql");const body=await r.json() as any;
  const name=/rows:(\w+)/.exec(body.query)![1];
  const rows:Record<string,any[]>={
   workersInvocationsAdaptive:[{dimensions:{scriptName:"platform-check"},sum:{requests:10}}],
   durableObjectsInvocationsAdaptiveGroups:[{dimensions:{namespaceId:"fixture",type:"http"},sum:{requests:10}}],
   durableObjectsPeriodicGroups:[{dimensions:{namespaceId:"fixture"},sum:{duration:10,rowsRead:high?500000:10,rowsWritten:10,inboundWebsocketMsgCount:0}}],
   durableObjectsSqlStorageGroups:[{dimensions:{namespaceId:"fixture"},max:{storedBytes:1024}}]
  };assert.ok(rows[name]);return Response.json({data:{viewer:{accounts:[{rows:rows[name]}]}}});
 },log:new Log(LogLevel.ERROR)});
options.resourcePersistencePath=resolve(directory,"storage");options.telemetry={enabled:false};
const mf=new Miniflare(options),report:any={started:new Date().toISOString(),kind:"real-workerd-platform-monitor",providerFixture:true,paidCalls:0,checks:[],directory};let cookie="";
try{
 const base=String(await mf.ready).replace(/\/$/,"");
 const api=async(path:string,body?:any)=>{
  const r=await fetch(base+path,{method:body===undefined?"GET":"POST",headers:{Cookie:cookie,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  if(path==="/api/login")cookie=r.headers.get("set-cookie")!.split(";")[0];const v=await r.json() as any;assert.equal(r.status,200,JSON.stringify(v));return v;
 };
 await api("/api/login",{token:admin});
 const request={requestId:crypto.randomUUID()},first=await api("/api/platform/refresh",request);
 assert.equal(first.enabled,true);assert.equal(first.blocked,false);
 const beforeReplay=reads;await api("/api/platform/refresh",request);assert.equal(reads,beforeReplay);
 report.checks.push("dedicated credential reads five provider datasets in workerd; owner refresh is idempotent");
 high=true;const beforeCron=reads,blocked=await api("/__fixture/cron");
 assert.equal(reads,beforeCron+5);assert.equal(blocked.reason,"PLATFORM_RESOURCE_LIMIT");
 assert.equal((await api("/__fixture/discovery")).ok,false);
 assert.equal((await api("/__fixture/background-budget")).error,"PLATFORM_RESOURCE_LIMIT");
 assert.equal((await api("/api/budget")).validation.requests,0);
 report.checks.push("production scheduled handler persists threshold, denies discovery and background reservations before any paid admission");
 denied=true;const unknown=await api("/api/platform/refresh",{requestId:crypto.randomUUID()});
 assert.equal(unknown.reason,"PLATFORM_METRICS_UNAVAILABLE");assert.equal(unknown.blocked,true);
 denied=false;high=false;const resumed=await api("/api/platform/refresh",{requestId:crypto.randomUUID()});
 assert.equal(resumed.blocked,false);assert.equal((await api("/__fixture/discovery")).ok,true);
 const view=await api("/api/platform");assert.equal(view.cloudMonitoringConfigured,true);assert.equal(JSON.stringify(view).includes(modelCredential),false);
 report.checks.push("provider denial holds work instead of inventing zero usage; new valid observations reopen admission");
 report.success=true;
}catch(error){report.success=false;report.error=error instanceof Error?error.message:"FAILED";process.exitCode=1;}
finally{
 await mf.dispose();report.providerRequests=reads;report.finished=new Date().toISOString();
 for(const path of await readdir(resolve(directory,"storage"),{recursive:true}).catch(()=>[]))if(/\.sqlite(?:-wal)?$/.test(path)){
  const data=await readFile(resolve(directory,"storage",path));assert.equal(data.includes(Buffer.from(modelCredential)),false,"raw metrics credential persisted");
 }
 await writeFile(resolve(directory,"report.json"),JSON.stringify(report,null,2));
 if(report.success)await writeFile("docs/validation/platform-monitor-local.json",JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
}
