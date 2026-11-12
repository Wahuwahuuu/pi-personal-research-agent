import {execFileSync} from "node:child_process";
import {readFile} from "node:fs/promises";
import {resolve,sep} from "node:path";
export const cloudflareCli=(args:string[],input?:string)=>{
 try{return execFileSync(process.execPath,["node_modules/wrangler/bin/wrangler.js",...args],{encoding:"utf8",windowsHide:true,input,stdio:["pipe","pipe","pipe"],timeout:120000,env:{...process.env,WRANGLER_SEND_METRICS:"false"}});}
 catch{throw Error("CLOUDFLARE_COMMAND_FAILED");}
};
export function validateOperatorTarget(value:any){
 const u=new URL(value?.url);
 if(typeof value?.name!=="string"||!/^[a-z0-9][a-z0-9-]{0,62}$/.test(value.name)||u.origin!==value.url||u.protocol!=="https:"||u.username||u.password||!u.hostname.startsWith(value.name+".")||!/^[-a-z0-9]+\.[-a-z0-9]+\.workers\.dev$/.test(u.hostname)||value.servingBuildVerified!==true||!/^[a-f0-9]{40}$/.test(value.build??""))throw Error("UNVERIFIED_PLATFORM_TARGET");
 return{name:value.name,url:u.origin,build:value.build as string};
}
export function privateOperatorPath(file:string){
 const path=resolve(file);if(!path.startsWith(resolve(".local")+sep))throw Error("LOCAL_OPERATOR_FILE_REQUIRED");return path;
}
export async function platformOperator(recordFile:string,sessionFile:string){
 const target=validateOperatorTarget(JSON.parse(await readFile(privateOperatorPath(recordFile),"utf8")));
 let cookie:string;try{cookie=execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-File","scripts/read-secret.ps1",privateOperatorPath(sessionFile)],{encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"]}).trim();}catch{throw Error("OWNER_SESSION_UNAVAILABLE");}
 if(!/^pra_session=[A-Za-z0-9._%-]{16,512}$/.test(cookie))throw Error("INVALID_OWNER_SESSION");
 const api=async(path:string,body?:unknown)=>{
  try{
   const r=await fetch(target.url+"/api/"+path,{method:body===undefined?"GET":"POST",headers:{Cookie:cookie,...(body===undefined?{}:{"Content-Type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:"error",signal:AbortSignal.timeout(45000)});
   if(!r.ok)throw Error();return await r.json() as any;
  }catch{throw Error("PLATFORM_APPLICATION_REQUEST_FAILED");}
 };
 if((await api("auth/status"))?.account?.role!=="owner")throw Error("OWNER_SESSION_REQUIRED");
 if((await api("overview"))?.build!==target.build)throw Error("PLATFORM_BUILD_MISMATCH");
 const status=await api("platform");if(status.workerName!==target.name)throw Error("PLATFORM_MONITOR_UPGRADE_REQUIRED");
 return{target,api,status};
}
export async function platformCloudAccount(target:{name:string;url:string}){
 const who=JSON.parse(cloudflareCli(["whoami","--json"]));
 if(!who.loggedIn||who.accounts?.length!==1)throw Error("ONE_AUTHENTICATED_ACCOUNT_REQUIRED");
 const auth=JSON.parse(cloudflareCli(["auth","token","--json"])),accountId=who.accounts[0].id;
 if(!/^[a-f0-9]{32}$/.test(accountId)||!auth.token)throw Error("CLOUDFLARE_ACCOUNT_UNAVAILABLE");
 let value:any;
 try{const r=await fetch("https://api.cloudflare.com/client/v4/accounts/"+accountId+"/workers/subdomain",{headers:{Authorization:"Bearer "+auth.token},redirect:"error",signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error();value=await r.json();}
 catch{throw Error("CLOUDFLARE_ACCOUNT_UNAVAILABLE");}
 if(value?.success!==true||target.url!=="https://"+target.name+"."+value.result?.subdomain+".workers.dev")throw Error("CLOUDFLARE_ACCOUNT_TARGET_MISMATCH");
 return{accountId,token:auth.token as string};
}
