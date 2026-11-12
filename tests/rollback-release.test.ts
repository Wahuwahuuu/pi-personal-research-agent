import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve,sep} from "node:path";
import {RELEASE_CONTRACT} from "../src/release-contract.ts";
import {inspectFrozenRelease} from "../scripts/frozen-release.ts";
import {prepareRollback} from "../scripts/rollback-plan.ts";
import {executeRollback,type RollbackPorts} from "../scripts/rollback-execution.ts";
import {acquireDeploymentLock} from "../scripts/deployment-lock.ts";

async function fixture(t:any){
 const root=await mkdtemp(join(tmpdir(),"pra-rollback-"));
 t.after(async()=>{if(!resolve(root).startsWith(resolve(tmpdir())+sep+"pra-rollback-"))throw Error("UNSAFE_TEST_PATH");await rm(root,{recursive:true,force:true});});
 const local=join(root,".local"),releases=join(local,"releases");await mkdir(releases,{recursive:true});
 const name="rollback-fixture",accountId="a".repeat(32),url="https://"+name+".example.workers.dev";
 const create=async(build:string)=>{
  const release=join(releases,build);await mkdir(join(release,"worker"),{recursive:true});await mkdir(join(release,"assets"));
  await writeFile(join(release,"worker/worker.js"),"export default {build:"+JSON.stringify(build)+"};");
  await writeFile(join(release,"assets/index.html"),"<main>Ready "+build+"</main>");
  const config={name,main:join(release,"worker/worker.js"),assets:{directory:join(release,"assets"),binding:"ASSETS"},vars:{BUILD_ID:build,MODEL_MODE:"mock",OWNER_ID:"example"},
   durable_objects:{bindings:[{name:"AGENTS",class_name:"PersonalAgent"}],code_update_strategy:{mode:"immediate"}}};
  await writeFile(join(release,"wrangler.json"),JSON.stringify(config));
  const frozen=await inspectFrozenRelease(releases,release,{name,build});
  const record={accountId,name,url,build,release,artifactDigest:frozen.digest,releaseContract:structuredClone(RELEASE_CONTRACT),servingBuildVerified:true};
  await writeFile(join(release,"verification.json"),JSON.stringify(record));return{record,config};
 };
 const older=await create("b".repeat(40)),newer=await create("c".repeat(40)),recordFile=join(local,"deployment.json");
 await writeFile(recordFile,JSON.stringify(newer.record));
 const plan=()=>prepareRollback(recordFile,older.record.release,root);
 const reseal=async()=>{
  await writeFile(join(older.record.release,"wrangler.json"),JSON.stringify(older.config));
  older.record.artifactDigest=(await inspectFrozenRelease(releases,older.record.release,older.record)).digest;
  await writeFile(join(older.record.release,"verification.json"),JSON.stringify(older.record));
 };
 const calls:string[]=[];let live=newer.record.build;
 const ports:RollbackPorts={
  probe:async()=>({build:live,release:RELEASE_CONTRACT}),
  publish:async path=>{assert.equal(path,join(older.record.release,"wrangler.json"));calls.push("upload");live=older.record.build;},
  wait:async(build,contract,timeout)=>{calls.push("verify");assert.equal(live,build);assert.deepEqual(contract,RELEASE_CONTRACT);assert.equal(timeout,120000);}
 };
 return{root,local,releases,older,newer,recordFile,plan,reseal,calls,ports,setLive:(v:string)=>{live=v;}};
}

test("rollback preview validates actual files and live identity without publishing or modifying the deployment record",async t=>{
 const f=await fixture(t),before=await readFile(f.recordFile,"utf8"),plan=await f.plan();
 const preview=await executeRollback(plan,f.ports);
 assert.equal(preview.status,"ready");assert.equal(preview.from,f.newer.record.build);assert.equal(preview.to,f.older.record.build);
 assert.deepEqual(f.calls,[]);assert.equal(await readFile(f.recordFile,"utf8"),before);
 await assert.rejects(readFile(join(f.local,"deployment-rollback-pending.json")),/ENOENT/);
});

