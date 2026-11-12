import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ResearchBatches } from "../src/research-batches.ts";
import { ProactiveResearch } from "../src/proactive-research.ts";
import { LibraryJobs } from "../src/library-jobs.ts";
import { Artifacts } from "../src/artifacts.ts";
import { Workspace } from "../src/workspace.ts";
import { StateRepository, type StateStorage } from "../src/state-store.ts";
import {
  reserve,
  settle,
  type Plan,
  type Paper,
  type Task,
} from "../src/domain.ts";
import type { ResearchCatalog } from "../src/research-catalog.ts";
import type { Chunk } from "../packages/research/core.ts";
function fixture(count = 2, maxPapers = 3) {
  const db = new DatabaseSync(":memory:");
  let depth = 0;
  const storage: StateStorage = {
    sql: {
      exec<T>(q: string, ...b: any[]) {
        const st = db.prepare(q),
          rows = st.columns().length
            ? (st.all(...b) as T[])
            : (st.run(...b), [] as T[]);
        return { toArray: () => rows };
      },
    },
    transactionSync(fn) {
      if (depth) return fn();
      db.exec("BEGIN");
      depth++;
      try {
        const v = fn();
        db.exec("COMMIT");
        return v;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      } finally {
        depth--;
      }
    },
  };
  const repo = new StateRepository(storage),
    state = repo.load(),
    workspace = new Workspace(storage);
  workspace.migrate(state);
  const batches = new ResearchBatches(storage),
    imports = new LibraryJobs(storage),
    artifacts = new Artifacts(storage);
  const plan: Plan = {
    id: "topic",
    query: "agents",
    objective: "Verify evidence",
    projectId: "default",
    enabled: true,
    autoProcess: true,
    maxPapers,
    revision: 1,
    cursor: 1000,
    next: 0,
  };
  state.plans.push(plan);
  const batch = batches.start(plan, 2000);
  const papers: Paper[] = Array.from({ length: count }, (_, i) => ({
    id: "2601." + String(i + 1).padStart(5, "0"),
    version: "v1",
    title: "Study " + String.fromCharCode(65 + i),
    summary: "Source-based research",
    published: "2026-01-01",
    updated: "2026-01-02",
    url: "https://arxiv.org/abs/2601." + String(i + 1).padStart(5, "0") + "v1",
  }));
  batches.commit(plan, batch.id, 0, papers, true);
  let catalog: ResearchCatalog | undefined;
  const deleted = new Set<string>();
  const host = new ProactiveResearch({
    state: () => state,
    batches,
    imports,
    artifacts,
    workspace,
    catalog: () => catalog,
    save: () => repo.save(state),
    deletedConversation: (id) => deleted.has(id),
  });
  const select = () => {
    host.tick();
    const t = state.tasks.at(-1)!;
    reserve(state, t, 100, 40);
    settle(state, 100, 40, { input: 90, output: 30 });
    host.finishControl(
      t,
      JSON.stringify({
        decisions: t.proactive!.candidateIds.map((id) => ({
          source: batches.candidate(id).source,
          relevant: true,
          priority: 2,
          reason: "Matches the research goal",
        })),
      }),
    );
    return t;
  };
  const publishNext = () => {
    host.tick();
    const jobs = imports.dispatch("node");
    assert.equal(jobs.length, 1);
    imports.receive("node", {
      id: jobs[0].id,
      generation: jobs[0].generation,
      phase: "published",
      paperId: jobs[0].arxivId,
      indexVersion: "index",
    });
    catalog = {
      indexVersion: "index",
      papers: papers.map((p) => ({
        paper_id: p.id + p.version,
        title: p.title,
        abstract: p.summary,
      })),
      evidence: [],
    };
    host.tick();
  };
  const read = (t: Task) => {
    const chunks: Chunk[] = t.proactive!.selectedIds.map((id, i) => ({
      paper_id: batches.candidate(id).source,
      chunk_id: "evidence-" + i,
      index_version: "index",
      section: "Methods",
      start: 0,
      end: 20,
      text: "Evidence is checked.",
      paragraph_id: "paragraph-" + i,
    }));
    t.researchEvidence = chunks;
    t.status = "completed";
    t.answer =
      "The studies check source evidence. " +
      chunks.map((c) => "[cite:" + c.chunk_id + "]").join(" ");
    host.afterReading(t);
    return chunks;
  };
  const assess = (t: Task, important = true) => {
    const findings = t.proactive!.selectedIds.map((id, i) => ({
      source: batches.candidate(id).source,
      important,
      change: "Evidence is checked.",
      impact: "This supports source-based research.",
      citations: ["evidence-" + i],
      openQuestions: ["Generalization remains unverified."],
    }));
    reserve(state, t, 100, 40);
    settle(state, 100, 40, { input: 90, output: 30 });
    host.finishControl(t, JSON.stringify({ findings }));
  };
  return {
    db,
    storage,
    repo,
    state,
    deleted,
    workspace,
    batches,
    imports,
    artifacts,
    plan,
    batch,
    host,
    select,
    publishNext,
    read,
    assess,
  };
}
test("one background task retains identity and budget from selection through serial imports and evidence-backed brief", () => {
  const f = fixture();
  try {
    const t = f.select(),
      id = t.id;
    assert.equal(t.proactive!.stage, "imports");
    assert.equal(t.status, "waiting_device");
    for (let i = 0; i < 30; i++) f.host.tick();
    assert.equal(t.calls, 1);
    assert.equal(
      f.imports.page().items.length,
      1,
      "only one heavy import is admitted at a time",
    );
    f.publishNext();
    f.publishNext();
    assert.equal(t.proactive!.stage, "research");
    assert.equal(t.id, id);
    assert.equal(t.calls, 1);
    f.read(t);
    assert.equal(t.proactive!.stage, "assess");
    assert.equal(
      t.status,
      "queued",
      "reading completion is not complete before impact assessment",
    );
    f.assess(t);
    assert.equal(t.status, "completed");
    assert.equal(t.id, id);
    assert.equal(t.calls, 2);
    assert.equal(f.state.tasks.length, 1);
    assert.equal(f.state.notices.length, 1);
    assert.equal(f.artifacts.list().items.length, 2);
    for (let i = 0; i < 50; i++) f.host.finishControl(t, "{}");
    assert.equal(f.state.notices.length, 1);
    assert.equal(f.artifacts.list().items.length, 2);
    assert.equal(f.batches.get(f.batch.id).status, "completed");
    assert.equal(f.batches.counts(f.batch.id).analyzed, 2);
  } finally {
    f.db.close();
  }
});
test("no material change is recorded without sending inbox or desktop notifications", () => {
  const f = fixture(1);
  try {
    const t = f.select();
    f.publishNext();
    f.read(t);
    f.assess(t, false);
    assert.equal(t.status, "completed");
    assert.equal(f.state.notices.length, 0);
    assert.equal(f.artifacts.list().items.length, 2);
  } finally {
    f.db.close();
  }
});
test("incomplete selection and forged or cross-paper citations cannot schedule or publish research", () => {
  const f = fixture();
  try {
    f.host.tick();
    const t = f.state.tasks[0];
    f.host.finishControl(t, JSON.stringify({ decisions: [] }));
    assert.equal(t.status, "waiting_user");
    assert.equal(f.imports.page().items.length, 0);
    t.status = "queued";
    f.host.finishControl(
      t,
      JSON.stringify({
        decisions: t.proactive!.candidateIds.map((id) => ({
          source: f.batches.candidate(id).source,
          relevant: true,
          priority: 1,
          reason: "Relevant",
        })),
      }),
    );
    f.publishNext();
    f.publishNext();
    f.read(t);
    f.host.finishControl(
      t,
      JSON.stringify({
        findings: t.proactive!.selectedIds.map((id) => ({
          source: f.batches.candidate(id).source,
          important: true,
          change: "Finding",
          impact: "Impact",
          citations: ["forged"],
          openQuestions: [],
        })),
      }),
    );
    assert.equal(t.status, "waiting_user");
    assert.equal(f.state.notices.length, 0);
    assert.equal(
      f.artifacts.list().items.filter((a) => a.kind === "brief").length,
      0,
    );
  } finally {
    f.db.close();
  }
});
test("a plan pause stops new steps and resuming never clears spent counters or overrides an independent user pause", () => {
  const f = fixture(1);
  try {
    const t = f.select();
    f.plan.enabled = false;
    f.host.tick();
    assert.equal(t.status, "paused");
    assert.equal(f.imports.page().items.length, 0);
    f.plan.enabled = true;
    f.host.tick();
    assert.equal(t.calls, 1);
    assert.equal(t.proactive!.stage, "imports");
    assert.equal(f.imports.page().items.length, 1);
    t.pauseRequested = true;
    t.status = "paused";
    t.proactive!.planPaused = false;
    f.plan.enabled = false;
    f.host.tick();
    f.plan.enabled = true;
    f.host.tick();
    assert.equal(t.status, "paused");
  } finally {
    f.db.close();
  }
});
test("unprocessed candidates survive a quiet daily discovery and cannot duplicate papers already analyzed", () => {
  const f = fixture(3, 1);
  try {
    const t = f.select();
    f.publishNext();
    f.read(t);
    f.assess(t);
    assert.equal(f.batches.backlogCount(f.plan.id, 1), 2);
    const next = f.batches.start(f.plan, 86402000);
    f.batches.commit(f.plan, next.id, 0, [], true);
    assert.equal(f.batches.get(next.id).status, "screening");
    f.host.tick();
    assert.equal(f.state.tasks.length, 2);
    const follow = f.state.tasks[1];
    assert.equal(follow.proactive!.candidateIds.length, 2);
    assert.ok(
      follow.proactive!.candidateIds.every(
        (id) => !t.proactive!.selectedIds.includes(id),
      ),
    );
  } finally {
    f.db.close();
  }
});
test("a missing body cannot be called deep reading and long-goal budget exhaustion preserves partial research", () => {
  const f = fixture(1);
  try {
    const t = f.select();
    f.publishNext();
    t.status = "completed";
    t.answer = "Only a catalog title";
    f.host.afterReading(t);
    assert.equal(t.status, "queued");
    assert.equal(t.proactive!.stage, "research");
    assert.match(t.workflow!.warnings.at(-1)!, /正文证据/);
    t.calls = 24;
    t.goal!.segments = Array.from({ length: 4 }, (_, i) => ({
      index: i + 1,
      started: 0,
      calls: i * 6,
      tools: 0,
      activeMs: 0,
    }));
    f.read(t);
    assert.equal(t.status, "paused");
    assert.equal(t.error, "GOAL_BUDGET");
    assert.equal(t.calls, 24);
    f.host.tick();
    assert.equal(f.state.tasks.length, 1);
  } finally {
    f.db.close();
  }
});
test("cancel while a plan is paused closes owned imports and deletion clears derived summaries without replay", () => {
  const f = fixture(1);
  try {
    const t = f.select();
    f.host.tick();
    f.plan.enabled = false;
    t.status = "cancelled";
    f.host.cancel(t);
    assert.equal(f.imports.page().items[0].status, "cancelled");
    assert.equal(f.batches.counts(f.batch.id).cancelled, 1);
    f.batches.clearResearch(t.conversationId!);
    assert.equal(f.batches.get(f.batch.id).error, "RESEARCH_DELETED");
    f.plan.enabled = true;
    f.state.tasks = [];
    f.host.tick();
    assert.equal(f.state.tasks.length, 0);
  } finally {
    f.db.close();
  }
});
test("daily budget waiting cannot be evaded by later batches creating another task for the same topic", () => {
  const f = fixture(1);
  try {
    const t = f.select();
    t.status = "waiting_user";
    t.error = "BACKGROUND_DAILY_BUDGET";
    const next = f.batches.start(f.plan, 86402000);
    f.batches.commit(
      f.plan,
      next.id,
      0,
      [
        {
          id: "2601.99999",
          version: "v1",
          title: "Later study",
          summary: "s",
          published: "2026-01-01",
          updated: "2026-01-02",
          url: "https://arxiv.org/abs/2601.99999v1",
        },
      ],
      true,
    );
    for (let i = 0; i < 20; i++) f.host.tick();
    assert.equal(f.state.tasks.length, 1);
    assert.equal(t.calls, 1);
  } finally {
    f.db.close();
  }
});

