import {execFile} from "node:child_process";
import {createHash} from "node:crypto";
import {readFile,writeFile,mkdir,realpath,stat,rename,lstat} from "node:fs/promises";
import {resolve,join,isAbsolute,relative,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {workerEnvironment} from "../packages/research/transport.ts";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const hash=(v:Buffer)=>createHash("sha256").update(v).digest("hex");
export interface RuntimeInstallOptions {
 models:string;device:"cpu"|"cuda";python?:string;uv?:string;proxy?:string;
}
export interface RuntimeCommand {executable:string;args:string[];cwd:string;env:NodeJS.ProcessEnv;input?:string;timeout:number}
export type RuntimeRunner=(command:RuntimeCommand)=>Promise<string>;
export const runRuntimeCommand:RuntimeRunner=command=>new Promise((ok,no)=>{
 const child=execFile(command.executable,command.args,{cwd:command.cwd,env:command.env,windowsHide:true,
  encoding:"utf8",maxBuffer:8*1024*1024,timeout:command.timeout},(error,stdout)=>{
   // Installer output can contain package-manager credentials. It is never logged or persisted.
   if(error)no(Error("RUNTIME_COMMAND_FAILED"));else ok(stdout);
 });
 child.stdin?.on("error",()=>{});child.stdin?.end(command.input);
});
export function runtimeEnvironment(proxy?:string):NodeJS.ProcessEnv{
 const env=workerEnvironment();
 for(const key of ["USERPROFILE","APPDATA","LOCALAPPDATA","PROGRAMDATA","HOMEDRIVE","HOMEPATH"])
  if(process.env[key]!==undefined)env[key]=process.env[key];
 if(proxy){
  const p=new URL(proxy);
  if(!["http:","https:"].includes(p.protocol)||p.username||p.password||p.search||p.hash||p.pathname!=="/")throw Error("INVALID_PROXY");
  env.HTTP_PROXY=p.origin;env.HTTPS_PROXY=p.origin;
 }
 return {...env,UV_LINK_MODE:"copy",UV_NO_PROGRESS:"1",UV_KEYRING_PROVIDER:"disabled"};
}
async function regular(file:string){
 const s=await lstat(file).catch(()=>undefined);if(!s?.isFile()||s.isSymbolicLink())throw Error("RUNTIME_SOURCE_UNAVAILABLE");
 return readFile(file);
}
async function childDirectory(parent:string,name:string){
 const path=join(parent,name);await mkdir(path,{recursive:true});
 if((await lstat(path)).isSymbolicLink()||relative(parent,await realpath(path))!==name)throw Error("RUNTIME_DIRECTORY_ESCAPE");
 return path;
}
export async function prepareRuntime(options:RuntimeInstallOptions,controls:{
 projectRoot?:string;run?:RuntimeRunner;progress?:(phase:string)=>void;platform?:string;
}={}){
 if((controls.platform??process.platform)!=="win32")throw Error("WINDOWS_REQUIRED");
 if(!["cuda","cpu"].includes(options.device))throw Error("RETRIEVAL_DEVICE_REQUIRED");
 if(!isAbsolute(options.models)||(await stat(options.models).catch(()=>undefined))?.isDirectory()!==true)throw Error("MODEL_DIRECTORY_REQUIRED");
 const python=options.python??"3.12";
 if(!/^3\.12(?:\.\d+)?$/.test(python)&&(!isAbsolute(python)||(await stat(python).catch(()=>undefined))?.isFile()!==true))throw Error("PYTHON_312_REQUIRED");
 const project=await realpath(controls.projectRoot??root),source=join(project,"packages/retrieval");
 const names=["pyproject.toml","uv.lock"],content=await Promise.all(names.map(n=>regular(join(source,n))));
 const check=join(project,"local/check-runtime.py"),checkContent=await regular(check);
 const env=runtimeEnvironment(options.proxy),run=controls.run??runRuntimeCommand,uv=options.uv??"uv";
 const version=(await run({executable:uv,args:["--version"],cwd:project,env,timeout:15000})).trim();
 if(!/^uv 0\.10\.12(?:\s|$)/.test(version))throw Error("UV_VERSION_UNSUPPORTED");
 const privateDir=await childDirectory(project,".local"),runtimes=await childDirectory(privateDir,"runtimes");
 const directory=join(runtimes,crypto.randomUUID());await mkdir(directory);
 const dependencies=join(directory,"dependencies"),environment=join(directory,"python"),status=join(directory,"status.json");
 const record:any={format:1,created:new Date().toISOString(),status:"installing",uv:version.split(" ").slice(0,2).join(" "),
  device:options.device,lockSha256:hash(content[1]),definitionSha256:hash(content[0]),checkSha256:hash(checkContent)};
 const save=async()=>{const temporary=status+".tmp";await writeFile(temporary,JSON.stringify(record,null,2),{mode:0o600});await rename(temporary,status);};
 await save();
 try{
  await mkdir(dependencies);
  for(let i=0;i<names.length;i++)await writeFile(join(dependencies,names[i]),content[i],{flag:"wx"});
  controls.progress?.("installing");
  await run({executable:uv,args:["sync","--project",dependencies,"--locked","--no-dev","--no-install-project","--no-editable",
   "--extra","retrieval","--extra","desktop","--python",python],
   cwd:project,env:{...env,UV_PROJECT_ENVIRONMENT:environment},timeout:1800000});
  record.status="checking";await save();controls.progress?.("checking");
  const executable=join(environment,"Scripts/python.exe"),pythonw=join(environment,"Scripts/pythonw.exe");
  for(const file of [executable,pythonw])if(!(await stat(file).catch(()=>undefined))?.isFile())throw Error("DESKTOP_RUNTIME_REQUIRED");
  const output=await run({executable,args:[check],cwd:source,
   env:{...workerEnvironment(),PYTHONPATH:source,HF_HUB_OFFLINE:"1",TRANSFORMERS_OFFLINE:"1"},
   input:JSON.stringify({models:options.models,device:options.device}),timeout:120000});
  let resources:any;try{resources=JSON.parse(output);}catch{throw Error("RUNTIME_CHECK_FAILED");}
  if(resources.ok!==true||!/^3\.12\.\d+$/.test(resources.python??"")||!/^[a-f0-9]{64}$/.test(resources.inventorySha256??"")||
    (options.device==="cuda"&&resources.cudaAvailable!==true))throw Error("RUNTIME_CHECK_FAILED");
  for(let i=0;i<names.length;i++)if(hash(await regular(join(source,names[i])))!==hash(content[i]))throw Error("RUNTIME_SOURCE_CHANGED");
  if(hash(await regular(check))!==hash(checkContent))throw Error("RUNTIME_SOURCE_CHANGED");
  record.status="ready";record.python=executable;record.pythonw=pythonw;record.resources=resources;record.finished=new Date().toISOString();
  await save();controls.progress?.("ready");
  return {prepared:true,manifest:status,python:executable,pythonw,lockSha256:record.lockSha256,activated:false};
 }catch(error){
  const code=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:"RUNTIME_INSTALL_FAILED";
  record.status="failed";record.error=code;record.finished=new Date().toISOString();await save().catch(()=>{});
  throw Error(code);
 }
}
