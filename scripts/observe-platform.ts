import {execFileSync} from "node:child_process";
import {mkdir,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {collectPlatformMetrics} from "./platform-metrics.ts";
const [name,day,...extra]=process.argv.slice(2);
if(!name||extra.length||!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name))throw Error("USAGE: node scripts/observe-platform.ts WORKER_NAME [YYYY-MM-DD]");
const cli=(args:string[])=>{
 try{return JSON.parse(execFileSync(process.execPath,["node_modules/wrangler/bin/wrangler.js",...args],{encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,WRANGLER_SEND_METRICS:"false"},timeout:30000}));}
 catch{throw Error("CLOUDFLARE_METRICS_AUTH_UNAVAILABLE");}
};
const identity=cli(["whoami","--json"]);
if(!identity.loggedIn||identity.accounts?.length!==1)throw Error("ONE_AUTHENTICATED_ACCOUNT_REQUIRED");
const credential=cli(["auth","token","--json"]);
if(typeof credential.token!=="string")throw Error("CLOUDFLARE_METRICS_AUTH_UNAVAILABLE");
const report=await collectPlatformMetrics({accountId:identity.accounts[0].id,token:credential.token,scriptName:name,day});
const directory=resolve(".local/platform-metrics");await mkdir(directory,{recursive:true});
const path=resolve(directory,report.window.day+"-"+name+"-"+Date.now()+".json");await writeFile(path,JSON.stringify(report,null,2),{flag:"wx"});
console.log(JSON.stringify({path,status:report.status,window:report.window,project:report.project,account:report.account,backgroundRecommendation:report.backgroundRecommendation,automaticPauseApplied:false,planChanged:false}));
if(report.backgroundRecommendation==="pause")process.exitCode=2;
else if(report.status!=="observed")process.exitCode=3;
