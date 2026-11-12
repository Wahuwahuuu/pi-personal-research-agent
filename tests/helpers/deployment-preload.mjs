// Subprocess-only deployment fixture: every external command and network request is intercepted.
import {RELEASE_CONTRACT} from "../../src/release-contract.ts";
import childProcess from "node:child_process";
import {syncBuiltinESMExports} from "node:module";
import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {resolve,dirname} from "node:path";
const scenario=process.env.PRA_DEPLOY_TEST_CASE,build="a".repeat(40),url="https://pi-personal-research-agent.validation.workers.dev";
const events=[];let uploaded=false,statusChecks=0;
const event=value=>{events.push(value);writeFileSync("events.json",JSON.stringify(events));};
childProcess.execFileSync=(exe,args,options={})=>{
 if(exe==="git"){
  if(args[0]==="rev-parse")return build+"\n";
  if(args[0]==="status"){statusChecks++;return scenario==="changed"&&statusChecks>1?" M src/worker.ts\n":"";}
 }
 if(exe==="powershell.exe"){
  if(args.some(v=>v.endsWith("read-secret.ps1")))return "d".repeat(64)+"\n";
  if(args.some(v=>v.endsWith("write-secret.ps1"))){event("protected-secret");return "";}
 }
 if(exe===process.execPath&&args[0].includes("vite")){
  mkdirSync("dist/web",{recursive:true});writeFileSync("dist/web/index.html","frozen-assets");event("build-web");return "";
 }
 if(exe===process.execPath&&args[0].includes("wrangler")){
  const command=args[1];
  if(command==="whoami")return JSON.stringify({loggedIn:true,accounts:[{id:"test-account"}]});
  if(command==="auth")return JSON.stringify({token:"synthetic-platform-credential"});
  if(command==="secret"){event("install-secret");return "";}
  if(command==="deploy"){
   const file=args[args.indexOf("--config")+1],cfg=JSON.parse(readFileSync(file,"utf8"));
   if(args.includes("--dry-run")){
    const output=args[args.indexOf("--outdir")+1];mkdirSync(output,{recursive:true});writeFileSync(resolve(output,"worker.js"),"// frozen-worker");
    writeFileSync("dist/web/index.html","subsequent-unrelated-build");event("build-worker");return "";
   }
   if(readFileSync(resolve(cfg.assets.directory,"index.html"),"utf8")!=="frozen-assets")throw Error("UNFROZEN_ASSETS");
   if(readFileSync(cfg.main,"utf8")!=="// frozen-worker")throw Error("UNFROZEN_WORKER");
   if(args.includes("--var"))throw Error("MODEL_VARIABLES_NOT_FROZEN");
   if(scenario==="live-success"&&(cfg.vars.MODEL_MODE!=="live"||cfg.vars.MODEL_ID!=="qwen3.7-flash"||!cfg.vars.MODEL_BASE_URL))throw Error("FROZEN_MODEL_CONFIG_MISSING");
   event("upload");uploaded=true;return url;
  }
 }
 throw Error("UNEXPECTED_EXTERNAL_COMMAND");
};
syncBuiltinESMExports();
globalThis.fetch=async(raw,init={})=>{
 const target=new URL(raw);event("HTTP "+target.pathname);
 if(target.hostname==="api.cloudflare.com")return Response.json({success:true,result:scenario==="initial"?[]:[{id:"pi-personal-research-agent"}]});
 if(target.origin!==url)throw Error("UNEXPECTED_ORIGIN");
 if(target.pathname==="/api/device/verify"){
  if(scenario==="denied"||scenario==="resume-initial"||(scenario==="revoked-after-upload"&&uploaded))return Response.json({}, {status:401});
  return Response.json({protocol:1,accountScope:"f".repeat(64),build:uploaded?build:"old",...(uploaded?{release:scenario==="wrong-contract-after-upload"?{...RELEASE_CONTRACT,family:"different-family"}:RELEASE_CONTRACT}:{})});
 }
 if(target.pathname==="/api/auth/status")return Response.json({bootstrapAvailable:["initial","resume-initial"].includes(scenario)});
 if(target.pathname==="/api/login"){
  if(!["initial","resume-initial"].includes(scenario))throw Error("BOOTSTRAP_MUST_STAY_CLOSED");
  return Response.json({}, {headers:{"set-cookie":"pra_session="+"c".repeat(64)+"; HttpOnly; Secure"}});
 }
 if(["/api/state","/api/deployment"].includes(target.pathname))return Response.json({build:uploaded?build:"old",...(uploaded?{release:scenario==="wrong-contract-after-upload"?{...RELEASE_CONTRACT,family:"different-family"}:RELEASE_CONTRACT}:{})});
 throw Error("UNEXPECTED_EXTERNAL_REQUEST");
};
