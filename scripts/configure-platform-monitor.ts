import {mkdir,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {collectPlatformMetrics} from "./platform-metrics.ts";
import {platformOperator,platformCloudAccount,cloudflareCli} from "./platform-operator.ts";
const [recordFile,sessionFile,...extra]=process.argv.slice(2);
if(!recordFile||!sessionFile||extra.length)throw Error("USAGE: node scripts/configure-platform-monitor.ts .local/DEPLOYMENT.json .local/SESSION.secret < TOKEN_STDIN");
let token="";
for await(const chunk of process.stdin){token+=chunk;if(token.length>512)throw Error("INVALID_METRICS_TOKEN");}
token=token.trim();if(!/^[A-Za-z0-9_-]{32,256}$/.test(token))throw Error("INVALID_METRICS_TOKEN");
const {target,api}=await platformOperator(recordFile,sessionFile),identity=await platformCloudAccount(target);
const report=await collectPlatformMetrics({accountId:identity.accountId,token,scriptName:target.name});
if(report.namespaceInventory.status!=="observed"||!report.namespaceInventory.projectCount||Object.values(report.datasets).some(d=>!["observed","no_data"].includes(d.status)))throw Error("METRICS_TOKEN_READ_PERMISSIONS_REQUIRED");
const directory=resolve(".local/platform-metrics","setup-"+crypto.randomUUID());await mkdir(directory,{recursive:true});
const config=resolve(directory,"wrangler.json");await writeFile(config,JSON.stringify({name:target.name,account_id:identity.accountId,compatibility_date:"2026-11-08"}));
// Only the dedicated read credential is sent to Worker Secrets. Never send the deployment OAuth token.
cloudflareCli(["secret","bulk","--config",config],JSON.stringify({CLOUDFLARE_METRICS_TOKEN:token,CLOUDFLARE_ACCOUNT_ID:identity.accountId}));token="";
let configured=false;
const deadline=Date.now()+120000;
while(Date.now()<deadline){
 try{configured=(await api("platform")).cloudMonitoringConfigured===true;if(configured)break;}catch{}
 await new Promise(r=>setTimeout(r,1500));
}
if(!configured)throw Error("METRICS_SECRET_NOT_YET_SERVING");
const result=await api("platform/refresh",{requestId:crypto.randomUUID()});
if(!result.enabled||!result.observedAt||Date.now()-result.observedAt>600000)throw Error("CLOUD_METRICS_NOT_CONFIRMED");
await writeFile(resolve(directory,"receipt.json"),JSON.stringify({target,configured:true,verifiedAt:new Date().toISOString(),result,planChanged:false},null,2));
console.log(JSON.stringify({configured:true,target:target.name,observedAt:result.observedAt,blocked:result.blocked,reason:result.reason,planChanged:false,credentialPersistedLocally:false}));