test("completed research is unchanged by cancellation and a deletion request immediately blocks admission", () => {
  const f = fixture(1);
  try {
    const t = f.select();
    f.publishNext();
    f.read(t);
    f.assess(t);
    const batch = f.batches.get(f.batch.id),
      candidates = f.batches.candidates(batch.id);
    f.host.cancel(t);
    assert.deepEqual(f.batches.get(batch.id), batch);
    assert.deepEqual(f.batches.candidates(batch.id), candidates);
    assert.equal(f.host.allowedBatch(batch.id), true);
    f.deleted.add(t.conversationId!);
    assert.equal(f.host.allowedBatch(batch.id), false);
    assert.equal(f.host.allowedBatch("deleted-batch"), false);
  } finally {
    f.db.close();
  }
});
test("multibyte control projections remain bounded and preserve evidence for each selected paper", () => {
  const f = fixture(20, 3);
  try {
    f.plan.query = "研".repeat(300);
    f.plan.objective = "研".repeat(2000);
    for (const c of f.batches.candidates(f.batch.id).items) {
      c.paper.title = "研".repeat(2000);
      c.paper.summary = "研".repeat(20000);
      f.db
        .prepare("UPDATE pra_research_candidates SET value=? WHERE id=?")
        .run(JSON.stringify(c), c.id);
    }
    f.host.tick();
    const t = f.state.tasks[0];
    const memory = Array.from({ length: 10 }, () => ({
      content: "研".repeat(400),
    }));
    assert.ok(Buffer.byteLength(f.host.prompt(t, memory)) < 45000);
    f.host.finishControl(
      t,
      JSON.stringify({
        decisions: t.proactive!.candidateIds.map((id) => ({
          source: f.batches.candidate(id).source,
          relevant: true,
          priority: 1,
          reason: "相关",
        })),
      }),
    );
    f.publishNext();
    f.publishNext();
    f.publishNext();
    f.read(t);
    t.proactive!.readingAnswer = "研".repeat(20000);
    t.proactive!.gaps = Array(10).fill("研".repeat(2000));
    const seeds = t.researchEvidence!;
    t.researchEvidence = seeds.flatMap((seed, i) =>
      Array.from({ length: 6 }, (_, j) => ({
        ...seed,
        chunk_id: seed.chunk_id + "-" + j,
        text: "研".repeat(1000),
      })),
    );
    const prompt = f.host.prompt(t, memory),
      projection = JSON.parse(prompt);
    assert.ok(Buffer.byteLength(prompt) < 45000);
    assert.equal(
      new Set(projection.evidence.map((e: Chunk) => e.paper_id)).size,
      3,
    );
    assert.ok(Buffer.byteLength(JSON.stringify(projection.evidence)) < 18100);
  } finally {
    f.db.close();
  }
});

