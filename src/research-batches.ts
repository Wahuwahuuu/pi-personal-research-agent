import {
  Problem,
  text,
  startBatch,
  nextShanghaiMorning,
  type Plan,
  type Paper,
} from "./domain.ts";
import type { StateStorage } from "./state-store.ts";
import { arxivVersion } from "../packages/research/source-links.ts";
export type BatchStatus =
  | "discovering"
  | "metadata_only"
  | "screening"
  | "processing"
  | "summarizing"
  | "waiting_user"
  | "completed";
export interface ResearchBatch {
  id: string;
  planId: string;
  projectId: string;
  revision: number;
  query: string;
  objective: string;
  autoProcess: boolean;
  maxPapers: number;
  from: number;
  until: number;
  offset: number;
  sourceProtocol?: "arxiv-updated-desc-v1";
  discovered: number;
  status: BatchStatus;
  created: number;
  updated: number;
  error?: string;
  conversationId?: string;
  screenTaskId?: string;
  summaryTaskId?: string;
  artifactId?: string;
  taskId?: string;
  selectedIds?: string[];
  coverageGaps?: string[];
}
export type CandidatePhase =
  | "discovered"
  | "selected"
  | "skipped"
  | "importing"
  | "ready"
  | "reading"
  | "analyzed"
  | "failed"
  | "cancelled";
export interface ResearchCandidate {
  id: string;
  batchId: string;
  source: string;
  paper: Paper;
  phase: CandidatePhase;
  reason: string;
  updated: number;
  importId?: string;
  taskId?: string;
  important?: boolean;
  analysisSummary?: string;
  citations?: string[];
}
const read = <T>(r: { value: string } | undefined): T | undefined =>
  r ? JSON.parse(r.value) : undefined;
