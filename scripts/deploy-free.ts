import {execFileSync} from "node:child_process";
import {mkdir,readFile,writeFile,cp,rename} from "node:fs/promises";
import {resolve,sep} from "node:path";
import {RELEASE_CONTRACT} from "../src/release-contract.ts";
import {parseModelSettings,modelDeploymentVariables} from "../src/model-settings.ts";
import {deploymentAccess,waitForDeployment,deploymentVerificationTimeout,type DeploymentAccess} from "./deployment-access.ts";
import {freezeWorker} from "./freeze-worker.ts";
import {inspectFrozenRelease,verifyFrozenRelease,assertReleaseVariables} from "./frozen-release.ts";
// No billing mutations; the operator has confirmed Workers Free for this account.
const env={...process.env,WRANGLER_SEND_METRICS:"false"};
const git=(args:string[])=>execFileSync("git",args,{encoding:"utf8",windowsHide:true}).trim();
const build=git(["rev-parse","HEAD"]);
function committed(){if(git(["status","--porcelain","--untracked-files=normal"])||git(["rev-parse","HEAD"])!==build)throw Error("COMMITTED_BUILD_REQUIRED");}
committed();
async function optionalJson(path:string){try{return JSON.parse(await readFile(path,"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw Error("INVALID_LOCAL_DEPLOYMENT_CONFIGURATION");}}
const rawSettings=await optionalJson(".local/model-settings.json"),settings=rawSettings?parseModelSettings(rawSettings):undefined;
const cli=(args:string[],input?:string)=>{
 try{return execFileSync(process.execPath,["node_modules/wrangler/bin/wrangler.js",...args],{encoding:"utf8",windowsHide:true,env,stdio:["pipe","pipe","pipe"],input,timeout:240000});}
 catch{throw Error("CLOUDFLARE_"+args[0].toUpperCase()+"_FAILED");}
};
const secret=(path:string)=>{
 try{return execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-File","scripts/read-secret.ps1",resolve(path)],{encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"]}).trim();}
 catch{throw Error("DEPLOYMENT_CREDENTIAL_UNAVAILABLE");}
};
const optionalSecret=async(path:string)=>{try{await readFile(path);return secret(path);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw error;}};
const who=JSON.parse(cli(["whoami","--json"]));if(!who.loggedIn||who.accounts.length!==1)throw Error("ONE_AUTHENTICATED_ACCOUNT_REQUIRED");
const auth=JSON.parse(cli(["auth","token","--json"])),name="pi-personal-research-agent";
const response=await fetch("https://api.cloudflare.com/client/v4/accounts/"+who.accounts[0].id+"/workers/scripts",{headers:{Authorization:"Bearer "+auth.token},redirect:"error",signal:AbortSignal.timeout(20000)});
const listing=await response.json() as any;if(!response.ok||!listing.success)throw Error("CANNOT_CHECK_EXISTING_WORKER");
const verified=await optionalJson(".local/deployment.json"),pending=await optionalJson(".local/deployment-pending.json");
const previous=verified??pending;
if(previous&&(previous.name!==name||!/^https:\/\/pi-personal-research-agent\.[a-z0-9-]+\.workers\.dev$/.test(previous.url)))throw Error("UNRECOGNIZED_DEPLOYMENT_RECORD");
if(listing.result.some((s:any)=>s.id===name)&&!previous)throw Error("REFUSING_TO_OVERWRITE_UNRECOGNIZED_WORKER");
await mkdir(".local",{recursive:true});
let token:string;
if(previous)token=secret(".local/admin.secret");
else{
 token=crypto.randomUUID()+crypto.randomUUID();
 execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-File","scripts/write-secret.ps1",resolve(".local/admin.secret")],{input:token,encoding:"utf8",windowsHide:true,stdio:["pipe","pipe","pipe"]});
}
let access:DeploymentAccess|undefined;
if(!verified&&pending?.initialProvisioning){
 const release=resolve(pending.release??"");
 if(!release.startsWith(resolve(".local/releases")+sep))throw Error("UNRECOGNIZED_INITIAL_RELEASE");
 const file=resolve(release,"wrangler.json"),initial=await optionalJson(file);
 if(initial?.name!==name||initial.vars?.BUILD_ID!==pending.build)throw Error("UNRECOGNIZED_INITIAL_RELEASE");
 // Resume only our recorded first installation; reuse the same protected key.
 cli(["secret","bulk","--config",file],JSON.stringify({ADMIN_TOKEN:token}));
}
if(previous){
 let deviceToken=process.env.PRA_DEPLOY_DEVICE_TOKEN;
 const node=await optionalJson(".local/node.json");
 if(!deviceToken&&node?.endpoint===previous.url&&typeof node.secretFile==="string")deviceToken=secret(node.secretFile);
 const sessionCookie=process.env.PRA_DEPLOY_SESSION??await optionalSecret(".local/deployment-session.secret");
 // Authentication must succeed before any new production upload.
 access=await deploymentAccess(previous.url,{deviceToken,sessionCookie,bootstrapToken:token});
}
execFileSync(process.execPath,["node_modules/vite/bin/vite.js","build"],{windowsHide:true,stdio:"inherit"});
const release=resolve(".local/releases",build+"-"+Date.now());await mkdir(release,{recursive:true});
await cp(resolve("dist/web"),resolve(release,"assets"),{recursive:true});
const config=JSON.parse((await readFile("wrangler.jsonc","utf8")).replace(/,\s*([}\]])/g,"$1"));
if(config.name!==name)throw Error("UNRECOGNIZED_WORKER_NAME");
config.main=resolve("src/worker.ts");config.assets.directory=resolve(release,"assets");config.vars={...config.vars,...modelDeploymentVariables(settings),BUILD_ID:build};
assertReleaseVariables(config.vars);
const effectiveMode=config.vars.MODEL_MODE??"mock";
if(!["mock","live"].includes(effectiveMode))throw Error("INVALID_MODEL_MODE");
const effectiveModel=effectiveMode==="live"?parseModelSettings({mode:"live",modelId:config.vars.MODEL_ID,baseUrl:config.vars.MODEL_BASE_URL,thinking:"off"}):undefined;
const file=resolve(release,"wrangler.json");await writeFile(file,JSON.stringify(config));
await freezeWorker(file,resolve(release,"worker"));committed();
const frozen=await inspectFrozenRelease(resolve(".local/releases"),release,{name,build});
const verificationTimeoutMs=deploymentVerificationTimeout(frozen.config.durable_objects?.code_update_strategy);
const output=cli(["deploy","--config",file]);
await verifyFrozenRelease(resolve(".local/releases"),frozen);
const url=output.match(/https:\/\/pi-personal-research-agent\.[a-z0-9-]+\.workers\.dev/)?.[0];
if(!url||(previous&&url!==previous.url))throw Error("DEPLOYED_URL_MISMATCH");
const record={name,url,mode:effectiveMode,modelId:effectiveModel?.modelId??"deterministic-v1",thinking:"off",freePlanConfirmedByUser:true,build,release,releaseContract:RELEASE_CONTRACT,artifactDigest:frozen.digest,verificationTimeoutMs,deployed:new Date().toISOString(),servingBuildVerified:false,initialProvisioning:!verified&&(!previous||!!pending?.initialProvisioning)};
await writeFile(".local/deployment-pending.json",JSON.stringify(record,null,2));
if(!previous)cli(["secret","bulk","--config",file],JSON.stringify({ADMIN_TOKEN:token}));
access??=await deploymentAccess(url,{bootstrapToken:token});
if(access.kind==="session")access={...access,path:"/api/deployment"};
await waitForDeployment(url,access,build,{timeoutMs:verificationTimeoutMs,expectedRelease:RELEASE_CONTRACT});
const completed={...record,servingBuildVerified:true,verified:new Date().toISOString(),verification:access.kind};
await writeFile(resolve(release,"verification.json"),JSON.stringify(completed,null,2));
const temporary=".local/deployment."+crypto.randomUUID()+".tmp";await writeFile(temporary,JSON.stringify(completed,null,2));await rename(temporary,".local/deployment.json");
console.log(JSON.stringify({url,mode:record.mode,modelId:record.modelId,thinking:"off",adminCredential:"DPAPI protected .local/admin.secret",planChanged:false,build,servingBuildVerified:true,verification:access.kind}));
