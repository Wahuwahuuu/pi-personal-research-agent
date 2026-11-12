import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {EventEmitter} from "node:events";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,dirname,resolve,sep} from "node:path";
import {APPLICATION_CONTRACT} from "../local/application-contract.ts";
import {selectApplication,rollbackApplication,selectedApplication} from "../local/application-selection.ts";
import {applicationIdentity} from "../local/application-identity.ts";
import {launchApplication} from "../local/application-launch.ts";
import {withRuntimeConfiguration,type RuntimeSwitchControls} from "../local/runtime-switch.ts";
import {controlKey} from "../local/lifecycle.ts";
const sha=(v:Buffer|string)=>createHash("sha256").update(v).digest("hex");

async function fixture(t:any){
 const root=await mkdtemp(join(tmpdir(),"pra-app-selection-"));
 t.after(async()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep+"pra-app-selection-"));await rm(root,{recursive:true,force:true,maxRetries:4,retryDelay:100});});
 const create=async(build:string)=>{
  const dir=join(root,".local/node-releases",build),files=[];
  for(const [path,content] of Object.entries({"package-lock.json":"{}", "packages/retrieval/uv.lock":"version = 1","local/check-runtime.py":"pass","local/node.ts":'export const build="'+build+'";',"local/application-identity.ts":"export {};","local/desktop/main.py":"pass"})){
   await mkdir(dirname(join(dir,path)),{recursive:true});await writeFile(join(dir,path),content);
   files.push({path,bytes:Buffer.byteLength(content),sha256:sha(content)});
  }
  files.sort((a,b)=>a.path.localeCompare(b.path));
  const manifest={format:1,status:"ready",build,created:new Date().toISOString(),contract:APPLICATION_CONTRACT,sourceFiles:files.length,files,digest:sha(JSON.stringify(files)),packageLock:sha("{}"),pythonLock:sha("version = 1")};
  await writeFile(join(dir,"release.json"),JSON.stringify(manifest));return{dir,manifest};
 };
 const first=await create("a".repeat(40)),second=await create("b".repeat(40));
 const python=join(root,"runtime/python.exe");await mkdir(dirname(python));await writeFile(python,"runtime");await writeFile(join(dirname(python),"pythonw.exe"),"runtime");
 const data=join(root,"data");await mkdir(data);await writeFile(join(data,"outbox.txt"),"unacknowledged result");const secret=join(root,"device.secret");await writeFile(secret,"protected test device credential");
 const value={configurationVersion:1,endpoint:"https://example.workers.dev",dataDir:data,libraryRoot:join(root,"library"),libraryPython:python,port:48879,secretFile:secret,python:{executable:python,models:join(root,"models"),device:"cpu",bootstrap:true,indexVersion:"library-empty-v1"}};
 const config=join(root,"node.json");await writeFile(config,JSON.stringify(value));const bytes=await readFile(config);
 const calls:string[]=[];const controls:RuntimeSwitchControls={projectRoot:root,platform:"win32",run:async c=>{calls.push("check");assert.ok(c.cwd.includes("node-releases"));return JSON.stringify({ok:true,python:"3.12.13",inventorySha256:"c".repeat(64)});},stop:async()=>{calls.push("stop");},reserve:async()=>()=>Promise.resolve()};
 return{root,first,second,config,bytes,value,data,secret,calls,controls};
}
test("selection validates before stopping, preserves data/configuration, and rolls back by receipt without a silent source fallback",async t=>{
 const f=await fixture(t);
 assert.equal((await selectedApplication(f.config,f.root)).managed,false);
 const first=await selectApplication(f.config,f.first.dir,f.controls);
 assert.equal(first.firstManagedBaseline,true);assert.equal(first.started,false);
 await assert.rejects(rollbackApplication(f.config,first.receipt!,f.controls),/BASELINE_HAS_NO_PRIOR/);
 const next=await selectApplication(f.config,f.second.dir,f.controls);
 assert.equal((await selectedApplication(f.config,f.root)).build,"b".repeat(40));
 assert.equal((await applicationIdentity(f.second.dir)).build,"b".repeat(40));
 assert.deepEqual(f.calls,["check","stop","check","stop"]);
 assert.equal((await rollbackApplication(f.config,next.receipt!,f.controls)).changed,true);
 assert.equal((await rollbackApplication(f.config,next.receipt!,f.controls)).changed,false);
 assert.equal((await selectedApplication(f.config,f.root)).build,"a".repeat(40));
 assert.deepEqual(await readFile(f.config),f.bytes);
 assert.equal(await readFile(join(f.data,"outbox.txt"),"utf8"),"unacknowledged result");
 assert.equal(await readFile(f.secret,"utf8"),"protected test device credential");
});
test("damaged source, unsupported startup protocol, and relative data paths stop before switching or stopping a node",async t=>{
 for(const kind of ["source","relative","protocol"]){
  const f=await fixture(t);
  if(kind==="source")await writeFile(join(f.first.dir,"local/node.ts"),"changed");
  if(kind==="relative")await writeFile(f.config,JSON.stringify({...f.value,dataDir:".local/data"}));
  if(kind==="protocol"){
   // Valid older frozen files still cannot implement the new launch handshake.
   const m=f.first.manifest;m.files=m.files.filter(x=>x.path!=="local/application-identity.ts");m.digest=sha(JSON.stringify(m.files));await rm(join(f.first.dir,"local/application-identity.ts"));await writeFile(join(f.first.dir,"release.json"),JSON.stringify(m));
  }
  await assert.rejects(selectApplication(f.config,f.first.dir,f.controls),kind==="relative"?/ABSOLUTE_PATHS/:kind==="protocol"?/LAUNCH_PROTOCOL/:/CHANGED/);
  assert.ok(!f.calls.includes("stop"));
 }
});
test("failed checks, stop failure, and concurrent edits leave the selected application untouched",async t=>{
 for(const fault of ["check","stop","config","selection"]){
  const f=await fixture(t);await selectApplication(f.config,f.first.dir,f.controls);
  const selected=await readFile(f.config+".application.json");
  if(fault==="check")f.controls.run=async()=>{throw Error("runtime failed");};
  if(fault==="stop")f.controls.stop=async()=>{throw Error("LOCAL_STOP_TIMEOUT");};
  if(fault==="config")f.controls.run=async()=>{await writeFile(f.config,JSON.stringify({...f.value,port:48880}));return JSON.stringify({ok:true,python:"3.12.13",inventorySha256:"c".repeat(64)});};
  if(fault==="selection")f.controls.stop=async()=>{await writeFile(f.config+".application.json",selected.toString()+"\n");};
  await assert.rejects(selectApplication(f.config,f.second.dir,f.controls));
  assert.equal(JSON.parse(await readFile(f.config+".application.json","utf8")).build,"a".repeat(40));
 }
});
test("prepared receipts recover after an atomic selection commit and later unrelated selections cannot be overwritten",async t=>{
 const f=await fixture(t);await selectApplication(f.config,f.first.dir,f.controls);
 const second=await selectApplication(f.config,f.second.dir,f.controls),path=second.receipt!;
 const r=JSON.parse(await readFile(path,"utf8"));r.status="prepared";await writeFile(path,JSON.stringify(r));
 await rollbackApplication(f.config,path,f.controls);
 const again=await selectApplication(f.config,f.second.dir,f.controls);
 await assert.rejects(rollbackApplication(f.config,path,f.controls),/SELECTION_CHANGED/);
 await writeFile(join(f.first.dir,"local/node.ts"),"damaged rollback target");
 await assert.rejects(rollbackApplication(f.config,again.receipt!,f.controls),/CHANGED/);
});
test("startup checks the served identity while holding the same configuration lock used for runtime and application upgrades",async t=>{
 const f=await fixture(t);await selectApplication(f.config,f.first.dir,f.controls);
 const child=new EventEmitter() as any;child.exitCode=null;child.kill=()=>{};
 let calls=0,spawned=false,locked=false;
 const result=await launchApplication(f.config,false,false,{...f.controls,health:async()=>{
  calls++;if(calls===1)return undefined;
  await assert.rejects(withRuntimeConfiguration(f.config,f.controls,async()=>{}),/UPDATE_LOCKED/);locked=true;
  return{instanceId:controlKey(f.config),application:{build:f.first.manifest.build,digest:f.first.manifest.digest}};
 },spawn:(exe,args,cwd,env)=>{assert.equal(exe,process.execPath);assert.equal(cwd,f.first.dir);assert.equal(args[1],f.config);assert.equal(env.PYTHONDONTWRITEBYTECODE,"1");spawned=true;return child;}});
 assert.equal(result,child);assert.ok(spawned&&locked);
 await withRuntimeConfiguration(f.config,f.controls,async()=>{});
});
test("wrong or failed startup cannot be reported as running and stops only the selected configuration",async t=>{
 const f=await fixture(t);await selectApplication(f.config,f.first.dir,f.controls);
 let spawned=false;
 await assert.rejects(launchApplication(f.config,false,false,{...f.controls,health:async()=>({instanceId:"other"}),spawn:()=>{spawned=true;throw Error("not reached");}}),/RESTART_REQUIRED/);
 assert.equal(spawned,false);
 const child=new EventEmitter() as any;child.exitCode=1;child.kill=()=>{};let stopped="";
 await assert.rejects(launchApplication(f.config,true,false,{...f.controls,health:async()=>undefined,spawn:()=>child,stop:async path=>{stopped=path;}}),/START_FAILED/);
 assert.equal(stopped,f.config);
});

test("a failed launcher cannot create a late orphan after cleanup; final stop runs after the owned parent exits",async t=>{
 const f=await fixture(t);await selectApplication(f.config,f.first.dir,f.controls);
 const child=new EventEmitter() as any;child.exitCode=null;
 const sequence:string[]=[];
 child.kill=()=>{sequence.push("kill-parent");child.exitCode=1;child.emit("exit",1);return true;};
 let reads=0;
 await assert.rejects(launchApplication(f.config,true,false,{...f.controls,health:async()=>++reads===1?undefined:{instanceId:"wrong"},spawn:()=>child,stop:async()=>{sequence.push("stop-config");}}),/RESTART_REQUIRED/);
 assert.deepEqual(sequence,["stop-config","kill-parent","stop-config"]);
});
