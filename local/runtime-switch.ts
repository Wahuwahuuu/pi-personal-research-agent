import {createHash,randomUUID} from "node:crypto";
import {readFile,mkdir,lstat,realpath,open,rename,unlink} from "node:fs/promises";
import {resolve,join,dirname,relative,isAbsolute,basename} from "node:path";
import {fileURLToPath} from "node:url";
import {createServer} from "node:net";
import {DatabaseSync} from "node:sqlite";
import {installationConfig,type InstallConfig} from "./setup.ts";
import {stopNode} from "./stop-node.ts";
import {trayRunning} from "./lifecycle.ts";
import {runRuntimeCommand,type RuntimeRunner} from "./runtime-install.ts";
import {workerEnvironment} from "../packages/research/transport.ts";
const project=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const sha=(v:Buffer)=>createHash("sha256").update(v).digest("hex");
export interface RuntimeSwitchControls {
 projectRoot?:string;platform?:string;run?:RuntimeRunner;
 stop?:(path:string)=>Promise<unknown>;
 reserve?:(config:InstallConfig)=>Promise<()=>Promise<void>>;
}
interface Receipt {format:1;id:string;config:string;status:"prepared"|"applied"|"rolled_back";beforeSha256:string;afterSha256:string;created:string;finished?:string;manifest?:string}
async function file(path:string){
 const s=await lstat(path).catch(()=>undefined);if(!s?.isFile()||s.isSymbolicLink())throw Error("RUNTIME_FILE_UNAVAILABLE");
 return readFile(path);
}
async function owned(root:string,path:string){
 const base=await realpath(root),actual=await realpath(path),rel=relative(base,actual);
 if(!rel||rel.startsWith("..")||isAbsolute(rel)||actual!==resolve(path))throw Error("RUNTIME_DIRECTORY_ESCAPE");
 return actual;
}
async function directory(parent:string,name:string){
 const path=join(parent,name);await mkdir(path,{recursive:true});
 if((await lstat(path)).isSymbolicLink()||relative(parent,await realpath(path))!==name)throw Error("RUNTIME_DIRECTORY_ESCAPE");
 return path;
}
async function durableWrite(path:string,value:Buffer|string){
 const handle=await open(path,"wx",0o600);
 try{await handle.writeFile(value);await handle.sync();}finally{await handle.close();}
}
async function replace(path:string,value:Buffer|string){
 const temporary=path+"."+randomUUID()+".tmp";
 try{await durableWrite(temporary,value);await rename(temporary,path);}finally{await unlink(temporary).catch(()=>{});}
}
async function reserve(configPath:string,config:InstallConfig){
 if(await trayRunning(configPath,config.dataDir))throw Error("LOCAL_TRAY_RUNNING");
 const server=createServer(socket=>socket.destroy());
 await new Promise<void>((ok,no)=>{
  server.once("error",()=>no(Error("LOCAL_NODE_NOT_STOPPED")));
  server.listen({host:"127.0.0.1",port:config.port,exclusive:true},ok);
 });
 return ()=>new Promise<void>((ok,no)=>server.close(error=>error?no(Error("LOCAL_RESERVATION_RELEASE_FAILED")):ok()));
}
export async function validateRuntimeEnvironment(config:InstallConfig,root:string,run:RuntimeRunner){
 for(const executable of new Set([config.python.executable,config.libraryPython])){
  await file(executable);await file(join(dirname(executable),"pythonw.exe"));
  let resources:any;
  try{resources=JSON.parse(await run({executable,args:[join(root,"local/check-runtime.py")],cwd:join(root,"packages/retrieval"),
   env:{...workerEnvironment(),PYTHONPATH:join(root,"packages/retrieval"),HF_HUB_OFFLINE:"1",TRANSFORMERS_OFFLINE:"1"},
   input:JSON.stringify({models:config.python.models,device:config.python.device}),timeout:120000}));}
  catch{throw Error("RUNTIME_CHECK_FAILED");}
  if(resources.ok!==true||!/^3\.12\.\d+$/.test(resources.python??"")||!/^[a-f0-9]{64}$/.test(resources.inventorySha256??"")||
   (config.python.device==="cuda"&&resources.cudaAvailable!==true))throw Error("RUNTIME_CHECK_FAILED");
 }
}
export async function verifyRuntimeCandidate(root:string,path:string,device?:string){
 const manifest=await owned(join(root,".local/runtimes"),resolve(path));
 if(manifest!==join(dirname(manifest),"status.json"))throw Error("RUNTIME_MANIFEST_REQUIRED");
 const value=JSON.parse((await file(manifest)).toString());
 if(value.format!==1||value.status!=="ready"||(!["cpu","cuda"].includes(value.device)||(device!==undefined&&value.device!==device)))throw Error("RUNTIME_NOT_COMPATIBLE");
 const checks=[["definitionSha256","packages/retrieval/pyproject.toml"],["lockSha256","packages/retrieval/uv.lock"],["checkSha256","local/check-runtime.py"]];
 for(const [field,name] of checks)if(value[field]!==sha(await file(join(root,name))))throw Error("RUNTIME_SOURCE_CHANGED");
 const python=join(dirname(manifest),"python/Scripts/python.exe"),pythonw=join(dirname(manifest),"python/Scripts/pythonw.exe");
 if(value.python!==python||value.pythonw!==pythonw)throw Error("RUNTIME_MANIFEST_CHANGED");
 await owned(dirname(manifest),python);await owned(dirname(manifest),pythonw);
 return {manifest,python,device:value.device as "cpu"|"cuda"};
}
export async function withRuntimeConfiguration<T>(filePath:string,controls:RuntimeSwitchControls,action:(root:string,current:Buffer,config:InstallConfig)=>Promise<T>):Promise<T>{
 if((controls.platform??process.platform)!=="win32")throw Error("WINDOWS_REQUIRED");
 const root=await realpath(controls.projectRoot??project),path=resolve(filePath),lock=path+".runtime-update.sqlite";
 const existing=await lstat(lock).catch(()=>undefined);if(existing&&(existing.isSymbolicLink()||!existing.isFile()))throw Error("RUNTIME_DIRECTORY_ESCAPE");
 const db=new DatabaseSync(lock);
 try{
  try{db.exec("PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS runtime_update_lock(id INTEGER PRIMARY KEY); BEGIN IMMEDIATE");}
  catch{throw Error("RUNTIME_UPDATE_LOCKED");}
  const current=await file(path),config=installationConfig(JSON.parse(current.toString()));
  return await action(root,current,config);
 }finally{if(db.isTransaction)db.exec("ROLLBACK");db.close();}
}
export async function pauseAndReserve(path:string,config:InstallConfig,controls:RuntimeSwitchControls){
 await (controls.stop??stopNode)(path);
 return controls.reserve?controls.reserve(config):reserve(path,config);
}
export async function switchRuntime(configPath:string,manifestPath:string,controls:RuntimeSwitchControls={}){
 configPath=resolve(configPath);
 return withRuntimeConfiguration(configPath,controls,async(root,current,config)=>{
  const next=await verifyRuntimeCandidate(root,manifestPath,config.python.device),original=JSON.parse(current.toString());
  if(original.python.executable===next.python&&original.libraryPython===next.python)throw Error("RUNTIME_ALREADY_SELECTED");
  const updated={...original,python:{...original.python,executable:next.python},libraryPython:next.python};
  const checked=installationConfig(updated);await validateRuntimeEnvironment(checked,root,controls.run??runRuntimeCommand);
  if(sha(await file(configPath))!==sha(current))throw Error("NODE_CONFIGURATION_CHANGED");
  const release=await pauseAndReserve(configPath,config,controls);
  try{
   if(sha(await file(configPath))!==sha(current))throw Error("NODE_CONFIGURATION_CHANGED");
   const latest=await verifyRuntimeCandidate(root,manifestPath,config.python.device);if(latest.python!==next.python)throw Error("RUNTIME_MANIFEST_CHANGED");
   const local=await directory(root,".local"),receipts=await directory(local,"runtime-switches"),id=randomUUID(),recordPath=await directory(receipts,id);
   const after=Buffer.from(JSON.stringify(updated,null,2)+"\n");
   const receipt:Receipt={format:1,id,config:configPath,status:"prepared",beforeSha256:sha(current),afterSha256:sha(after),created:new Date().toISOString(),manifest:next.manifest};
   await durableWrite(join(recordPath,"before.json"),current);await durableWrite(join(recordPath,"after.json"),after);
   await durableWrite(join(recordPath,"receipt.json"),JSON.stringify(receipt,null,2));
   if(sha(await file(configPath))!==receipt.beforeSha256)throw Error("NODE_CONFIGURATION_CHANGED");
   await replace(configPath,after);
   receipt.status="applied";receipt.finished=new Date().toISOString();await replace(join(recordPath,"receipt.json"),JSON.stringify(receipt,null,2));
   return {changed:true,receipt:join(recordPath,"receipt.json"),python:next.python,started:false};
  }finally{await release();}
 });
}
export async function rollbackRuntime(configPath:string,receiptPath:string,controls:RuntimeSwitchControls={}){
 configPath=resolve(configPath);
 return withRuntimeConfiguration(configPath,controls,async(root,current,config)=>{
  const path=await owned(join(root,".local/runtime-switches"),resolve(receiptPath)),folder=dirname(path);
  if(path!==join(folder,"receipt.json"))throw Error("RUNTIME_RECEIPT_REQUIRED");
  const receipt:Receipt=JSON.parse((await file(path)).toString());
  if(receipt.format!==1||receipt.id!==basename(folder)||receipt.config!==configPath||!["prepared","applied","rolled_back"].includes(receipt.status))throw Error("RUNTIME_RECEIPT_INVALID");
  const before=await file(join(folder,"before.json")),after=await file(join(folder,"after.json"));
  if(sha(before)!==receipt.beforeSha256||sha(after)!==receipt.afterSha256)throw Error("RUNTIME_RECEIPT_CHANGED");
  if(sha(current)===receipt.beforeSha256){
   receipt.status="rolled_back";receipt.finished=new Date().toISOString();await replace(path,JSON.stringify(receipt,null,2));
   return {rolledBack:true,changed:false,started:false};
  }
  if(sha(current)!==receipt.afterSha256)throw Error("NODE_CONFIGURATION_CHANGED");
  const checked=installationConfig(JSON.parse(before.toString()));await validateRuntimeEnvironment(checked,root,controls.run??runRuntimeCommand);
  if(sha(await file(configPath))!==sha(current))throw Error("NODE_CONFIGURATION_CHANGED");
  const release=await pauseAndReserve(configPath,config,controls);
  try{
   if(sha(await file(configPath))!==receipt.afterSha256)throw Error("NODE_CONFIGURATION_CHANGED");
   await replace(configPath,before);
   receipt.status="rolled_back";receipt.finished=new Date().toISOString();await replace(path,JSON.stringify(receipt,null,2));
   return {rolledBack:true,changed:true,started:false};
  }finally{await release();}
 });
}
