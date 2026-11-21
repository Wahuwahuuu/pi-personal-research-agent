import {canSaveTaskAnswer} from "../src/artifact-contract.ts";
import {VALIDATION_LIMITS} from "../src/validation-limits.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialState,
  submit,
  reserve,
  settle,
  taskAllowance,
  expire,
  operation,
  acceptResult,
} from "../src/domain.ts";
import {
  handleModelBudget,
  configureTask,
  nextSegment,
  segmentUsage,
  pauseTask,
  resumeTask,
  amendTask,
  answerResearchQuestion,
  currentInstruction,
  checkpoint,
  orderedTasks,
  nextResearchTurn,
} from "../src/task-control.ts";
import {
  createResearchPorts,
  acceptResearchResult,
} from "../src/research-coordinator.ts";
import { nodeCatalog } from "../local/catalog.ts";
const catalog = await nodeCatalog(undefined, true);
const fixture = () => {
  const s = initialState(),
    t = submit(s, "Read the methods", "request", "research", 0);
  configureTask(t, "long", 1);
  t.engine = "durable";
  t.sessionId = "s";
  t.researchIndex = "fixture-v1";
  return { s, t };
};
test("four segments preserve one task, one session and the cumulative 24-call limit across restoration", () => {
  let { s, t } = fixture();
  const id = t.id;
  for (let segment = 1; segment <= 4; segment++) {
    for (let call = 0; call < 6; call++) {
      reserve(s, t, 20, 10);
      settle(s, 20, 10, { input: 10, output: 4 });
    }
    assert.equal(t.calls, segment * 6);
    assert.equal(segmentUsage(t).calls, 6);
    assert.throws(() => reserve(s, t, 20, 10), /MODEL_BUDGET/);
    s = JSON.parse(JSON.stringify(s));
    t = s.tasks[0];
    assert.equal(t.id, id);
    assert.equal(t.sessionId, "s");
    if (segment < 4) assert.equal(nextSegment(t, "segment_budget"), true);
  }
  assert.equal(nextSegment(t, "segment_budget"), false);
  assert.equal(t.status, "paused");
  assert.equal(t.error, "GOAL_BUDGET");
  assert.throws(() => resumeTask(s, t), /GOAL_BUDGET/);
  assert.equal(t.calls, 24);
  assert.equal(s.tasks.length, 1);
  assert.equal(s.usage.requests, 24);
});
test("ordinary tasks cannot get new allowance through pause, continuation or amendments", () => {
  const s = initialState(),
    t = submit(s, "Ask", "r", "auto");
  for (let i = 0; i < 6; i++) {
    reserve(s, t, 1, 1);
    settle(s, 1, 1, { input: 1, output: 1 });
  }
  pauseTask(t);
  amendTask(s, t, "Only discuss methods");
  assert.throws(() => resumeTask(s, t), /MODEL_BUDGET/);
  assert.equal(nextSegment(t, "manual"), false);
  assert.equal(t.calls, 6);
});
test("paused local results are accepted once without rescheduling a model, including reconnect expiration", () => {
  const { s, t } = fixture();
  const op = operation(s, t, "fixture-v1", "search_papers", {
    query: "method",
  });
  op.state = "sent";
  op.deadline = 10;
  pauseTask(t);
  assert.throws(() => amendTask(s, t, "change"), /PAUSE_REQUIRED/);
  expire(s, 20);
  assert.equal(t.status, "paused");
  const raw = {
    backend: "fixture",
    index_version: "fixture-v1",
    papers: [
      {
        paper_id: "fixture-paper",
        title: "Deterministic research fixture",
        abstract: "Not a scientific evaluation.",
        score: 1,
      },
    ],
  };
  assert.equal(
    acceptResearchResult(s, op.id, "fixture-v1", raw, () => catalog, 200),
    "accepted",
  );
  assert.equal(t.status, "paused");
  assert.equal(
    acceptResearchResult(s, op.id, "fixture-v1", raw, () => catalog, 200),
    "duplicate",
  );
  assert.equal(t.activeMs, 200);
  amendTask(s, t, "Compare the method only");
  assert.equal(t.amendments!.length, 1);
  resumeTask(s, t);
  assert.equal(t.status, "queued");
  assert.equal(t.tools, 1);
  assert.equal(t.activeMs, 200);
});
test("pausing a model prevents subsequent tool admission and amendment waits for the step boundary", async () => {
  const { s, t } = fixture();
  t.runOpen = true;
  t.status = "running";
  pauseTask(t);
  assert.throws(() => resumeTask(s, t), /PAUSE_PENDING/);
  assert.throws(() => amendTask(s, t, "new direction"), /PAUSE_REQUIRED/);
  const ports = createResearchPorts(
    () => s,
    () => catalog,
    () => {},
  );
  await assert.rejects(
    () =>
      ports.execute(
        {
          conversationId: "s",
          operationId: "op",
          indexVersion: "fixture-v1",
          tool: "search_papers",
          params: { query: "method" },
        } as any,
        new AbortController().signal,
      ),
    /TASK_PAUSED/,
  );
  assert.equal(s.operations.length, 0);
  t.runOpen = false;
  resumeTask(s, t);
  assert.equal(t.status, "queued");
});
test("foreground always precedes background; user priority applies within each class", () => {
  const s = initialState();
  const bg = submit(s, "Background", "b", "research", 0);
  bg.origin = "schedule";
  bg.priority = 2;
  const normal = submit(s, "Foreground", "f", "auto", 2);
  normal.priority = 1;
  const high = submit(s, "Urgent", "u", "auto", 3);
  high.priority = 2;
  assert.deepEqual(
    orderedTasks(s).map((t) => t.id),
    [high.id, normal.id, bg.id],
  );
  assert.equal(s.tasks[0], bg);
});
test("segment checkpoints retain evidence gaps and active time cannot exceed four segments", () => {
  const { s, t } = fixture();
  t.answer = "Partial finding";
  t.workflow = {
    phase: "finished",
    warnings: [],
    execution: {
      state: "partial",
      remaining_needs: ["Missing experiment"],
      stop_reason: "remaining_allowance",
    },
  };
  for (let i = 0; i < 4; i++) {
    t.activeMs += 180000;
    assert.equal(taskAllowance(t).activeMs, 0);
    const advanced = nextSegment(t, "segment_deadline");
    assert.equal(advanced, i < 3);
  }
  assert.equal(
    t.goal!.segments[0].checkpoint!.remaining[0],
    "Missing experiment",
  );
  assert.equal(t.activeMs, 720000);
  assert.equal(t.status, "paused");
});
test("no evidence progress never automatically spends another long-goal segment", () => {
  const { t } = fixture();
  t.workflow = {
    phase: "finished",
    warnings: [],
    execution: {
      state: "partial",
      remaining_needs: ["No new source"],
      stop_reason: "no_execution_progress",
    },
  };
  assert.equal(nextSegment(t, "segment_budget"), false);
  assert.equal(t.goal!.segments.length, 1);
});
test("local tools retain ten-per-segment and forty-total limits without resetting counters", () => {
  const { s, t } = fixture();
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 10; j++) {
      t.operationId = undefined;
      const op = operation(s, t, "v", "search_papers", { query: "q" });
      op.state = "done";
    }
    t.operationId = undefined;
    assert.throws(
      () => operation(s, t, "v", "search_papers", { query: "q" }),
      /TOOL_BUDGET/,
    );
    if (i < 3) assert.equal(nextSegment(t, "segment_budget"), true);
  }
  assert.equal(t.tools, 40);
  assert.equal(taskAllowance(t).tools, 0);
});

