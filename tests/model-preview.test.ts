import {test} from "node:test";
import assert from "node:assert/strict";
import {answerPreview} from "../src/model-response.ts";
import {initialState,submit} from "../src/domain.ts";
import {bindResearchPreview} from "../src/research-preview.ts";
import {liveModels} from "../src/live-model.ts";
test("malformed preview strings never throw or expose execution fields",()=>{
 for(const text of ['{"bad\\x":"value","answer":"ok"}','{"answer":"line one\nline two"}','{"answer":"bad\\x"}','{"execution":{"state":"working"},"answer":"bad\\u00xx"}'])assert.equal(answerPreview(text),"");
 assert.equal(answerPreview('{"answer":"escaped\\nline"}'),"escaped\nline");
 assert.equal(answerPreview('{"execution":{"state":"working"},"answer":"partial'),"partial");
});
test("a malformed display preview cannot discard the provider's final usage",async()=>{
 const content='{"answer":"line one\nline two"}',settlements:any[]=[],failures:any[]=[];
 const frames=[{choices:[{delta:{content}}]},{choices:[{delta:{},finish_reason:"stop"}],usage:{prompt_tokens:34,completion_tokens:18}}];
 const models=liveModels({authorized:"explicitly-authorized",apiKey:"synthetic-preview-key",baseUrl:"https://model.invalid/v1",modelId:"fixture",onVisible:answerPreview,onFailure:c=>failures.push(c)},()=>{},(u,t)=>{settlements.push({u,t});},(async()=>new Response(frames.map(f=>"data: "+JSON.stringify(f)+"\n\n").join("")+"data: [DONE]\n\n",{headers:{"content-type":"text/event-stream"}})) as typeof fetch);
 const result=await models.stream(models.getModel("pra","fixture")!,{messages:[]}).result();
 assert.deepEqual(failures,[]);assert.equal(settlements.length,1);assert.deepEqual(settlements[0].u,{input:34,output:18});assert.equal(settlements[0].t.status,"response_received");
 assert.equal(result.stopReason,"stop");assert.equal(result.usage.input,34);
});
test("answer previews stay with their admitted task and throttle fragmented output",()=>{
 const state=initialState(),task=submit(state,"question","request","research"),other=submit(state,"another","other","research");
 const source="canonical-research-source-123456789",label="ref-000000000123";
 Object.assign(task,{modelOperation:"first",runOpen:true,status:"running",workflow:{phase:"agent",visibleSourceIds:[source],citationLabels:[label]}});
 let time=100,reads=0;const published:string[]=[];
 const display=bindResearchPreview(task,()=>{reads++;return state;},()=>published.push(task.preview!),()=>time)!;
 display('{"answer":"First [cite:'+label+']"}');
 for(let i=0;i<1300;i++)display('{"answer":"Intermediate"}');
 assert.deepEqual(published,["First [cite:"+source+"]"]);assert.equal(reads,2);
 time+=1000;display('{"execution":{"state":"working"}}');assert.equal(published.length,1);
 time+=1000;display('{"answer":"Updated"}');time+=1000;display('{"answer":"Updated"}');
 assert.deepEqual(published,["First [cite:"+source+"]","Updated"]);assert.equal(other.preview,undefined);
});

test("a late model frame cannot publish after task control, phase changes or state replacement",()=>{
 for(const end of ["cancel","pause","operation","phase","closed","remove","restore","invalidate"]){
  let state=initialState();const task=submit(state,"question","request","research");
  Object.assign(task,{runOpen:true,status:"running",modelOperation:"one",workflow:{phase:"agent"}});
  let count=0;const display=bindResearchPreview(task,()=>state,()=>{count++;},()=>100)!;
  switch(end){
   case "cancel":task.status="cancelled";break;
   case "pause":task.pauseRequested=true;break;
   case "operation":task.modelOperation="new";break;
   case "phase":task.workflow!.phase="completion";break;
   case "closed":task.runOpen=false;break;
   case "remove":state.tasks=[];break;
   case "restore":state={...state};break;
   case "invalidate":state.cloudMemory={enabled:true,entries:[],deletedSlots:[],invalidatedTurns:[task.id]};break;
  }
  display("Late answer");assert.equal(count,0,end);assert.equal(task.preview,undefined,end);
 }
 const state=initialState(),task=submit(state,"question","request","research");
 Object.assign(task,{modelOperation:"one",workflow:{phase:"prepare"}});
 assert.equal(bindResearchPreview(task,()=>state,()=>{}),undefined);
});
