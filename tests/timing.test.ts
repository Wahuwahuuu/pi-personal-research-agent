import {test} from "node:test";
import assert from "node:assert/strict";
import {acceptResult, cancel, initialState, operation, submit} from "../src/domain.ts";
import {apiTiming, beginModelTiming, finishModelTiming, markToolDispatch, taskTimings, toolMeasurement, type ModelMeasurement} from "../src/timing.ts";
import {liveModels} from "../src/live-model.ts";
import {mockModels} from "../src/model.ts";

const fixture=()=>{
  const state=initialState(), task=submit(state,"private prompt","request","research");
  const op=operation(state,task,"v1","search_papers",{query:"private query"});
  return {state,task,op,result:{index_version:"v1",papers:[]}};
};
test("tool timings count the accepted result once and never turn redelivery into network latency",()=>{
  const {state,task,op,result}=fixture();
  markToolDispatch(op,100);
  acceptResult(state,op.id,"v1",result,250,40);
  const before=structuredClone(op.timing);
  assert.equal(toolMeasurement(op).roundTripMs,150);
  assert.equal(toolMeasurement(op).transportAndSchedulingMs,110);
  assert.equal(acceptResult(state,op.id,"v1",result,500,90),"duplicate");
  assert.deepEqual(op.timing,before);
  assert.equal(task.activeMs,40);
  const replay=fixture();markToolDispatch(replay.op,100);markToolDispatch(replay.op,190);
  acceptResult(replay.state,replay.op.id,"v1",replay.result,250,40);
  assert.equal(toolMeasurement(replay.op).sample,"redelivered");
  assert.equal(toolMeasurement(replay.op).roundTripMs,null);
  assert.equal(toolMeasurement(replay.op).transportAndSchedulingMs,null);
  assert.equal(toolMeasurement(replay.op).localExecutionMs,40);
});
test("absent local timing, clock reversal and negative residual stay unknown",()=>{
  const missing=fixture();markToolDispatch(missing.op,100);
  acceptResult(missing.state,missing.op.id,"v1",missing.result,200);
  assert.equal(toolMeasurement(missing.op).localExecutionMs,null);
  assert.equal(toolMeasurement(missing.op).transportAndSchedulingMs,null);
  const backwards=fixture();markToolDispatch(backwards.op,200);
  acceptResult(backwards.state,backwards.op.id,"v1",backwards.result,100,10);
  assert.equal(toolMeasurement(backwards.op).roundTripMs,null);
  const rounded=fixture();markToolDispatch(rounded.op,100);
  acceptResult(rounded.state,rounded.op.id,"v1",rounded.result,109,10);
  assert.equal(toolMeasurement(rounded.op).transportAndSchedulingMs,null);
});
test("cancelled and invalid results cannot create a completed timing sample",()=>{
  const {state,task,op,result}=fixture();markToolDispatch(op,100);cancel(state,task.id);
  assert.equal(acceptResult(state,op.id,"v1",result,200,10),"discarded");
  assert.equal(op.timing?.receivedAt,undefined);
  assert.equal(toolMeasurement(op).sample,"unfinished");
  const invalid=fixture();markToolDispatch(invalid.op,100);
  assert.throws(()=>acceptResult(invalid.state,invalid.op.id,"v1",invalid.result,200,-1),/INVALID_EXECUTION_TIME/);
  assert.equal(invalid.op.timing?.receivedAt,undefined);
});
test("numeric model diagnostics retain interruption and unknown after restart without exposing prompt or evidence",()=>{
  const {state,task}=fixture();task.calls=1;beginModelTiming(task,"live");
  task.calls=2;beginModelTiming(task,"mock");
  const recovered=JSON.parse(JSON.stringify(state));
  finishModelTiming(recovered.tasks[0],2,{status:"response_received",elapsedMs:0});
  finishModelTiming(recovered.tasks[0],2,{status:"interrupted",elapsedMs:200});
  const view=taskTimings(recovered,recovered.tasks[0]);
  assert.deepEqual(view.model.map(r=>[r.status,r.elapsedMs]),[["pending",null],["response_received",0]]);
  assert.ok(!JSON.stringify(view).includes("private"));
  assert.equal(view.modelCallsWithoutTiming,0);
  task.calls=3;assert.equal(taskTimings(state,task).modelCallsWithoutTiming,1);
});
const config={authorized:"explicitly-authorized",apiKey:"synthetic-secret-only",baseUrl:"https://model.invalid/v1",modelId:"timing"};
test("model round trip excludes admission and billing and keeps mock measurements labelled by their caller",async()=>{
  let now=0,seen:ModelMeasurement|undefined;
  const models=liveModels(config,()=>{now=1000;},(_u,t)=>{seen=t;now=9000;},async()=>{
    now=1123;return Response.json({choices:[{message:{content:"Visible answer"}}],usage:{prompt_tokens:10,completion_tokens:2}});
  },()=>now);
  await models.stream(models.getModel("pra","timing")!,{messages:[]}).result();
  assert.deepEqual(seen,{status:"response_received",elapsedMs:123});
  let sample:ModelMeasurement|undefined;
  const mock=mockModels(()=>{},(_i,_o,t)=>{sample=t;},undefined,()=>0);
  await mock.stream(mock.getModel("pra","deterministic-v1")!,{messages:[]}).result();
  assert.deepEqual(sample,{status:"response_received",elapsedMs:0});
});
test("denied model calls have no sample; failures and cancellation before dispatch have distinct outcomes",async()=>{
  let dispatched=0,settled=0,now=0,sample:ModelMeasurement|undefined;
  const deny=liveModels(config,()=>{throw Error("MODEL_BUDGET");},()=>{settled++;},async()=>{dispatched++;return Response.json({});});
  await deny.stream(deny.getModel("pra","timing")!,{messages:[]}).result();
  assert.equal(dispatched,0);assert.equal(settled,0);
  const fail=liveModels(config,()=>{},(_u,t)=>{sample=t;},async()=>{now=77;throw Error("private upstream message");},()=>now);
  await fail.stream(fail.getModel("pra","timing")!,{messages:[]}).result();
  assert.deepEqual(sample,{status:"interrupted",elapsedMs:77});
  const controller=new AbortController();
  const abort=liveModels(config,()=>{controller.abort();},(_u,t)=>{sample=t;},async()=>{dispatched++;return Response.json({});},()=>now);
  await abort.stream(abort.getModel("pra","timing")!,{messages:[]},{signal:controller.signal}).result();
  assert.equal(dispatched,0);assert.deepEqual(sample,{status:"not_dispatched",elapsedMs:null});
});
test("Server-Timing preserves response status, body, cookies and existing measurements",async()=>{
  const response=new Response("private body",{status:202,headers:{"set-cookie":"session=synthetic; HttpOnly","server-timing":"existing;dur=1"}});
  const measured=apiTiming(response,100,175);
  assert.equal(measured.status,202);assert.equal(await measured.text(),"private body");
  assert.equal(measured.headers.get("set-cookie"),"session=synthetic; HttpOnly");
  assert.match(measured.headers.get("server-timing")!,/existing;dur=1, pra_gateway;dur=75/);
  const upgrade={status:101} as Response;assert.equal(apiTiming(upgrade,0,1),upgrade);
  const backwards=new Response("ok");assert.equal(apiTiming(backwards,100,90),backwards);
});
