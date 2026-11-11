import {readFile,realpath,access} from "node:fs/promises";
import {resolve,relative,isAbsolute,join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {createHash} from "node:crypto";
import {PythonBridge,type PythonConfig} from "./python.ts";
import {nodeCatalog} from "./catalog.ts";
import {createLocalReading} from "../packages/research/local-reading.ts";
import type {ResearchCatalog} from "../src/research-catalog.ts";
import type {Tool} from "../src/domain.ts";
import type {IndexDescriptor} from "./library-client.ts";
type Runtime={config:PythonConfig;catalog:ResearchCatalog;bridge:PythonBridge;reading:Awaited<ReturnType<typeof createLocalReading>>};
/** All tasks select a registered immutable version; only one version's models are resident at once. */
export class SnapshotManager {
 base:PythonConfig;
 root?:string;
 dataDir:string;
 activeVersion:string;
 configs=new Map<string,PythonConfig>();
 runtimes=new Map<string,Runtime>();
 selected?:Runtime;
 busy=false;
 activePointer?:string;
 constructor(base:PythonConfig,dataDir:string,libraryRoot?:string){
  this.base=base;this.dataDir=resolve(dataDir);this.root=libraryRoot?resolve(libraryRoot):undefined;
  this.activeVersion=base.indexVersion;this.configs.set(base.indexVersion,base);
 }
 async owned(path:string){
  if(!this.root||isAbsolute(path))throw Error("UNSAFE_INDEX_PATH");
  const root=await realpath(this.root),target=await realpath(resolve(root,path)),rel=relative(root,target);
  if(rel.startsWith("..")||isAbsolute(rel))throw Error("UNSAFE_INDEX_PATH");
  return target;
 }
 async refresh(){
  if(!this.root||this.busy)return false;
  try{await access(join(this.root,"active.json"));}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return false;throw e;}
  const pointerText=await readFile(join(this.root,"active.json"),"utf8");
  if(pointerText===this.activePointer)return false;
  const pointer=JSON.parse(pointerText) as IndexDescriptor;
  const db=new DatabaseSync(join(this.root,"library.sqlite"),{readOnly:true});
  let versions:{version:string;descriptor:string}[];
  try{versions=db.prepare("SELECT version,descriptor FROM versions ORDER BY rowid DESC LIMIT 201").all() as typeof versions;}finally{db.close();}
  if(versions.length>200)throw Error("INDEX_RETENTION_REVIEW_REQUIRED");
  const active=versions.find(v=>v.version===pointer.version);
  if(!active)throw Error("UNREGISTERED_INDEX");
  const recorded=JSON.parse(active.descriptor);
  if((["version","index","corpus","manifest_sha"] as const).some(k=>recorded[k]!==pointer[k]))throw Error("INDEX_DESCRIPTOR_CHANGED");
  const candidates=new Map<string,PythonConfig>([[this.base.indexVersion,this.base]]);
  for(const row of versions){
   const descriptor=JSON.parse(row.descriptor) as IndexDescriptor;
   if(descriptor.version!==row.version||typeof row.version!=="string"||row.version.length>256||!/^[a-f0-9]{64}$/.test(descriptor.manifest_sha))throw Error("INVALID_INDEX_DESCRIPTOR");
   try{
    const index=await this.owned(descriptor.index),corpus=await this.owned(descriptor.corpus);
    if(createHash("sha256").update(await readFile(join(index,"index-manifest.json"))).digest("hex")!==descriptor.manifest_sha)throw Error("INDEX_MANIFEST_CHANGED");
    candidates.set(row.version,{...this.base,worker:undefined,index,corpus,indexVersion:row.version});
   }catch(e){if(row.version===pointer.version)throw e;} // Missing historical snapshots are excluded, so the host reports unavailability.
  }
  const config=candidates.get(pointer.version)!;
  await nodeCatalog(config);
  const changed=this.activeVersion!==pointer.version;
  if(candidates.size>200)throw Error("INDEX_RETENTION_REVIEW_REQUIRED");
  this.configs=candidates;this.activeVersion=pointer.version;this.activePointer=pointerText;
  return changed;
 }
 retained(){return [...this.configs.keys()];}
 async runtime(version:string){
  const config=this.configs.get(version);
  if(!config)throw Error("INDEX_UNAVAILABLE");
  const cached=this.runtimes.get(version);if(cached)return cached;
  const catalog=await nodeCatalog(config),bridge=new PythonBridge({...config,scientificCacheDir:join(this.dataDir,".cache/scientific-reading")});
  const reading=await createLocalReading({root:this.dataDir,indexVersion:version,papers:catalog.papers,evidence:catalog.evidence,worker:{
   request:(tool,params,signal)=>bridge.request(tool,{...params},signal??AbortSignal.timeout(180000)),
   readScientificSources:(params,signal)=>bridge.readScientificSources(params,signal)
  }});
  const runtime={config,catalog,bridge,reading};this.runtimes.set(version,runtime);
  while(this.runtimes.size>2){const key=[...this.runtimes.keys()].find(key=>key!==version&&this.runtimes.get(key)!==this.selected);if(!key)break;this.runtimes.get(key)!.bridge.stop();this.runtimes.delete(key);}
  return runtime;
 }
 async activate(version:string,signal?:AbortSignal){
  signal?.throwIfAborted();
  const next=await this.runtime(version);
  signal?.throwIfAborted();
  if(this.selected!==next){await this.selected?.bridge.close();this.selected=next;}
  signal?.throwIfAborted();
  const abort=()=>next.bridge.stop();signal?.addEventListener("abort",abort,{once:true});
  try{await next.bridge.ready();signal?.throwIfAborted();return next;}finally{signal?.removeEventListener("abort",abort);}
 }
 async ready(){
  if(this.busy)throw Error("RETRIEVER_BUSY");
  this.busy=true;try{return await this.activate(this.activeVersion);}finally{this.busy=false;}
 }
 async execute(version:string,tool:Tool,params:any,signal:AbortSignal){
  if(this.busy)throw Error("RETRIEVER_BUSY");
  this.busy=true;
  try{const runtime=await this.activate(version,signal);signal.throwIfAborted();const result=await runtime.reading.execute(tool,params,signal);return {...result,catalog:runtime.catalog};}
  finally{this.busy=false;}
 }
 async maintain<T>(work:()=>Promise<T>){
  if(this.busy)throw Error("RETRIEVER_BUSY");
  this.busy=true;await this.selected?.bridge.close();this.selected=undefined;
  try{return await work();}finally{this.busy=false;}
 }
 async pdf(version:string,paper:string){
  const runtime=await this.runtime(version);
  if(!runtime.catalog.papers.some(p=>p.paper_id===paper))throw Error("UNKNOWN_PAPER");
  let registryExists=false;if(this.root)try{await access(join(this.root,"library.sqlite"));registryExists=true;}catch{}
  if(this.root&&registryExists){
   const db=new DatabaseSync(join(this.root,"library.sqlite"),{readOnly:true});
   let saved:{sha:string}|undefined;try{saved=db.prepare("SELECT sha FROM papers WHERE id=?").get(paper) as typeof saved;}finally{db.close();}
   if(saved){
    if(!/^[a-f0-9]{64}$/.test(saved.sha))throw Error("INVALID_PAPER_RECORD");
    const bytes=await readFile(await this.owned("objects/"+saved.sha+".pdf"));
    if(createHash("sha256").update(bytes).digest("hex")!==saved.sha)throw Error("LIBRARY_OBJECT_CHANGED");
    return bytes;
   }
  }
  return runtime.reading.pdf(paper);
 }
 stop(){for(const runtime of this.runtimes.values())runtime.bridge.stop();this.selected=undefined;}
}