/** Per-topic discovery checkpoints are independent from import and analysis progress. */
export class ResearchBatches {
  readonly db: StateStorage;
  constructor(db: StateStorage) {
    this.db = db;
    db.sql.exec(
      "CREATE TABLE IF NOT EXISTS pra_research_batches(id TEXT PRIMARY KEY,plan_id TEXT NOT NULL,project_id TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,value TEXT NOT NULL)",
    );
    db.sql.exec(
      "CREATE INDEX IF NOT EXISTS pra_research_batches_plan ON pra_research_batches(plan_id,created)",
    );
    db.sql.exec(
      "CREATE INDEX IF NOT EXISTS pra_research_batches_status ON pra_research_batches(status,created)",
    );
    db.sql.exec(
      "CREATE TABLE IF NOT EXISTS pra_research_candidates(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,plan_id TEXT NOT NULL,revision INTEGER NOT NULL,source TEXT NOT NULL,phase TEXT NOT NULL,value TEXT NOT NULL,UNIQUE(plan_id,revision,source))",
    );
    db.sql.exec(
      "CREATE INDEX IF NOT EXISTS pra_research_candidates_batch ON pra_research_candidates(batch_id,phase,id)",
    );
    db.sql.exec(
      "CREATE TABLE IF NOT EXISTS pra_research_batch_tombstones(id TEXT PRIMARY KEY)",
    );
    db.sql.exec(
      "CREATE TABLE IF NOT EXISTS pra_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,created INTEGER NOT NULL,value TEXT NOT NULL)",
    );
  }
  private changed(id: string, deleted = false) {
    this.db.sql.exec(
      "INSERT INTO pra_changes(created,value) VALUES(?,?)",
      Date.now(),
      JSON.stringify([
        {
          entity: "research_batches",
          id,
          ...(deleted ? { deleted: true } : {}),
        },
      ]),
    );
  }
  get(id: string): ResearchBatch {
    const result = read<ResearchBatch>(
      this.db.sql
        .exec<{ value: string }>(
          "SELECT value FROM pra_research_batches WHERE id=?",
          id,
        )
        .toArray()[0],
    );
    if (!result) throw new Problem("NOT_FOUND", 404);
    return result;
  }
  private put(b: ResearchBatch) {
    this.db.sql.exec(
      "INSERT INTO pra_research_batches VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,value=excluded.value",
      b.id,
      b.planId,
      b.projectId,
      b.status,
      b.created,
      JSON.stringify(b),
    );
  }
  start(plan: Plan, now = Date.now()) {
    const checkpoint = startBatch(plan, now),
      revision = plan.revision ?? 1,
      id = plan.id + ":" + revision + ":" + checkpoint.until;
    if (
      this.db.sql
        .exec("SELECT id FROM pra_research_batch_tombstones WHERE id=?", id)
        .toArray().length
    )
      throw new Problem("BATCH_DELETED", 410);
    const old = read<ResearchBatch>(
      this.db.sql
        .exec<{ value: string }>(
          "SELECT value FROM pra_research_batches WHERE id=?",
          id,
        )
        .toArray()[0],
    );
    if (old) {
      if (
        old.status === "discovering" &&
        old.sourceProtocol !== "arxiv-updated-desc-v1"
      ) {
        old.offset = 0;
        old.sourceProtocol = "arxiv-updated-desc-v1";
        old.updated = now;
        checkpoint.offset = 0;
        this.db.transactionSync(() => {
          this.put(old);
          this.changed(old.id);
        });
      }
      return old;
    }
    // An in-flight legacy metadata scan has no per-topic membership journal. Re-scan its bounded window.
    if (checkpoint.offset) {
      checkpoint.offset = 0;
      checkpoint.count = 0;
    }
    const b: ResearchBatch = {
      id,
      planId: plan.id,
      projectId: plan.projectId ?? "default",
      revision,
      query: plan.query,
      objective: plan.objective ?? plan.query,
      autoProcess: plan.autoProcess === true,
      maxPapers: plan.maxPapers ?? 3,
      from: checkpoint.from,
      until: checkpoint.until,
      offset: checkpoint.offset,
      sourceProtocol: "arxiv-updated-desc-v1",
      discovered: 0,
      status: "discovering",
      created: now,
      updated: now,
    };
    this.db.transactionSync(() => {
      this.put(b);
      this.changed(b.id);
    });
    return b;
  }
  commit(
    plan: Plan,
    batchId: string,
    offset: number,
    rows: Paper[],
    complete: boolean,
    now = Date.now(),
    nextOffset = offset + rows.length,
  ) {
    const batch = this.get(batchId);
    if (
      !plan.batch ||
      batch.planId !== plan.id ||
      batch.revision !== (plan.revision ?? 1) ||
      batch.until !== plan.batch.until
    )
      throw new Problem("STALE_DISCOVERY_PAGE", 409);
    if (offset < batch.offset) return false;
    if (
      batch.status !== "discovering" ||
      offset !== batch.offset ||
      rows.length > 200 ||
      !Number.isInteger(nextOffset) ||
      nextOffset < offset + rows.length ||
      nextOffset > offset + 200 ||
      (!complete && nextOffset <= offset) ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new Problem("INVALID_DISCOVERY_PAGE");
    for (const p of rows) {
      const source = p.id + p.version;
      if (
        arxivVersion(source) !== source ||
        p.url !== "https://arxiv.org/abs/" + source ||
        !Number.isFinite(Date.parse(p.updated)) ||
        !Number.isFinite(Date.parse(p.published))
      )
        throw new Problem("INVALID_DISCOVERY_SOURCE");
      text(p.title, 2000);
      if (typeof p.summary !== "string" || p.summary.length > 20000)
        throw new Problem("INVALID_DISCOVERY_SUMMARY");
    }
    const saved = structuredClone(plan);
    try {
      return this.db.transactionSync(() => {
        const total = this.db.sql
          .exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM pra_research_candidates",
          )
          .toArray()[0].n;
        let added = 0;
        for (const paper of rows) {
          const source = paper.id + paper.version;
          if (
            this.db.sql
              .exec(
                "SELECT id FROM pra_research_candidates WHERE plan_id=? AND revision=? AND source=?",
                plan.id,
                batch.revision,
                source,
              )
              .toArray().length
          )
            continue;
          if (total + added >= 10000)
            throw new Problem("DISCOVERY_CAPACITY", 429);
          const candidate: ResearchCandidate = {
            id: batch.id + "@" + source,
            batchId: batch.id,
            source,
            paper,
            phase: "discovered",
            reason: "",
            updated: now,
          };
          this.db.sql.exec(
            "INSERT INTO pra_research_candidates VALUES(?,?,?,?,?,?,?)",
            candidate.id,
            batch.id,
            plan.id,
            batch.revision,
            source,
            candidate.phase,
            JSON.stringify(candidate),
          );
          added++;
        }
        batch.offset = nextOffset;
        batch.discovered += added;
        batch.updated = now;
        delete batch.error;
        plan.batch!.offset = batch.offset;
        plan.batch!.count = batch.discovered;
        delete plan.sourceError;
        if (complete) {
          batch.status =
            batch.discovered ||
            (batch.autoProcess && this.backlogCount(plan.id, batch.revision))
              ? batch.autoProcess
                ? "screening"
                : "metadata_only"
              : "completed";
          plan.cursor = batch.until;
          plan.next = nextShanghaiMorning(now);
          plan.latestBatchId = batch.id;
          plan.lastSuccess = now;
          delete plan.batch;
        } else plan.next = now + 3000;
        this.put(batch);
        this.changed(batch.id);
        return true;
      });
    } catch (e) {
      for (const key of Object.keys(plan)) delete (plan as any)[key];
      Object.assign(plan, saved);
      throw e;
    }
  }
  sourceFailure(plan: Plan, batchId: string, code: string, now = Date.now()) {
    const b = this.get(batchId);
    b.error = code;
    b.updated = now;
    plan.sourceError = code;
    plan.next = now + 15 * 60000;
    this.db.transactionSync(() => {
      this.put(b);
      this.changed(b.id);
    });
  }
  page(planId?: string, after = 0, limit = 20) {
    this.pageArgs(after, limit);
    const rows = this.db.sql
      .exec<{ value: string }>(
        "SELECT value FROM pra_research_batches " +
          (planId ? "WHERE plan_id=? " : "") +
          "ORDER BY created DESC,id LIMIT ? OFFSET ?",
        ...(planId ? [planId] : []),
        limit + 1,
        after,
      )
      .toArray();
    return {
      items: rows.slice(0, limit).map((r) => ({
        ...read<ResearchBatch>(r)!,
        counts: this.counts(read<ResearchBatch>(r)!.id),
      })),
      nextCursor: rows.length > limit ? after + limit : null,
    };
  }
  candidates(id: string, after = 0, limit = 100) {
    this.get(id);
    this.pageArgs(after, limit);
    const rows = this.db.sql
      .exec<{ value: string }>(
        "SELECT value FROM pra_research_candidates WHERE batch_id=? ORDER BY id LIMIT ? OFFSET ?",
        id,
        limit + 1,
        after,
      )
      .toArray();
    return {
      items: rows.slice(0, limit).map((r) => read<ResearchCandidate>(r)!),
      nextCursor: rows.length > limit ? after + limit : null,
    };
  }
  counts(id: string) {
    return Object.fromEntries(
      this.db.sql
        .exec<{ phase: string; n: number }>(
          "SELECT phase,COUNT(*) AS n FROM pra_research_candidates WHERE batch_id=? GROUP BY phase",
          id,
        )
        .toArray()
        .map((r) => [r.phase, r.n]),
    );
  }
  private pageArgs(after: number, limit: number) {
    if (
      !Number.isInteger(after) ||
      after < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200
    )
      throw new Problem("INVALID_PAGE");
  }
  update(
    id: string,
    patch: Partial<
      Pick<
        ResearchBatch,
        | "status"
        | "error"
        | "conversationId"
        | "screenTaskId"
        | "summaryTaskId"
        | "artifactId"
        | "taskId"
        | "selectedIds"
        | "coverageGaps"
      >
    >,
    now = Date.now(),
  ) {
    const old = this.get(id),
      b = { ...old, ...patch };
    if (JSON.stringify(b) === JSON.stringify(old)) return old;
    b.updated = now;
    this.db.transactionSync(() => {
      this.put(b);
      this.changed(id);
    });
    return b;
  }
  candidate(id: string) {
    const r = read<ResearchCandidate>(
      this.db.sql
        .exec<{ value: string }>(
          "SELECT value FROM pra_research_candidates WHERE id=?",
          id,
        )
        .toArray()[0],
    );
    if (!r) throw new Problem("NOT_FOUND", 404);
    return r;
  }
  updateCandidate(
    id: string,
    patch: Partial<
      Pick<
        ResearchCandidate,
        | "phase"
        | "reason"
        | "importId"
        | "taskId"
        | "important"
        | "analysisSummary"
        | "citations"
      >
    >,
    now = Date.now(),
  ) {
    const old = this.candidate(id),
      value = { ...old, ...patch };
    if (JSON.stringify(old) === JSON.stringify(value)) return old;
    value.updated = now;
    this.db.transactionSync(() => {
      this.db.sql.exec(
        "UPDATE pra_research_candidates SET phase=?,value=? WHERE id=?",
        value.phase,
        JSON.stringify(value),
        id,
      );
      this.changed(value.batchId);
    });
    return value;
  }
  pending(limit = 20) {
    this.pageArgs(0, limit);
    return this.db.sql
      .exec<{ value: string }>(
        "SELECT value FROM pra_research_batches WHERE status IN ('screening','processing','summarizing','waiting_user') ORDER BY created,id LIMIT ?",
        limit,
      )
      .toArray()
      .map((r) => read<ResearchBatch>(r)!);
  }
  backlog(planId: string, revision: number, limit = 20) {
    this.pageArgs(0, limit);
    return this.db.sql
      .exec<{ value: string }>(
        "SELECT c.value FROM pra_research_candidates c JOIN pra_research_batches b ON b.id=c.batch_id WHERE c.plan_id=? AND c.revision=? AND c.phase='discovered' ORDER BY b.created,c.id LIMIT ?",
        planId,
        revision,
        limit,
      )
      .toArray()
      .map((r) => read<ResearchCandidate>(r)!);
  }
  backlogCount(planId: string, revision: number) {
    return this.db.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM pra_research_candidates WHERE plan_id=? AND revision=? AND phase='discovered'",
        planId,
        revision,
      )
      .toArray()[0].n;
  }
  clearResearch(conversationId: string) {
    const batches = this.db.sql
      .exec<{ value: string }>(
        "SELECT value FROM pra_research_batches WHERE json_extract(value,'$.conversationId')=?",
        conversationId,
      )
      .toArray()
      .map((r) => read<ResearchBatch>(r)!);
    for (const b of batches) {
      for (const {id} of this.db.sql.exec<{id:string}>("SELECT id FROM pra_research_candidates WHERE batch_id=?",b.id).toArray()) {
        this.updateCandidate(id, {
          phase: "cancelled",
          reason: "研究会话已删除",
          taskId: undefined,
          analysisSummary: undefined,
          citations: undefined,
          important: undefined,
        });
      }
      this.update(b.id, {
        status: "completed",
        error: "RESEARCH_DELETED",
        taskId: undefined,
        screenTaskId: undefined,
        summaryTaskId: undefined,
        conversationId: undefined,
        artifactId: undefined,
        selectedIds: [],
        coverageGaps: [],
      });
    }
    return batches.map(b=>b.id);
  }
  removePlan(planId: string) {
    const batches = this.db.sql
      .exec<{ id: string }>(
        "SELECT id FROM pra_research_batches WHERE plan_id=?",
        planId,
      )
      .toArray()
      .map((r) => r.id);
    return this.db.transactionSync(() => {
      for (const id of batches) {
        this.db.sql.exec(
          "INSERT OR IGNORE INTO pra_research_batch_tombstones VALUES(?)",
          id,
        );
        this.changed(id, true);
      }
      this.db.sql.exec(
        "DELETE FROM pra_research_candidates WHERE plan_id=?",
        planId,
      );
      this.db.sql.exec(
        "DELETE FROM pra_research_batches WHERE plan_id=?",
        planId,
      );
      return batches;
    });
  }
}
