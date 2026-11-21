import {test} from "node:test";
import assert from "node:assert/strict";
import {initialState, submit, operation} from "../src/domain.ts";
import {localToolTimeout, toolDispatchFrame} from "../src/tool-deadline.ts";

test("relative tool budgets survive independent device clocks without changing cloud deadlines", () => {
  const state = initialState(), task = submit(state, "Find evidence", "clock-check", "research");
  const op = operation(state, task, "v1", "search_papers", {query: "evidence"});
  op.deadline = 160000;
  const original = structuredClone(op), frame = toolDispatchFrame(op, 100250);
  assert.equal(frame.timeoutMs, 59750);
  assert.deepEqual(op, original);
  for (const skew of [-86400000, -300000, 0, 300000, 86400000])
    assert.equal(localToolTimeout(op.deadline, frame.timeoutMs, 100250 + skew), 59750);
  assert.equal(toolDispatchFrame(op, 160001).timeoutMs, 0);
  assert.equal(toolDispatchFrame(op, 0).timeoutMs, 60000);
});

test("invalid explicit durations cannot fall back to a longer legacy timeout", () => {
  for (const value of [-1, 60001, Infinity, NaN, null, "60000", {}, true])
    assert.equal(localToolTimeout(200000, value, 100000), undefined);
  assert.equal(localToolTimeout(NaN, 5000), undefined);
  assert.equal(localToolTimeout(200000, 0), 1);
  assert.equal(localToolTimeout(200000, 123.2), 124);
});

test("old cloud frames keep their bounded legacy timer during rolling upgrades", () => {
  assert.equal(localToolTimeout(110000, undefined, 100000), 10000);
  assert.equal(localToolTimeout(99000, undefined, 100000), 1);
  assert.equal(localToolTimeout(1000000, undefined, 100000), 180000);
});
