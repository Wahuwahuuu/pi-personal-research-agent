import {createHash} from "node:crypto";
type Fetcher=typeof globalThis.fetch;
type Row=Record<string,any>;
type DataState="observed"|"no_data"|"unavailable"|"truncated"|"invalid";
interface Dataset {status:DataState;rows:Row[]}
interface Namespace {id:string;script:string;sqlite:boolean}
export interface Measurement {value:number|null;status:DataState;unit:string;basis:string;freeLimit:number;projectTarget:number;estimatedRemaining:number|null;targetRemaining:number|null;targetExceeded:boolean|null}
export interface PlatformMetricsOptions {accountId:string;token:string;scriptName:string;day?:string;now?:number}
const LIMIT=10000;
const datasets={
 workers:{name:"workersInvocationsAdaptive",fields:"dimensions{scriptName} sum{requests}"},
 invocations:{name:"durableObjectsInvocationsAdaptiveGroups",fields:"dimensions{namespaceId type} sum{requests}"},
 periodic:{name:"durableObjectsPeriodicGroups",fields:"dimensions{namespaceId} sum{duration rowsRead rowsWritten inboundWebsocketMsgCount}"},
 storage:{name:"durableObjectsSqlStorageGroups",fields:"dimensions{namespaceId} max{storedBytes}"}
} as const;
export function metricsWindow(day:string|undefined,now=Date.now()){
 if(!Number.isFinite(now))throw Error("INVALID_METRICS_TIME");
 const date=day??new Date(now).toISOString().slice(0,10);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error("INVALID_METRICS_DAY");
 const start=Date.parse(date+"T00:00:00.000Z");
 if(!Number.isFinite(start)||new Date(start).toISOString().slice(0,10)!==date||start>now||Date.parse(new Date(now).toISOString().slice(0,10)+"T00:00:00Z")-start>6*86400000)throw Error("METRICS_DAY_OUT_OF_RANGE");
 return{day:date,start:new Date(start).toISOString(),end:new Date(Math.min(now,start+86400000)).toISOString(),timezone:"UTC" as const};
}
async function requestJson(url:string,token:string,fetcher:Fetcher,body?:unknown){
 try{
  const response=await fetcher(url,{method:body?"POST":"GET",headers:{Authorization:"Bearer "+token,...(body?{"Content-Type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:"manual",signal:AbortSignal.timeout(30000)});
  // workerd supports manual, not error. Reject 3xx without forwarding credentials.
  if(!response.ok)return null;return await response.json() as any;
 }catch{return null;} // Provider responses can contain account identifiers: persist only normalized status.
}
async function inventory(account:string,token:string,fetcher:Fetcher):Promise<{status:DataState;rows:Namespace[]}>{
 const rows:Namespace[]=[];
 for(let page=1;page<=100;page++){
  const v=await requestJson("https://api.cloudflare.com/client/v4/accounts/"+account+"/workers/durable_objects/namespaces?per_page=100&page="+page,token,fetcher);
  if(!v||v.success!==true||!Array.isArray(v.result)||!Number.isInteger(v.result_info?.total_count)||v.result_info.page!==page)return{status:"unavailable",rows:[]};
  for(const row of v.result){
   if(typeof row.id!=="string"||!row.id||typeof row.script!=="string"||typeof row.use_sqlite!=="boolean"||rows.some(x=>x.id===row.id))return{status:"invalid",rows:[]};
   rows.push({id:row.id,script:row.script,sqlite:row.use_sqlite});
  }
  if(rows.length===v.result_info.total_count)return{status:"observed",rows};
  if(!v.result.length||rows.length>v.result_info.total_count)return{status:"invalid",rows:[]};
 }
 return{status:"truncated",rows:[]};
}
async function dataset(key:keyof typeof datasets,options:PlatformMetricsOptions,window:ReturnType<typeof metricsWindow>,fetcher:Fetcher):Promise<Dataset>{
 const d=datasets[key];
 const query=`query($account:string,$start:Time,$end:Time){viewer{accounts(filter:{accountTag:$account}){rows:${d.name}(limit:${LIMIT},filter:{datetime_geq:$start,datetime_lt:$end}){${d.fields}}}}}`;
 const v=await requestJson("https://api.cloudflare.com/client/v4/graphql",options.token,fetcher,{query,variables:{account:options.accountId,start:window.start,end:window.end}});
 if(!v||v.errors?.length||!Array.isArray(v.data?.viewer?.accounts)||v.data.viewer.accounts.length!==1)return{status:"unavailable",rows:[]};
 const rows=v.data.viewer.accounts[0].rows;
 if(!Array.isArray(rows))return{status:"invalid",rows:[]};
 if(rows.length>=LIMIT)return{status:"truncated",rows:[]};
 if(rows.some((r:any)=>!r||typeof r!=="object"||!r.dimensions||typeof r.dimensions[key==="workers"?"scriptName":"namespaceId"]!=="string"))return{status:"invalid",rows:[]};
 return{status:rows.length?"observed":"no_data",rows};
}
function select(d:Dataset,filter:(row:Row)=>boolean):Dataset{
 if(d.status!=="observed")return d;
 const rows=d.rows.filter(filter);return{status:rows.length?"observed":"no_data",rows};
}
function sum(d:Dataset,field:string,group:"sum"|"max"="sum"):{status:DataState;value:number|null}{
 if(d.status!=="observed")return{status:d.status,value:null};
 let value=0;
 const seen=new Set<string>();
 for(const row of d.rows){
  const v=row[group]?.[field];
  if(typeof v!=="number"||!Number.isFinite(v)||v<0||v>Number.MAX_SAFE_INTEGER)return{status:"invalid",value:null};
  if(group==="max"){const id=row.dimensions.namespaceId;if(seen.has(id))return{status:"invalid",value:null};seen.add(id);}
  value+=v;
 }
 return Number.isFinite(value)&&value<=Number.MAX_SAFE_INTEGER?{status:"observed",value}:{status:"invalid",value:null};
}
function measurement(v:{status:DataState;value:number|null},unit:string,basis:string,freeLimit:number,projectTarget:number,account:boolean):Measurement{
 return{...v,unit,basis,freeLimit,projectTarget,estimatedRemaining:!account||v.value===null?null:Math.max(0,freeLimit-v.value),targetRemaining:account||v.value===null?null:Math.max(0,projectTarget-v.value),targetExceeded:v.value===null?null:v.value>(account?freeLimit:projectTarget)};
}
function scope(data:Record<keyof typeof datasets,Dataset>,namespaces:Namespace[]|null,account:boolean){
 const requests=sum(data.invocations,"requests"),messages=sum(data.periodic,"inboundWebsocketMsgCount");
 const requestUpper=requests.value!==null&&messages.value!==null?{status:"observed" as const,value:requests.value+messages.value}:{status:requests.value===null?requests.status:messages.status,value:null};
 let storage=sum(data.storage,"storedBytes","max");
 if(namespaces===null)storage={status:"unavailable",value:null};
 else if(namespaces.some(n=>n.sqlite&&!data.storage.rows.some(r=>r.dimensions.namespaceId===n.id)))storage={status:storage.status==="observed"?"no_data":storage.status,value:null};
 return{
  workerRequests:measurement(sum(data.workers,"requests"),"requests","platform adaptive estimate; not an invoice",100000,10000,account),
  doRequestUpperEstimate:measurement(requestUpper,"requests","raw invocations plus periodic inbound messages, no 20:1 discount; conservative estimate may double count hibernation messages",100000,10000,account),
  doDuration:measurement(sum(data.periodic,"duration"),"GB-s","platform duration, already weighted by memory; do not multiply again",13000,6500,account),
  sqliteRowsRead:measurement(sum(data.periodic,"rowsRead"),"rows","platform periodic rowsRead",5000000,500000,account),
  sqliteRowsWritten:measurement(sum(data.periodic,"rowsWritten"),"rows","platform periodic rowsWritten",100000,50000,account),
  sqliteStoredBytes:measurement(storage,"bytes","sum of each namespace peak in this UTC window; not a simultaneous storage total",5000000000,500000000,account)
 };
}
export async function collectPlatformMetrics(options:PlatformMetricsOptions,fetcher:Fetcher=fetch){
 if(!/^[a-f0-9]{32}$/.test(options.accountId)||!options.token||/[\r\n]/.test(options.token)||!/^[a-z0-9][a-z0-9-]{0,62}$/.test(options.scriptName))throw Error("INVALID_METRICS_CONFIGURATION");
 const now=options.now??Date.now(),window=metricsWindow(options.day,now);
 const [ns,workers,invocations,periodic,storage]=await Promise.all([inventory(options.accountId,options.token,fetcher),...(["workers","invocations","periodic","storage"] as const).map(key=>dataset(key,options,window,fetcher))]);
 const all={workers,invocations,periodic,storage},projectNamespaces=ns.status==="observed"?ns.rows.filter(n=>n.script===options.scriptName):null,ids=new Set(projectNamespaces?.map(n=>n.id));
 const project={workers:select(workers,r=>r.dimensions.scriptName===options.scriptName),invocations:select(invocations,r=>ids.has(r.dimensions.namespaceId)),periodic:select(periodic,r=>ids.has(r.dimensions.namespaceId)),storage:select(storage,r=>ids.has(r.dimensions.namespaceId))};
 if(projectNamespaces===null)for(const key of ["invocations","periodic","storage"] as const)project[key]={status:ns.status,rows:[]};
 const accountMetrics=scope(all,ns.status==="observed"?ns.rows:null,true),projectMetrics=scope(project,projectNamespaces,false);
 const measurements=[...Object.values(accountMetrics),...Object.values(projectMetrics)];
 const missing=measurements.some(v=>v.status!=="observed");
 const nearLimit=Object.values(accountMetrics).some(v=>v.value!==null&&v.value>=v.freeLimit*0.8);
 const exceeded=Object.values(projectMetrics).some(v=>v.value!==null&&v.value>=v.projectTarget);
 return{
  version:1,source:"Cloudflare GraphQL Analytics API",observedAt:new Date(now).toISOString(),window,
  accountScope:createHash("sha256").update(options.accountId).digest("hex"),scriptName:options.scriptName,
  namespaceInventory:{status:ns.status,accountCount:ns.status==="observed"?ns.rows.length:null,projectCount:projectNamespaces?.length??null},
  datasets:Object.fromEntries(Object.entries(all).map(([k,v])=>[k,{status:v.status,rows:v.rows.length}])),
  account:accountMetrics,project:projectMetrics,status:missing?"partial":"observed",
  backgroundRecommendation:nearLimit||exceeded?"pause":missing?"hold-until-measured":"within-observed-targets",
  automaticPauseApplied:false,planChanged:false,
  limitations:["Analytics can be sampled or delayed; remaining values are estimates, not guaranteed quota.","No data, failed requests and truncated groups are unknown, never zero.","Daily cloud windows use UTC; model billing uses Asia/Shanghai.","This observer does not change a plan or stop application scheduling."]
 };
}
