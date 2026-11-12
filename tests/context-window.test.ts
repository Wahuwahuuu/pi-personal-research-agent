import { test } from "node:test";
import assert from "node:assert/strict";
import { projectRecentDialogue } from "../packages/research/context-window.ts";
import { workflowPrompt,newWorkflow,type WorkflowContext } from "../packages/research/cloud-workflow.ts";
import { liveModels } from "../src/live-model.ts";
const context=():WorkflowContext=>({id:"current",input:"continue",calls:1,evidence:[],catalog:{indexVersion:"v",papers:[],evidence:[]},conversation:{id:"c",title:"c",projectId:"p",scope:[],created:0,history:[]},memories:[],operations:[]});
test("long Chinese discussion retains the newest turn, flags cuts and does not alter the archive",()=>{
 const records=Array.from({length:100},(_,i)=>({turn_id:"t"+i,user_text:"请使用中文核对证据。".repeat(200)+i,final_answer:"此前已经讨论。".repeat(400)}));
 const before=JSON.stringify(records),window=projectRecentDialogue(records,true);
 assert.ok(window.bytes<=2500);assert.equal(window.items.at(-1)?.turn_id,"t99");assert.ok(window.items.length<4);
 assert.deepEqual(window.items.at(-1)?.truncated,["user_text","final_answer"]);assert.equal(JSON.stringify(records),before);
});
test("short turns preserve chronological order within the recent four",()=>{
 const records=Array.from({length:8},(_,i)=>({turn_id:"t"+i,user_text:"Q"+i,final_answer:"A"+i}));
 const result=projectRecentDialogue(records,true);
 assert.deepEqual(result.items.map(t=>t.turn_id),["t4","t5","t6","t7"]);assert.deepEqual(result.truncated,[]);
});
test("emoji and JSON escaping obey serialized UTF-8 limits without broken Unicode",()=>{
 for(const value of ["🧪证据",'\"\n\\\t'.repeat(3)]){
  const result=projectRecentDialogue([{turn_id:"latest",user_text:value.repeat(2000),final_answer:value.repeat(2000)}],true);
  assert.equal(result.items.length,1);assert.equal(result.items[0].turn_id,"latest");
  assert.ok(result.bytes<=2500);assert.equal(new TextEncoder().encode(JSON.stringify(result.items)).length,result.bytes);
  for(const value of [result.items[0].user_text,result.items[0].final_answer!])assert.equal(new TextDecoder().decode(new TextEncoder().encode(value)),value);
 }
});
test("reading-note projection does not reintroduce archived assistant answers",()=>{
 const result=projectRecentDialogue([{turn_id:"t",user_text:"question",final_answer:"UNVERIFIED_OLD_CLAIM"}],false);
 assert.equal(result.items[0].final_answer,undefined);assert.ok(!JSON.stringify(result).includes("UNVERIFIED_OLD_CLAIM"));
});
test("manifest matches the actual bounded history and counts only invalidated turns in this conversation",()=>{
 const c=context(),w=newWorkflow();
 c.conversation.history=Array.from({length:100},(_,i)=>({turn_id:"t"+i,user_text:"较长的用户讨论。".repeat(100),final_answer:"历史回答。".repeat(300)}));
 c.invalidatedMemoryTurns=["t99","other-conversation"];
 const before=JSON.stringify(c.conversation.history),body=JSON.parse(workflowPrompt(w,c)),m=body.context_manifest;
 assert.deepEqual(m.visible_recent_turns,body.conversation.conversation_only.map((h:any)=>h.turn_id));
 assert.equal(m.visible_recent_turns.at(-1),"t98");assert.equal(m.invalidated_turns_excluded,1);
 assert.equal(m.omitted_valid_turns,99-m.visible_recent_turns.length);assert.equal(m.stored_turns,100);
 assert.equal(m.history_bytes,new TextEncoder().encode(JSON.stringify(body.conversation.conversation_only)).length);
 assert.deepEqual(w.contextWindow!.truncated_recent_turns,m.truncated_recent_turns);assert.equal(JSON.stringify(c.conversation.history),before);
});
test("recent constraints are favored inside the existing byte budget",()=>{
 const c=context(),w=newWorkflow();workflowPrompt(w,c);
 c.conversation.domain!.user_constraints=Array.from({length:15},(_,i)=>({key:"k"+i,value:"older".repeat(200),source_quote:"old",source_turn:"t"+i,superseded_by:null}));
 c.conversation.domain!.user_constraints.push({key:"latest",value:"优先使用我刚刚纠正的术语",source_quote:"刚刚纠正",source_turn:"new",superseded_by:null});
 const body=JSON.parse(workflowPrompt(w,c)),entries=body.conversation.domain_memory.user_constraints;
 assert.equal(entries.at(-1).key,"latest");assert.ok(new TextEncoder().encode(JSON.stringify(entries)).length<=2500);
 assert.equal(body.context_manifest.constraints,entries.length);
});
test("real provider adapter sends the exact managed projection and excludes archived text",async()=>{
 const c=context(),w=newWorkflow();
 c.conversation.history=[{turn_id:"old",user_text:"OLD_ARCHIVE_ONLY",final_answer:"old"},...Array.from({length:10},(_,i)=>({turn_id:"t"+i,user_text:"最新要求🧪".repeat(500),final_answer:"answer"}))];
 const prompt=workflowPrompt(w,c);let sent:any;
 const models=liveModels({authorized:"explicitly-authorized",apiKey:"software-test",baseUrl:"https://model.invalid/v1",modelId:"test"},()=>{},()=>{},(async(_url,init)=>{
  sent=JSON.parse(String(init?.body));return Response.json({choices:[{message:{content:"ok"}}],usage:{prompt_tokens:1,completion_tokens:1}});
 }) as typeof fetch);
 await models.stream(models.getModel("pra","test")!,{messages:[{role:"user",content:"OLD_ARCHIVE_ONLY",timestamp:0},{role:"user",content:prompt,timestamp:1}]}).result();
 assert.equal(sent.messages.length,1);
 const content=sent.messages[0].content;
 const actual=JSON.parse(typeof content==="string"?content:content.map((p:any)=>p.text).join(""));
 assert.deepEqual(actual.context_manifest,JSON.parse(prompt).context_manifest);assert.ok(!JSON.stringify(sent).includes("OLD_ARCHIVE_ONLY"));
 assert.equal(c.conversation.history[0].user_text,"OLD_ARCHIVE_ONLY");
});
