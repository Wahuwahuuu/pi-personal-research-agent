import {spawn,execFile,type ChildProcess} from "node:child_process";
import {isAbsolute} from "node:path";
import {fileURLToPath} from "node:url";
import {workerEnvironment} from "../packages/research/transport.ts";
export interface LibraryConfig {root:string;executable:string;models:string;device?:"cpu"|"cuda";proxy?:string;baseCorpus?:string;}
export interface ImportJob {id:string;source:string;title?:string;status:"queued"|"acquiring"|"parsing"|"indexing"|"validating"|"published"|"failed"|"cancelled";error?:string;paper_id?:string;version?:string;}
export interface IndexDescriptor {version:string;index:string;corpus:string;manifest_sha:string;job_id:string;}
export type ImportMetadata={title?:string;authors?:string;abstract?:string};
/** Fixed module, fixed actions, JSON stdin. Filesystem selection is exclusively a local UI concern. */
export class LibraryClient {
 config:LibraryConfig;
 children=new Set<ChildProcess>();
 constructor(config:LibraryConfig){
  for(const value of [config.root,config.executable,config.models,...(config.baseCorpus?[config.baseCorpus]:[])])if(!isAbsolute(value))throw Error("ABSOLUTE_LOCAL_PATH_REQUIRED");
  if(config.proxy&&!["http:","https:"].includes(new URL(config.proxy).protocol))throw Error("INVALID_PROXY");
  this.config=config;
 }
 private invoke<T>(body:Record<string,unknown>,signal?:AbortSignal,timeoutMs=30000):Promise<T>{
  signal?.throwIfAborted();
  const env={...workerEnvironment(),...(this.config.proxy?{HTTPS_PROXY:this.config.proxy,HTTP_PROXY:this.config.proxy}:{}),
   ...(this.config.device==="cpu"?{OMP_NUM_THREADS:"4",MKL_NUM_THREADS:"4",TOKENIZERS_PARALLELISM:"false"}:{})};
  return new Promise((resolve,reject)=>{
   const child=spawn(this.config.executable,["-m","retriever.library","--root",this.config.root],{
    cwd:fileURLToPath(new URL("../packages/retrieval",import.meta.url)),env,windowsHide:true,stdio:["pipe","pipe","pipe"],shell:false
   });
   this.children.add(child);
   let output="",failure:string|undefined,settled=false;
   const kill=(reason:string)=>{
    failure??=reason;
    if(child.pid&&process.platform==="win32")execFile("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true},()=>{});
    else child.kill("SIGKILL");
   };
   const abort=()=>kill("CANCELLED"),timer=setTimeout(()=>kill("LIBRARY_TIMEOUT"),timeoutMs);
   signal?.addEventListener("abort",abort,{once:true});
   const finish=(error?:Error,result?:T)=>{
    if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener("abort",abort);this.children.delete(child);
    error?reject(error):resolve(result!);
   };
   child.stdout.setEncoding("utf8");child.stdout.on("data",part=>{output+=part;if(Buffer.byteLength(output)>1000000)kill("LIBRARY_RESPONSE_LIMIT");});
   child.stderr.resume(); // Never persist arbitrary parser output or selected filenames.
   child.once("error",()=>finish(Error("LIBRARY_START_FAILED")));
   child.once("close",code=>{
    if(failure)return finish(Error(failure));
    try{
     const value=JSON.parse(output);
     if(code!==0||value.error)throw Error(typeof value.error==="string"&&/^[A-Z_]{1,80}$/.test(value.error)?value.error:"LIBRARY_COMMAND_FAILED");
     finish(undefined,value.result);
    }catch(e){finish(e instanceof Error?e:Error("LIBRARY_PROTOCOL_ERROR"));}
   });
   child.stdin.on("error",()=>kill("LIBRARY_INPUT_FAILED"));
   child.stdin.end(JSON.stringify(body));
  });
 }
 registerPdf(requestId:string,path:string,metadata:ImportMetadata={}){if(!isAbsolute(path))throw Error("ABSOLUTE_LOCAL_PATH_REQUIRED");return this.invoke<ImportJob>({action:"register_pdf",requestId,path,metadata});}
 registerArxiv(requestId:string,arxivId:string,metadata:ImportMetadata={}){
  if(!/^\d{4}\.\d{4,5}v[1-9]\d{0,3}$/.test(arxivId))throw Error("VERSIONED_ARXIV_ID_REQUIRED");
  return this.invoke<ImportJob>({action:"register_arxiv",requestId,arxivId,metadata});
 }
 run(signal?:AbortSignal){return this.invoke<ImportJob|null>({action:"run",models:this.config.models,device:this.config.device??"cuda",baseCorpus:this.config.baseCorpus},signal,1800000);}
 jobs(){return this.invoke<ImportJob[]>({action:"list",limit:200});}
 status(id:string){return this.invoke<ImportJob>({action:"status",id});}
 cancel(id:string){return this.invoke<ImportJob>({action:"cancel",id});}
 fail(id:string,code:"IMPORT_PROCESS_INTERRUPTED"|"IMPORT_TIMEOUT"){return this.invoke<ImportJob>({action:"mark_failure",id,code});}
 retry(id:string){return this.invoke<ImportJob>({action:"retry",id});}
 active(){return this.invoke<IndexDescriptor|null>({action:"active"});}
 rollback(version:string){return this.invoke<IndexDescriptor>({action:"rollback",version});}
}
