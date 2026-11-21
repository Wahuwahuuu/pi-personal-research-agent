import {test} from "node:test";
import assert from "node:assert/strict";
import {splitAnswerControl} from "../packages/research/internal/web/answer-format.js";
import {prepareWorkbenchAnswer} from "../packages/research/internal/agent/workbench-answer.ts";
import {executionFromOutput} from "../packages/research/internal/agent/turn-execution.ts";
const answer="The current scope ends in 2025.\n\nThis is saved personal context.";
const execution={state:"complete",remaining_needs:[],needs_sources:false};
const envelope={execution,answer};
test("duplicate trailing envelopes preserve prose and execution without exposing protocol JSON",()=>{
 for(const tail of ["\n\n```json\n"+JSON.stringify(envelope,null,2)+"\n```", "\n"+JSON.stringify(envelope),"\r\n```json\r\n"+JSON.stringify(envelope)+"\r\n```"]){
  const raw=answer+tail,parts=splitAnswerControl(raw);
  assert.equal(parts.body,answer);assert.deepEqual(parts.control,envelope);
  assert.equal(executionFromOutput(raw)?.state,"complete");
  const rendered=prepareWorkbenchAnswer(raw,{evidence:new Map(),allowAnswer:true,expectedKind:"session_control"});
  assert.equal(rendered?.value.answer,answer);
 }
});
test("nonduplicate JSON examples and following substantive prose remain untouched",()=>{
 for(const value of [{...envelope,answer:"A different answer"},{...envelope,extra:"example"},{answer}]){
  const raw=answer+"\n```json\n"+JSON.stringify(value)+"\n```";assert.equal(splitAnswerControl(raw).body,raw);
 }
 const followed=answer+"\n```json\n"+JSON.stringify(envelope)+"\n```\nFurther explanation.";assert.equal(splitAnswerControl(followed).body,followed);
 assert.equal(splitAnswerControl(JSON.stringify(envelope)).body,JSON.stringify(envelope));
});
