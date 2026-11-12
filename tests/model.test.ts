import { test } from "node:test";
import assert from "node:assert/strict";
import { liveModels } from "../src/live-model.ts";
import {
  parseModelSettings,
  modelDeploymentArgs,
} from "../src/model-settings.ts";
const config = {
  authorized: "explicitly-authorized",
  apiKey: "test-secret-DO-NOT-PERSIST",
  baseUrl: "https://model.invalid/v1",
  modelId: "test",
};
test("Qwen requests explicitly disable thinking and never persist provider reasoning", async () => {
  let sent: Record<string, unknown> | undefined;
  const settings = { ...config, modelId: "qwen3.7-flash" };
  const models = liveModels(
    settings,
    () => {},
    () => {},
    (async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({
        choices: [
          { message: { content: "OK", reasoning_content: "HIDDEN_SENTINEL" } },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      });
    }) as typeof fetch,
  );
  const events = [];
  for await (const event of models.stream(
    models.getModel("pra", settings.modelId)!,
    { messages: [{ role: "user", content: "test", timestamp: 0 }] },
  ))
    events.push(event);
  assert.equal(sent?.enable_thinking, false);
  assert.equal(sent?.preserve_thinking, false);
  assert.equal(sent?.max_tokens, 2048);
  assert.equal(sent?.stream, true);
  assert.ok(!JSON.stringify(events).includes("HIDDEN_SENTINEL"));
});
test("deployment profile carries only non-secret settings and keeps mock as the default", () => {
  assert.deepEqual(modelDeploymentArgs(), []);
  const input = {
    mode: "live",
    modelId: "qwen3.7-flash",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    thinking: "off",
  };
  const parsed = parseModelSettings(input);
  assert.deepEqual(modelDeploymentArgs(parsed), [
    "--var",
    "MODEL_MODE:live",
    "--var",
    "MODEL_ID:qwen3.7-flash",
    "--var",
    "MODEL_BASE_URL:https://dashscope.aliyuncs.com/compatible-mode/v1",
  ]);
  assert.throws(
    () => parseModelSettings({ ...input, apiKey: "fake-only" }),
    /UNKNOWN_MODEL_SETTING/,
  );
  assert.throws(
    () => parseModelSettings({ ...input, thinking: "on" }),
    /THINKING_MUST_BE_OFF/,
  );
  assert.throws(
    () =>
      parseModelSettings({
        ...input,
        baseUrl: "https://user:password@model.invalid/v1",
      }),
    /INVALID_MODEL_URL/,
  );
  assert.throws(
    () =>
      parseModelSettings({
        ...input,
        baseUrl: "https://model.invalid/v1?key=fake-only",
      }),
    /INVALID_MODEL_URL/,
  );
});
test("live model cannot be enabled without explicit authorization", () => {
  assert.throws(
    () =>
      liveModels(
        { ...config, authorized: "" },
        () => {},
        () => {},
      ),
    /PAID_CALLS_DISABLED/,
  );
});
test("provider drops hidden reasoning before Pi can persist it", async () => {
  let calls = 0,
    usage: unknown;
  const models = liveModels(
    config,
    () => {
      calls++;
    },
    (u) => {usage = u;},
    (async (_url, init) => {
      assert.match(
        String(new Headers(init?.headers).get("Authorization")),
        /Bearer test-secret/,
      );
      return Response.json({
        choices: [
          {
            message: {
              content: "Visible evidence answer.",
              reasoning_content: "HIDDEN_SENTINEL",
            },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 23 },
      });
    }) as typeof fetch,
  );
  const stream = models.stream(models.getModel("pra", "test")!, {
    messages: [{ role: "user", content: "test", timestamp: 0 }],
  });
  const seen = [];
  for await (const event of stream) seen.push(event);
  const encoded = JSON.stringify(seen);
  assert.ok(encoded.includes("Visible evidence answer."));
  assert.ok(!encoded.includes("HIDDEN_SENTINEL"));
  assert.ok(!encoded.includes(config.apiKey));
  assert.equal(calls, 1);
  assert.deepEqual(usage, { input: 12, output: 23 });
});
test("unsafe model output and provider errors never enter persisted events", async () => {
  for (const body of [
    { choices: [{ message: { content: "<think>HIDDEN_SENTINEL</think>" } }] },
    { choices: [{ message: { content: config.apiKey } }] },
  ]) {
    const models = liveModels(
      config,
      () => {},
      () => {},
      (async () => Response.json(body)) as typeof fetch,
    );
    const events = [];
    for await (const e of models.stream(models.getModel("pra", "test")!, {
      messages: [],
    }))
      events.push(e);
    const encoded = JSON.stringify(events);
    assert.match(encoded, /MODEL_REQUEST_FAILED/);
    assert.ok(!encoded.includes("HIDDEN_SENTINEL"));
    assert.ok(!encoded.includes(config.apiKey));
  }
});

test("tool protocol retains declarations, call identity and tool observations without reasoning", async()=>{
 const bodies:any[]=[];
 const models=liveModels(config,()=>{},()=>{},(async(_url,init)=>{
   bodies.push(JSON.parse(String(init?.body)));
   return Response.json({choices:[{message:{content:null,reasoning_content:"HIDDEN_SENTINEL",tool_calls:[{id:"call_1",type:"function",function:{name:"search_papers",arguments:JSON.stringify({query:"method"})}}]},finish_reason:"tool_calls"}],usage:{prompt_tokens:10,completion_tokens:4}});
 }) as typeof fetch);
 const model=models.getModel("pra","test")!;
 const first=await models.stream(model,{messages:[{role:"user",content:"find",timestamp:0}],tools:[{name:"search_papers",description:"search",parameters:{type:"object",properties:{query:{type:"string"}},required:["query"]}}]}).result();
 assert.equal(first.stopReason,"toolUse");
 assert.equal(first.content.find(c=>c.type==="toolCall")?.name,"search_papers");
 assert.ok(!JSON.stringify(first).includes("HIDDEN_SENTINEL"));
 await models.stream(model,{messages:[{role:"user",content:"find",timestamp:0},first,{role:"toolResult",toolCallId:"call_1",toolName:"search_papers",content:[{type:"text",text:"observed"}],isError:false,timestamp:1}],
 tools:[{name:"search_papers",description:"search",parameters:{type:"object"}}]}).result();
 assert.equal(bodies[0].tools[0].function.name,"search_papers");
 assert.equal(bodies[1].messages.find((m:any)=>m.role==="assistant").tool_calls[0].id,"call_1");
 assert.deepEqual(bodies[1].messages.find((m:any)=>m.role==="tool"),{role:"tool",tool_call_id:"call_1",content:"observed"});
});
test("unregistered tool calls and secret arguments are rejected",async()=>{
 for(const name of ["shell","search_papers"]){
 const models=liveModels(config,()=>{},()=>{},(async()=>Response.json({choices:[{message:{tool_calls:[{id:"bad",type:"function",function:{name,arguments:JSON.stringify({query:config.apiKey})}}]}}]})) as typeof fetch);
 const result=await models.stream(models.getModel("pra","test")!,{messages:[],tools:[{name:"search_papers",description:"search",parameters:{type:"object"}}]}).result();
 assert.equal(result.stopReason,"error");
 assert.ok(!JSON.stringify(result).includes(config.apiKey));
 }
});

test("Pi named system sections reach the actual provider payload once with latest values",async()=>{
 let sent:any;
 const models=liveModels(config,()=>{},()=>{},(async(_url,init)=>{sent=JSON.parse(String(init?.body));return Response.json({choices:[{message:{content:"OK"}}],usage:{prompt_tokens:4,completion_tokens:1}});}) as typeof fetch);
 await models.stream(models.getModel("pra","test")!,{messages:[{role:"system",content:"Base",sections:{research:"OLD_SECTION"},timestamp:0},{role:"system",content:"",sections:{research:"ACTUAL_RESEARCH_RULE"},timestamp:1},{role:"user",content:"question",timestamp:2}]}).result();
 const systems=sent.messages.filter((m:any)=>m.role==="system");assert.equal(systems.length,1);assert.match(systems[0].content,/ACTUAL_RESEARCH_RULE/);assert.ok(!systems[0].content.includes("OLD_SECTION"));
});


test("SSE forwards visible text before completion, drops reasoning and joins split tools",async()=>{
 const {modelResponse,answerPreview}=await import("../src/model-response.ts");
 const chunks=[{choices:[{delta:{reasoning_content:"HIDDEN_SENTINEL",content:"Visible ".repeat(20)}}]},{choices:[{delta:{tool_calls:[{index:0,id:"call1",type:"function",function:{name:"search_papers",arguments:'{"query":'}}]}}]},{choices:[{delta:{tool_calls:[{index:0,function:{arguments:'"method"}'}}]},finish_reason:"tool_calls"}],usage:{prompt_tokens:1,completion_tokens:2}}];
 let controller:ReadableStreamDefaultController<Uint8Array>;const rs=new ReadableStream<Uint8Array>({start(c){controller=c;}});const seen:string[]=[];
 const result=modelResponse(new Response(rs,{headers:{"content-type":"text/event-stream"}}),config.apiKey,t=>seen.push(t));
 controller!.enqueue(new TextEncoder().encode("data: "+JSON.stringify(chunks[0])+"\n\n"));await new Promise(r=>setTimeout(r,5));assert.ok(seen.length>0);
 for(const c of chunks.slice(1))controller!.enqueue(new TextEncoder().encode("data: "+JSON.stringify(c)+"\n\n"));controller!.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));controller!.close();
 const data=await result;assert.equal(data.choices[0].message.tool_calls[0].function.arguments,'{"query":"method"}');assert.ok(!JSON.stringify({seen,data}).includes("HIDDEN_SENTINEL"));
 assert.equal(answerPreview('{"execution":{"state":"complete"},"answer":"你好'),"你好");assert.equal(answerPreview('{"execution":{"state":"working"}'),"");
});
test("SSE rejects incomplete streams and secrets split across network frames",async()=>{
 const {modelResponse}=await import("../src/model-response.ts");
 for(const content of [[config.apiKey.slice(0,9),config.apiKey.slice(9)],["<thi","nk>HIDDEN_SENTINEL"]]){
  const seen:string[]=[];const raw=content.map(text=>"data: "+JSON.stringify({choices:[{delta:{content:text}}]})+"\n\n").join("");
  await assert.rejects(()=>modelResponse(new Response(raw,{headers:{"content-type":"text/event-stream"}}),config.apiKey,t=>seen.push(t)));
  assert.ok(!seen.join("").includes(config.apiKey));assert.ok(!seen.join("").includes("HIDDEN_SENTINEL"));
 }
 await assert.rejects(()=>modelResponse(new Response('data: {"choices":[]}\n\n',{headers:{"content-type":"text/event-stream"}}),config.apiKey,()=>{}),/INCOMPLETE_STREAM/);
});