test("user task pause also prevents queued import dispatch and assessment admission", () => {
  const f = fixture(1);
  try {
    const t = f.select();
    f.host.tick();
    t.pauseRequested = true;
    t.status = "paused";
    assert.equal(
      f.imports.dispatch("node", Date.now(), (job) =>
        f.host.allowedImport(job.batchId),
      ).length,
      0,
    );
    t.pauseRequested = false;
    t.status = "waiting_device";
    f.publishNext();
    t.pauseRequested = true;
    f.read(t);
    assert.equal(t.proactive!.stage, "assess");
    assert.equal(t.status, "paused");
    assert.equal(f.host.allowedImport(f.batch.id), false);
  } finally {
    f.db.close();
  }
});

test("twenty daily budget waits retry only after Shanghai rollover, retain the same allowance and survive restoration", () => {
  const f = fixture(1);
  try {
    const t = f.select();
    t.proactive!.stage = "select";
    const calls = t.calls,
      taskId = t.id;
    for (let i = 0; i < 20; i++) {
      const at = Date.parse("2026-11-01T12:00:00+08:00") + i * 86400000;
      t.status = "waiting_user";
      t.error = "BACKGROUND_DAILY_BUDGET";
      t.updated = at;
      f.host.budgetWait(t, at);
      const wake = f.host.nextBudgetWake()!;
      for (let n = 0; n < 5; n++) f.host.tick(at + n * 1000);
      assert.equal(t.status, "waiting_user");
      assert.equal(t.calls, calls);
      assert.ok(wake > at);
      f.repo.save(f.state);
      const restored = f.repo.load().tasks.find((x) => x.id === taskId)!;
      assert.equal(restored.proactive!.budgetResumeAt, wake);
      f.host.tick(wake);
      assert.equal(t.status, "queued");
      assert.equal(t.id, taskId);
      assert.equal(t.calls, calls);
      assert.equal(f.host.nextBudgetWake(), undefined);
    }
  } finally {
    f.db.close();
  }
});
test("monthly limits wait for the month, while user pauses and price-review blocks never resume automatically", () => {
  const f = fixture(1);
  try {
    const t = f.select();
    t.proactive!.stage = "select";
    const at = Date.parse("2026-11-12T12:00:00+08:00"),
      december = Date.parse("2026-12-01T00:00:00+08:00");
    t.status = "waiting_user";
    t.error = "BACKGROUND_BUDGET";
    t.updated = at;
    f.host.budgetWait(t, at);
    assert.equal(f.host.nextBudgetWake(), december);
    f.host.tick(at + 86400000);
    assert.equal(t.status, "waiting_user");
    t.pauseRequested = true;
    t.status = "paused";
    f.host.tick(december);
    assert.equal(t.status, "paused");
    assert.equal(f.host.nextBudgetWake(), undefined);
    t.pauseRequested = false;
    t.status = "waiting_user";
    f.host.tick(december);
    assert.equal(t.status, "queued");
    t.status = "waiting_user";
    t.error = "PRICE_REVIEW_REQUIRED";
    f.host.budgetWait(t, at);
    f.host.tick(december);
    assert.equal(t.status, "waiting_user");
    assert.equal(f.host.nextBudgetWake(), undefined);
  } finally {
    f.db.close();
  }
});
test("resuming a plan does not trigger a budget retry inside the blocked period", () => {
  const f = fixture(1);
  try {
    const t = f.select();
    t.proactive!.stage = "select";
    const now = Date.now();
    t.status = "waiting_user";
    t.error = "BACKGROUND_DAILY_BUDGET";
    t.updated = now;
    f.host.budgetWait(t, now);
    f.plan.enabled = false;
    f.host.tick(now);
    assert.equal(t.status, "paused");
    f.plan.enabled = true;
    f.host.tick(now + 1000);
    assert.equal(t.status, "waiting_user");
    assert.equal(t.pauseRequested, false);
    assert.equal(t.calls, 1);
    assert.ok(f.host.nextBudgetWake()! > now);
  } finally {
    f.db.close();
  }
});

