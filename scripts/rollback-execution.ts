import {readFile,open,rename,unlink} from "node:fs/promises";
import {dirname,basename,join} from "node:path";
import {randomUUID} from "node:crypto";
import {fileDigest,type RollbackPlan} from "./rollback-plan.ts";
import {verifyFrozenRelease} from "./frozen-release.ts";
import {deploymentVerificationTimeout} from "./deployment-access.ts";
import {assertReleaseCompatible,type ReleaseContract} from "../src/release-contract.ts";

export interface RollbackPorts {
 probe():Promise<{build:string;release?:ReleaseContract}>;
 publish(config:string):Promise<void>;
 wait(build:string,contract:ReleaseContract,timeoutMs:number):Promise<void>;
}
async function atomic(path:string,value:unknown){
 const temporary=path+"."+randomUUID()+".tmp",handle=await open(temporary,"wx",0o600);
 try{await handle.writeFile(JSON.stringify(value,null,2));await handle.sync();}finally{await handle.close();}
 try{await rename(temporary,path);}finally{await unlink(temporary).catch(()=>{});}
}
function pendingFile(plan:RollbackPlan){return join(dirname(plan.recordFile),basename(plan.recordFile,".json")+"-rollback-pending.json");}
export async function executeRollback(plan:RollbackPlan,ports:RollbackPorts,apply=false){
 if(fileDigest(await readFile(plan.recordFile))!==plan.recordHash)throw Error("DEPLOYMENT_RECORD_CHANGED");
 await verifyFrozenRelease(plan.root,plan.currentFrozen);await verifyFrozenRelease(plan.root,plan.targetFrozen);
 const path=pendingFile(plan);let prior:any;
 try{prior=JSON.parse(await readFile(path,"utf8"));}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw Error("INVALID_ROLLBACK_RECEIPT");}
 const matches=prior?.format===1&&prior.from===plan.current.build&&prior.to===plan.target.build&&
  prior.currentDigest===plan.current.artifactDigest&&prior.targetDigest===plan.target.artifactDigest;
 if(prior&&prior.status!=="verified"&&!matches)throw Error("OTHER_ROLLBACK_PENDING");
 const live=await ports.probe();
 assertReleaseCompatible(plan.current.releaseContract,live.release);
 if(live.build!==plan.current.build&&!(matches&&live.build===plan.target.build))throw Error("DEPLOYED_BUILD_CHANGED");
 const summary={from:plan.current.build,to:plan.target.build,worker:plan.current.name,modelMode:plan.targetFrozen.config.vars.MODEL_MODE??"mock"};
 if(!apply)return{...summary,status:"ready",applyRequired:true};
 const receipt:any=matches?prior:{format:1,id:randomUUID(),...summary,currentDigest:plan.current.artifactDigest,targetDigest:plan.target.artifactDigest,started:new Date().toISOString()};
 receipt.status="prepared";delete receipt.error;await atomic(path,receipt);
 try{
  // Check again after asynchronous authentication, before making any publication.
  if(fileDigest(await readFile(plan.recordFile))!==plan.recordHash)throw Error("DEPLOYMENT_RECORD_CHANGED");
  await verifyFrozenRelease(plan.root,plan.targetFrozen);
  if(live.build!==plan.target.build){
   receipt.status="uploading";await atomic(path,receipt);
   await ports.publish(plan.targetFrozen.configPath);
   receipt.status="uploaded";await atomic(path,receipt);
  }
  await verifyFrozenRelease(plan.root,plan.targetFrozen);
  const timeoutMs=deploymentVerificationTimeout(plan.targetFrozen.config.durable_objects?.code_update_strategy);
  await ports.wait(plan.target.build,plan.target.releaseContract,timeoutMs);
  if(fileDigest(await readFile(plan.recordFile))!==plan.recordHash)throw Error("DEPLOYMENT_RECORD_CHANGED");
  const vars=plan.targetFrozen.config.vars,verified=new Date().toISOString();
  const completed={...plan.target,mode:vars.MODEL_MODE??"mock",modelId:vars.MODEL_MODE==="live"?vars.MODEL_ID:"deterministic-v1",thinking:"off",
   verified,servingBuildVerifiedAt:verified,verificationTimeoutMs:timeoutMs,operation:"republish-frozen-release",operationId:receipt.id,
   previousBuild:plan.current.build,planChanged:false,dataRestored:false};
  receipt.status="verified";receipt.verified=verified;
  await atomic(join(dirname(plan.recordFile),"rollback-"+receipt.id+".json"),{...receipt,recordPromotion:"tracked-by-operation-id",deploymentRecord:plan.recordFile});
  await atomic(path,receipt);
  // Promote last: a crash or journal failure cannot leave a new verified record with a failed pending receipt.
  await atomic(plan.recordFile,completed);
  return{...summary,status:"verified",operationId:receipt.id,dataRestored:false,planChanged:false};
 }catch(error){
  receipt.status="failed";receipt.error=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:"ROLLBACK_FAILED";
  await atomic(path,receipt);throw Error(receipt.error);
 }
}
