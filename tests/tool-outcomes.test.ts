import {test} from "node:test";
import assert from "node:assert/strict";
import {projectToolOutcomes,type ToolOutcomeOperation} from "../packages/research/tool-outcomes.ts";
import {workflowPrompt,newWorkflow,advanceWorkflow,type WorkflowContext} from "../packages/research/cloud-workflow.ts";
import {nodeCatalog} from "../local/catalog.ts";
const catalog=await nodeCatalog(undefined,true);
const chunks=Array.from({length:30},(_,i)=>({paper_id:"fixture-paper",chunk_id:"c"+i,paragraph_id:"p"+i,section:"Methods",text:"RAW_EXCERPT_NOT_FOR_COMPLETION ".repeat(100),start:0,end:3000,index_version:"fixture-v1"}));
const operations:ToolOutcomeOperation[]=Array.from({length:5},(_,i)=>({id:"op"+i,tool:"retrieve_chunks",params:{query:"method",paper_ids:["fixture-paper"],unexpected:"PRIVATE_PARAMETER_CANARY"},state:"done",result:{index_version:"fixture-v1",chunks:chunks.slice(i*6,i*6+6),unexpected:"PRIVATE_RESULT_CANARY"}}));
test("completion projection retains actual outcomes without copying original excerpts or arbitrary fields",()=>{
 const before=JSON.stringify(operations),result=projectToolOutcomes(operations),encoded=JSON.stringify(result);
 assert.equal(result.tools.length,5);assert.equal(result.tools[0].returned_records,6);assert.equal(result.tools[0].executed,true);
 assert.deepEqual(result.tools[0].chunks,["c0","c1","c2","c3","c4","c5"]);
 assert.deepEqual(result.tools[0].paper_ids,["fixture-paper"]);assert.ok(!encoded.includes("RAW_EXCERPT"));assert.ok(!encoded.includes("PRIVATE_"));
 assert.equal(JSON.stringify(operations),before);
});
test("empty, missing and uncompleted outcomes stay distinct; retries and unknown legacy execution are not conflated",()=>{
 const ops:ToolOutcomeOperation[]=[
  {tool:"search_papers",params:{},state:"done",result:{papers:[]}},
  {tool:"retrieve_chunks",params:{},state:"done"},
  {tool:"retrieve_chunks",params:{},state:"pending",attempts:2,result:{chunks:[{chunk_id:"late"}]}},
  {tool:"retrieve_chunks",params:{},state:"pending",attempts:0},
  {tool:"retrieve_chunks",params:{},state:"cancelled"},
  {tool:"retrieve_chunks",params:{},state:"pending"},
 ];
 const rows=projectToolOutcomes(ops).tools;
 assert.equal(rows[0].result_state,"available");assert.equal(rows[0].returned_records,0);
 assert.equal(rows[1].result_state,"not_recorded");assert.equal(rows[1].returned_records,null);
 assert.equal(rows[2].executed,true);assert.equal(rows[2].result_state,"not_completed");assert.deepEqual(rows[2].chunks,[]);
 assert.equal(rows[3].executed,false);assert.equal(rows[4].executed,null);assert.equal(rows[5].executed,null);
});
test("forty large operations fit the outcome window, preserve recent chronological order and expose all omissions",()=>{
 const ops=Array.from({length:40},(_,i)=>({id:"op"+i,tool:"retrieve_chunks",params:{paper_ids:Array.from({length:20},(_,j)=>"paper"+j)},state:"done",result:{chunks:Array.from({length:20},(_,j)=>({paper_id:"paper"+j,chunk_id:"c"+i+"-"+j+"长标识".repeat(60),text:"hidden"}))}}));
 const {tools,tool_window}=projectToolOutcomes(ops);
 assert.ok(tool_window.bytes<=8000);assert.ok(tools.length<40);assert.equal(tools.at(-1)?.id,"op39");
 assert.equal(tool_window.omitted,40-tools.length);assert.equal(tool_window.state_counts.done,40);
 assert.ok(tools.every((t,i)=>i===0||t.ordinal>tools[i-1].ordinal));assert.ok(tools.every(t=>t.chunk_ids_omitted>0));
 assert.ok(!JSON.stringify(tools).includes("hidden"));
});
test("identifier samples are exact identities, never shortened into nonexistent citation IDs",()=>{
 const op={tool:"retrieve_chunks",params:{paper_ids:["a".repeat(257),"valid🧪"]},state:"done",result:{chunks:[{paper_id:"p",chunk_id:"c".repeat(257)},{paper_id:"p",chunk_id:"valid🧪"}]}};
 const [out]=projectToolOutcomes([op]).tools;
 assert.deepEqual(out.requested_paper_ids,["valid🧪"]);assert.equal(out.requested_papers_omitted,1);
 assert.deepEqual(out.chunks,["valid🧪"]);assert.equal(out.chunk_ids_omitted,1);
});
test("large multi-retrieval completion request stays within host limit without changing candidate or citation window",()=>{
 const c:WorkflowContext={id:"t",input:"Explain the method",calls:3,evidence:chunks,catalog,conversation:{id:"c",title:"c",projectId:"p",scope:[],created:0,history:[]},memories:[],operations};
 const w=newWorkflow();advanceWorkflow(w,c,JSON.stringify({intent:"answer",targets:["fixture-paper"],rewrite:c.input,queries:[],constraints:[]}));
 w.phase="completion";w.candidate="Original candidate [cite:c0]";w.visibleSourceIds=["c0"];
 const prompt=workflowPrompt(w,c),body=JSON.parse(prompt);
 assert.ok(Buffer.byteLength(prompt)<12000);assert.equal(body.tools.length,5);assert.equal(body.tool_window.omitted,0);
 assert.equal(body.candidate,w.candidate);assert.deepEqual(body.visible_source_ids,["c0"]);assert.equal(w.phase,"completion");
 assert.ok(!prompt.includes("RAW_EXCERPT"));assert.equal(c.calls,3);assert.equal(c.operations.length,5);
});
test("execution metadata cannot substitute for evidence when the completion model claims success",()=>{
 const c:WorkflowContext={id:"t",input:"Explain the method",calls:4,evidence:[],catalog,conversation:{id:"c",title:"c",projectId:"p",scope:[],created:0,history:[]},memories:[],operations};
 const w=newWorkflow();advanceWorkflow(w,c,JSON.stringify({intent:"answer",targets:["fixture-paper"],rewrite:c.input,queries:[],constraints:[]}));
 w.phase="completion";w.candidate="The method works well.";w.visibleSourceIds=[];
 workflowPrompt(w,c);const outcome=advanceWorkflow(w,c,JSON.stringify({state:"complete",remaining_needs:[],needs_sources:true}));
 assert.notEqual(outcome.status,"completed");assert.notEqual(w.execution?.state,"complete");
});