test("budget rejection happens before network dispatch and is retained as an actionable code",async()=>{
 let requests=0,settlements=0,failure="";
 const models=liveModels({...config,onFailure:code=>{failure=code;}},()=>{throw Error("MONTHLY_BUDGET");},()=>{settlements++;},(async()=>{requests++;throw Error("MUST_NOT_CALL");}) as typeof fetch);
 for await(const _event of models.stream(models.getModel("pra","test")!,{messages:[{role:"user",content:"synthetic",timestamp:0}]})){}
 assert.equal(requests,0);assert.equal(settlements,0);assert.equal(failure,"MONTHLY_BUDGET");
});

test("asynchronous admission is awaited and cancellation before dispatch settles zero without HTTP",async()=>{
 let release!:()=>void,requests=0,usage:unknown;
 const gate=new Promise<void>(r=>{release=r;}),abort=new AbortController();
 const models=liveModels(config,()=>gate,async u=>{usage=u;},(async()=>{requests++;return Response.json({choices:[{message:{content:"never"}}]});}) as typeof fetch);
 const result=models.stream(models.getModel("pra","test")!,{messages:[]},{signal:abort.signal}).result();
 await new Promise<void>(r=>setImmediate(r));assert.equal(requests,0);
 abort.abort();release();assert.equal((await result).stopReason,"aborted");assert.equal(requests,0);assert.deepEqual(usage,{input:0,output:0});
});

