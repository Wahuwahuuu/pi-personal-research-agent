import { Problem, text } from "./domain.ts";
import type { StateStorage } from "./state-store.ts";
import { arxivVersion } from "../packages/research/source-links.ts";
export const importPhases = [
  "queued",
  "acquiring",
  "parsing",
  "indexing",
  "validating",
  "published",
  "failed",
  "cancelled",
] as const;
export interface LibraryJob {
  id: string;
  projectId: string;
  arxivId: string;
  title: string;
  status:
    "queued" | "sent" | "processing" | "published" | "failed" | "cancelled";
  phase: (typeof importPhases)[number];
  created: number;
  updated: number;
  generation: number;
  attempts: number;
  deviceHash: string;
  assignedAt: number;
  paperId: string;
  indexVersion: string;
  contentSha256: string;
  error: string;
  cancelPending: boolean;
  origin: "user" | "schedule";
  batchId: string;
}
const final = (s: string) => ["published", "failed", "cancelled"].includes(s);
/** Separate durable side-effect queue. No model loop, PDF bytes, URLs or local paths enter this protocol. */
export class LibraryJobs {
  readonly db: StateStorage;
  constructor(db: StateStorage) {
    this.db = db;
    db.sql.exec(
      "CREATE TABLE IF NOT EXISTS pra_library_tombstones(id TEXT PRIMARY KEY,generation INTEGER NOT NULL,device_hash TEXT NOT NULL,cancel_pending INTEGER NOT NULL)",
    );
    db.sql.exec(
      "CREATE TABLE IF NOT EXISTS pra_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,created INTEGER NOT NULL,value TEXT NOT NULL)",
    );
    db.sql.exec(
      "CREATE TABLE IF NOT EXISTS pra_library_jobs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,source TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,phase TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,generation INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,device_hash TEXT NOT NULL DEFAULT '',assigned_at INTEGER NOT NULL DEFAULT 0,paper_id TEXT NOT NULL DEFAULT '',index_version TEXT NOT NULL DEFAULT '',content_hash TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',cancel_pending INTEGER NOT NULL DEFAULT 0,origin TEXT NOT NULL,batch_id TEXT NOT NULL,UNIQUE(project_id,source))",
    );
    db.sql.exec(
      "CREATE INDEX IF NOT EXISTS pra_library_jobs_pending ON pra_library_jobs(status,created)",
    );
    db.sql.exec(
      "CREATE TABLE IF NOT EXISTS pra_library_requests(id TEXT PRIMARY KEY,signature TEXT NOT NULL,job_id TEXT NOT NULL)",
    );
  }
  private changed(ids: string[]) {
    if (ids.length)
      this.db.sql.exec(
        "INSERT INTO pra_changes(created,value) VALUES(?,?)",
        Date.now(),
        JSON.stringify(ids.map((id) => ({ entity: "imports", id }))),
      );
  }
  private parse(r: any): LibraryJob {
    return {
      id: r.id,
      projectId: r.project_id,
      arxivId: r.source,
      title: r.title,
      status: r.status,
      phase: r.phase,
      created: r.created,
      updated: r.updated,
      generation: r.generation,
      attempts: r.attempts,
      deviceHash: r.device_hash,
      assignedAt: r.assigned_at,
      paperId: r.paper_id,
      indexVersion: r.index_version,
      contentSha256: r.content_hash,
      error: r.error,
      cancelPending: !!r.cancel_pending,
      origin: r.origin,
      batchId: r.batch_id,
    };
  }
  deleted(id: string) {
    return !!this.db.sql
      .exec("SELECT id FROM pra_library_tombstones WHERE id=?", id)
      .toArray().length;
  }
  removeProject(projectId: string) {
    return this.db.transactionSync(() => {
      const rows = this.db.sql
        .exec<{ id: string; generation: number; device_hash: string }>(
          "SELECT id,generation,device_hash FROM pra_library_jobs WHERE project_id=?",
          projectId,
        )
        .toArray();
      for (const row of rows) {
        this.db.sql.exec(
          "INSERT OR IGNORE INTO pra_library_tombstones VALUES(?,?,?,?)",
          row.id,
          row.generation,
          row.device_hash,
          Number(!!row.device_hash),
        );
        this.db.sql.exec(
          "DELETE FROM pra_library_requests WHERE job_id=?",
          row.id,
        );
      }
      this.db.sql.exec(
        "DELETE FROM pra_library_jobs WHERE project_id=?",
        projectId,
      );
      this.changed(rows.map((r) => r.id));
      return rows.map((r) => r.id);
    });
  }
  get(id: string) {
    const r = this.db.sql
      .exec<any>("SELECT * FROM pra_library_jobs WHERE id=?", id)
      .toArray()[0];
    if (!r) throw new Problem("NOT_FOUND", 404);
    return this.parse(r);
  }
  page(projectId?: string, after = 0, limit = 30) {
    if (
      !Number.isInteger(after) ||
      after < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Problem("INVALID_PAGE");
    const r = this.db.sql
      .exec<any>(
        "SELECT * FROM pra_library_jobs " +
          (projectId ? "WHERE project_id=? " : "") +
          "ORDER BY created DESC,id LIMIT ? OFFSET ?",
        ...(projectId ? [projectId] : []),
        limit + 1,
        after,
      )
      .toArray();
    return {
      pendingCount: this.db.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM pra_library_jobs WHERE status IN ('queued','sent','processing')"+(projectId?" AND project_id=?":""),...(projectId?[projectId]:[])).toArray()[0].n,
      items: r.slice(0, limit).map((v) => this.public(this.parse(v))),
      nextCursor: r.length > limit ? after + limit : null,
    };
  }
  public(job: LibraryJob) {
    const { deviceHash, ...value } = job;
    return value;
  }
  private once(
    requestId: unknown,
    signature: string,
    action: () => LibraryJob,
  ) {
    const id = text(requestId, 128);
    return this.db.transactionSync(() => {
      const prior = this.db.sql
        .exec<{ signature: string; job_id: string }>(
          "SELECT * FROM pra_library_requests WHERE id=?",
          id,
        )
        .toArray()[0];
      if (prior) {
        if (prior.signature !== signature)
          throw new Problem("REQUEST_CONFLICT", 409);
        return this.get(prior.job_id);
      }
      const job = action();
      this.db.sql.exec(
        "INSERT INTO pra_library_requests VALUES(?,?,?)",
        id,
        signature,
        job.id,
      );
      return job;
    });
  }
  create(
    requestId: unknown,
    input: {
      projectId: string;
      arxivId: string;
      title?: string;
      origin?: "user" | "schedule";
      batchId?: string;
    },
    now = Date.now(),
  ) {
    const source = text(input.arxivId, 32),
      project = text(input.projectId, 128),
      title = text(input.title ?? source, 500),
      origin = input.origin ?? "user",
      batchId = input.batchId ?? "";
    if (
      arxivVersion(source) !== source ||
      !["user", "schedule"].includes(origin) ||
      batchId.length > 128
    )
      throw new Problem("VERSIONED_ARXIV_ID_REQUIRED");
    return this.once(
      requestId,
      JSON.stringify(["create", project, source, title, origin, batchId]),
      () => {
        const prior = this.db.sql
          .exec<{ id: string }>(
            "SELECT id FROM pra_library_jobs WHERE project_id=? AND source=?",
            project,
            source,
          )
          .toArray()[0];
        if (prior) return this.get(prior.id);
        if (
          (this.db.sql
            .exec<{ n: number }>(
              "SELECT COUNT(*) n FROM pra_library_jobs WHERE status NOT IN ('published','failed','cancelled')",
            )
            .toArray()[0]?.n ?? 0) >= 100
        )
          throw new Problem("IMPORT_QUEUE_FULL", 429);
        const id = crypto.randomUUID();
        this.db.sql.exec(
          "INSERT INTO pra_library_jobs(id,project_id,source,title,status,phase,created,updated,origin,batch_id) VALUES(?,?,?,?,'queued','queued',?,?,?,?)",
          id,
          project,
          source,
          title,
          now,
          now,
          origin,
          batchId,
        );
        this.changed([id]);
        return this.get(id);
      },
    );
  }
  action(
    id: string,
    action: "cancel" | "retry",
    requestId: unknown,
    now = Date.now(),
  ) {
    return this.once(requestId, JSON.stringify([action, id]), () => {
      const job = this.get(id),
        before = JSON.stringify(job);
      if (action === "cancel") {
        if (job.status === "published")
          throw new Problem("IMPORT_ALREADY_PUBLISHED", 409);
        if (job.status !== "cancelled")
          this.db.sql.exec(
            "UPDATE pra_library_jobs SET status='cancelled',phase='cancelled',cancel_pending=?,updated=? WHERE id=?",
            Number(!!job.deviceHash),
            now,
            id,
          );
      } else if (action === "retry") {
        if (job.cancelPending) throw new Problem("LOCAL_CANCEL_PENDING", 409);
        if (!["failed", "cancelled"].includes(job.status))
          throw new Problem("IMPORT_NOT_RETRYABLE", 409);
        this.db.sql.exec(
          "UPDATE pra_library_jobs SET status='queued',phase='queued',generation=generation+1,attempts=0,device_hash='',assigned_at=0,error='',updated=? WHERE id=?",
          now,
          id,
        );
      } else throw new Problem("ACTION_DENIED");
      const updated = this.get(id);
      if (JSON.stringify(updated) !== before) this.changed([id]);
      return updated;
    });
  }
  dispatch(hash: string, now = Date.now()) {
    return this.db.transactionSync(() => {
      const rows = this.db.sql
        .exec<any>(
          "SELECT * FROM pra_library_jobs WHERE status='queued' AND attempts<3 ORDER BY created LIMIT 20",
        )
        .toArray();
      for (const r of rows)
        this.db.sql.exec(
          "UPDATE pra_library_jobs SET status='sent',device_hash=?,assigned_at=?,attempts=attempts+1,updated=? WHERE id=?",
          hash,
          now,
          now,
          r.id,
        );
      this.changed(rows.map((r) => r.id));
      return rows.map((r) => this.get(r.id));
    });
  }
  revokeDevice(hash: string) {
    this.db.transactionSync(() => {
      const rows = this.db.sql
        .exec<{ id: string }>(
          "SELECT id FROM pra_library_jobs WHERE device_hash=? AND status!='published'",
          hash,
        )
        .toArray();
      this.db.sql.exec(
        "UPDATE pra_library_jobs SET phase=CASE WHEN status IN ('failed','cancelled') THEN phase ELSE 'failed' END,error=CASE WHEN status IN ('failed','cancelled') THEN error ELSE 'IMPORT_DEVICE_REVOKED' END,status=CASE WHEN status IN ('failed','cancelled') THEN status ELSE 'failed' END,cancel_pending=0,device_hash='',updated=? WHERE device_hash=? AND status!='published'",
        Date.now(),
        hash,
      );
      this.changed(rows.map((r) => r.id));
    });
  }
  reconnect(hash: string) {
    this.db.transactionSync(() => {
      const rows = this.db.sql
        .exec<{ id: string }>(
          "SELECT id FROM pra_library_jobs WHERE device_hash=? AND status IN ('sent','processing')",
          hash,
        )
        .toArray();
      // A confirmed local registration is durable; reconnect is not a new failure attempt.
      this.db.sql.exec(
        "UPDATE pra_library_jobs SET attempts=CASE WHEN status='processing' THEN 0 ELSE attempts END,status='queued',updated=? WHERE device_hash=? AND status IN ('sent','processing')",
        Date.now(),
        hash,
      );
      this.changed(rows.map((r) => r.id));
    });
  }
  cancellations(): Array<{
    id: string;
    generation: number;
    deviceHash: string;
  }> {
    const jobs = this.db.sql
      .exec<any>(
        "SELECT id,generation,device_hash FROM pra_library_jobs WHERE cancel_pending=1 LIMIT 100",
      )
      .toArray();
    const tombstones = this.db.sql
      .exec<any>(
        "SELECT id,generation,device_hash FROM pra_library_tombstones WHERE cancel_pending=1 LIMIT 100",
      )
      .toArray();
    return [...jobs, ...tombstones].map((r) => ({
      id: r.id,
      generation: r.generation,
      deviceHash: r.device_hash,
    }));
  }
  cancelled(id: string, generation: number, hash: string) {
    if (this.deleted(id)) {
      const row = this.db.sql
        .exec<{
          generation: number;
          device_hash: string;
          cancel_pending: number;
        }>("SELECT * FROM pra_library_tombstones WHERE id=?", id)
        .toArray()[0];
      if (row.generation !== generation || row.device_hash !== hash)
        return false;
      if (row.cancel_pending)
        this.db.sql.exec(
          "UPDATE pra_library_tombstones SET cancel_pending=0 WHERE id=?",
          id,
        );
      return true;
    }
    const job = this.get(id);
    if (
      job.deviceHash !== hash ||
      job.generation !== generation ||
      job.status !== "cancelled"
    )
      return false;
    if (!job.cancelPending) return true;
    this.db.transactionSync(() => {
      this.db.sql.exec(
        "UPDATE pra_library_jobs SET cancel_pending=0,updated=? WHERE id=?",
        Date.now(),
        id,
      );
      this.changed([id]);
    });
    return true;
  }
  receive(hash: string, value: any, now = Date.now()) {
    const job = this.get(text(value.id, 128));
    if (
      job.deviceHash !== hash ||
      job.generation !== value.generation ||
      job.status === "cancelled"
    )
      return { accepted: false, terminal: true, changed: false, job };
    if (!importPhases.includes(value.phase))
      throw new Problem("INVALID_IMPORT_RESULT");
    if (final(job.status))
      return {
        accepted: job.phase === value.phase,
        terminal: true,
        changed: false,
        job,
      };
    const phase = value.phase as LibraryJob["phase"];
    const status = final(phase)
      ? (phase as "published" | "failed" | "cancelled")
      : "processing";
    let paper = "",
      version = "",
      error = "",
      contentHash = "";
    if (phase === "published") {
      paper = text(value.paperId, 256);
      version = text(value.indexVersion, 256);
      if (value.contentSha256 !== undefined) {
        if (
          typeof value.contentSha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(value.contentSha256)
        )
          throw new Problem("INVALID_IMPORT_DIGEST");
        contentHash = value.contentSha256;
      }
      // A local file may have the same bytes as the requested public paper.
      const duplicate =
        !!contentHash &&
        value.source === "arxiv:" + job.arxivId &&
        (paper === "local-" + contentHash || !!arxivVersion(paper));
      if (arxivVersion(paper) !== job.arxivId && !duplicate)
        throw new Problem("IMPORT_SOURCE_CHANGED");
    }
    if (value.error !== undefined && value.error !== "") {
      if (
        typeof value.error !== "string" ||
        !/^[A-Z_]{1,80}$/.test(value.error)
      )
        throw new Problem("INVALID_IMPORT_ERROR");
      error = value.error;
    }
    const changed =
      job.status !== status ||
      job.phase !== phase ||
      job.paperId !== paper ||
      job.indexVersion !== version ||
      job.error !== error ||
      job.contentSha256 !== contentHash;
    if (changed)
      this.db.transactionSync(() => {
        this.db.sql.exec(
          "UPDATE pra_library_jobs SET status=?,phase=?,paper_id=?,index_version=?,content_hash=?,error=?,updated=? WHERE id=?",
          status,
          phase,
          paper,
          version,
          contentHash,
          error,
          now,
          job.id,
        );
        this.changed([job.id]);
      });
    return {
      accepted: true,
      terminal: final(status),
      changed,
      job: this.get(job.id),
    };
  }
  expire(now = Date.now()) {
    this.db.transactionSync(() => {
      const rows = this.db.sql
        .exec<{ id: string }>(
          "SELECT id FROM pra_library_jobs WHERE (status='sent' AND assigned_at<=?) OR (status='queued' AND attempts>=3)",
          now - 60000,
        )
        .toArray();
      this.db.sql.exec(
        "UPDATE pra_library_jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,phase=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,error='IMPORT_REGISTRATION_TIMEOUT',updated=? WHERE status='sent' AND assigned_at<=?",
        now,
        now - 60000,
      );
      this.db.sql.exec(
        "UPDATE pra_library_jobs SET status='failed',phase='failed',error='IMPORT_DELIVERY_LIMIT',updated=? WHERE status='queued' AND attempts>=3",
        now,
      );
      this.changed(rows.map((r) => r.id));
    });
  }
  nextDeadline() {
    return (
      this.db.sql
        .exec<{ at: number }>(
          "SELECT MIN(assigned_at+60000) at FROM pra_library_jobs WHERE status='sent'",
        )
        .toArray()[0]?.at ?? undefined
    );
  }
}