test("amending a paused goal cancels unstarted old tool requests while keeping spent allowance", async () => {
  const { s, t } = fixture();
  const op = operation(s, t, "v", "search_papers", { query: "old direction" });
  pauseTask(t);
  amendTask(s, t, "New direction");
  assert.equal(op.state, "cancelled");
  assert.equal(t.tools, 1);
  const { taskSummary } = await import("../src/workspace.ts");
  assert.equal(taskSummary(t).amendments![0].text, "New direction");
  resumeTask(s, t);
  assert.equal(t.status, "queued");
  assert.equal(t.tools, 1);
});

test("budget exhaustion inside Pi checkpoints the same goal and never resets total or validation counters",()=>{
 const {s,t}=fixture();
 t.calls=6;t.tools=2;t.status="running";t.modelFailure="MODEL_BUDGET";t.modelFailureDetail="tool_id";
 handleModelBudget(s,t);
 assert.equal(t.status,"queued");assert.equal(t.calls,6);assert.equal(t.tools,2);
 assert.equal(t.goal!.segments.length,2);assert.equal(t.modelFailure,undefined);assert.equal(t.modelFailureDetail,undefined);
 t.calls=24;t.status="running";handleModelBudget(s,t);
 assert.equal(t.status,"paused");assert.equal(t.error,"GOAL_BUDGET");
 const next=fixture();next.t.calls=6;next.s.usage.requests=VALIDATION_LIMITS.requests;
 handleModelBudget(next.s,next.t);
 assert.equal(next.t.status,"waiting_user");assert.equal(next.t.error,"VALIDATION_BUDGET");
 assert.equal(next.t.goal!.segments.length,1);assert.equal(next.s.usage.requests,VALIDATION_LIMITS.requests);
});


