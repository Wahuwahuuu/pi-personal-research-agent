import {spawn,type ChildProcess} from "node:child_process";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve,relative,isAbsolute} from "node:path";
import {createServer} from "node:http";
import {WebSocketServer} from "ws";
import assert from "node:assert/strict";
const python=process.argv[2];if(!python||!isAbsolute(python))throw Error("ABSOLUTE_PYTHON_REQUIRED");
const directory=await mkdtemp(join(tmpdir(),"pra-import-status-")),token=crypto.randomUUID()+crypto.randomUUID();
const server=createServer(),ws=new WebSocketServer({server});
await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
const endpoint="http://127.0.0.1:"+(server.address() as any).port;
const probe=createServer();await new Promise<void>(r=>probe.listen(0,"127.0.0.1",r));
const port=(probe.address() as any).port;await new Promise<void>(r=>probe.close(()=>r()));
let child:ChildProcess|undefined;
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function api(path:string,body?:unknown){
 const r=await fetch("http://127.0.0.1:"+port+"/local/"+path,{method:body?"POST":"GET",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
 assert.equal(r.status,200);return r.json() as Promise<any>;
}
try{
 const config=join(directory,"node.json"),pdf=join(directory,"synthetic.pdf");
 await writeFile(pdf,"%PDF-synthetic-registration-only");
 await writeFile(config,JSON.stringify({endpoint,fixture:true,port,dataDir:join(directory,"node"),libraryRoot:join(directory,"library"),
  libraryPython:python,python:{executable:python,models:directory,indexVersion:"fixture-v1",device:"cpu"}}));
 child=spawn(process.execPath,["local/node.ts",config],{cwd:resolve("."),windowsHide:true,stdio:"ignore",
  env:{...process.env,PRA_DEVICE_TOKEN:crypto.randomUUID()+crypto.randomUUID(),PRA_LOCAL_TOKEN:token}});
 let ready=false;
 for(const end=Date.now()+15000;Date.now()<end;){
  ready=await fetch("http://127.0.0.1:"+port+"/local/status",{headers:{Authorization:"Bearer "+token}}).then(r=>r.ok).catch(()=>false);
  if(ready)break;if(child.exitCode!==null)throw Error("NODE_EXITED");await delay(100);
 }
 assert.equal(ready,true);
 assert.equal((await fetch("http://127.0.0.1:"+port+"/local/status")).status,401);
 await api("control",{action:"pause"});
 const job=await api("import",{kind:"pdf",requestId:crypto.randomUUID(),path:pdf});
 assert.equal((await api("status")).imports.find((j:any)=>j.id===job.id).status,"queued");
 for(let i=0;i<10;i++){
  assert.equal((await api("import/cancel",{id:job.id})).status,"cancelled");
  assert.equal((await api("status")).imports.find((j:any)=>j.id===job.id).status,"cancelled");
  assert.equal((await api("import/retry",{id:job.id})).status,"queued");
  assert.equal((await api("status")).imports.find((j:any)=>j.id===job.id).status,"queued");
 }
 console.log(JSON.stringify({passed:10,realNode:true,realPython:true,realSQLite:true,fixtureCloud:true,modelCalls:0}));
}finally{
 if(child&&child.exitCode===null){const ended=new Promise<void>(r=>child!.once("exit",()=>r()));child.kill();await ended;}
 for(const socket of ws.clients)socket.terminate();
 await new Promise<void>(r=>ws.close(()=>r()));await new Promise<void>(r=>server.close(()=>r()));
 assert.ok(relative(resolve(tmpdir()),directory).startsWith("pra-import-status-"));
 await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
