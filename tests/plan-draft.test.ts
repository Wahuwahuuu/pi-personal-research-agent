import { test } from "node:test";
import assert from "node:assert/strict";
import { draftPlan } from "../src/plan-draft.ts";
test("daily topic drafts preserve the objective and extract exact supplied keywords and limit", () => {
  const d = draftPlan(
    "每天关注 retrieval augmented generation，重点研究原文依据，最多两篇",
  );
  assert.equal(d.query, "retrieval augmented generation");
  assert.equal(d.maxPapers, 2);
  assert.match(d.objective, /原文依据/);
  assert.equal(d.warnings.length, 0);
});
test("unsupported times and missing English query are explicit and no permission is inferred", () => {
  const d = draftPlan("每周关注科研智能体，最多10篇");
  assert.equal(d.query, "");
  assert.equal(d.maxPapers, 3);
  assert.equal(d.warnings.length, 3);
  assert.ok(!("autoProcess" in d));
  assert.ok(!("enabled" in d));
});
test("draft bounds reject empty and oversized text without creating a plan", () => {
  assert.throws(() => draftPlan(" "));
  assert.throws(() => draftPlan("a".repeat(2001)));
  assert.throws(() => draftPlan({ query: "agents" }));
});
