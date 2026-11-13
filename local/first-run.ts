import {readFile,readdir,lstat,realpath} from "node:fs/promises";
import {resolve,join,dirname,isAbsolute,relative} from "node:path";
import {createServer} from "node:net";
import {DatabaseSync} from "node:sqlite";
import {installationConfig,preflight,verifyDevice,persistInstallation,type InstallConfig} from "./setup.ts";
import {verifyRuntimeCandidate} from "./runtime-switch.ts";
import {selectedApplication,selectApplication} from "./application-selection.ts";
import {prepareApplicationRelease,verifyApplicationRelease} from "./application-release.ts";
import {runtimeEnvironment,runRuntimeCommand} from "./runtime-install.ts";

export interface FirstRunInput {endpoint:string;directory:string;models:string;runtime:string;port:number;proxy?:string}
export interface FirstRunControls {
 preflight?:typeof preflight;verify?:typeof verifyDevice;persist?:typeof persistInstallation;
}
const exists=async(path:string)=>{try{return await lstat(path);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw e;}};
async function directory(path:unknown){
 if(typeof path!=="string"||!isAbsolute(path))throw Error("ABSOLUTE_LOCAL_PATH_REQUIRED");
 const actual=await realpath(path).catch(()=>{throw Error("LOCAL_DIRECTORY_REQUIRED");});
 if(!(await lstat(path)).isDirectory()||actual!==resolve(path))throw Error("LOCAL_DIRECTORY_REQUIRED");
 return actual;
}
export async function availableRuntimes(root:string){
 const parent=join(root,".local/runtimes"),rows=[];
 for(const entry of await readdir(parent,{withFileTypes:true}).catch(()=>[])){
  if(!entry.isDirectory()||entry.isSymbolicLink())continue;
  try{const item=await verifyRuntimeCandidate(root,join(parent,entry.name,"status.json"));rows.push({...item,id:entry.name});}catch{}
 }
 return rows;
}
export async function firstRunConfig(root:string,raw:FirstRunInput):Promise<InstallConfig>{
 if(!raw||typeof raw!=="object"||Array.isArray(raw)||Object.keys(raw).some(k=>!["endpoint","directory","models","runtime","port","proxy"].includes(k)))throw Error("INVALID_SETUP_INPUT");
 const home=await directory(raw.directory),models=await directory(raw.models);
 const overlaps=(a:string,b:string)=>{const rel=relative(a,b);return rel===""||(!rel.startsWith("..")&&!isAbsolute(rel));};
 if(overlaps(home,models)||overlaps(models,home)||overlaps(home,resolve(root)))throw Error("SETUP_DIRECTORY_OVERLAP");
 const candidate=await verifyRuntimeCandidate(root,raw.runtime);
 return installationConfig({endpoint:raw.endpoint,dataDir:join(home,"node"),libraryRoot:join(home,"papers"),port:raw.port,
  python:{executable:candidate.python,models,device:candidate.device,bootstrap:true,indexVersion:"library-empty-v1"},libraryPython:candidate.python,
  ...(raw.proxy?{proxy:raw.proxy}:{})});
}
async function freePort(port:number){
 const server=createServer(socket=>socket.destroy());
 await new Promise<void>((ok,no)=>{server.once("error",()=>no(Error("LOCAL_PORT_IN_USE")));server.listen({host:"127.0.0.1",port,exclusive:true},ok);});
 await new Promise<void>((ok,no)=>server.close(e=>e?no(Error("LOCAL_PORT_IN_USE")):ok()));
}
async function fresh(config:InstallConfig,path:string){
 if(await exists(path))throw Error("NODE_ALREADY_CONFIGURED");
 for(const p of [config.dataDir,config.libraryRoot])if(await exists(p))throw Error("SETUP_DIRECTORY_IN_USE");
 await freePort(config.port);
}
export async function checkFirstRun(root:string,path:string,raw:FirstRunInput,controls:FirstRunControls={}){
 const config=await firstRunConfig(root,raw);await fresh(config,path);
 const resources=await (controls.preflight??preflight)(config);
 return {config,resources};
}
/** Reserve this data root for one configuration, including retries after a crashed installer.
 * The small ownership database contains paths only, never a device credential.
 */
async function reserveDirectory(config:InstallConfig,path:string){
 const file=join(dirname(config.dataDir),".aster-setup.sqlite"),existing=await exists(file);
 if(existing&&(existing.isSymbolicLink()||!existing.isFile()))throw Error("SETUP_DIRECTORY_IN_USE");
 const db=new DatabaseSync(file);
 try{
  db.exec("PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK(id=1),config TEXT NOT NULL); BEGIN IMMEDIATE");
  const prior=db.prepare("SELECT config FROM owner WHERE id=1").get() as {config:string}|undefined;
  if(prior&&prior.config!==resolve(path))throw Error("SETUP_DIRECTORY_IN_USE");
  db.prepare("INSERT OR IGNORE INTO owner(id,config) VALUES(1,?)").run(resolve(path));
  db.exec("COMMIT; BEGIN IMMEDIATE");
  return ()=>{if(db.isTransaction)db.exec("ROLLBACK");db.close();};
 }catch(e){if(db.isTransaction)db.exec("ROLLBACK");db.close();if(String(e).includes("locked"))throw Error("SETUP_BUSY");throw e;}
}
export async function installFirstRun(root:string,path:string,raw:FirstRunInput,token:string,controls:FirstRunControls={},progress:(phase:string)=>void=()=>{}){
 const config=await firstRunConfig(root,raw);await fresh(config,path);
 const release=await reserveDirectory(config,path);
 try{
  progress("checking");const resources=await (controls.preflight??preflight)(config);
  progress("pairing");const device=await (controls.verify??verifyDevice)(config,token);
  await fresh(config,path);progress("saving");
  return await (controls.persist??persistInstallation)(config,path,token,{...resources,accountScope:device.accountScope,checkedAt:new Date().toISOString()});
 }finally{release();}
}
export async function activateFirstRun(root:string,path:string,releasePath?:string){
 const current=await selectedApplication(path,root);
 if(current.managed)return {ready:true,build:current.build,started:false};
 const config=installationConfig(JSON.parse(await readFile(path,"utf8")));
 const proxyEnv=runtimeEnvironment(config.proxy);
 const release=releasePath?await verifyApplicationRelease(root,releasePath):await prepareApplicationRelease({projectRoot:root,
  run:command=>runRuntimeCommand({...command,env:{...command.env,HTTP_PROXY:proxyEnv.HTTP_PROXY,HTTPS_PROXY:proxyEnv.HTTPS_PROXY}})});
 const result=await selectApplication(path,release.directory,{projectRoot:root});
 return {ready:true,build:result.build,started:false};
}
