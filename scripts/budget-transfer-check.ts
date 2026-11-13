import {Miniflare,convertV4MiniflareOptions,Log,LogLevel} from "miniflare";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import assert from "node:assert/strict";
import {freezeWorker} from "./freeze-worker.ts";
const directory=resolve(".local/budget-transfer-check",crypto.randomUUID());await mkdir(directory,{recursive:true});
const source=JSON.stringify(resolve("src/worker.ts").replaceAll("\\","/"));
const entry=resolve(directory,"worker.ts");
await writeFile(entry,[
 "import worker,{PersonalAgent as Agent,IdentityRegistry as Registry} from "+source+";",
 "export class PersonalAgent extends Agent {seedUsage(){this.state.usage={requests:0,input:0,output:0,reservedInput:0,reservedOutput:0};this.repository.save(this.state);}}",
 "export class IdentityRegistry extends Registry {async seed(){this.store.ensure('a','A','owner');this.store.ensure('b','B','member');const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('synthetic-member-session'));this.store.addSession(Array.from(new Uint8Array(hash)).map(v=>v.toString(16).padStart(2,'0')).join(''),'b',Date.now()+3600000);}}",
 "export default {async fetch(r,env){if(new URL(r.url).pathname!=='/fixture')return worker.fetch(r,env);const b=await r.json(),registry=env.IDENTITIES.getByName('accounts:a');",
 "if(b.action==='seed'){await registry.seed();for(const id of ['a','b'])await env.AGENTS.getByName(id).seedUsage();return Response.json({ok:true});}",
 "if(b.action==='reserve')return Response.json(await registry.reserveBudget(b.owner,b.request));",
 "if(b.action==='settle')return Response.json(await registry.settleBudget(b.owner,b.id,b.usage));",
 "return Response.json(await registry.budgetSnapshot());}};"
].join("\n"));
const config=JSON.parse((await readFile("wrangler.jsonc","utf8")).replace(/,\s*([}\]])/g,"$1"));config.main=entry;delete config.assets;
const file=resolve(directory,"wrangler.json");await writeFile(file,JSON.stringify(config));await freezeWorker(file,resolve(directory,"bundle"));
let outbound=0,mf:Miniflare|undefined,cookie="";
async function open(budget:any,name="origin"){
 if(mf)await mf.dispose();
 mf=new Miniflare(convertV4MiniflareOptions({name:"budget-transfer-"+name,scriptPath:resolve(directory,"bundle/worker.js"),modules:true,
 compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags,cf:false,port:0,host:"127.0.0.1",
 bindings:{OWNER_ID:"a",ADMIN_TOKEN:"synthetic-admin-"+"x".repeat(40),MODEL_MODE:"mock",RESEARCH_ENGINE:"durable",BUDGET_DEPLOYMENT:JSON.stringify(budget)},
 durableObjects:{AGENTS:{className:"PersonalAgent",useSQLite:true},IDENTITIES:{className:"IdentityRegistry",useSQLite:true}},resourcePersistencePath:resolve(directory,"persist-"+name),
 outboundService:async()=>{outbound++;throw Error("EXTERNAL_REQUEST_DENIED");},log:new Log(LogLevel.ERROR)}));
}
async function api(path:string,method="GET",body?:any,expected=200,session=cookie){
 const response=await mf!.dispatchFetch("http://localhost"+path,{method,headers:{"Content-Type":"application/json",...(session?{Cookie:session}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
 assert.equal(response.status,expected,method+" "+path);return response.json() as Promise<any>;
}
async function login(){const response=await mf!.dispatchFetch("http://localhost/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:"synthetic-admin-"+"x".repeat(40)})});assert.equal(response.status,200);cookie=response.headers.get("set-cookie")!.split(";")[0];}
const report:any={started:new Date().toISOString(),kind:"workerd-budget-transfer",syntheticAdmissions:true,paidCalls:0,checks:[]};
try{
 const prior={version:1,source:"legacy:retired-example",sealedAt:Date.now(),validation:{requests:499,input:1000,output:100},months:[{month:"2026-11",spent:900000,background:0,days:[]}]};
 await open({frozen:false,carryovers:[prior]});await api("/fixture","POST",{action:"seed"});await login();
 assert.equal((await api("/api/budget")).validation.requests,499);await api("/api/budget/transfer","GET",undefined,401,"");await api("/api/budget/transfer","GET",undefined,403,"pra_session=synthetic-member-session");
 assert.equal((await api("/api/budget/transfer","POST",{requestId:"before-freeze"},409)).error,"BUDGET_FREEZE_REQUIRED");report.checks.push("owner_only_transfer_and_freeze_required");
 await api("/api/budget/transfer","POST",{requestId:"anon"},401,"");await api("/api/budget/transfer","POST",{requestId:"member"},403,"pra_session=synthetic-member-session");
 const request=(id:string)=>({id,taskId:"synthetic-"+id,input:52000,output:2048,model:"qwen3.7-flash",baseUrl:"https://dashscope.aliyuncs.com/compatible-mode/v1"});
 const admissions=await Promise.all(["a","b"].map(async owner=>({owner,result:await api("/fixture","POST",{action:"reserve",owner,request:request(owner)})})));
 assert.equal(admissions.filter(v=>v.result.ok).length,1);assert.equal(admissions.find(v=>!v.result.ok)!.result.error,"VALIDATION_BUDGET");report.checks.push("one_atomic_admission_after_external_499_requests");
 const winner=admissions.find(v=>v.result.ok)!;
 await open({frozen:true,carryovers:[prior]});await login();assert.equal((await api("/api/budget/transfer")).admissionFrozen,true);
 assert.equal((await api("/fixture","POST",{action:"reserve",owner:"a",request:request("frozen")})).error,"BUDGET_FROZEN");
 assert.equal((await api("/api/budget/transfer","POST",{requestId:"pending"},409)).error,"BUDGET_IN_FLIGHT");
 await api("/fixture","POST",{action:"settle",owner:winner.owner,id:winner.result.id});
 const receipt=await api("/api/budget/transfer","POST",{requestId:"seal"});assert.equal(receipt.validation.requests,1);assert.equal(receipt.validation.input,52000);assert.equal(receipt.months[0].spent,36116);
 assert.deepEqual(await api("/api/budget/transfer","POST",{requestId:"seal"}),receipt);report.checks.push("freeze_reopen_pending_refusal_and_unknown_settlement_before_seal");
 await open({frozen:false,carryovers:[prior]});await login();
 assert.equal((await api("/fixture","POST",{action:"reserve",owner:"b",request:request("after-reopen")})).error,"BUDGET_TRANSFER_SEALED");
 assert.deepEqual((await api("/api/budget/transfer")).receipt,receipt);assert.equal((await api("/api/budget")).validation.requests,500);report.checks.push("sealed_source_survives_environment_and_object_restart");
 await open({frozen:false,carryovers:[receipt]},"destination");await api("/fixture","POST",{action:"seed"});await login();
 const destination=await api("/api/budget");assert.equal(destination.validation.requests,1);assert.equal(destination.estimatedSpent,0.036116);assert.equal(destination.importedBudgetSources,1);report.checks.push("native_delta_import_does_not_duplicate_old_source_history");
 const changed=structuredClone(receipt);changed.validation.requests=0;
 await open({frozen:false,carryovers:[changed]},"destination");await login();assert.equal((await api("/fixture","POST",{action:"reserve",owner:"a",request:request("conflict")})).error,"BUDGET_CARRYOVER_CONFLICT");
 await open({frozen:"false",carryovers:[]},"destination");await login();assert.equal((await api("/fixture","POST",{action:"reserve",owner:"a",request:request("invalid")})).error,"BUDGET_CARRYOVER_INVALID");
 await open({frozen:false,carryovers:[receipt]},"destination");await login();assert.equal((await api("/api/budget")).validation.requests,1);report.checks.push("invalid_or_conflicting_configuration_cannot_admit_or_erase_history");
 assert.equal(outbound,0);report.success=true;report.outboundRequests=outbound;
}catch(error){report.success=false;report.failure=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{if(mf)await mf.dispose();report.finished=new Date().toISOString();await writeFile(resolve(directory,"report.json"),JSON.stringify(report,null,2));if(report.success)await writeFile("docs/validation/budget-transfer-rpc.json",JSON.stringify(report,null,2));console.log(JSON.stringify({...report,directory}));}
