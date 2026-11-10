import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeCatalog, catalogPages } from "../local/catalog.ts";
import { validateCatalog } from "../src/research-catalog.ts";
import { initialState, submit, cancel, reserve } from "../src/domain.ts";
import {
  createResearchPorts,
  acceptResearchResult,
  resumePrompt,
  checkedResult,
  validateResearchAnswer,
} from "../src/research-coordinator.ts";
const catalog = await nodeCatalog(undefined, true);
const search = {
  backend: "fixture",
  index_version: "fixture-v1",
  papers: catalog.papers,
};
const chunk = {
  paper_id: "fixture-paper",
  chunk_id: "fixture-chunk",
  paragraph_id: "p1",
  section: "abstract",
  start: 0,
  end: 9,
  text: "Evidence.",
  index_version: "fixture-v1",
  citation: "[fixture-chunk]",
  truncated: false,
};
function setup() {
  const state = initialState(),
    t = submit(state, "research", "request", "research");
  t.engine = "durable";
  t.sessionId = "1";
  t.researchIndex = "fixture-v1";
  t.runOpen = true;
  t.status = "running";
  let saves = 0;
  const ports = createResearchPorts(
    () => state,
    () => catalog,
    () => saves++,
  );
  return { state, t, ports, saves: () => saves };
}
test("durable admission replays same operation and keeps fast results waiting until Pi settles", async () => {
  const { state, t, ports, saves } = setup();
  const request = {
    operationId: "1:call",
    conversationId: "1",
    tool: "search_papers" as const,
    params: { query: "method" },
    indexVersion: "fixture-v1",
  };
  await ports.execute(request, new AbortController().signal);
  await ports.execute(request, new AbortController().signal);
  assert.equal(state.operations.length, 1);
  assert.equal(t.tools, 1);
  assert.equal(saves(), 2);
  assert.equal(await ports.waiting("1"), true);
  assert.equal(
    acceptResearchResult(
      state,
      "1:call",
      "fixture-v1",
      search,
      () => catalog,
      10,
    ),
    "accepted",
  );
  assert.equal(t.status, "waiting_device");
  assert.equal(t.activeMs, 10);
  for (let i = 0; i < 5; i++)
    assert.equal(
      acceptResearchResult(
        state,
        "1:call",
        "fixture-v1",
        search,
        () => catalog,
        10,
      ),
      "duplicate",
    );
  assert.equal(t.activeMs, 10);
  const restored = JSON.parse(JSON.stringify(state)),
    rt = restored.tasks[0];
  const resume = resumePrompt(restored, rt, () => catalog);
  assert.deepEqual(resume.ids, ["1:call"]);
  assert.ok(resume.prompt.includes("observations"));
  restored.operations[0].delivered = true;
  assert.deepEqual(resumePrompt(restored, rt, () => catalog).ids, []);
  assert.equal(rt.sessionId, "1");
  await assert.rejects(
    () =>
      ports.execute(
        { ...request, params: { query: "different" } },
        new AbortController().signal,
      ),
    /OPERATION_CONFLICT/,
  );
});
test("source-map verification rejects tampered Unicode spans and versions before persistence", async () => {
  const { state, t, ports } = setup();
  await ports.execute(
    {
      operationId: "1:read",
      conversationId: "1",
      tool: "retrieve_chunks",
      params: { query: "evidence", paper_ids: ["fixture-paper"], top_k: 1 },
      indexVersion: "fixture-v1",
    },
    new AbortController().signal,
  );
  const good = {
    backend: "fixture",
    index_version: "fixture-v1",
    chunks: [chunk],
  };
  for (const bad of [
    { ...good, index_version: "wrong" },
    { ...good, chunks: [{ ...chunk, text: "Modified." }] },
    { ...good, chunks: [{ ...chunk, chunk_id: "invented" }] },
  ]) {
    assert.throws(() =>
      acceptResearchResult(state, "1:read", "fixture-v1", bad, () => catalog),
    );
    assert.equal(state.operations[0].state, "pending");
    assert.equal(t.researchEvidence, undefined);
  }
  assert.equal(
    acceptResearchResult(state, "1:read", "fixture-v1", good, () => catalog),
    "accepted",
  );
  assert.equal(t.researchEvidence?.[0].citation, "[cite:fixture-chunk]");
  assert.equal(
    validateResearchAnswer(t, "Claim [cite:fixture-chunk]"),
    "waiting_user",
  );
  assert.equal(
    validateResearchAnswer(
      t,
      JSON.stringify({
        execution: {
          state: "complete",
          remaining_needs: [],
          needs_sources: true,
        },
        answer: "Claim [cite:fixture-chunk]",
      }),
    ),
    "completed",
  );
  assert.equal(
    validateResearchAnswer(
      t,
      JSON.stringify({
        execution: {
          state: "partial",
          remaining_needs: ["read more"],
          needs_sources: true,
        },
        answer: "Claim [cite:fixture-chunk]",
      }),
    ),
    "waiting_user",
  );
  assert.throws(() => validateResearchAnswer(t, ""), /EMPTY_RESEARCH_ANSWER/);
  assert.throws(
    () => validateResearchAnswer(t, "Claim [cite:invented]"),
    /INVALID_ANSWER_CITATION/,
  );
  assert.equal(
    checkedResult(state.operations[0], good, catalog).index_version,
    "fixture-v1",
  );
});
test("cancelled tools and late results cannot restart task or consume new model budget", async () => {
  const { state, t, ports } = setup();
  await ports.execute(
    {
      operationId: "1:cancel",
      conversationId: "1",
      tool: "search_papers",
      params: { query: "method" },
      indexVersion: "fixture-v1",
    },
    new AbortController().signal,
  );
  cancel(state, t.id);
  assert.equal(
    acceptResearchResult(
      state,
      "1:cancel",
      "fixture-v1",
      search,
      () => catalog,
    ),
    "discarded",
  );
  await assert.rejects(
    () =>
      ports.execute(
        {
          operationId: "1:new",
          conversationId: "1",
          tool: "search_papers",
          params: { query: "method" },
          indexVersion: "fixture-v1",
        },
        new AbortController().signal,
      ),
    /TASK_CLOSED/,
  );
  assert.equal(state.operations.length, 1);
  assert.equal(t.calls, 0);
});
test("catalog validation strips extra fields and enforces immutable source identities", () => {
  const v = validateCatalog({
    ...catalog,
    private: "not retained",
    papers: catalog.papers.map((p) => ({ ...p, full_text: "not retained" })),
  });
  assert.equal(JSON.stringify(v).includes("not retained"), false);
  assert.deepEqual(
    validateCatalog(JSON.parse(catalogPages(v).join(""))),
    catalog,
  );
  assert.throws(
    () =>
      validateCatalog({
        ...catalog,
        evidence: [...catalog.evidence, ...catalog.evidence],
      }),
    /INVALID_CATALOG/,
  );
  assert.throws(
    () =>
      validateCatalog({
        ...catalog,
        evidence: [{ ...catalog.evidence[0], index_version: "wrong" }],
      }),
    /INVALID_CATALOG/,
  );
});
test("separate owners cannot access each other's session ports and retries preserve budgets", async () => {
  const a = setup(),
    b = setup();
  b.t.sessionId = "2";
  await assert.rejects(
    () =>
      b.ports.execute(
        {
          operationId: "1:x",
          conversationId: "1",
          tool: "search_papers",
          params: { query: "q" },
          indexVersion: "fixture-v1",
        },
        new AbortController().signal,
      ),
    /UNKNOWN_RESEARCH_SESSION/,
  );
  for (let i = 0; i < 6; i++) reserve(a.state, a.t, 10, 10);
  const restored = JSON.parse(JSON.stringify(a.state));
  assert.throws(
    () => reserve(restored, restored.tasks[0], 10, 10),
    /MODEL_BUDGET/,
  );
  assert.equal(b.state.usage.requests, 0);
});
