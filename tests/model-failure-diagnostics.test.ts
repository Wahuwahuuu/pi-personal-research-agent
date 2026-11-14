import {test} from "node:test";
import assert from "node:assert/strict";
import {liveModels} from "../src/live-model.ts";
const config={authorized:"explicitly-authorized",apiKey:"synthetic-diagnostic-key",baseUrl:"https://model.invalid/v1",modelId:"fixture"};
const call={id:"call_1",type:"function",function:{name:"search_papers",arguments:"{}"}};
test("invalid tool envelopes retain only bounded diagnostics and settle once without execution",async()=>{
 const cases:[unknown[],string][]=[
  [[null],"tool_type"],
  [[{...call,type:"unsupported-private-value"}],"tool_type"],
  [[{...call,id:"private invalid identifier"}],"tool_id"],
  [[call,call],"duplicate_tool_id"],
  [[{...call,function:{...call.function,name:"private_unknown_tool"}}],"undeclared_tool"],
  [[{...call,function:{...call.function,arguments:{private:"private_argument_value"}}}],"tool_arguments"],
 ];
 for(const [calls,detail] of cases){
  const failures:any[]=[],usage:any[]=[],events:any[]=[];
  const models=liveModels({...config,onFailure:(...failure)=>failures.push(failure)},()=>{},u=>{usage.push(u);},(async()=>Response.json({choices:[{message:{content:null,reasoning_content:"HIDDEN_DIAGNOSTIC_SENTINEL",tool_calls:calls},finish_reason:"tool_calls"}],usage:{prompt_tokens:17,completion_tokens:9}})) as typeof fetch);
  for await(const event of models.stream(models.getModel("pra","fixture")!,{messages:[],tools:[{name:"search_papers",description:"search",parameters:{type:"object"}}]}))events.push(event);
  assert.deepEqual(failures,[["INVALID_TOOL_CALL",detail]]);assert.deepEqual(usage,[{input:17,output:9}]);
  assert.equal(events.at(-1).type,"error");assert.ok(!events.some(e=>e.type==="toolcall_end"||e.type==="done"));
  const saved=JSON.stringify({events,failures});for(const marker of ["private_","private invalid",config.apiKey,"HIDDEN_DIAGNOSTIC_SENTINEL"])assert.ok(!saved.includes(marker));
 }
});
test("an undeclared streamed tool is diagnosed without recording its provider value",async()=>{
 const failures:any[]=[],events:any[]=[];
 const frames=[{choices:[{delta:{tool_calls:[{index:0,...call,function:{name:"private_unknown_tool",arguments:"{}"}}]}}]},{choices:[{delta:{},finish_reason:"tool_calls"}],usage:{prompt_tokens:17,completion_tokens:9}}];
 const models=liveModels({...config,onFailure:(...f)=>failures.push(f)},()=>{},()=>{},(async()=>new Response(frames.map(f=>"data: "+JSON.stringify(f)+"\n\n").join("")+"data: [DONE]\n\n",{headers:{"content-type":"text/event-stream"}})) as typeof fetch);
 for await(const e of models.stream(models.getModel("pra","fixture")!,{messages:[],tools:[{name:"search_papers",description:"search",parameters:{type:"object"}}]}))events.push(e);
 assert.deepEqual(failures,[["INVALID_TOOL_CALL","undeclared_tool"]]);assert.ok(!JSON.stringify({events,failures}).includes("private_unknown_tool"));assert.ok(!events.some(e=>e.type==="toolcall_end"));
});
