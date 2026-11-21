import {test} from "node:test";
import assert from "node:assert/strict";
import type {Task} from "../src/domain.ts";
import {scheduleRejectedToolRepair} from "../src/model-tool-recovery.ts";
const task=():Task=>({id:"task",requestId:"request",input:"Explain the supplied evidence",kind:"research",status:"running",created:0,updated:0,calls:4,tools:1,activeMs:23000,runOpen:false,modelFailure:"INVALID_TOOL_CALL",modelFailureDetail:"undeclared_tool",workflow:{phase:"agent",warnings:[]}});

test("a rejected undeclared tool permits one correction without resetting paid or tool usage",()=>{
 const t=task(),before={calls:t.calls,tools:t.tools,activeMs:t.activeMs};
 assert.equal(scheduleRejectedToolRepair(t),true);assert.equal(t.status,"queued");
 assert.deepEqual({calls:t.calls,tools:t.tools,activeMs:t.activeMs},before);
 assert.deepEqual(t.modelToolRepairs,[{call:4,detail:"undeclared_tool"}]);
 const restored=JSON.parse(JSON.stringify(t));restored.status="running";restored.calls=5;
 assert.equal(scheduleRejectedToolRepair(restored),false);
 restored.goal={maxSegments:4,segments:[{index:1,started:0,calls:4,tools:1,activeMs:23000}]};
 assert.equal(scheduleRejectedToolRepair(restored),false);
});

test("invalid-tool correction cannot bypass task control, limits, or unrelated failures",()=>{
 const changes:Partial<Task>[]=[{status:"cancelled"},{status:"paused"},{status:"waiting_device"},{status:"waiting_user"},{status:"completed"},{runOpen:true},{pauseRequested:true},{researchWaiting:true},{calls:6},{tools:10},{activeMs:180000},{modelFailure:"BILLING_UNAVAILABLE"},{modelFailure:"UNSAFE_OR_UNSUPPORTED_RESPONSE"},{modelFailure:"MODEL_OUTPUT_TRUNCATED"},{modelFailureDetail:"tool_arguments"},{workflow:{phase:"memory",warnings:[]}}];
 for(const change of changes){const t={...task(),...change},before=structuredClone(t);assert.equal(scheduleRejectedToolRepair(t),false);assert.deepEqual(t,before);}
});
