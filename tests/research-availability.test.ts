import assert from "node:assert/strict";
import {test} from "node:test";
import {advanceWorkflow, newWorkflow, type ResearchConversation} from "../packages/research/cloud-workflow.ts";
import {awaitsResearchCatalog, holdForMissingPapers, revisitPaperWait} from "../src/research-availability.ts";
import {cancel, initialState, submit, type Task} from "../src/domain.ts";
import {amendTask, pauseTask, resumeTask} from "../src/task-control.ts";
import type {ResearchCatalog} from "../src/research-catalog.ts";

const empty: ResearchCatalog = {indexVersion:"library-empty-v1", papers:[], evidence:[]};
const catalog = (id: string): ResearchCatalog => ({
  indexVersion:"index-" + id, papers:[{paper_id:id, title:id, abstract:"Abstract"}], evidence:[],
});
function setup(scope: string[] = [], snapshot = empty, intent = "answer") {
  const state = initialState();
  const task = submit(state, "Explain the study method", "request", "research", 0);
  const conversation: ResearchConversation = {id:"c", title:"Study", projectId:"project", scope, history:[], created:0};
  Object.assign(task, {engine:"durable", conversationId:"c", sessionId:"pi-1", calls:1, activeMs:325, researchIndex:snapshot.indexVersion});
  task.workflow = newWorkflow();
  advanceWorkflow(task.workflow, {id:task.id, input:task.input, calls:1, catalog:snapshot, conversation, evidence:[], memories:[], operations:[]},
    JSON.stringify({intent, targets:[], rewrite:task.input, queries:[], constraints:[]}));
  return {state, task};
}

test("empty research waits without an answer and resumes once against the first matching published snapshot", () => {
  const {task} = setup();
  const counters = [task.id, task.sessionId, task.calls, task.tools, task.activeMs];
  assert.equal(holdForMissingPapers(task, empty, []), true);
  assert.equal(task.status, "waiting_user");
  assert.equal(task.error, "PAPER_LIBRARY_EMPTY");
  assert.equal(task.answer, undefined);
  const restored: Task = JSON.parse(JSON.stringify(task));
  assert.equal(revisitPaperWait(restored, empty, []), false);
  assert.equal(revisitPaperWait(restored, catalog("paper"), []), true);
  assert.equal(restored.status, "queued");
  assert.equal(restored.workflow?.phase, "prepare");
  assert.equal(restored.researchIndex, "index-paper");
  assert.equal(restored.paperWait, undefined);
  assert.deepEqual([restored.id, restored.sessionId, restored.calls, restored.tools, restored.activeMs], counters);
  assert.equal(revisitPaperWait(restored, catalog("next"), []), false);
});

test("a scoped task keeps its paper requirement across other imports, offline resume and user pause", () => {
  const scope = ["needed"], {task, state} = setup(scope, catalog("unrelated"));
  assert.equal(holdForMissingPapers(task, catalog("unrelated"), scope), true);
  assert.equal(task.error, "SCOPE_PAPERS_UNAVAILABLE");
  assert.equal(revisitPaperWait(task, catalog("other"), scope), false);
  pauseTask(task);
  assert.equal(revisitPaperWait(task, catalog("needed"), scope), false);
  resumeTask(state, task);
  assert.equal(revisitPaperWait(task, undefined, scope), true);
  assert.equal(task.status, "waiting_device");
  assert.equal(awaitsResearchCatalog(task), true);
  assert.equal(revisitPaperWait(task, empty, scope), true);
  assert.equal(task.status, "waiting_user");
  assert.equal(revisitPaperWait(task, catalog("needed"), scope), true);
  assert.equal(task.researchIndex, "index-needed");
});

test("a published catalog does not revive cancelled or invalidated tasks, rebind evidence, or block nonfactual turns", () => {
  for (const mutation of ["cancel", "invalidate", "evidence", "tools"]) {
    const {task, state} = setup();
    holdForMissingPapers(task, empty, []);
    if (mutation === "cancel") cancel(state, task.id);
    if (mutation === "invalidate") task.error = "CONTEXT_CHANGED";
    if (mutation === "evidence") task.researchEvidence = [{chunk_id:"original"} as NonNullable<Task["researchEvidence"]>[number]];
    if (mutation === "tools") task.tools = 1;
    assert.equal(revisitPaperWait(task, catalog("paper"), []), false);
    assert.equal(task.researchIndex, empty.indexVersion);
  }
  for (const intent of ["session_update", "find_papers"]) {
    const {task} = setup([], empty, intent);
    assert.equal(holdForMissingPapers(task, empty, []), false);
  }
  const unknown = {...empty, indexVersion:"cloud-only"}, {task} = setup([], unknown);
  assert.equal(holdForMissingPapers(task, unknown, []), false);
  delete task.researchIndex;
  assert.equal(awaitsResearchCatalog(task), true);
  task.researchIndex = empty.indexVersion;
  task.workflow!.automatic = true;
  assert.equal(holdForMissingPapers(task, empty, []), true);
  assert.equal(task.calls, 1);
  task.paperWait = undefined;
  delete task.researchIndex;
  task.tools++;
  assert.equal(awaitsResearchCatalog(task), false);
});

test("a direction change may be reclassified, but retains the same conversation and consumed budget", () => {
  const {task, state} = setup();
  holdForMissingPapers(task, empty, []);
  amendTask(state, task, "先说明如何导入资料。");
  assert.equal(task.status, "paused");
  assert.equal(revisitPaperWait(task, catalog("new"), []), false);
  resumeTask(state, task);
  assert.equal(task.paperWait, undefined);
  assert.equal(task.researchIndex, undefined);
  assert.equal(task.workflow?.phase, "prepare");
  assert.equal(task.sessionId, "pi-1");
  assert.equal(task.calls, 1);
  assert.equal(task.tools, 0);
});