test("rollback refuses another identity, compatibility family or effective configuration before publishing",async t=>{
 for(const kind of ["account","family","mode"]){
  const f=await fixture(t);
  if(kind==="account")f.older.record.accountId="d".repeat(32);
  if(kind==="family")f.older.record.releaseContract.family="other";
  if(kind==="mode")f.older.config.vars.MODEL_MODE="live";
  await f.reseal();
  await assert.rejects(f.plan(),new RegExp(kind==="account"?"IDENTITY":kind==="family"?"INCOMPATIBLE":"CONFIGURATION"));
  assert.deepEqual(f.calls,[]);
 }
});

test("unverified, missing contracts and changed frozen bytes cannot become rollback targets",async t=>{
 const f=await fixture(t);
 await writeFile(join(f.older.record.release,"verification.json"),JSON.stringify({...f.older.record,releaseContract:undefined}));
 await assert.rejects(f.plan(),/UNVERIFIED_TARGET/);
 await f.reseal();
 await writeFile(join(f.older.record.release,"worker/worker.js"),"changed");
 await assert.rejects(f.plan(),/DIGEST_MISMATCH/);
 const outside=join(f.root,"outside");await mkdir(outside);await assert.rejects(prepareRollback(f.recordFile,outside,f.root),/PATH_ESCAPE/);
});

test("only a served target contract promotes the deployment record and allows a later restoration of the newer release",async t=>{
 const f=await fixture(t),plan=await f.plan();
 const result=await executeRollback(plan,f.ports,true);
 assert.equal(result.status,"verified");assert.deepEqual(f.calls,["upload","verify"]);
 const record=JSON.parse(await readFile(f.recordFile,"utf8"));assert.equal(record.build,f.older.record.build);
 assert.equal(record.previousBuild,f.newer.record.build);assert.equal(record.dataRestored,false);assert.equal(record.servingBuildVerified,true);
 const pending=JSON.parse(await readFile(join(f.local,"deployment-rollback-pending.json"),"utf8"));assert.equal(pending.status,"verified");
 const forward=await prepareRollback(f.recordFile,f.newer.record.release,f.root);
 assert.equal(forward.current.build,f.older.record.build);assert.equal(forward.target.build,f.newer.record.build);
});

test("ambiguous upload failure is journaled; a served target resumes verification without another upload",async t=>{
 const f=await fixture(t),plan=await f.plan();
 await assert.rejects(executeRollback(plan,{...f.ports,publish:async path=>{await f.ports.publish(path);throw Error("UPLOAD_CONNECTION_LOST");}},true),/UPLOAD_CONNECTION_LOST/);
 assert.equal(JSON.parse(await readFile(f.recordFile,"utf8")).build,f.newer.record.build);
 assert.equal(JSON.parse(await readFile(join(f.local,"deployment-rollback-pending.json"),"utf8")).status,"failed");
 const resumed=await executeRollback(await f.plan(),f.ports,true);assert.equal(resumed.status,"verified");
 assert.deepEqual(f.calls,["upload","verify"]);
});

test("verification failure, revoked access, unexpected builds and concurrent record edits cannot be promoted",async t=>{
 for(const fault of ["verify","auth","build","record","files"]){
  const f=await fixture(t),plan=await f.plan(),ports={...f.ports};
  if(fault==="verify")ports.wait=async()=>{throw Error("DEPLOYED_BUILD_NOT_SERVING");};
  if(fault==="auth")ports.probe=async()=>{throw Error("DEPLOYMENT_AUTH_REJECTED");};
  if(fault==="build")f.setLive("d".repeat(40));
  if(fault==="record")await writeFile(f.recordFile,JSON.stringify({...f.newer.record,changed:true}));
  if(fault==="files")await writeFile(join(f.older.record.release,"worker/worker.js"),"changed after plan");
  await assert.rejects(executeRollback(plan,ports,true));
  assert.equal(JSON.parse(await readFile(f.recordFile,"utf8")).build,f.newer.record.build);
  assert.equal(f.calls.includes("upload"),fault==="verify");
 }
});

test("normal publishing and rollback reserve the same local account/worker lock and release it after completion",async()=>{
 const id=crypto.randomUUID().replaceAll("-",""),name="deployment-lock-test";
 const release=await acquireDeploymentLock(id,name);
 try{await assert.rejects(acquireDeploymentLock(id,name),/DEPLOYMENT_LOCKED/);}finally{await release();}
 const again=await acquireDeploymentLock(id,name);await again();await again();
});
