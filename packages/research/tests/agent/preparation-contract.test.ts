import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage as reply } from "@earendil-works/pi-ai";
import { DomainMemory } from "../../internal/agent/domain-memory.ts";
import { parseQuestionPreparation, planPreparedRetrieval } from "../../internal/agent/question-preparation.ts";
import { mainFixture, final } from "./main-fixture.ts";

const papers = [{ paper_id: "p1", title: "Paper One", abstract: "" }, { paper_id: "p2", title: "Paper Two", abstract: "" }];
const context = { original: "Compare p2 and p1: both the method and the evaluation. Answer in Chinese.", allowed: new Set(["p1", "p2"]), publicPapers: papers, frameId: "contract", history: [], activeConstraints: [] };
const raw = { intent: "compare", targets: ["p2", "p1"], rewrite: "Compare the method and evaluation of p2 and p1", queries: ["method", "evaluation"], constraints: [] };

test("host metadata is never a user constraint or an alternate authority for objects", () => {
  const parsed = parseQuestionPreparation(JSON.stringify({ ...raw, constraints: [
    { key: "comparison_order", value: "p1 then p2", source_quote: "invented" },
    { key: "current_paper", value: "outside" },
    { key: "language", value: "Chinese", source_quote: "Chinese" },
  ] }), context);
  assert.deepEqual(parsed.frame.ordered_targets, ["p2", "p1"]);
  assert.deepEqual(parsed.frame.constraints, [{ key: "language", value: "Chinese", source_quote: "Chinese" }]);
  assert.equal(parsed.diagnostics?.filter(d => d.code === "host_owned_metadata_ignored").length, 2);
  const memory = new DomainMemory("fixture"); memory.applyFrame(parsed.frame, "contract");
  assert.deepEqual(memory.state.comparison_order, ["p2", "p1"]);
  assert.deepEqual(memory.activeConstraints().map(c => c.key), ["language"]);
});

test("advisory field failures are isolated without guessing schemas or losing the full goal", () => {
  const parsed = parseQuestionPreparation(JSON.stringify({ ...raw, rewrite: 17, queries: [{ query: "a fragment" }], needs: [{ question: "a subgoal" }], comparison_dimensions: "bad" }), context);
  assert.equal(parsed.rewrite, context.original);
  assert.equal(parsed.frame.question_text, context.original);
  assert.deepEqual(parsed.frame.ordered_targets, ["p2", "p1"]);
  assert.equal(parsed.frame.information_needs.length, 1);
  assert.match(parsed.frame.information_needs[0].text, /complete original_question/);
  assert.deepEqual(parsed.diagnostics?.map(d => d.path).sort(), ["comparison_dimensions", "needs", "queries", "rewrite"]);
  const plan = planPreparedRetrieval(parsed, context.allowed, 1);
  assert.equal(plan.queries[0].query, context.original);
});

test("unused constraint metadata does not weaken actual user quote provenance", () => {
  const good = { key: "language", value: "Chinese", source_quote: "Chinese", confidence: 0.4 };
  const parsed = parseQuestionPreparation(JSON.stringify({ ...raw, constraints: [good] }), context);
  assert.deepEqual(parsed.frame.constraints, [{ key: "language", value: "Chinese", source_quote: "Chinese" }]);
  assert.equal(parsed.diagnostics?.[0].code, "unused_constraint_fields");
  assert.throws(() => parseQuestionPreparation(JSON.stringify({ ...raw, constraints: [{ ...good, source_quote: "not in the actual user request" }] }), context), /source_quote/);
  assert.throws(() => parseQuestionPreparation(JSON.stringify({ ...raw, targets: ["outside"], needs: [{ invalid: true }] }), context), /allowed/);
  assert.throws(() => parseQuestionPreparation('{"intent":"answer","intent":"compare"}', context));
});

test("one-query capacity uses the complete standalone question rather than a subplan prefix", () => {
  for (const [question, rewrite, hints] of [
    ["比较p2与p1的数据来源和评价方式", "比较两篇论文的数据来源以及评价方式", ["数据来源", "评价方式"]],
    [context.original, raw.rewrite, ["method", "evaluation"]],
    ["Relate objectives to the reported limitations", "Relate the objectives and limitations in both papers", ["objectives", "limitations"]],
  ] as const) {
    const parsed = parseQuestionPreparation(JSON.stringify({ ...raw, rewrite, queries: hints }), { ...context, original: question });
    const before = structuredClone(parsed);
    const plan = planPreparedRetrieval(parsed, context.allowed, 1);
    assert.equal(plan.strategy, "whole_question");
    assert.deepEqual(plan.queries, [{ query: rewrite, paper_ids: ["p2", "p1"] }]);
    assert.equal(plan.unexecuted_suggestions.length, 2);
    assert.deepEqual(parsed, before);
    assert.deepEqual(planPreparedRetrieval(parsed, context.allowed, 2).queries, parsed.frame.queries);
  }
});