test("validation output exhaustion respects the active research phase before opening another segment",()=>{
 const {s,t}=fixture();t.calls=6;t.workflow={phase:"agent",warnings:[]};
 s.usage.output=VALIDATION_LIMITS.output-5000;
 handleModelBudget(s,t);
 assert.equal(t.error,"VALIDATION_BUDGET");assert.equal(t.status,"waiting_user");assert.equal(t.goal!.segments.length,1);
 assert.equal(s.usage.output,VALIDATION_LIMITS.output-5000);assert.equal(t.calls,6);
});

test("only the head of a blocked Pi conversation is eligible to wake the scheduler", () => {
  const {t} = fixture();
  const first = {...t, id:"a", conversationId:"one", status:"waiting_device" as const, created:10};
  const later = {...first, id:"b", status:"queued" as const, priority:2 as const, created:11};
  const independent = {...later, id:"c", conversationId:"two", created:12};
  const offline = (task: typeof t) => task.status === "queued";
  assert.equal(nextResearchTurn([later,first],offline),undefined);
  assert.equal(nextResearchTurn([later,independent,first],offline)?.id,"c");
  assert.equal(nextResearchTurn([later,first],()=>true)?.id,"a");
  for (const status of ["completed","failed","cancelled","waiting_user"] as const)
    assert.equal(nextResearchTurn([later,{...first,status}],offline)?.id,"b");
  assert.equal(nextResearchTurn([later,{...first,status:"paused"}],offline),undefined);
});

test("turns admitted in the same millisecond have a stable head after restoration", () => {
  const {t} = fixture();
  const first = {...t, id:"a",conversationId:"shared",status:"queued" as const,created:1};
  const second = {...first,id:"b",priority:2 as const};
  assert.equal(nextResearchTurn([second,first],()=>true)?.id,"a");
  assert.equal(nextResearchTurn(structuredClone([first,second]),()=>true)?.id,"a");
  assert.equal(nextResearchTurn([first,second],turn=>turn.id!=="a"),undefined);
});

test("a clarification for a waiting task pauses the same turn and preserves the original findings until explicit resume",()=>{
 const {s,t}=fixture();
 t.goal=undefined;t.status="waiting_user";t.calls=3;t.tools=2;t.activeMs=8000;t.answer="Partial result";
 t.workflow={phase:"finished",warnings:[],execution:{state:"partial",remaining_needs:["The remaining source"]}} as any;
 const original=structuredClone(t.workflow),originalId=t.id;
 amendTask(s,t,"Focus on the remaining source");
 assert.equal(t.id,originalId);assert.equal(s.tasks.length,1);assert.equal(t.status,"paused");assert.deepEqual(t.workflow,original);
 assert.equal(canSaveTaskAnswer(t),true);assert.equal(canSaveTaskAnswer({...t,runOpen:true}),false);assert.equal(canSaveTaskAnswer({...t,status:"running"}),false);
 assert.equal(t.answer,"Partial result");assert.equal(t.calls,3);assert.equal(t.tools,2);assert.equal(t.activeMs,8000);
 const restored=structuredClone(s),again=restored.tasks[0];resumeTask(restored,again);
 assert.equal(again.id,originalId);assert.equal(again.status,"queued");assert.equal(again.workflow?.phase,"prepare");assert.equal(again.calls,3);assert.equal(again.tools,2);
 assert.equal(again.amendments?.[0].text,"Focus on the remaining source");
});

test("waiting amendments reject exhausted, in-flight or invalidated turns before changing their evidence or state",()=>{
 for(const reason of ["requests","time","active","invalidated","terminal"]){
  const {s,t}=fixture();t.goal=undefined;t.status="waiting_user";t.calls=reason==="requests"?6:2;t.activeMs=reason==="time"?180000:0;t.runOpen=reason==="active";t.answer="Recorded answer";
  if(reason==="invalidated")t.error="CONTEXT_CHANGED";
  if(reason==="terminal")t.status="completed";
  const previous=structuredClone(t);
  assert.throws(()=>amendTask(s,t,"Narrow the task"),reason==="requests"||reason==="time"?/MODEL_BUDGET/:reason==="invalidated"?/NEW_TASK_REQUIRED/:/PAUSE_REQUIRED/);
  assert.deepEqual(t,previous);
 }
});

