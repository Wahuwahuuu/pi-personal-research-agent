import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from "node:fs/promises";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import {join,resolve,relative,dirname} from "node:path";
import {createServer} from "node:net";
import {spawn,type ChildProcess} from "node:child_process";
import {switchRuntime,rollbackRuntime,type RuntimeSwitchControls} from "../local/runtime-switch.ts";
const sha=(s:Buffer|string)=>createHash("sha256").update(s).digest("hex");
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),"pra-runtime-switch-"));
 for(const name of ["packages/retrieval","local","models","old/Scripts",".local/runtimes/candidate/python/Scripts"])await mkdir(join(root,name),{recursive:true});
 await writeFile(join(root,"packages/retrieval/pyproject.toml"),"definition");await writeFile(join(root,"packages/retrieval/uv.lock"),"lock");
 await writeFile(join(root,"local/check-runtime.py"),"check");
 const old=join(root,"old/Scripts/python.exe"),next=join(root,".local/runtimes/candidate/python/Scripts/python.exe");
 for(const exe of [old,next]){await writeFile(exe,"executable");await writeFile(join(dirname(exe),"pythonw.exe"),"desktop");}
 const probe=createServer();await new Promise<void>(r=>probe.listen(0,"127.0.0.1",r));const port=(probe.address() as any).port;await new Promise<void>(r=>probe.close(()=>r()));
 const value={endpoint:"https://example.invalid",dataDir:join(root,"data"),port,configurationVersion:1,fixture:false,libraryRoot:join(root,"library"),libraryPython:old,
  python:{executable:old,models:join(root,"models"),device:"cpu",bootstrap:true,indexVersion:"library-empty-v1"},
  secretFile:join(root,"device.secret"),localSecretFile:join(root,"local.secret")};
 const config=join(root,"node.json"),before=Buffer.from(JSON.stringify(value,null,1)+"\r\n");await writeFile(config,before);
 const manifest=join(root,".local/runtimes/candidate/status.json"),ready={format:1,status:"ready",device:"cpu",
  definitionSha256:sha("definition"),lockSha256:sha("lock"),checkSha256:sha("check"),python:next,pythonw:join(dirname(next),"pythonw.exe")};
 await writeFile(manifest,JSON.stringify(ready));
 const calls:string[]=[];
 const controls:RuntimeSwitchControls={projectRoot:root,platform:"win32",run:async command=>{
  calls.push("check:"+command.executable);assert.equal(command.env.HF_HUB_OFFLINE,"1");
  return JSON.stringify({ok:true,python:"3.12.13",inventorySha256:"a".repeat(64),cudaAvailable:false});
 },stop:async path=>{assert.equal(path,config);calls.push("stop");}};
 return {root,old,next,config,before,manifest,ready,value,controls,calls};
}
async function clean(root:string){assert.ok(relative(resolve(tmpdir()),root).startsWith("pra-runtime-switch-"));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
test("runtime selection preserves credentials, data and original bytes, then rolls back idempotently",async()=>{
 const f=await fixture();try{
  const result=await switchRuntime(f.config,f.manifest,f.controls);
  assert.equal(result.started,false);assert.equal(result.changed,true);assert.equal(result.python,f.next);
  assert.deepEqual(JSON.parse(await readFile(f.config,"utf8")),{...f.value,python:{...f.value.python,executable:f.next},libraryPython:f.next});
  assert.deepEqual(await readFile(join(dirname(result.receipt),"before.json")),f.before);
  assert.deepEqual(f.calls,["check:"+f.next,"stop"]);
  assert.equal(JSON.parse(await readFile(result.receipt,"utf8")).status,"applied");
  assert.equal((await rollbackRuntime(f.config,result.receipt,f.controls)).changed,true);
  assert.deepEqual(await readFile(f.config),f.before);
  assert.equal((await rollbackRuntime(f.config,result.receipt,f.controls)).changed,false);
  assert.deepEqual(f.calls,["check:"+f.next,"stop","check:"+f.old,"stop"]);
 }finally{await clean(f.root);}
});
test("invalid candidates and failed resource checks never stop or replace the existing configuration",async()=>{
 for(const kind of ["schema","status","device","hash","executable","check"]){
  const f=await fixture();try{
   const value:any={...f.ready};if(kind==="schema")value.format=2;if(kind==="status")value.status="installing";
   if(kind==="device")value.device="cuda";if(kind==="hash")value.lockSha256="b".repeat(64);if(kind==="executable")value.python=f.old;
   await writeFile(f.manifest,JSON.stringify(value));
   if(kind==="check")f.controls.run=async()=>{throw Error("raw-private-tool-output");};
   await assert.rejects(switchRuntime(f.config,f.manifest,f.controls),/RUNTIME_(NOT_COMPATIBLE|SOURCE_CHANGED|MANIFEST_CHANGED|CHECK_FAILED)/);
   assert.deepEqual(await readFile(f.config),f.before);assert.ok(!f.calls.includes("stop"));
  }finally{await clean(f.root);}
 }
});
test("stop errors and hand edits during verification cannot overwrite configuration",async()=>{
 for(const mode of ["stop","edit"]){
  const f=await fixture();try{
   let expected=f.before;
   if(mode==="stop")f.controls.stop=async()=>{throw Error("LOCAL_STOP_TIMEOUT");};
   else{const run=f.controls.run!;f.controls.run=async c=>{expected=Buffer.from(JSON.stringify({...f.value,port:f.value.port+1}));await writeFile(f.config,expected);return run(c);};}
   await assert.rejects(switchRuntime(f.config,f.manifest,f.controls),mode==="stop"?/LOCAL_STOP_TIMEOUT/:/NODE_CONFIGURATION_CHANGED/);
   assert.deepEqual(await readFile(f.config),expected);
   if(mode==="edit")assert.ok(!f.calls.includes("stop"));
  }finally{await clean(f.root);}
 }
});
test("rollback rejects later configuration changes, invalid receipts and unavailable old environments",async()=>{
 for(const mode of ["edit","receipt","runtime"]){
  const f=await fixture();try{
   const result=await switchRuntime(f.config,f.manifest,f.controls);
   if(mode==="edit")await writeFile(f.config,(await readFile(f.config,"utf8"))+"\n");
   if(mode==="receipt"){const r=JSON.parse(await readFile(result.receipt,"utf8"));r.format=2;await writeFile(result.receipt,JSON.stringify(r));}
   if(mode==="runtime")f.controls.run=async()=>JSON.stringify({ok:false});
   const before=await readFile(f.config),stops=f.calls.filter(c=>c==="stop").length;
   await assert.rejects(rollbackRuntime(f.config,result.receipt,f.controls),mode==="edit"?/NODE_CONFIGURATION_CHANGED/:mode==="receipt"?/RUNTIME_RECEIPT_INVALID/:/RUNTIME_CHECK_FAILED/);
   assert.deepEqual(await readFile(f.config),before);assert.equal(f.calls.filter(c=>c==="stop").length,stops);
  }finally{await clean(f.root);}
 }
});
test("SQLite ownership rejects concurrent switches and is released after process termination",async()=>{
 const f=await fixture();let child:ChildProcess|undefined;
 try{
  let release!:()=>void,entered!:()=>void;
  const entry=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r),run=f.controls.run!;
  const first=switchRuntime(f.config,f.manifest,{...f.controls,run:async c=>{entered();await gate;return run(c);}});
  await entry;
  await assert.rejects(switchRuntime(f.config,f.manifest,f.controls),/RUNTIME_UPDATE_LOCKED/);release();
  const result=await first,receipt=JSON.parse(await readFile(result.receipt,"utf8"));
  // Simulate interruption after the atomic config write but before the completion record.
  receipt.status="prepared";delete receipt.finished;await writeFile(result.receipt,JSON.stringify(receipt));
  child=spawn(process.execPath,["--input-type=module","-e",
   'import {DatabaseSync} from "node:sqlite";const db=new DatabaseSync(process.argv[1]);db.exec("BEGIN IMMEDIATE");process.stdout.write("locked");setInterval(()=>{},1000);',
   f.config+".runtime-update.sqlite"],{windowsHide:true,stdio:["ignore","pipe","ignore"]});
  await new Promise<void>((ok,no)=>{child!.stdout!.once("data",()=>ok());child!.once("error",no);child!.once("exit",()=>no(Error("LOCK_CHILD_EXITED")));});
  await assert.rejects(rollbackRuntime(f.config,result.receipt,f.controls),/RUNTIME_UPDATE_LOCKED/);
  const ended=new Promise<void>(r=>child!.once("exit",()=>r()));child.kill();await ended;
  assert.equal((await rollbackRuntime(f.config,result.receipt,f.controls)).changed,true);
  assert.deepEqual(await readFile(f.config),f.before);
 }finally{if(child?.exitCode===null)child.kill();await clean(f.root);}
});