test("actual provider payload excludes superseded archived memory in a managed continuous conversation",async()=>{
 let sent:any;
 const models=liveModels(config,()=>{},()=>{},(async(_url,init)=>{sent=JSON.parse(String(init?.body));return Response.json({choices:[{message:{content:"OK"}}],usage:{prompt_tokens:10,completion_tokens:1}});})as typeof fetch);
 const messages:any[]=[{role:"user",content:"DELETED_MEMORY_SENTINEL",timestamp:0},...Array.from({length:200},(_,i)=>({role:"user",content:"Archived discussion ".repeat(50)+i,timestamp:i+1})),{role:"user",content:JSON.stringify({projection:"pra-context-v1",request:"continue",memory:["corrected preference"],context_manifest:{archived_turns:201,visible_recent_turns:[]}}),timestamp:300}];
 const result=await models.stream(models.getModel("pra","test")!,{messages}).result();
 assert.equal(result.stopReason,"stop");assert.equal(sent.messages.length,1);assert.ok(!JSON.stringify(sent).includes("DELETED_MEMORY_SENTINEL"));assert.ok(JSON.stringify(sent).includes("corrected preference"));
});

test("mock empty search retains explicit current paper scope without inventing fixture identifiers", async () => {
 const {mockModels, MODEL}=await import("../src/model.ts");
 const models=mockModels(()=>{},()=>{});
 const tools=[{name:"search_papers",description:"search",parameters:{type:"object"}},{name:"retrieve_chunks",description:"read",parameters:{type:"object"}}];
 for(const ids of [["known-paper"],[]]){
  const frame={stage:"agent",frame:{ordered_targets:ids},observations:[{result:{papers:[]}}]};
  const result=await models.stream(models.getModel(MODEL.provider,MODEL.id)!,{messages:[{role:"user",content:JSON.stringify(frame),timestamp:0}],tools}).result();
  const call=result.content.find(c=>c.type==="toolCall");
  if(ids.length){assert.equal(call?.name,"retrieve_chunks");assert.deepEqual(call?.arguments.paper_ids,ids);}
  else {assert.equal(call,undefined);const text=result.content.find(c=>c.type==="text")?.text!;assert.equal(JSON.parse(text).execution.state,"partial");}
 }
});
test("mock preserves known admission denials without leaking arbitrary errors or settling rejected calls", async()=>{
 const {mockModels,MODEL}=await import("../src/model.ts");
 for(const message of ["MODEL_BUDGET","BACKGROUND_DAILY_BUDGET","private exception content"]){
  let settled=0,failure="";
  const models=mockModels(()=>{throw Error(message);},()=>{settled++;},code=>{failure=code;});
  const result=await models.stream(models.getModel(MODEL.provider,MODEL.id)!,{messages:[]}).result();
  assert.equal(result.stopReason,"error");assert.equal(settled,0);
  assert.equal(failure,message==="private exception content"?"MODEL_REQUEST_FAILED":message);
  assert.ok(!JSON.stringify(result).includes("private exception content"));
 }
});

test("mock follows validated retrieval suggestions after an empty scoped discovery", async()=>{
 const {mockModels,MODEL}=await import("../src/model.ts");
 const models=mockModels(()=>{},()=>{});
 const tools=[{name:"search_papers",description:"search",parameters:{type:"object"}},{name:"retrieve_chunks",description:"read",parameters:{type:"object"}}];
 const frame={stage:"agent",frame:{ordered_targets:[]},retrieval_suggestions:{queries:[{query:"full original question",paper_ids:["known-scoped-paper"]}]},observations:[{result:{papers:[]}}]};
 const answer=await models.stream(models.getModel(MODEL.provider,MODEL.id)!,{messages:[{role:"user",content:JSON.stringify(frame),timestamp:0}],tools}).result();
 const call=answer.content.find(c=>c.type==="toolCall");
 assert.equal(call?.name,"retrieve_chunks");assert.deepEqual(call?.arguments.paper_ids,["known-scoped-paper"]);
});