test("a reply belongs to the displayed question and continues the same task with its original counters",()=>{
 const {s,t}=fixture();t.goal=undefined;t.status="waiting_user";t.error="RESEARCH_CLARIFICATION";t.calls=2;t.tools=1;t.activeMs=1600;
 t.answer="Which comparison dimension?";t.workflow={phase:"finished",warnings:[],execution:{state:"clarification",remaining_needs:[]}};
 t.amendments=[{text:"Keep the original units",at:1}];
 const session=t.sessionId,id=t.id;
 answerResearchQuestion(s,t,{questionCall:2,input:"Methods",resume:true});
 assert.equal(t.status,"queued");assert.equal(t.workflow.phase,"prepare");assert.equal(t.id,id);assert.equal(t.sessionId,session);
 assert.equal(t.calls,2);assert.equal(t.tools,1);assert.equal(t.activeMs,1600);assert.equal(s.tasks.length,1);
 assert.deepEqual(t.amendments[1].replyTo,{call:2,question:"Which comparison dimension?"});
 const instruction=currentInstruction(t);assert.ok(instruction.includes("Keep the original units"));assert.ok(instruction.includes("Which comparison dimension?"));assert.ok(instruction.includes("Methods"));
 const after=structuredClone(t);
 assert.throws(()=>answerResearchQuestion(s,t,{questionCall:2,input:"Another answer",resume:true}),/RESEARCH_QUESTION_CHANGED/);assert.deepEqual(t,after);
});
test("saving a reply for later preserves the question and older waiting records remain compatible",()=>{
 const {s,t}=fixture();t.goal=undefined;t.status="waiting_user";t.calls=3;t.answer="Which source?";t.error="COMPLETION_UNCONFIRMED";
 t.workflow={phase:"finished",warnings:[],execution:{state:"clarification",remaining_needs:["source"]}};
 answerResearchQuestion(s,t,{questionCall:3,input:"The second paper",resume:false});
 assert.equal(t.status,"paused");assert.equal(t.amendmentPending,true);assert.equal(t.calls,3);
 const restored=structuredClone(s),again=restored.tasks[0];resumeTask(restored,again);assert.ok(currentInstruction(again).includes("Which source?"));
 assert.equal(again.sessionId,t.sessionId);assert.equal(again.calls,3);
});
test("stale, out-of-budget and non-question replies leave the original record intact",()=>{
 for(const mode of ["differentCall","missingCall","missingIntent","wrongStatus","otherWait","exhausted","invalidated","empty"]){
  const {s,t}=fixture();t.goal=undefined;t.status=mode==="wrongStatus"?"paused":"waiting_user";t.calls=mode==="exhausted"?6:3;
  t.error=mode==="otherWait"?"RESEARCH_REFUSAL":"RESEARCH_CLARIFICATION";t.answer="Which source?";
  t.workflow={phase:"finished",warnings:[],execution:{state:"clarification",remaining_needs:[]}};
  if(mode==="invalidated")s.cloudMemory={invalidatedTurns:[t.id]} as any;
  const original=structuredClone(t);
  assert.throws(()=>answerResearchQuestion(s,t,{questionCall:mode==="differentCall"?2:mode==="missingCall"?undefined:t.calls,input:mode==="empty"?" ":"Methods",resume:mode==="missingIntent"?undefined:true}));
  assert.deepEqual(t,original);
 }
});

test("a user's clarification can use the next existing long-goal segment without creating a new budget",()=>{
 const {s,t}=fixture();t.status="waiting_user";t.calls=6;t.tools=2;t.answer="Partial result";
 t.workflow={phase:"finished",warnings:[],execution:{state:"partial",remaining_needs:["Locate the baseline"],stop_reason:"no_execution_progress"}} as any;
 assert.equal(t.goal!.segments.length,1);amendTask(s,t,"Only locate the baseline");
 assert.equal(t.workflow?.phase,"finished");assert.equal(t.goal!.segments.length,1);
 resumeTask(s,t);assert.equal(t.goal!.segments.length,2);assert.equal(t.calls,6);assert.equal(t.tools,2);assert.equal(t.workflow?.phase,"prepare");assert.equal(s.tasks.length,1);
 const capped=fixture();capped.t.calls=24;capped.t.status="waiting_user";
 assert.throws(()=>amendTask(capped.s,capped.t,"One more attempt"),/GOAL_BUDGET/);assert.equal(capped.t.status,"waiting_user");
 capped.t.calls=3;capped.t.tools=40;capped.t.error="GOAL_BUDGET";capped.t.status="paused";
 assert.throws(()=>resumeTask(capped.s,capped.t),/GOAL_BUDGET/);assert.equal(capped.t.status,"paused");
});