test("actual provider request contains only the bounded completion projection, including after large archived tool traffic",async()=>{
 const {liveModels}=await import("../src/live-model.ts");
 const c:WorkflowContext={id:"t",input:"Explain the method",calls:3,evidence:chunks,catalog,conversation:{id:"c",title:"c",projectId:"p",scope:[],created:0,history:[]},memories:[],operations};
 const w=newWorkflow();w.phase="completion";w.candidate="Original candidate [cite:c0]";w.visibleSourceIds=["c0"];
 const prompt=workflowPrompt(w,c);let sent:any;
 const models=liveModels({authorized:"explicitly-authorized",apiKey:"software-test",baseUrl:"https://model.invalid/v1",modelId:"test"},()=>{},()=>{},(async(_url,init)=>{
  sent=JSON.parse(String(init?.body));return Response.json({choices:[{message:{content:'{"state":"complete","remaining_needs":[],"needs_sources":true}'}}],usage:{prompt_tokens:1,completion_tokens:1}});
 }) as typeof fetch);
 await models.stream(models.getModel("pra","test")!,{messages:[{role:"user",content:JSON.stringify({archivedToolResults:operations}),timestamp:0},{role:"user",content:prompt,timestamp:1}]}).result();
 assert.equal(sent.messages.length,1);assert.ok(Buffer.byteLength(JSON.stringify(sent))<45000);
 assert.ok(!JSON.stringify(sent).includes("RAW_EXCERPT"));assert.ok(!JSON.stringify(sent).includes("PRIVATE_RESULT"));
});
