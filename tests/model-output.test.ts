import {test} from "node:test";
import assert from "node:assert/strict";
import {liveModels} from "../src/live-model.ts";
import {modelOutputLimit} from "../src/model-limits.ts";
import {prepareWorkbenchAnswer} from "../packages/research/internal/agent/workbench-answer.ts";
const config={authorized:"explicitly-authorized",apiKey:"synthetic-output-key",baseUrl:"https://model.invalid/v1",modelId:"fixture"};

test("research phases reserve room for source identities without enlarging cloud chat",()=>{
 for(const phase of ["agent","comparison","memory","translation"])assert.equal(modelOutputLimit({workflow:{phase}}),8192);
 for(const phase of ["prepare","completion"])assert.equal(modelOutputLimit({workflow:{phase}}),2048);
 assert.equal(modelOutputLimit({workflow:{phase:"agent",cloudOnly:true}}),2048);
 assert.equal(modelOutputLimit(),2048);
});

test("a request freezes its admitted output allowance through settlement and missing usage",async()=>{
 let limit=2048,sent:any,settled=0;
 const models=liveModels({...config,maxOutput:()=>limit},()=>{limit=8192;},usage=>{assert.equal(usage,undefined);settled++;limit=2048;},(async(_url,init)=>{
  sent=JSON.parse(String(init?.body));return Response.json({choices:[{message:{content:"Visible answer"},finish_reason:"stop"}]});
 }) as typeof fetch);
 const result=await models.stream(models.getModel("pra","fixture")!,{messages:[]}).result();
 assert.equal(sent.max_tokens,8192);assert.equal(result.usage.output,8192);assert.equal(settled,1);
});

test("length responses settle actual usage once and never emit executable tools or completion",async()=>{
 for(const content of ["text","valid_tool","broken_tool"]){
  const calls:any[]=[],failures:string[]=[],seen:any[]=[];
  const models=liveModels({...config,onFailure:code=>failures.push(code)},()=>{},u=>{calls.push(u);},(async()=>Response.json({
   choices:[{message:content==="text"?{content:'{"execution":{"state":"complete"},"answer":"unfinished'}:{content:null,tool_calls:[{id:"call1",type:"function",function:{name:"search_papers",arguments:content==="valid_tool"?'{"query":"paper"}':'{"query":'}}]},finish_reason:"length"}],usage:{prompt_tokens:321,completion_tokens:2048}
  })) as typeof fetch);
  for await(const e of models.stream(models.getModel("pra","fixture")!,{messages:[],tools:[{name:"search_papers",description:"search",parameters:{type:"object"}}]}))seen.push(e);
  assert.deepEqual(calls,[{input:321,output:2048}]);assert.deepEqual(failures,["MODEL_OUTPUT_TRUNCATED"]);
  assert.equal(seen.at(-1).type,"error");assert.equal(seen.at(-1).error.usage.output,2048);assert.ok(!seen.some(e=>e.type==="toolcall_end"||e.type==="done"));
  assert.ok(!seen.at(-1).error.content.some((c:any)=>c.type==="toolCall"));
 }
});

test("SSE length status survives decoding and is rejected after billing",async()=>{
 let usage:any,code="";
 const frames=[{choices:[{delta:{content:'{"answer":"partial'}}]},{choices:[{delta:{},finish_reason:"length"}],usage:{prompt_tokens:12,completion_tokens:17}}];
 const models=liveModels({...config,onFailure:c=>{code=c;}},()=>{},u=>{usage=u;},(async()=>new Response(frames.map(f=>"data: "+JSON.stringify(f)+"\n\n").join("")+"data: [DONE]\n\n",{headers:{"content-type":"text/event-stream"}})) as typeof fetch);
 const result=await models.stream(models.getModel("pra","fixture")!,{messages:[]}).result();
 assert.equal(result.stopReason,"error");assert.equal(code,"MODEL_OUTPUT_TRUNCATED");assert.deepEqual(usage,{input:12,output:17});
});

test("broken response envelopes never become prose; complete answer strings and Markdown remain compatible",()=>{
 const context={evidence:new Map(),expectedKind:"session_control" as const,allowAnswer:true};
 for(const broken of ['{"execution":{"state":"complete"},"answer":"unfinished','```json\n{"answer":"unfinished','{"execution":{"state":"complete"}}'])assert.equal(prepareWorkbenchAnswer(broken,context),null);
 const salvaged=prepareWorkbenchAnswer('{"answer":"Readable answer","execution":',context);
 assert.equal(salvaged?.value.answer,"Readable answer");
 assert.equal(prepareWorkbenchAnswer("Ordinary **Markdown**",context)?.value.answer,"Ordinary **Markdown**");
 assert.equal(prepareWorkbenchAnswer('{"config":"value"}',context)?.value.answer,'{"config":"value"}');
});
