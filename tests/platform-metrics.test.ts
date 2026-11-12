import {test} from "node:test";
import assert from "node:assert/strict";
import {collectPlatformMetrics,metricsWindow} from "../scripts/platform-metrics.ts";
const now=Date.parse("2026-11-12T10:00:00Z"),base={accountId:"a".repeat(32),token:"credential-canary-never-persist",scriptName:"research",now};
const row=(namespaceId:string,sum:any)=>({dimensions:{namespaceId},sum});
function fixture(options:{fail?:string;empty?:string;invalid?:string;truncated?:string;namespaceFail?:boolean;large?:boolean;missingStorage?:boolean}={}){
 const calls:{url:string;request:RequestInit}[]=[];
 const fetcher=(async(url:RequestInfo|URL,request:RequestInit={})=>{
  calls.push({url:String(url),request});assert.equal(request.redirect,"manual");
  if(String(url).includes("namespaces")){
   if(options.namespaceFail)return Response.json({success:false},{status:403});
   return Response.json({success:true,result_info:{page:1,total_count:2},result:[{id:"one",script:"research",use_sqlite:true},{id:"two",script:"other",use_sqlite:true}]});
  }
  const body=JSON.parse(String(request.body)),key=/rows:(\w+)/.exec(body.query)![1];assert.equal(body.variables.start,"2026-11-12T00:00:00.000Z");
  if(key===options.fail)return Response.json({errors:[{message:base.token}]});
  const rows:Record<string,any[]>={
   workersInvocationsAdaptive:[{dimensions:{scriptName:"research"},sum:{requests:options.large?90000:100}},{dimensions:{scriptName:"other"},sum:{requests:25}}],
   durableObjectsInvocationsAdaptiveGroups:[{...row("one",{requests:40}),dimensions:{namespaceId:"one",type:"hibernation"}},row("two",{requests:10})],
   durableObjectsPeriodicGroups:[row("one",{duration:5,rowsRead:150,rowsWritten:60,inboundWebsocketMsgCount:100}),row("two",{duration:3,rowsRead:10,rowsWritten:5,inboundWebsocketMsgCount:20})],
   durableObjectsSqlStorageGroups:[{dimensions:{namespaceId:"one"},max:{storedBytes:200}},{dimensions:{namespaceId:"two"},max:{storedBytes:300}}]
  };
  let selected=rows[key];
  if(key===options.empty)selected=[];
  if(key===options.invalid)selected=[row("one",{duration:-1,rowsRead:"0",rowsWritten:NaN})];
  if(key===options.truncated)selected=Array(10000).fill(selected[0]);
  if(options.missingStorage&&key==="durableObjectsSqlStorageGroups")selected=selected.slice(0,1);
  return Response.json({data:{viewer:{accounts:[{rows:selected}]}}});
 }) as typeof fetch;
 return{calls,fetcher};
}
test("platform observer keeps account and project scopes, duration units and conservative WS requests separate",async()=>{
 const f=fixture(),r=await collectPlatformMetrics(base,f.fetcher);
 assert.equal(r.status,"observed");assert.equal(r.project.workerRequests.value,100);assert.equal(r.account.workerRequests.value,125);
 assert.equal(r.project.doRequestUpperEstimate.value,140);assert.equal(r.account.doRequestUpperEstimate.value,170);
 assert.equal(r.project.workerRequests.estimatedRemaining,null);assert.equal(r.project.workerRequests.targetRemaining,9900);assert.equal(r.account.workerRequests.estimatedRemaining,99875);
 assert.equal(r.project.doDuration.value,5);assert.equal(r.project.sqliteRowsWritten.value,60);
 assert.equal(r.account.sqliteStoredBytes.value,500);assert.equal(r.project.sqliteStoredBytes.value,200);
 assert.equal(r.backgroundRecommendation,"within-observed-targets");assert.equal(r.automaticPauseApplied,false);
 assert.equal(JSON.stringify(r).includes(base.token),false);assert.equal(JSON.stringify(r).includes(base.accountId),false);assert.equal(f.calls.length,5);
});
test("GraphQL partial failures, empty datasets, invalid fields and truncation never become zero or success",async()=>{
 for(const option of [{fail:"workersInvocationsAdaptive"},{empty:"workersInvocationsAdaptive"},{truncated:"workersInvocationsAdaptive"}]){
  const r=await collectPlatformMetrics(base,fixture(option).fetcher);assert.equal(r.project.workerRequests.value,null);assert.equal(r.status,"partial");assert.equal(r.backgroundRecommendation,"hold-until-measured");assert.equal(JSON.stringify(r).includes(base.token),false);
 }
 const r=await collectPlatformMetrics(base,fixture({invalid:"durableObjectsPeriodicGroups"}).fetcher);
 assert.equal(r.project.doDuration.status,"invalid");assert.equal(r.project.sqliteRowsRead.value,null);assert.equal(r.project.doRequestUpperEstimate.value,null);
});
test("namespace discovery failure leaves DO scope unknown while usable Worker data remains",async()=>{
 const r=await collectPlatformMetrics(base,fixture({namespaceFail:true}).fetcher);
 assert.equal(r.project.workerRequests.value,100);assert.equal(r.project.doDuration.status,"unavailable");assert.equal(r.account.sqliteStoredBytes.value,null);
});
test("namespace storage peaks require complete inventory coverage, not summing an incomplete known subset",async()=>{
 const r=await collectPlatformMetrics(base,fixture({missingStorage:true}).fetcher);
 assert.equal(r.account.sqliteStoredBytes.value,null);assert.equal(r.project.sqliteStoredBytes.value,200);assert.equal(r.status,"partial");
});
test("near-account limit and exceeded project target recommend pausing without changing scheduling",async()=>{
 const r=await collectPlatformMetrics(base,fixture({large:true}).fetcher);
 assert.equal(r.backgroundRecommendation,"pause");assert.equal(r.project.workerRequests.targetExceeded,true);assert.equal(r.automaticPauseApplied,false);assert.equal(r.planChanged,false);
});
test("UTC window does not follow Shanghai date and invalid/future days fail before sending credentials",async()=>{
 assert.equal(metricsWindow(undefined,Date.parse("2026-11-12T01:00:00+08:00")).day,"2026-11-11");
 assert.equal(metricsWindow("2026-11-11",now).end,"2026-11-12T00:00:00.000Z");
 for(const day of ["2026-02-31","2026-11-13","2026-01-01","11/12/2026"])assert.throws(()=>metricsWindow(day,now));
 let calls=0;await assert.rejects(collectPlatformMetrics({...base,token:"bad\nvalue"},(async()=>{calls++;return Response.json({});}) as typeof fetch));assert.equal(calls,0);
});
test("transport exceptions and invalid schemas are normalized without credential or provider text",async()=>{
 const r=await collectPlatformMetrics(base,(async()=>{throw Error(base.token);}) as typeof fetch);
 assert.equal(r.status,"partial");assert.equal(r.project.workerRequests.value,null);assert.equal(JSON.stringify(r).includes(base.token),false);
});

test("platform fetch refuses redirects without forwarding the credential",async()=>{
 let calls=0;const r=await collectPlatformMetrics(base,(async(_url,init)=>{calls++;assert.equal(init?.redirect,"manual");return new Response(null,{status:302,headers:{Location:"https://untrusted.example"}});}) as typeof fetch);
 assert.equal(calls,5);assert.equal(r.status,"partial");assert.equal(r.account.workerRequests.value,null);
});
