import {execFileSync} from "node:child_process";
import {readFile,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {createHash} from "node:crypto";
import {freezeWorker} from "./freeze-worker.ts";

export function verifyBundleSources(map:unknown,readCommitted:(path:string)=>string) {
  const value=map as any;
  if(!value||!Array.isArray(value.sources)||!Array.isArray(value.sourcesContent)||value.sources.length!==value.sourcesContent.length)
    throw Error("SOURCE_MAP_REQUIRED");
  const hashes=new Map<string,string>();
  for(let i=0;i<value.sources.length;i++){
    if(typeof value.sources[i]!=="string")throw Error("SOURCE_MAP_INVALID");
    const path=value.sources[i].replaceAll("\\","/").replace(/^(?:\.\.\/)+/,"");
    if(path.split("/").includes("node_modules"))continue;
    if(!path.startsWith("src/")&&!path.startsWith("packages/research/"))continue;
    if(path.split("/").some((s:string)=>s===".."||s===".")||typeof value.sourcesContent[i]!=="string")throw Error("SOURCE_MAP_INVALID");
    let source:string;try{source=readCommitted(path);}catch{throw Error("BUNDLE_SOURCE_NOT_COMMITTED");}
    const content=value.sourcesContent[i].replaceAll("\r\n","\n");
    if(content!==source.replaceAll("\r\n","\n"))throw Error("BUNDLE_SOURCE_MISMATCH");
    hashes.set(path,createHash("sha256").update(content).digest("hex"));
  }
  if(!hashes.has("src/worker.ts"))throw Error("WORKER_SOURCE_REQUIRED");
  return {files:hashes.size,digest:createHash("sha256").update(JSON.stringify([...hashes].sort(([a],[b])=>a.localeCompare(b)))).digest("hex")};
}
/** Fresh source compilation and source-map comparison prevent assigning a new commit ID to an old dist bundle. */
export async function freezeSourceWorker(configPath:string,outputDir:string,build:string,root=process.cwd()){
  if(!/^[a-f0-9]{40}$/.test(build))throw Error("SOURCE_COMMIT_REQUIRED");
  const git=(args:string[])=>execFileSync("git",args,{cwd:root,encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"],maxBuffer:10000000});
  const committed=()=>{if(git(["rev-parse","HEAD"]).trim()!==build||git(["status","--porcelain","--untracked-files=normal"]).trim())throw Error("COMMITTED_BUILD_REQUIRED");};
  committed();
  const config=JSON.parse(await readFile(configPath,"utf8"));
  if(resolve(config.main)!==resolve(root,"src/worker.ts"))throw Error("FRESH_WORKER_SOURCE_REQUIRED");
  config.define={...config.define,__PRA_SOURCE_BUILD__:JSON.stringify(build)};
  await writeFile(configPath,JSON.stringify(config));
  await freezeWorker(configPath,outputDir);committed();
  const proof=verifyBundleSources(JSON.parse(await readFile(resolve(outputDir,"worker.js.map"),"utf8")),path=>git(["show",build+":"+path]));
  return {build,...proof};
}