test("automatic budget renewal cannot erase cumulative long-goal exhaustion", () => {
  const f = fixture(1);
  try {
    const t = f.select();
    t.proactive!.stage = "select";
    t.calls = 24;
    t.activeMs = 720000;
    t.status = "waiting_user";
    t.error = "MONTHLY_BUDGET";
    const at = Date.parse("2026-12-31T23:59:59+08:00");
    f.host.budgetWait(t, at);
    assert.equal(f.host.nextBudgetWake(), Date.parse("2027-01-01T00:00:00+08:00"));
    f.host.tick(at + 1000);
    assert.equal(t.error, "GOAL_BUDGET");
    assert.equal(t.status, "paused");
    assert.equal(t.calls, 24);
    assert.equal(t.activeMs, 720000);
    assert.equal(f.host.nextBudgetWake(), undefined);
  } finally { f.db.close(); }
});

test("replaying proactive completion respects deleted reading and brief records without a persistence retry loop",()=>{
 const f=fixture();
 try{
  const task=f.select();f.publishNext();f.publishNext();f.read(task);
  const reading=f.artifacts.list().items.find(a=>a.kind==="reading")!;
  f.assess(task);const brief=f.artifacts.list().items.find(a=>a.kind==="brief")!;
  f.artifacts.delete(reading.id);f.artifacts.delete(brief.id);
  f.state.notices=f.state.notices.filter(n=>n.artifactId!==brief.id);
  task.proactive!.stage="research";task.status="completed";
  for(const id of task.proactive!.selectedIds)f.batches.updateCandidate(id,{phase:"reading"});
  f.batches.update(f.batch.id,{status:"processing"});
  f.read(task);assert.equal(task.proactive!.stage,"assess");
  f.assess(task);
  assert.equal(task.status,"completed");assert.equal(task.proactive!.stage,"done");
  assert.equal(f.artifacts.list().items.length,0);assert.equal(f.state.notices.length,0);
  assert.equal(f.batches.get(f.batch.id).artifactId,undefined);
 }finally{f.db.close();}
});
