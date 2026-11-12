import {Miniflare,convertV4MiniflareOptions,Log,LogLevel} from "miniflare";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import assert from "node:assert/strict";
import {freezeWorker} from "./freeze-worker.ts";
const directory=resolve(".local/budget-check",crypto.randomUUID());await mkdir(directory,{recursive:true});
const source=JSON.stringify(resolve("src/worker.ts").split(String.fromCharCode(92)).join("/"));
const entry=resolve(directory,"worker.ts");
await writeFile(entry,[
 "import {PersonalAgent as Agent,IdentityRegistry as Registry} from "+source+";",
 "export class PersonalAgent extends Agent {",
 " seedUsage(usage){this.state.usage={reservedInput:0,reservedOutput:0,...usage};this.repository.save(this.state);}",
 " async admit(owner,request){return this.identityRegistry().reserveBudget(owner,request);}",
 "}",
 "export class IdentityRegistry extends Registry {seed(){this.store.ensure('a','A','owner');this.store.ensure('b','B','member');}}",
 "export default {async fetch(r,env){const b=await r.json(),registry=env.IDENTITIES.getByName('accounts:a');",
 " if(b.action==='seed'){await registry.seed();for(const id of ['a','b'])await env.AGENTS.getByName(id).seedUsage(b[id]);return Response.json({ok:true});}",
 " if(b.action==='reserve')return Response.json(await env.AGENTS.getByName(b.owner).admit(b.owner,b.request));",
 " if(b.action==='settle')return Response.json(await registry.settleBudget(b.owner,b.id,b.usage));",
 " return Response.json(await registry.budgetSnapshot());}};"
].join("\n"));
const config=JSON.parse((await readFile("wrangler.jsonc","utf8")).replace(/,\s*([}\]])/g,"$1"));
config.main=entry;delete config.assets;
const configFile=resolve(directory,"wrangler.json");await writeFile(configFile,JSON.stringify(config));
await freezeWorker(configFile,resolve(directory,"bundle"));
let outbound=0;
const mf=new Miniflare(convertV4MiniflareOptions({name:"budget-check",scriptPath:resolve(directory,"bundle/worker.js"),modules:true,
 compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags,cf:false,port:0,host:"127.0.0.1",
 bindings:{OWNER_ID:"a",MODEL_MODE:"mock",RESEARCH_ENGINE:"durable"},
 durableObjects:{AGENTS:{className:"PersonalAgent",useSQLite:true},IDENTITIES:{className:"IdentityRegistry",useSQLite:true}},
 outboundService:async()=>{outbound++;throw Error("EXTERNAL_REQUEST_DENIED");},log:new Log(LogLevel.ERROR)}));
const report:any={started:new Date().toISOString(),kind:"workerd-shared-budget-rpc",syntheticAdmissions:true,paidCalls:0,checks:[]};
try{
 const api=async(body:any)=>{const response=await mf.dispatchFetch("http://localhost/test",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});assert.equal(response.status,200);return response.json() as Promise<any>;};
 await api({action:"seed",a:{requests:499,input:100,output:10},b:{requests:0,input:5000,output:30}});
 const request=(id:string)=>({id,taskId:"synthetic-"+id,input:52000,output:2048,model:"qwen3.7-flash",baseUrl:"https://dashscope.aliyuncs.com/compatible-mode/v1"});
 const admissions=await Promise.all(["a","b"].map(async owner=>({owner,result:await api({action:"reserve",owner,request:request(owner)})})));
 assert.equal(admissions.filter(x=>x.result.ok).length,1);
 assert.equal(admissions.find(x=>!x.result.ok)!.result.error,"VALIDATION_BUDGET");
 const first=await api({action:"snapshot"});assert.equal(first.validation.requests,500);assert.equal(first.validation.input,5100);assert.equal(first.validation.reservedInput,52000);
 report.checks.push("reentrant_agent_to_registry_rpc_imports_both_accounts_before_one_atomic_admission");
 const winner=admissions.find(x=>x.result.ok)!;
 await api({action:"settle",owner:winner.owner,id:winner.result.id});
 const settled=await api({action:"snapshot"});assert.equal(settled.validation.input,57100);assert.equal(settled.validation.output,2088);
 await api({action:"settle",owner:winner.owner,id:winner.result.id,usage:{input:0,output:0}});
 assert.deepEqual(await api({action:"snapshot"}),settled);report.checks.push("unknown_usage_and_late_duplicate_receipts_do_not_refund_shared_limits");
 await api({action:"seed",a:{requests:0,input:0,output:0},b:{requests:0,input:0,output:0}});
 assert.equal((await api({action:"reserve",owner:"b",request:request("again")})).error,"VALIDATION_BUDGET");
 assert.deepEqual(await api({action:"snapshot"}),settled);report.checks.push("reimporting_smaller_user_counters_cannot_reset_application_history");
 assert.equal(outbound,0);report.outboundRequests=outbound;report.success=true;
}catch(error){report.success=false;report.failure=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{await mf.dispose();report.finished=new Date().toISOString();await writeFile(resolve(directory,"report.json"),JSON.stringify(report,null,2));await mkdir("docs/validation",{recursive:true});if(report.success)await writeFile("docs/validation/shared-budget-rpc.json",JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
