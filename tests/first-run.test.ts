import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {createHash} from "node:crypto";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {resolve,join,relative,dirname} from "node:path";
import {availableRuntimes,firstRunConfig,checkFirstRun,installFirstRun,type FirstRunControls} from "../local/first-run.ts";
import {persistInstallation} from "../local/setup.ts";
const sha=(s:string)=>createHash("sha256").update(s).digest("hex");
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),"pra-first-run-"));
 for(const name of ["packages/retrieval","local","models","data",".local/runtimes/ready/python/Scripts"])await mkdir(join(root,name),{recursive:true});
 for(const [name,value] of [["packages/retrieval/pyproject.toml","definition"],["packages/retrieval/uv.lock","lock"],["local/check-runtime.py","check"]])await writeFile(join(root,name),value);
 const python=join(root,".local/runtimes/ready/python/Scripts/python.exe"),manifest=join(root,".local/runtimes/ready/status.json");
 await writeFile(python,"synthetic");await writeFile(join(dirname(python),"pythonw.exe"),"synthetic");
 const ready={format:1,status:"ready",device:"cpu",python,pythonw:join(dirname(python),"pythonw.exe"),definitionSha256:sha("definition"),lockSha256:sha("lock"),checkSha256:sha("check")};
 await writeFile(manifest,JSON.stringify(ready));
 const server=createServer();await new Promise<void>(ok=>server.listen(0,"127.0.0.1",ok));const port=(server.address() as any).port;await new Promise<void>(ok=>server.close(()=>ok()));
 const raw={endpoint:"https://research.example",directory:join(root,"data"),models:join(root,"models"),runtime:manifest,port};
 const path=join(root,"config/node.json"),calls:string[]=[];
 const controls:FirstRunControls={preflight:async()=>{calls.push("check");return {protocol:1,configurationVersion:1,runtimes:[]};},
  verify:async(_,token)=>{assert.equal(token,"synthetic-device-credential");calls.push("verify");return {protocol:1,accountScope:"a".repeat(64)};},
  persist:async(config,path,token,resources)=>persistInstallation(config,path,token,resources,(secret,value)=>{assert.equal(value,"synthetic-device-credential");calls.push("protect");})};
 return {root,manifest,ready,raw,path,calls,controls};
}
async function clean(root:string){assert.ok(relative(resolve(tmpdir()),root).startsWith("pra-first-run-"));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
test("first run reuses verified runtimes and builds an explicit empty library without accepting hidden configuration fields",async()=>{
 const f=await fixture();try{
  assert.equal((await availableRuntimes(f.root)).length,1);
  const config=await firstRunConfig(f.root,f.raw);assert.equal(config.python.bootstrap,true);assert.equal(config.libraryRoot,join(f.raw.directory,"papers"));
  await assert.rejects(firstRunConfig(f.root,{...f.raw,apiKey:"synthetic"} as any),/INVALID_SETUP_INPUT/);
  await assert.rejects(firstRunConfig(f.root,{...f.raw,directory:f.root}),/SETUP_DIRECTORY_OVERLAP/);
  await assert.rejects(firstRunConfig(f.root,{...f.raw,endpoint:"https://research.example/?credential=synthetic"}),/INVALID_ENDPOINT/);
  await writeFile(f.manifest,JSON.stringify({...f.ready,lockSha256:"changed"}));
  assert.equal((await availableRuntimes(f.root)).length,0);
  await assert.rejects(firstRunConfig(f.root,f.raw),/RUNTIME_SOURCE_CHANGED/);
 }finally{await clean(f.root);}
});
test("occupied ports, existing libraries and configurations are rejected before pairing",async()=>{
 const f=await fixture();const server=createServer();
 try{
  await new Promise<void>(ok=>server.listen(f.raw.port,"127.0.0.1",ok));
  await assert.rejects(checkFirstRun(f.root,f.path,f.raw,f.controls),/LOCAL_PORT_IN_USE/);
  await new Promise<void>(ok=>server.close(()=>ok()));
  await mkdir(join(f.raw.directory,"papers"));await assert.rejects(checkFirstRun(f.root,f.path,f.raw,f.controls),/SETUP_DIRECTORY_IN_USE/);
  assert.deepEqual(f.calls,[]);
 }finally{if(server.listening)await new Promise<void>(ok=>server.close(()=>ok()));await clean(f.root);}
});
test("pairing orders resource checks and verification before atomic persistence; no credential enters configuration or resource reports",async()=>{
 const f=await fixture();try{
  const phases:string[]=[];const result=await installFirstRun(f.root,f.path,f.raw,"synthetic-device-credential",f.controls,p=>phases.push(p));
  assert.equal(result.configured,true);assert.equal(result.started,false);
  assert.deepEqual(f.calls,["check","verify","protect"]);assert.deepEqual(phases,["checking","pairing","saving"]);
  const before=await readFile(f.path,"utf8");assert.ok(!before.includes("synthetic-device-credential"));
  assert.ok(!(await readFile(f.path+".resources.json","utf8")).includes("synthetic-device-credential"));
  await assert.rejects(installFirstRun(f.root,f.path,f.raw,"synthetic-device-credential",f.controls),/NODE_ALREADY_CONFIGURED/);
  assert.equal(await readFile(f.path,"utf8"),before);
  await assert.rejects(installFirstRun(f.root,join(f.root,"second.json"),f.raw,"synthetic-device-credential",f.controls),/SETUP_DIRECTORY_IN_USE/);
 }finally{await clean(f.root);}
});
test("failed pairing can retry only the reserved configuration; simultaneous installers cannot share a data root",async()=>{
 const f=await fixture();let release!:()=>void,entered!:()=>void;
 try{
  await assert.rejects(installFirstRun(f.root,f.path,f.raw,"synthetic-device-credential",{...f.controls,verify:async()=>{throw Error("DEVICE_CREDENTIAL_REJECTED");}}),/DEVICE_CREDENTIAL_REJECTED/);
  await assert.rejects(readFile(f.path),/ENOENT/);
  const started=new Promise<void>(ok=>entered=ok),gate=new Promise<void>(ok=>release=ok);
  const pending=installFirstRun(f.root,f.path,f.raw,"synthetic-device-credential",{...f.controls,preflight:async c=>{entered();await gate;return f.controls.preflight!(c);}});
  await started;
  await assert.rejects(installFirstRun(f.root,join(f.root,"second.json"),f.raw,"synthetic-device-credential",f.controls),/SETUP_BUSY/);
  release();assert.equal((await pending).configured,true);
 }finally{release?.();await clean(f.root);}
});
test("resources changed after checks cannot be paired into an occupied library",async()=>{
 const f=await fixture();try{
  await assert.rejects(installFirstRun(f.root,f.path,f.raw,"synthetic-device-credential",{...f.controls,verify:async(c,t)=>{
   await mkdir(join(f.raw.directory,"papers"));return f.controls.verify!(c,t);}}),/SETUP_DIRECTORY_IN_USE/);
  assert.equal(f.calls.includes("protect"),false);await assert.rejects(readFile(f.path),/ENOENT/);
 }finally{await clean(f.root);}
});
