import {verifyCloudflareOrigin} from "./cloudflare-origin.ts";
import {execFileSync} from "node:child_process";
import {resolve} from "node:path";
import {prepareRollback} from "./rollback-plan.ts";
import {executeRollback} from "./rollback-execution.ts";
import {deploymentAccess,deploymentInfo,waitForDeployment} from "./deployment-access.ts";
import {acquireDeploymentLock} from "./deployment-lock.ts";

try{
 const values:Record<string,string>={};let apply=false;
 const args=process.argv.slice(2);
 while(args.length){
  const key=args.shift()!;
  if(key==="--apply"){if(apply)throw Error("INVALID_ROLLBACK_ARGUMENT");apply=true;continue;}
  const value=args.shift();
  if(!["--record","--target","--session-file","--device-secret-file"].includes(key)||!value||value.startsWith("--")||values[key])throw Error("INVALID_ROLLBACK_ARGUMENT");
  values[key]=value;
 }
 if(!values["--record"]||!values["--target"]||(!values["--session-file"]&&!values["--device-secret-file"]))throw Error("ROLLBACK_TARGET_AND_CREDENTIAL_REQUIRED");
 const cli=(args:string[])=>{
  try{return execFileSync(process.execPath,["node_modules/wrangler/bin/wrangler.js",...args],{encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,WRANGLER_SEND_METRICS:"false"},timeout:240000});}
  catch{throw Error("CLOUDFLARE_COMMAND_FAILED");}
 };
 const plan=await prepareRollback(values["--record"],values["--target"]);
 const who=JSON.parse(cli(["whoami","--json"]));
 if(!who.loggedIn||who.accounts?.length!==1||who.accounts[0].id!==plan.current.accountId)throw Error("CLOUDFLARE_ACCOUNT_MISMATCH");
 const auth=JSON.parse(cli(["auth","token","--json"]));
 await verifyCloudflareOrigin(plan.current.accountId,plan.current.name,plan.current.url,auth.token);
 const release=await acquireDeploymentLock(plan.current.accountId,plan.current.name);
 try{
  const secret=(path:string)=>{
   try{return execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-File","scripts/read-secret.ps1",resolve(path)],{encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"]}).trim();}
   catch{throw Error("DEPLOYMENT_CREDENTIAL_UNAVAILABLE");}
  };
  let access=await deploymentAccess(plan.current.url,{
   ...(values["--session-file"]?{sessionCookie:secret(values["--session-file"])}:{}),
   ...(values["--device-secret-file"]?{deviceToken:secret(values["--device-secret-file"])}:{}),
  });
  if(access.kind==="session")access={...access,path:"/api/deployment"};
  const result=await executeRollback(plan,{
   probe:()=>deploymentInfo(plan.current.url,access),
   publish:async file=>{const output=cli(["deploy","--config",file]);if(!output.includes(plan.current.url))throw Error("DEPLOYED_URL_MISMATCH");},
   wait:(build,contract,timeoutMs)=>waitForDeployment(plan.current.url,access,build,{timeoutMs,expectedRelease:contract}),
  },apply);
  console.log(JSON.stringify(result));
 }finally{await release();}
}catch(e){
 const code=e instanceof Error?e.message:"";
 console.error(/^[A-Z_]+$/.test(code)?code:"ROLLBACK_FAILED");process.exitCode=1;
}
