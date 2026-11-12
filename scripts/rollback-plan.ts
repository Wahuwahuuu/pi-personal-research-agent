import {createHash} from "node:crypto";
import {readFile,lstat,realpath} from "node:fs/promises";
import {resolve,relative,isAbsolute,dirname,join,sep} from "node:path";
import {inspectFrozenRelease,type FrozenRelease} from "./frozen-release.ts";
import {parseReleaseContract,assertReleaseCompatible,type ReleaseContract} from "../src/release-contract.ts";

export interface VerifiedReleaseRecord {
 accountId:string;name:string;url:string;build:string;release:string;artifactDigest:string;
 releaseContract:ReleaseContract;servingBuildVerified:true;
}
export interface RollbackPlan {
 recordFile:string;recordHash:string;root:string;current:VerifiedReleaseRecord;target:VerifiedReleaseRecord;
 currentFrozen:FrozenRelease;targetFrozen:FrozenRelease;
}
export const fileDigest=(v:Buffer|string)=>createHash("sha256").update(v).digest("hex");
async function owned(root:string,path:string){
 const rel=relative(root,path);
 if(!rel||rel===".."||rel.startsWith(".."+sep)||isAbsolute(rel)||(await lstat(path)).isSymbolicLink()||await realpath(path)!==path)
  throw Error("RELEASE_PATH_ESCAPE");
}
function record(raw:any):VerifiedReleaseRecord{
 if(!raw||raw.servingBuildVerified!==true||!/^[a-f0-9]{32}$/.test(raw.accountId??"")||
  !/^[a-z0-9][a-z0-9-]{0,62}$/.test(raw.name??"")||!/^([a-f0-9]{40})$/.test(raw.build??"")||
  !/^[a-f0-9]{64}$/.test(raw.artifactDigest??"")||typeof raw.release!=="string"||!isAbsolute(raw.release))
  throw Error("UNVERIFIED_RELEASE");
 const url=new URL(raw.url);
 if(url.protocol!=="https:"||url.username||url.password||url.pathname!=="/"||url.search||url.hash||
  !new RegExp("^"+raw.name+"\\.[a-z0-9-]+\\.workers\\.dev$").test(url.hostname))throw Error("INVALID_RELEASE_ORIGIN");
 return{accountId:raw.accountId,name:raw.name,url:url.origin,build:raw.build,release:resolve(raw.release),artifactDigest:raw.artifactDigest,
  releaseContract:parseReleaseContract(raw.releaseContract),servingBuildVerified:true};
}
function canonical(v:any):any{
 if(Array.isArray(v))return v.map(canonical);
 if(v&&typeof v==="object")return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));
 return v;
}
/** Relocated code/assets and the build marker may differ; all effective bindings/configuration must match. */
function configuration(config:Record<string,any>){
 const copy=JSON.parse(JSON.stringify(config));delete copy.main;delete copy.vars.BUILD_ID;delete copy.assets.directory;
 return JSON.stringify(canonical(copy));
}
export async function prepareRollback(recordPath:string,targetPath:string,project=process.cwd()):Promise<RollbackPlan>{
 const local=resolve(project,".local"),recordFile=resolve(project,recordPath);
 if(await realpath(local)!==local)throw Error("RELEASE_PATH_ESCAPE");
 await owned(local,recordFile);const bytes=await readFile(recordFile);
 let current:VerifiedReleaseRecord;
 try{current=record(JSON.parse(bytes.toString("utf8")));}catch{throw Error("UNVERIFIED_CURRENT_RELEASE");}
 const root=dirname(current.release);await owned(local,root);
 const targetDirectory=resolve(project,targetPath);await owned(root,targetDirectory);
 const receipt=join(targetDirectory,"verification.json");await owned(targetDirectory,receipt);
 let target:VerifiedReleaseRecord;
 try{target=record(JSON.parse(await readFile(receipt,"utf8")));}catch{throw Error("UNVERIFIED_TARGET_RELEASE");}
 if(target.release!==targetDirectory||current.name!==target.name||current.url!==target.url||current.accountId!==target.accountId)
  throw Error("ROLLBACK_IDENTITY_MISMATCH");
 if(current.build===target.build)throw Error("RELEASE_ALREADY_CURRENT");
 assertReleaseCompatible(current.releaseContract,target.releaseContract);
 const currentFrozen=await inspectFrozenRelease(root,current.release,current),targetFrozen=await inspectFrozenRelease(root,target.release,target);
 if(currentFrozen.digest!==current.artifactDigest||targetFrozen.digest!==target.artifactDigest)throw Error("RELEASE_DIGEST_MISMATCH");
 if(configuration(currentFrozen.config)!==configuration(targetFrozen.config))throw Error("ROLLBACK_CONFIGURATION_MISMATCH");
 return{recordFile,recordHash:fileDigest(bytes),root,current,target,currentFrozen,targetFrozen};
}