test("a single hint is still not assumed to be a complete question and does not add a call", () => {
  const parsed = parseQuestionPreparation(JSON.stringify({ ...raw, queries: ["method only"] }), context);
  const plan = planPreparedRetrieval(parsed, context.allowed, 2);
  assert.equal(plan.queries.length, 1);
  assert.equal(plan.queries[0].query, raw.rewrite);
  assert.deepEqual(plan.suggestions.map(q => q.query), ["method only"]);
});

test("long complete questions never become truncated prefixes", () => {
  const long = "😀".repeat(1001) + " important trailing condition";
  const parsed = parseQuestionPreparation(JSON.stringify({ ...raw, rewrite: long, queries: [] }), context);
  const plan = planPreparedRetrieval(parsed, context.allowed, 1);
  assert.equal(plan.query_source, "original_question"); assert.equal(plan.queries[0].query, context.original);
  const impossible = parseQuestionPreparation(JSON.stringify({ ...raw, rewrite: long, queries: [] }), { ...context, original: long });
  assert.deepEqual(impossible.frame.queries, []);
  const deferred = planPreparedRetrieval(impossible, context.allowed, 1);
  assert.equal(deferred.action, "autonomous"); assert.equal(deferred.reason, "complete_query_exceeds_capacity"); assert.deepEqual(deferred.queries, []);
});

test("clarification, session control and exhausted capacity do not silently turn into retrieval", () => {
  const ambiguous = parseQuestionPreparation(JSON.stringify({ intent: "answer", targets: [], queries: [], clarification: { question: "Which object?", reference_quote: "it" } }), { ...context, original: "What is its method?" });
  assert.equal(planPreparedRetrieval(ambiguous, context.allowed, 1).action, "clarify");
  const greeting = parseQuestionPreparation(JSON.stringify({ intent: "session_update", targets: [] }), { ...context, original: "你好" });
  assert.equal(planPreparedRetrieval(greeting, context.allowed, 1).action, "skip");
  const parsed = parseQuestionPreparation(JSON.stringify(raw), context);
  assert.equal(planPreparedRetrieval(parsed, context.allowed, 0).reason, "no_retrieval_capacity");
  assert.throws(() => planPreparedRetrieval(parsed, context.allowed, -1), /capacity/);
  parsed.frame.queries[0].paper_ids = ["outside"];
  assert.throws(() => planPreparedRetrieval(parsed, context.allowed, 1), /allowed scope/);
});

test("the real harness retains valid preparation and executes the whole goal after advisory recovery", async () => {
  const rewrite = "Describe p1 methodology and evaluation in Chinese";
  const input = { intent: "answer", targets: ["p1"], rewrite, queries: ["method"], constraints: [
    { key: "comparison_order", value: "untrusted object metadata" },
    { key: "language", value: "中文", source_quote: "用中文回答" },
  ], needs: [{ unexpected_schema: "evaluation" }] };
  for (const reliability of ["baseline", "candidate"] as const) {
    const setup = await mainFixture([reply(JSON.stringify(input)), reply(JSON.stringify(final))], [[0]], {
      controls: { arm: "C", reflect: false, compaction: "off", reliability, implementation_id: "1".repeat(64) },
    });
    try {
      const result = await setup.harness.runTurn("请说明p1的方法和评估，用中文回答", ["p1"], `contract/${reliability}`);
      assert.equal(result.status, "completed", result.error ?? "");
      assert.equal(result.question_preparation.status, "completed");
      assert.equal(result.requests.length, 2);
      assert.equal(setup.calls.length, 1);
      assert.equal((setup.calls[0].params as { query: string }).query, rewrite);
      assert.equal(result.question_preparation.result?.diagnostics?.length, 2);
      assert.equal(result.question_preparation.result?.retrieval_plan?.unexecuted_suggestions.length, 1);
      assert.deepEqual(setup.harness.memory.activeConstraints().map(c => c.key), ["language"]);
      assert.equal(result.pipeline_trace?.stages.find(s => s.stage === "QuestionPreparation")?.status, "degraded");
    } finally { setup.harness.dispose(); }
  }
});
