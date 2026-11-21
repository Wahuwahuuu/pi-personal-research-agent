import assert from "node:assert/strict";
import test from "node:test";
import { isTaskPreview, withTaskPreview, type TaskPreview } from "../web/task-preview.ts";
import { initialState, submit } from "../src/domain.ts";

test("stream previews apply only to the admitted running task and never replace a final answer", () => {
  const task = submit(initialState(), "Question", "request", "research");
  Object.assign(task, { status: "running", runOpen: true, conversationId: "conversation", modelOperation: "operation" });
  const p: TaskPreview = { type: "task-preview", id: task.id, conversationId: "conversation",
    operation: "operation", updated: task.updated, text: "Visible partial answer" };
  assert.equal(isTaskPreview(p), true);
  assert.equal(withTaskPreview(task, p).preview, p.text);
  assert.equal(task.preview, undefined);
  for (const patch of [{id:"different"}, {conversationId:"other"}, {operation:"old"}, {updated:0}])
    assert.equal(withTaskPreview(task, {...p,...patch}), task);
  for (const patch of [{status:"completed"}, {status:"cancelled"}, {status:"waiting_user"},
    {runOpen:false}, {pauseRequested:true}, {answer:"Final answer"}]) {
    const changed = {...task,...patch} as typeof task;
    assert.equal(withTaskPreview(changed,p),changed);
  }
});

test("malformed and legacy events keep the authoritative refresh path", () => {
  for (const value of [null, 1, {}, {type:"change",cursor:4}, {type:"task-preview"},
    {type:"task-preview",id:"t",conversationId:"c",operation:"o",updated:NaN,text:"x"}])
    assert.equal(isTaskPreview(value),false);
});
