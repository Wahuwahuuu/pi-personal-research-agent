import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {Harness,MemoryStorage} from "@earendil-works/pi-durable";
import {BACKGROUND_CONTEXT as ctx} from "@earendil-works/chord/context";
import {createResearchRegistry} from "../src/research-durable.ts";
import {liveModels} from "../src/live-model.ts";

test("real Pi Durable loops through registered AsterCite tools and reuses conversation",async()=>{
 const text="A verified original.",version="fixture";
 const chunk={paper_id:"p1",paragraph_id:"p1:s0:p0",chunk_id:"fixture:p1:s0:p0:c0-20",section:"Methods",text,start:0,end:Array.from(text).length,index_version:version,citation:"[fixture:p1:s0:p0:c0-20]",truncated:false};
 const sources=new Map<string,typeof chunk[]>(),calls:string[]=[],requests:any[]=[];
 const registry=createResearchRegistry({
 catalog:()=>({papers:[{paper_id:"p1",title:"Paper",abstract:"catalog"}],indexVersion:version,scope:["p1"],evidence:new Map([[chunk.chunk_id,{...chunk,text_sha256:createHash("sha256").update(text).digest("hex")} ]])}),
 async execute(r){calls.push(r.operationId);return r.tool==="search_papers"?{backend:"fixture",index_version:version,papers:[{paper_id:"p1",title:"Paper",abstract:"catalog"}]}:{backend:"fixture",index_version:version,chunks:[chunk]};},
 async waiting(){return false;},
 async remember(_op,id,items){sources.set(id,items as typeof chunk[]);},
 async evidence(id){return sources.get(id)??[];}
 });
 let n=0;
 const models=liveModels({authorized:"explicitly-authorized",apiKey:"synthetic-key",baseUrl:"https://example.invalid/v1",modelId:"fixture"},()=>{if(++n>6)throw Error("BUDGET");},()=>{},(async(_url,init)=>{
 const body=JSON.parse(String(init?.body));requests.push(body);
 const tools=body.messages.filter((m:any)=>m.role==="tool");
 const message=tools.length<2?{content:null,tool_calls:[{id:"call_"+tools.length,type:"function",function:{name:tools.length?"retrieve_chunks":"search_papers",arguments:JSON.stringify(tools.length?{query:"method",paper_ids:["p1"],top_k:1}:{query:"method"})}}]}:
 {content:JSON.stringify({execution:{state:"complete",remaining_needs:[],needs_sources:true},answer:"Original [cite:"+chunk.chunk_id+"]"})};
 return Response.json({choices:[{message}],usage:{prompt_tokens:12,completion_tokens:8}});
 }) as typeof fetch);
 const harness=await Harness.open(new MemoryStorage(),{models,registry,settings:{retry:{maxRetries:0},compaction:{enabled:false}}},ctx);
 try{
 const conversation=await harness.root(ctx,{agent:{model:{provider:"pra",modelId:"fixture"},maxTurns:6}});
 const submission=await conversation.submit({type:"input",content:"Find and explain the method"},ctx);
 const result=await submission.wait(ctx);
 assert.equal(result.status,"done");
 assert.equal(calls.length,2);assert.equal(new Set(calls).size,2);
 assert.deepEqual(requests[0].tools.map((t:any)=>t.function.name),["search_papers","retrieve_chunks"]);
 assert.equal(requests[2].messages.filter((m:any)=>m.role==="tool").length,2);
 const follow=await conversation.submit({type:"input",content:"Explain the same evidence again"},ctx);
 assert.equal((await follow.wait(ctx)).status,"done");
 assert.equal(calls.length,2);
 assert.ok(JSON.stringify(requests.at(-1).messages).includes("Find and explain"));
 }finally{await harness.close(ctx);}
});

test("device wait ends Pi work without model retries and same conversation accepts resume event",async()=>{
 let waiting=false,requests=0,operations=0;
 const registry=createResearchRegistry({
 catalog:()=>({papers:[{paper_id:"p1",title:"Paper",abstract:"catalog"}],indexVersion:"fixture",scope:["p1"],evidence:new Map()}),
 async execute(){operations++;waiting=true;return {};},async waiting(){return waiting;},async remember(){},async evidence(){return [];}
 });
 const models=liveModels({authorized:"explicitly-authorized",apiKey:"synthetic-key",baseUrl:"https://example.invalid/v1",modelId:"fixture"},()=>{requests++;},()=>{},(async()=>{
 return Response.json({choices:[{message:requests===1?{content:null,tool_calls:[{id:"offline",type:"function",function:{name:"search_papers",arguments:'{"query":"method"}'}}]}:{content:"Resumed"}}],usage:{prompt_tokens:5,completion_tokens:5}});
 }) as typeof fetch);
 const harness=await Harness.open(new MemoryStorage(),{models,registry,settings:{retry:{maxRetries:0},compaction:{enabled:false}}},ctx);
 try{
 const c=await harness.root(ctx,{agent:{model:{provider:"pra",modelId:"fixture"},maxTurns:6}});
 await (await c.submit({type:"input",content:"Find paper"},ctx)).wait(ctx);
 await harness.waitForIdle(ctx);
 assert.equal(waiting,true);assert.equal(requests,1);assert.equal(operations,1);
 for(let i=0;i<20&&harness.wake().active;i++)await new Promise<void>(r=>setImmediate(r));
 assert.equal(harness.wake().active,false);
 assert.equal((await harness.inspect(ctx)).tasks.length,0);
 waiting=false;
 await (await c.submit({type:"input",content:"Device result now available; resume existing research",entry:{kind:"research.resume",data:{operationId:"fixture"}}},ctx)).wait(ctx);
 assert.equal(requests,2);assert.equal(operations,1);
 }finally{await harness.close(ctx);}
});
