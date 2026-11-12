import {test} from "node:test";
import assert from "node:assert/strict";
import {liveModels} from "../src/live-model.ts";
const config={authorized:"explicitly-authorized",apiKey:"synthetic-test-key",baseUrl:"https://model.invalid/v1",modelId:"test"};

test("a provider holds one admission slot through asynchronous reservation",async()=>{
 let release!:()=>void,admissions=0,requests=0,settlements=0;
 const gate=new Promise<void>(r=>{release=r;});
 const models=liveModels(config,async()=>{admissions++;await gate;},()=>{settlements++;},(async()=>{requests++;return Response.json({choices:[{message:{content:"OK"}}],usage:{prompt_tokens:3,completion_tokens:1}});}) as typeof fetch);
 const model=models.getModel("pra","test")!,input={messages:[{role:"user" as const,content:"synthetic",timestamp:0}]};
 const first=models.stream(model,input).result();
 await new Promise<void>(r=>setImmediate(r));
 const second=models.stream(model,input).result();await new Promise<void>(r=>setImmediate(r));
 const overlap=admissions;assert.equal(requests,0);assert.equal(settlements,0);
 release();assert.equal((await first).stopReason,"stop");assert.equal((await second).stopReason,"error");
 assert.equal(overlap,1);assert.equal(settlements,1);
 assert.equal((await models.stream(model,input).result()).stopReason,"stop");
 assert.equal(admissions,2);assert.equal(requests,2);assert.equal(settlements,2);
});
test("a committed settlement followed by acknowledgement failure is never invoked twice",async()=>{
 let settlements=0,requests=0,failure="";
 const models=liveModels({...config,onFailure:code=>{failure=code;}},()=>{},()=>{
  settlements++;throw Error("post-commit transport failure");
 },(async()=>{requests++;return Response.json({choices:[{message:{content:"OK"}}],usage:{prompt_tokens:3,completion_tokens:1}});}) as typeof fetch);
 const result=await models.stream(models.getModel("pra","test")!,{messages:[]}).result();
 assert.equal(result.stopReason,"error");assert.equal(requests,1);assert.equal(settlements,1);
 assert.equal(failure,"BILLING_UNAVAILABLE");
 assert.ok(!JSON.stringify(result).includes("post-commit"));
});
test("mock provider shares the same single-admission boundary",async()=>{
 const {mockModels,MODEL}=await import("../src/model.ts");
 let release!:()=>void,admissions=0,settlements=0;
 const gate=new Promise<void>(r=>{release=r;});
 const models=mockModels(async()=>{admissions++;await gate;},()=>{settlements++;});
 const model=models.getModel(MODEL.provider,MODEL.id)!,input={messages:[]};
 const first=models.stream(model,input).result();await new Promise<void>(r=>setImmediate(r));
 const second=models.stream(model,input).result();await new Promise<void>(r=>setImmediate(r));const overlap=admissions;
 release();assert.equal((await first).stopReason,"stop");assert.equal((await second).stopReason,"error");assert.equal(overlap,1);assert.equal(settlements,1);
 assert.equal((await models.stream(model,input).result()).stopReason,"stop");assert.equal(settlements,2);
});

test("only the persisted current submission can reserve a model request",async()=>{
 const {assertModelSubmission}=await import("../src/provider-context.ts");
 const expected=JSON.stringify({projection:"pra-context-v1",stage:"agent",request:"current"});
 let admissions=0,requests=0;
 const models=liveModels(config,messages=>{assertModelSubmission(messages,expected);admissions++;},()=>{},(async()=>{requests++;return Response.json({choices:[{message:{content:"OK"}}],usage:{prompt_tokens:3,completion_tokens:1}});}) as typeof fetch);
 const model=models.getModel("pra","test")!;
 for(const content of ["summarize archived conversation",JSON.stringify({projection:"pra-context-v1",request:"old"})]){
   assert.equal((await models.stream(model,{messages:[{role:"user",content,timestamp:0}]}).result()).stopReason,"error");
 }
 assert.equal(admissions,0);assert.equal(requests,0);
 assert.equal((await models.stream(model,{messages:[{role:"user",content:expected,timestamp:0}]}).result()).stopReason,"stop");
 assert.equal(admissions,1);assert.equal(requests,1);
 assert.doesNotThrow(()=>assertModelSubmission([{role:"user",content:[{type:"text",text:expected}]}],expected));
 assert.throws(()=>assertModelSubmission([{role:"toolResult",content:expected}],expected),/MODEL_SUBMISSION_MISMATCH/);
});

test("the model slot remains owned until the settlement callback finishes",async()=>{
 let release!:()=>void,entered!:()=>void,admissions=0;
 const gate=new Promise<void>(r=>{release=r;}),settling=new Promise<void>(r=>{entered=r;});
 const models=liveModels(config,()=>{admissions++;},async()=>{entered();await gate;},(async()=>Response.json({choices:[{message:{content:"OK"}}],usage:{prompt_tokens:3,completion_tokens:1}})) as typeof fetch);
 const model=models.getModel("pra","test")!,input={messages:[]};
 const first=models.stream(model,input).result();await settling;
 const second=models.stream(model,input).result();await new Promise<void>(r=>setImmediate(r));const overlap=admissions;release();
 assert.equal((await second).stopReason,"error");assert.equal(overlap,1);assert.equal((await first).stopReason,"stop");
});
