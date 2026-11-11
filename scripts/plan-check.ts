import {spawn,execFileSync,type ChildProcess} from "node:child_process";
import {mkdir,readFile,writeFile,cp} from "node:fs/promises";
import {resolve} from "node:path";
import {freezeWorker} from "./freeze-worker.ts";
import {verifyPlanRecords} from "./plan-integration.ts";
const directory=resolve(".local/plan-check",crypto.randomUUID()),base="http://127.0.0.1:8807";
await mkdir(directory,{recursive:true});
const admin=crypto.randomUUID()+crypto.randomUUID();
const config=JSON.parse((await readFile("wrangler.jsonc","utf8")).replace(/,\s*([}\]])/g,"$1"));
config.main=resolve("src/worker.ts");config.assets.directory=resolve(directory,"assets");
config.vars={...config.vars,ADMIN_TOKEN:admin,OWNER_ID:"plan-check-"+crypto.randomUUID(),MODEL_MODE:"mock",RESEARCH_ENGINE:"durable"};
await cp(resolve("dist/web"),config.assets.directory,{recursive:true});
const file=resolve(directory,"wrangler.json");await writeFile(file,JSON.stringify(config));
await freezeWorker(file,resolve(directory,"bundle"));
let child:ChildProcess|undefined,cookie="";
const report:any={kind:"local-workerd-plan-records",started:new Date().toISOString(),paidCalls:0,cloudDeployment:false};
async function api(path:string,method="GET",body?:unknown,expected?:number){
 const r=await fetch(base+"/api/"+path,{method,headers:{Cookie:cookie,"Content-Type":"application/json"},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
 if(path==="login")cookie=r.headers.get("set-cookie")?.split(";")[0]??"";
 const value:any=await r.json();if(expected!==undefined?r.status!==expected:!r.ok)throw Error(path+":"+r.status+":"+value.error);return value;
}
try{
 child=spawn(process.execPath,["node_modules/wrangler/bin/wrangler.js","dev","--local","--ip","127.0.0.1","--port","8807","--config",file,"--persist-to",resolve(directory,"state")],{windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,WRANGLER_SEND_METRICS:"false"}});
 child.stdout?.resume();child.stderr?.resume();
 let ready=false;for(const end=Date.now()+60000;Date.now()<end;){try{if((await fetch(base,{signal:AbortSignal.timeout(1000)})).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,300));}
 if(!ready)throw Error("TEST_WORKER_UNAVAILABLE");
 await api("login","POST",{token:admin});
 report.checks=await verifyPlanRecords(api);report.success=true;
}catch(e){report.success=false;report.failure=e instanceof Error?e.message:String(e);process.exitCode=1;}
finally{
 if(child?.pid)try{if(process.platform==="win32")execFileSync("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});else child.kill();}catch{}
 report.finished=new Date().toISOString();await writeFile(resolve(directory,"report.json"),JSON.stringify(report,null,2));
 if(report.success)await writeFile("docs/validation/local-plans.json",JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
}
