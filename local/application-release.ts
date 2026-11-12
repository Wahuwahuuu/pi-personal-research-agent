import {createHash,randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {readFile,writeFile,mkdir,lstat,realpath,readdir,open,rename,unlink} from "node:fs/promises";
import {resolve,join,dirname,relative,isAbsolute,sep} from "node:path";
import {fileURLToPath} from "node:url";
import {APPLICATION_CONTRACT,assertApplicationCompatible} from "./application-contract.ts";
import {runRuntimeCommand,type RuntimeRunner} from "./runtime-install.ts";
import {workerEnvironment} from "../packages/research/transport.ts";

const project=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const sha=(value:Buffer|string)=>createHash("sha256").update(value).digest("hex");
interface Entry {path:string;bytes:number;sha256:string}
export interface ApplicationManifest {
  format:1;status:"ready";build:string;created:string;contract:typeof APPLICATION_CONTRACT;
  sourceFiles:number;files:Entry[];digest:string;packageLock:string;pythonLock:string;
}
export interface ApplicationRelease {directory:string;manifest:ApplicationManifest;digest:string}
export interface ApplicationReleaseControls {projectRoot?:string;run?:RuntimeRunner;npmCli?:string}
function allowed(path:string) {
  return /^(?:local\/|src\/|packages\/research\/|packages\/retrieval\/|scripts\/(?:read-secret|write-secret)\.ps1$|package(?:-lock)?\.json$)/.test(path) &&
    !/(^|\/)(?:tests?|__pycache__|node_modules|\.local|\.git)(\/|$)/.test(path) &&
    !/(?:^|\/)(?:AGENTS|CLAUDE)\.md$/i.test(path) &&
    !/(?:^|\/)test_[^/]*$|\.(?:test|spec)\.[^/]+$/.test(path) &&
    /(?:\.(?:ts|js|mjs|cjs|css|py|html|json|ps1|toml|lock|md)|\/LICENSE)$/.test(path);
}
function safeRelative(path:string) {
  return path!==""&&!path.includes("\\")&&!path.includes(":")&&!path.startsWith("/")&&
    path.split("/").every(p=>p!==""&&p!=="."&&p!=="..");
}
async function owned(root:string,path:string){
 const rel=relative(root,path);
 if(!rel||rel===".."||rel.startsWith(".."+sep)||isAbsolute(rel)||
   (await lstat(path)).isSymbolicLink()||await realpath(path)!==path)throw Error("LOCAL_RELEASE_PATH_ESCAPE");
}
async function inventory(directory:string):Promise<Entry[]>{
 const folders=[directory],paths:string[]=[],out:Entry[]=[];
 // Bound parallel reads across the whole tree, rather than multiplying concurrency per folder.
 while(folders.length){
  const folder=folders.pop()!;
  for(const entry of await readdir(folder,{withFileTypes:true})){
   if(folder===directory&&entry.name==="release.json")continue;
   const path=join(folder,entry.name);
   if(entry.isSymbolicLink())throw Error("LOCAL_RELEASE_PATH_ESCAPE");
   if(entry.isDirectory()){await owned(directory,path);folders.push(path);}
   else if(entry.isFile())paths.push(path);
   else throw Error("LOCAL_RELEASE_FILE_REQUIRED");
  }
 }
 let cursor=0;
 await Promise.all(Array.from({length:Math.min(8,paths.length)},async()=>{
  while(cursor<paths.length){
   const file=paths[cursor++];await owned(directory,file);
   const bytes=await readFile(file);
   out.push({path:relative(directory,file).split(sep).join("/"),bytes:bytes.length,sha256:sha(bytes)});
  }
 }));
 return out.sort((a,b)=>a.path.localeCompare(b.path));
}
async function writeAtomic(path:string,value:string){
 const temporary=path+"."+randomUUID()+".tmp",handle=await open(temporary,"wx",0o600);
 try{await handle.writeFile(value);await handle.sync();}finally{await handle.close();}
 try{await rename(temporary,path);}finally{await unlink(temporary).catch(()=>{});}
}
export async function verifyApplicationRelease(root:string,path:string):Promise<ApplicationRelease>{
 root=await realpath(resolve(root));const parent=resolve(root,".local/node-releases"),directory=resolve(path);
 await owned(root,parent);await owned(parent,directory);
 const file=join(directory,"release.json");await owned(directory,file);
 let manifest:ApplicationManifest;
 try{manifest=JSON.parse(await readFile(file,"utf8"));}catch{throw Error("LOCAL_RELEASE_INVALID");}
 if(manifest.format!==1||manifest.status!=="ready"||!/^[a-f0-9]{40}$/.test(manifest.build)||
   !Number.isSafeInteger(manifest.sourceFiles)||manifest.sourceFiles<1||!Array.isArray(manifest.files)||
   manifest.files.some(f=>!safeRelative(f.path)||!Number.isSafeInteger(f.bytes)||f.bytes<0||!/^[a-f0-9]{64}$/.test(f.sha256)))
   throw Error("LOCAL_RELEASE_INVALID");
 assertApplicationCompatible(manifest.contract);
 const files=await inventory(directory),digest=sha(JSON.stringify(files));
 if(digest!==manifest.digest||JSON.stringify(files)!==JSON.stringify(manifest.files))throw Error("LOCAL_RELEASE_CHANGED");
 if(sha(await readFile(join(directory,"package-lock.json")))!==manifest.packageLock||
    sha(await readFile(join(directory,"packages/retrieval/uv.lock")))!==manifest.pythonLock)throw Error("LOCAL_RELEASE_CHANGED");
 return {directory,manifest,digest};
}
/** Copy committed product files only. Configuration, data and development materials are never inputs. */
export async function prepareApplicationRelease(controls:ApplicationReleaseControls={}):Promise<ApplicationRelease>{
 const root=await realpath(controls.projectRoot??project),run=controls.run??runRuntimeCommand;
 const git=(args:string[])=>execFileSync("git",["-C",root,...args],{windowsHide:true,stdio:["ignore","pipe","pipe"],maxBuffer:40*1024*1024});
 const build=git(["rev-parse","HEAD"]).toString().trim();
 const clean=()=>{if(!/^[a-f0-9]{40}$/.test(build)||git(["rev-parse","HEAD"]).toString().trim()!==build||
   git(["status","--porcelain","--untracked-files=normal"]).toString().trim())throw Error("COMMITTED_BUILD_REQUIRED");};
 clean();
 const paths=git(["ls-tree","-r","--name-only","-z",build]).toString("utf8").split("\0").filter(p=>p&&allowed(p));
 for(const required of ["local/node.ts","local/application-contract.ts","local/desktop/main.py","local/check-runtime.py","package.json","package-lock.json","packages/research/package.json","packages/research/package-lock.json","packages/retrieval/uv.lock","packages/retrieval/pyproject.toml"])
  if(!paths.includes(required))throw Error("LOCAL_RELEASE_SOURCE_MISSING");
 const local=join(root,".local");await mkdir(local,{recursive:true});await owned(root,local);
 const parent=join(local,"node-releases");await mkdir(parent,{recursive:true});await owned(local,parent);
 const directory=join(parent,build+"-"+randomUUID());await mkdir(directory);await owned(parent,directory);
 let phase="copying-source";
 try{
  for(const path of paths){
   if(!safeRelative(path))throw Error("LOCAL_RELEASE_PATH_ESCAPE");
   const file=join(directory,...path.split("/"));await mkdir(dirname(file),{recursive:true});
   await writeFile(file,git(["show",build+":"+path]),{flag:"wx"});
  }
  const npmCli=controls.npmCli??join(dirname(process.execPath),"node_modules/npm/bin/npm-cli.js");
  const env={...workerEnvironment(),HTTPS_PROXY:process.env.HTTPS_PROXY,HTTP_PROXY:process.env.HTTP_PROXY};
  for(const cwd of [directory,join(directory,"packages/research")]){
    phase=cwd===directory?"installing-host-dependencies":"installing-research-dependencies";
    await run({executable:process.execPath,args:[npmCli,"ci","--omit=dev","--ignore-scripts","--no-audit","--no-fund"],cwd,env,timeout:300000});
  }
  phase="checking-imports";
  // Imports execute the real installed dependencies without opening a node, file library or cloud session.
  await run({executable:process.execPath,args:["--input-type=module","-e",
   'await import("ws");await import("https-proxy-agent");await import("./packages/research/core.ts");await import("./local/catalog.ts");'],
   cwd:directory,env:workerEnvironment(),timeout:30000});
  clean();phase="sealing-files";
  const files=await inventory(directory),digest=sha(JSON.stringify(files));
  const manifest:ApplicationManifest={format:1,status:"ready",build,created:new Date().toISOString(),contract:APPLICATION_CONTRACT,sourceFiles:paths.length,files,digest,
   packageLock:sha(await readFile(join(directory,"package-lock.json"))),pythonLock:sha(await readFile(join(directory,"packages/retrieval/uv.lock")))};
  await writeAtomic(join(directory,"release.json"),JSON.stringify(manifest,null,2));
  return verifyApplicationRelease(root,directory);
 }catch{
  await writeFile(join(directory,"failure.json"),JSON.stringify({status:"failed",phase,at:new Date().toISOString(),build})).catch(()=>{});
  // Keep an incomplete directory for diagnosis; without a ready manifest it cannot be selected.
  throw Error("LOCAL_APPLICATION_PREPARATION_FAILED");
 }
}
