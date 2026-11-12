import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {resolve,join,sep} from "node:path";
import {pathToFileURL} from "node:url";
import {spawnSync} from "node:child_process";
const root=process.cwd(),url="https://pi-personal-research-agent.validation.workers.dev",build="a".repeat(40);
for(const scenario of ["success","denied","changed","revoked-after-upload","initial","resume-initial"])test("deployment CLI "+scenario+" freezes publication and never verifies an unserved build",()=>{
 const directory=mkdtempSync(join(tmpdir(),"pra-deploy-"));
 try{
  mkdirSync(resolve(directory,".local"),{recursive:true});
  const previous={name:"pi-personal-research-agent",url,build:"old",servingBuildVerified:true};
  if(!["initial","resume-initial"].includes(scenario))writeFileSync(resolve(directory,".local/deployment.json"),JSON.stringify(previous));
  if(scenario==="resume-initial"){
   const release=resolve(directory,".local/releases/initial");mkdirSync(release,{recursive:true});
   writeFileSync(resolve(release,"wrangler.json"),JSON.stringify({name:"pi-personal-research-agent",vars:{BUILD_ID:"old"}}));
   writeFileSync(resolve(directory,".local/deployment-pending.json"),JSON.stringify({...previous,release,initialProvisioning:true,servingBuildVerified:false}));
  }
  writeFileSync(resolve(directory,".local/node.json"),JSON.stringify({endpoint:url,secretFile:resolve(directory,".local/device.secret")}));
  writeFileSync(resolve(directory,"wrangler.jsonc"),JSON.stringify({name:"pi-personal-research-agent",main:"src/worker.ts",assets:{directory:"dist/web"},vars:{MODEL_MODE:"mock"}}));
  const env:NodeJS.ProcessEnv={...process.env,PRA_DEPLOY_TEST_CASE:scenario};delete env.PRA_DEPLOY_SESSION;delete env.PRA_DEPLOY_DEVICE_TOKEN;
  const child=spawnSync(process.execPath,["--import",pathToFileURL(resolve(root,"tests/helpers/deployment-preload.mjs")).href,resolve(root,"scripts/deploy-free.ts")],{cwd:directory,windowsHide:true,encoding:"utf8",timeout:15000,env});
  assert.equal(child.signal,null);assert.equal(child.error,undefined);
  const events=JSON.parse(readFileSync(resolve(directory,"events.json"),"utf8")) as string[];
  if(["success","initial","resume-initial"].includes(scenario)){
   assert.equal(child.status,0,child.stderr);const stored=JSON.parse(readFileSync(resolve(directory,".local/deployment.json"),"utf8"));
   assert.equal(stored.build,build);assert.equal(stored.servingBuildVerified,true);
   assert.equal(stored.verification,scenario==="success"?"device":"session");
   assert.equal(events.filter(e=>e==="upload").length,1);
   assert.equal(events.filter(e=>e==="install-secret").length,scenario==="success"?0:1);
   assert.equal(events.filter(e=>e==="HTTP /api/login").length,scenario==="success"?0:1);
  }else{
   assert.notEqual(child.status,0);assert.deepEqual(JSON.parse(readFileSync(resolve(directory,".local/deployment.json"),"utf8")),previous);
   assert.equal(events.filter(e=>e==="upload").length,scenario==="revoked-after-upload"?1:0);
   assert.equal(events.includes("HTTP /api/login"),false);
   if(scenario==="revoked-after-upload")assert.equal(JSON.parse(readFileSync(resolve(directory,".local/deployment-pending.json"),"utf8")).servingBuildVerified,false);
   else assert.equal(existsSync(resolve(directory,".local/deployment-pending.json")),false);
  }
 }finally{
  if(!resolve(directory).startsWith(resolve(tmpdir())+sep+"pra-deploy-"))throw Error("UNSAFE_FIXTURE_DIRECTORY");
  rmSync(directory,{recursive:true,force:true});
 }
});
