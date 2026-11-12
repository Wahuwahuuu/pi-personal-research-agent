import {createHash,randomUUID} from "node:crypto";
import {readFile,mkdir,lstat,realpath,open,rename,unlink} from "node:fs/promises";
import {resolve,join,dirname,relative,isAbsolute,sep} from "node:path";
import {fileURLToPath} from "node:url";
import {verifyApplicationRelease,type ApplicationRelease} from "./application-release.ts";
import {withRuntimeConfiguration,validateRuntimeEnvironment,pauseAndReserve,type RuntimeSwitchControls} from "./runtime-switch.ts";
import {runRuntimeCommand} from "./runtime-install.ts";
import {installationConfig,type InstallConfig} from "./setup.ts";

const project=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const sha=(bytes:Buffer|string)=>createHash("sha256").update(bytes).digest("hex");
interface Selection {format:1;config:string;release:string;build:string;digest:string;operationId:string;selectedAt:string}
interface Receipt {format:1;id:string;config:string;configSha256:string;before:Selection|null;after:Selection;status:"prepared"|"selected"|"rolled_back"}
const selectionFile=(config:string)=>resolve(config)+".application.json";
async function regular(path:string){
 const stat=await lstat(path);
 if(!stat.isFile()||stat.isSymbolicLink()||await realpath(path)!==resolve(path))throw Error("APPLICATION_FILE_UNAVAILABLE");
 return readFile(path);
}
async function optional(path:string){try{return await regular(path);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw e;}}
async function atomic(path:string,value:unknown){
 const temp=path+"."+randomUUID()+".tmp",handle=await open(temp,"wx",0o600);
 try{await handle.writeFile(JSON.stringify(value,null,2)+"\n");await handle.sync();}finally{await handle.close();}
 try{await rename(temp,path);}finally{await unlink(temp).catch(()=>{});}
}
async function child(root:string,path:string){
 const rel=relative(root,path);
 if(!rel||rel===".."||rel.startsWith(".."+sep)||isAbsolute(rel)||(await lstat(path)).isSymbolicLink()||await realpath(path)!==path)throw Error("APPLICATION_PATH_ESCAPE");
}
function managedConfig(bytes:Buffer):InstallConfig{
 const raw=JSON.parse(bytes.toString()),config=installationConfig(raw);
 const paths=[raw.dataDir,raw.libraryRoot,raw.python.executable,raw.python.models,raw.libraryPython,
  ...["secretFile","localSecretFile"].filter(k=>raw[k]!==undefined).map(k=>raw[k]),
  ...(!raw.python.bootstrap?[raw.python.corpus,raw.python.index]:[])];
 if(paths.some(p=>typeof p!=="string"||!isAbsolute(p)))throw Error("APPLICATION_ABSOLUTE_PATHS_REQUIRED");
 return config;
}
function parseSelection(bytes:Buffer,config:string):Selection{
 const value=JSON.parse(bytes.toString());
 if(value.format!==1||value.config!==config||!isAbsolute(value.release??"")||!/^[a-f0-9]{40}$/.test(value.build??"")||
   !/^[a-f0-9]{64}$/.test(value.digest??"")||!/^[a-f0-9-]{36}$/.test(value.operationId??""))throw Error("APPLICATION_SELECTION_INVALID");
 return value;
}
async function check(root:string,selection:Selection):Promise<ApplicationRelease>{
 const release=await verifyApplicationRelease(root,selection.release);
 if(release.manifest.build!==selection.build||release.digest!==selection.digest)throw Error("APPLICATION_SELECTION_CHANGED");
 return release;
}
async function unchanged(config:string,bytes:Buffer,selected:Buffer|undefined){
 if(sha(await regular(config))!==sha(bytes))throw Error("NODE_CONFIGURATION_CHANGED");
 const now=await optional(selectionFile(config));
 if((now?sha(now):null)!==(selected?sha(selected):null))throw Error("APPLICATION_SELECTION_CHANGED");
}
/** Read-only startup resolution. A damaged selection never falls back silently. */
export async function selectedApplication(configPath:string,root=project){
 const config=resolve(configPath),bytes=await optional(selectionFile(config));
 if(!bytes)return {directory:await realpath(root),build:"development",managed:false};
 managedConfig(await regular(config));
 const selection=parseSelection(bytes,config),release=await check(await realpath(root),selection);
 return {directory:release.directory,build:selection.build,digest:selection.digest,managed:true};
}
export async function selectApplication(configPath:string,targetPath:string,controls:RuntimeSwitchControls={}){
 configPath=resolve(configPath);
 return withRuntimeConfiguration(configPath,controls,async(root,current)=>{
  const config=managedConfig(current),selected=await optional(selectionFile(configPath));
  const before=selected?parseSelection(selected,configPath):null;
  if(before)await check(root,before);
  const target=await verifyApplicationRelease(root,resolve(targetPath));
  if(!target.manifest.files.some(f=>f.path==="local/application-identity.ts"))throw Error("LOCAL_RELEASE_LAUNCH_PROTOCOL_UNSUPPORTED");
  if(before?.release===target.directory&&before.digest===target.digest)return {changed:false,build:before.build,started:false};
  await validateRuntimeEnvironment(config,target.directory,controls.run??runRuntimeCommand);
  await unchanged(configPath,current,selected);
  const unlock=await pauseAndReserve(configPath,config,controls);
  try{
   await unchanged(configPath,current,selected);
   const verified=await verifyApplicationRelease(root,target.directory);
   if(verified.digest!==target.digest)throw Error("LOCAL_RELEASE_CHANGED");
   const local=join(root,".local"),receipts=join(local,"application-switches");await mkdir(receipts,{recursive:true});await child(local,receipts);
   const id=randomUUID(),folder=join(receipts,id);await mkdir(folder);
   const after:Selection={format:1,config:configPath,release:target.directory,build:target.manifest.build,digest:target.digest,operationId:id,selectedAt:new Date().toISOString()};
   const receipt:Receipt={format:1,id,config:configPath,configSha256:sha(current),before,after,status:"prepared"};
   const receiptPath=join(folder,"receipt.json");await atomic(receiptPath,receipt);
   await unchanged(configPath,current,selected);await atomic(selectionFile(configPath),after);
   receipt.status="selected";await atomic(receiptPath,receipt);
   return {changed:true,build:after.build,receipt:receiptPath,firstManagedBaseline:before===null,started:false};
  }finally{await unlock();}
 });
}
export async function rollbackApplication(configPath:string,receiptPath:string,controls:RuntimeSwitchControls={}){
 configPath=resolve(configPath);
 return withRuntimeConfiguration(configPath,controls,async(root,current)=>{
  const config=managedConfig(current),path=resolve(receiptPath),parent=join(root,".local/application-switches");
  await child(root,parent);await child(parent,path);
  const receipt:Receipt=JSON.parse((await regular(path)).toString());
  if(receipt.format!==1||receipt.config!==configPath||path!==join(parent,receipt.id,"receipt.json")||
   !["prepared","selected","rolled_back"].includes(receipt.status))throw Error("APPLICATION_RECEIPT_INVALID");
  if(!receipt.before)throw Error("APPLICATION_BASELINE_HAS_NO_PRIOR_RELEASE");
  if(sha(current)!==receipt.configSha256)throw Error("NODE_CONFIGURATION_CHANGED");
  const prior=parseSelection(Buffer.from(JSON.stringify(receipt.before)),configPath),after=parseSelection(Buffer.from(JSON.stringify(receipt.after)),configPath);
  const target=await check(root,prior),selected=await optional(selectionFile(configPath));
  if(!selected)throw Error("APPLICATION_SELECTION_CHANGED");
  const live=parseSelection(selected,configPath);
  if(JSON.stringify(live)===JSON.stringify(prior)){receipt.status="rolled_back";await atomic(path,receipt);return{changed:false,rolledBack:true,build:prior.build,started:false};}
  if(JSON.stringify(live)!==JSON.stringify(after))throw Error("APPLICATION_SELECTION_CHANGED");
  await check(root,after);
  await validateRuntimeEnvironment(config,target.directory,controls.run??runRuntimeCommand);
  await unchanged(configPath,current,selected);
  const unlock=await pauseAndReserve(configPath,config,controls);
  try{
   await unchanged(configPath,current,selected);await check(root,prior);
   await atomic(selectionFile(configPath),prior);
   receipt.status="rolled_back";await atomic(path,receipt);
   return {changed:true,rolledBack:true,build:prior.build,started:false};
  }finally{await unlock();}
 });
}
