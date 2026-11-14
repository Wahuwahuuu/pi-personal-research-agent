import {test} from "node:test";
import assert from "node:assert/strict";
import {answerPreview} from "../src/model-response.ts";
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
