import {Miniflare,convertV4MiniflareOptions,Log,LogLevel} from "miniflare";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import assert from "node:assert/strict";
import {freezeWorker} from "./freeze-worker.ts";
import {authenticator} from "./auth-integration.ts";
import {VALIDATION_LIMITS} from "../src/validation-limits.ts";
const directory=resolve(".local/budget-check",crypto.randomUUID());await mkdir(directory,{recursive:true});
const source=JSON.stringify(resolve("src/worker.ts").split(String.fromCharCode(92)).join("/"));
const entry=resolve(directory,"worker.ts");
await writeFile(entry,[
 "import app,{PersonalAgent as Agent,IdentityRegistry as Registry} from "+source+";",
 "export class PersonalAgent extends Agent {",
 " seedUsage(usage){this.state.usage={reservedInput:0,reservedOutput:0,...usage};this.repository.save(this.state);}",
 " async admit(owner,request){return this.identityRegistry().reserveBudget(owner,request);}",
 "}",
 "export class IdentityRegistry extends Registry {",
 " seed(){this.store.ensure('a','A','owner');this.store.ensure('b','B','member');}",
 " enrollment(id){return {account:!!this.store.account(id),credentialCount:this.store.credentials(id).length,money:this.budget.db.sql.exec('SELECT owner FROM pra_budget_imports WHERE owner=?',id).toArray().length===1,validation:this.budget.validation.imported(id)};}",
 " failNextEnrollment(enabled){if(enabled)this.store.db.sql.exec(\"CREATE TRIGGER reject_test_enrollment BEFORE INSERT ON pra_validation_imports BEGIN SELECT RAISE(ABORT,'fixture unavailable'); END\");else this.store.db.sql.exec('DROP TRIGGER reject_test_enrollment');}",
 "}",
 "export default {async fetch(r,env,ctx){if(new URL(r.url).pathname.startsWith('/api/'))return app.fetch(r,env,ctx);const b=await r.json(),registry=env.IDENTITIES.getByName('accounts:a');",
 " if(b.action==='enrollment')return Response.json(await registry.enrollment(b.id));",
 " if(b.action==='failEnrollment'){await registry.failNextEnrollment(b.enabled);return Response.json({ok:true});}",
 " if(b.action==='seed'){await registry.seed();for(const id of ['a','b'])await env.AGENTS.getByName(id).seedUsage(b[id]);return Response.json({ok:true});}",
 " if(b.action==='reserve')return Response.json(await env.AGENTS.getByName(b.owner).admit(b.owner,b.request));",
 " if(b.action==='settle')return Response.json(await registry.settleBudget(b.owner,b.id,b.usage));",
 " return Response.json(await registry.budgetSnapshot());}};"
].join("\n"));
const config=JSON.parse((await readFile("wrangler.jsonc","utf8")).replace(/,\s*([}\]])/g,"$1"));
config.main=entry;delete config.assets;
const configFile=resolve(directory,"wrangler.json");await writeFile(configFile,JSON.stringify(config));
await freezeWorker(configFile,resolve(directory,"bundle"));
const admin=crypto.randomUUID()+crypto.randomUUID();
let outbound=0;
const mf=new Miniflare(convertV4MiniflareOptions({name:"budget-check",scriptPath:resolve(directory,"bundle/worker.js"),modules:true,
 compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags,cf:false,port:0,host:"127.0.0.1",
 bindings:{OWNER_ID:"a",ADMIN_TOKEN:admin,MODEL_MODE:"mock",RESEARCH_ENGINE:"durable"},
 durableObjects:{AGENTS:{className:"PersonalAgent",useSQLite:true},IDENTITIES:{className:"IdentityRegistry",useSQLite:true}},
 outboundService:async()=>{outbound++;throw Error("EXTERNAL_REQUEST_DENIED");},log:new Log(LogLevel.ERROR)}));
const report:any={started:new Date().toISOString(),kind:"workerd-shared-budget-rpc",syntheticAdmissions:true,paidCalls:0,checks:[]};
try{
 const api=async(body:any)=>{const response=await mf.dispatchFetch("http://localhost/test",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});assert.equal(response.status,200);return response.json() as Promise<any>;};
 const origin="http://localhost";
 const http=async(path:string,body:unknown,cookie="")=>{
  const response=await mf.dispatchFetch(origin+"/api/"+path,{method:"POST",headers:{Cookie:cookie,"Content-Type":"application/json"},body:JSON.stringify(body)});
  return {status:response.status,body:await response.json() as any,cookie:response.headers.get("set-cookie")?.split(";")[0]??cookie};
 };
 await api({action:"seed",a:{requests:VALIDATION_LIMITS.requests-1,input:100,output:10},b:{requests:0,input:5000,output:30}});
 const owner=await http("login",{token:admin});assert.equal(owner.status,200);
 assert.equal((await api({action:"enrollment",id:"a"})).validation,false);
 const invited=await http("auth/invites",{requestId:crypto.randomUUID(),name:"Member"},owner.cookie);assert.equal(invited.status,200);
 const challenge=await http("auth/register/options",{invite:invited.body.code});assert.equal(challenge.status,200);
 const id=Buffer.from(challenge.body.options.user.id,"base64url").toString("utf8");
 const registration={id:challenge.body.id,response:authenticator(origin).register(challenge.body.options)};
 await api({action:"failEnrollment",enabled:true});
 assert.ok((await http("auth/register/verify",registration)).status>=400);
 assert.deepEqual(await api({action:"enrollment",id}),{account:false,credentialCount:0,money:false,validation:false});
 await api({action:"failEnrollment",enabled:false});
 const member=await http("auth/register/verify",registration);assert.equal(member.status,200);
 assert.deepEqual(await api({action:"enrollment",id}),{account:true,credentialCount:1,money:true,validation:true});
 const initial=await api({action:"snapshot"});assert.equal(initial.validation.requests,0);
 const extra=await http("auth/register/options",{},member.cookie);
 assert.equal((await http("auth/register/verify",{id:extra.body.id,response:authenticator(origin).register(extra.body.options)},member.cookie)).status,200);
 assert.deepEqual(await api({action:"snapshot"}),initial);
 assert.equal((await api({action:"enrollment",id:"b"})).validation,false);
 report.checks.push("invitation_registers_both_ledgers_atomically_and_preserves_legacy_history");
 const request=(id:string)=>({id,taskId:"synthetic-"+id,input:52000,output:2048,model:"qwen3.7-flash",baseUrl:"https://dashscope.aliyuncs.com/compatible-mode/v1"});
 const admissions=await Promise.all(["a","b"].map(async owner=>({owner,result:await api({action:"reserve",owner,request:request(owner)})})));
 assert.equal(admissions.filter(x=>x.result.ok).length,1);
 assert.equal(admissions.find(x=>!x.result.ok)!.result.error,"VALIDATION_BUDGET");
 const first=await api({action:"snapshot"});assert.equal(first.validation.requests,VALIDATION_LIMITS.requests);assert.equal(first.validation.input,5100);assert.equal(first.validation.reservedInput,52000);
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
