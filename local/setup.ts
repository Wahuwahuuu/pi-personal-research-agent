import {execFileSync} from "node:child_process";
import {readFile,writeFile,mkdir,open,link,unlink,access,stat} from "node:fs/promises";
import {resolve,dirname,isAbsolute,join} from "node:path";
import {fileURLToPath} from "node:url";
import {request as httpRequest} from "node:http";
import {request as httpsRequest} from "node:https";
import {HttpsProxyAgent} from "https-proxy-agent";
import {workerEnvironment} from "../packages/research/transport.ts";
import {nodeCatalog} from "./catalog.ts";
import type {PythonConfig} from "./python.ts";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
export interface InstallConfig {
 endpoint:string;dataDir:string;port:number;configurationVersion:1;fixture:false;
 python:PythonConfig;libraryPython:string;libraryRoot:string;proxy?:string;secretFile?:string;
}
const keys=(value:Record<string,unknown>,allowed:string[])=>{if(Object.keys(value).some(k=>!allowed.includes(k)))throw Error("UNKNOWN_CONFIGURATION_FIELD");};
export function installationConfig(value:any):InstallConfig{
 if(!value||typeof value!=="object"||Array.isArray(value))throw Error("INVALID_LOCAL_CONFIGURATION");
 keys(value,["endpoint","dataDir","port","configurationVersion","fixture","python","libraryPython","libraryRoot","proxy","secretFile","localSecretFile"]);
 if(value.configurationVersion!==undefined&&value.configurationVersion!==1)throw Error("CONFIGURATION_VERSION_UNSUPPORTED");
 if(value.fixture)throw Error("FIXTURE_INSTALL_DENIED");
 const endpoint=new URL(value.endpoint);
 if(endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=="/"||
   !(endpoint.protocol==="https:"||(endpoint.protocol==="http:"&&["127.0.0.1","localhost"].includes(endpoint.hostname))))throw Error("INVALID_ENDPOINT");
 const port=value.port??48731;
 if(!Number.isSafeInteger(port)||port<1024||port>65535)throw Error("INVALID_LOCAL_PORT");
 if(!value.python||typeof value.python!=="object"||Array.isArray(value.python))throw Error("PYTHON_CONFIG_REQUIRED");
 keys(value.python,["executable","models","device","bootstrap","indexVersion","corpus","index","profile"]);
 const python={...value.python} as PythonConfig;
 for(const name of ["executable","models",...(python.bootstrap?[]:["corpus","index"])]){
  const p=(python as any)[name];if(typeof p!=="string"||!isAbsolute(p))throw Error("ABSOLUTE_LOCAL_PATH_REQUIRED");
 }
 if(!["cuda","cpu"].includes(python.device??""))throw Error("RETRIEVAL_DEVICE_REQUIRED");
 if(python.bootstrap){if(python.bootstrap!==true||python.corpus||python.index||python.indexVersion!=="library-empty-v1")throw Error("INVALID_EMPTY_LIBRARY_CONFIG");}
 else if(typeof python.indexVersion!=="string"||!python.indexVersion||python.indexVersion.length>256)throw Error("VERIFIED_INDEX_REQUIRED");
 for(const name of ["dataDir","libraryRoot"])if(typeof value[name]!=="string"||!value[name])throw Error("LOCAL_DIRECTORY_REQUIRED");
 const libraryPython=value.libraryPython??python.executable;
 if(!isAbsolute(libraryPython))throw Error("ABSOLUTE_LOCAL_PATH_REQUIRED");
 let proxy:string|undefined;
 if(value.proxy){
  const p=new URL(value.proxy);if(!["http:","https:"].includes(p.protocol)||p.username||p.password||p.search||p.hash||p.pathname!=="/")throw Error("INVALID_PROXY");
  proxy=p.href;
 }
 return{endpoint:endpoint.origin,dataDir:resolve(root,value.dataDir),port,configurationVersion:1,fixture:false,python,
  libraryPython,libraryRoot:resolve(root,value.libraryRoot),...(proxy?{proxy}:{})};
}
export async function preflight(config:InstallConfig){
 await access(join(config.dataDir,"node.sqlite")).then(()=>{throw Error("NODE_DATA_ALREADY_IN_USE");},error=>{if(error.code!=="ENOENT")throw error;});
 if(process.platform==="win32"&&!(await stat(join(dirname(config.libraryPython),"pythonw.exe")).catch(()=>undefined))?.isFile())throw Error("DESKTOP_RUNTIME_REQUIRED");
 for(const file of [config.python.executable,config.libraryPython])if(!(await stat(file).catch(()=>undefined))?.isFile())throw Error("PYTHON_EXECUTABLE_UNAVAILABLE");
 await nodeCatalog(config.python);
 const reports:any[]=[];
 for(const python of new Set([config.python.executable,config.libraryPython])){
  let output:string;
  try{output=execFileSync(python,[resolve(root,"local/check-runtime.py")],{cwd:resolve(root,"packages/retrieval"),windowsHide:true,
   input:JSON.stringify({models:config.python.models,device:config.python.device}),encoding:"utf8",stdio:["pipe","pipe","pipe"],timeout:120000,
   env:{...workerEnvironment(),PYTHONPATH:resolve(root,"packages/retrieval"),HF_HUB_OFFLINE:"1",TRANSFORMERS_OFFLINE:"1"}});}
  catch(error){const stdout=(error as {stdout?:string}).stdout;let codes:string[]=[];try{codes=JSON.parse(stdout??"{}").errors??[];}catch{}
   throw Error(codes.filter(c=>/^[A-Z_]+(?::[a-z0-9-]+)?$/.test(c)).join(",")||"RUNTIME_CHECK_FAILED");}
  const report=JSON.parse(output);if(report.ok!==true)throw Error("RUNTIME_CHECK_FAILED");reports.push(report);
 }
 return{protocol:1,configurationVersion:1,runtimes:reports};
}
export function verifyDevice(config:Pick<InstallConfig,"endpoint"|"proxy">,token:string):Promise<{protocol:1;accountScope:string}>{
 if(!/^[A-Za-z0-9._-]{32,256}$/.test(token))return Promise.reject(Error("INVALID_DEVICE_CREDENTIAL"));
 const url=new URL("/api/device/verify",config.endpoint);
 return new Promise((ok,no)=>{
  const req=(url.protocol==="https:"?httpsRequest:httpRequest)(url,{headers:{Authorization:"Bearer "+token},agent:config.proxy?new HttpsProxyAgent(config.proxy):undefined},res=>{
   let text="";res.setEncoding("utf8");
   res.on("data",part=>{text+=part;if(text.length>16000)req.destroy(Error("PAIRING_RESPONSE_LIMIT"));});
   res.on("end",()=>{
    if(res.statusCode!==200)return no(Error(res.statusCode===401?"DEVICE_CREDENTIAL_REJECTED":"DEVICE_VERIFICATION_FAILED"));
    try{const v=JSON.parse(text);if(v.protocol!==1||!/^[a-f0-9]{64}$/.test(v.accountScope))throw Error();ok({protocol:1,accountScope:v.accountScope});}
    catch{no(Error("PROTOCOL_MISMATCH"));}
   });res.on("error",()=>no(Error("DEVICE_VERIFICATION_FAILED")));
  });
  req.setTimeout(15000,()=>req.destroy(Error("DEVICE_VERIFICATION_TIMEOUT")));
  req.on("error",()=>no(Error("DEVICE_VERIFICATION_FAILED")));req.end();
 });
}
export async function persistInstallation(config:InstallConfig,file:string,token:string,resources:unknown,
 protect:(path:string,token:string)=>void=(path,value)=>{execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-File",resolve(root,"scripts/write-secret.ps1"),path],{input:value,windowsHide:true,stdio:["pipe","pipe","pipe"]});}){
 file=resolve(file);const secret=file+".device.secret",report=file+".resources.json",temporary=file+"."+crypto.randomUUID()+".tmp";
 const owned:string[]=[];let committed=false;
 await mkdir(dirname(file),{recursive:true});
 try{
  await access(file).then(()=>{throw Error("NODE_ALREADY_CONFIGURED");},error=>{if(error.code!=="ENOENT")throw error;});
  for(const path of [secret,report,temporary]){const handle=await open(path,"wx",0o600);owned.push(path);await handle.close();}
  protect(secret,token);
  await writeFile(report,JSON.stringify(resources,null,2));
  await writeFile(temporary,JSON.stringify({...config,secretFile:secret},null,2));
  await link(temporary,file);committed=true;await unlink(temporary);owned.splice(owned.indexOf(temporary),1);
  return{configured:true,config:file,credential:"windows-dpapi",started:false};
 }catch(error){
  if(!committed)for(const path of owned)await unlink(path).catch(()=>{});
  if((error as NodeJS.ErrnoException).code==="EEXIST")throw Error("INSTALLATION_FILE_EXISTS");
  throw error;
 }
}
export async function configureNode(template:string,file:string,token:string){
 if(process.platform!=="win32")throw Error("WINDOWS_REQUIRED");
 await access(resolve(file)).then(()=>{throw Error("NODE_ALREADY_CONFIGURED");},error=>{if(error.code!=="ENOENT")throw error;});
 const config=installationConfig(JSON.parse(await readFile(template,"utf8")));
 const resources=await preflight(config);
 const device=await verifyDevice(config,token);
 return persistInstallation(config,file,token,{...resources,accountScope:device.accountScope,checkedAt:new Date().toISOString()});
}
