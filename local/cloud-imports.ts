import type { DatabaseSync } from "node:sqlite";
import type { LibraryClient, ImportJob } from "./library-client.ts";
type Port = Pick<
  LibraryClient,
  "registerArxiv" | "statuses" | "cancelRemote" | "retry"
>;
interface Row {
  id: string;
  generation: number;
  source: string;
  title: string;
  job_id: string;
  done: number;
  cancelled: number;
  retry_done: number;
  frame: string;
}
const terminal = (phase: string) =>
  ["published", "failed", "cancelled"].includes(phase);
const code = (error: unknown) =>
  error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message)
    ? error.message
    : "IMPORT_REGISTRATION_FAILED";
/** Durable mapping/outbox; only explicit arXiv versions cross this application protocol. */
export class CloudImports {
  private inflight = new Map<string, Promise<void>>();
  private flushing = false;
  readonly db: DatabaseSync;
  readonly library: Port;
  readonly send: (frame: unknown) => void;
  readonly abort: (id: string) => void;
  constructor(
    db: DatabaseSync,
    library: Port,
    send: (frame: unknown) => void,
    abort: (id: string) => void = () => {},
  ) {
    this.db = db;
    this.library = library;
    this.send = send;
    this.abort = abort;
    db.exec(
      "CREATE TABLE IF NOT EXISTS cloud_imports(id TEXT PRIMARY KEY,generation INTEGER NOT NULL,source TEXT NOT NULL,title TEXT NOT NULL,job_id TEXT NOT NULL DEFAULT '',done INTEGER NOT NULL DEFAULT 0,cancelled INTEGER NOT NULL DEFAULT 0,retry_done INTEGER NOT NULL DEFAULT 0,frame TEXT NOT NULL DEFAULT '')",
    );
  }
  private get(id: string) {
    return this.db.prepare("SELECT * FROM cloud_imports WHERE id=?").get(id) as
      Row | undefined;
  }
  private identity(m: any) {
    if (
      !m ||
      typeof m.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(m.id) ||
      !Number.isSafeInteger(m.generation) ||
      m.generation < 0 ||
      m.generation > 1000000
    )
      throw Error("INVALID_IMPORT_COMMAND");
  }
  async receive(m: any) {
    this.identity(m);
    if (m.type === "library_ack") {
      if (m.terminal === true)
        this.db
          .prepare(
            "UPDATE cloud_imports SET done=1 WHERE id=? AND generation=?",
          )
          .run(m.id, m.generation);
      return;
    }
    if (m.type === "library_cancel") {
      await this.cancel(m.id, m.generation);
      return;
    }
    if (
      m.type !== "library_import" ||
      Object.keys(m).some(
        (k) => !["type", "id", "generation", "arxivId", "title"].includes(k),
      ) ||
      typeof m.arxivId !== "string" ||
      !/^\d{4}\.\d{4,5}v[1-9]\d{0,3}$/.test(m.arxivId) ||
      typeof m.title !== "string" ||
      m.title.length > 500
    )
      throw Error("INVALID_IMPORT_COMMAND");
    const prior = this.get(m.id);
    if (prior && prior.generation > m.generation) return;
    if (prior && prior.generation === m.generation) {
      if (prior.cancelled) {
        if (!this.inflight.has(m.id)) await this.finishCancelled(prior);
        return;
      }
      if (prior.source !== m.arxivId || prior.title !== m.title)
        throw Error("IMPORT_IDENTITY_CHANGED");
      if (prior.frame) {
        this.send(JSON.parse(prior.frame));
        if (prior.done || terminal(JSON.parse(prior.frame).phase)) return;
      }
      if (prior.job_id) return;
    } else
      this.db
        .prepare(
          "INSERT INTO cloud_imports(id,generation,source,title) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,source=excluded.source,title=excluded.title,job_id='',done=0,cancelled=0,retry_done=0,frame=''",
        )
        .run(m.id, m.generation, m.arxivId, m.title);
    const old = this.inflight.get(m.id);
    if (old) {
      await old;
      if (
        this.get(m.id)?.generation === m.generation &&
        !this.get(m.id)?.job_id
      )
        await this.receive(m);
      return;
    }
    const promise = this.register(m.id, m.generation);
    this.inflight.set(m.id, promise);
    try {
      await promise;
    } finally {
      if (this.inflight.get(m.id) === promise) this.inflight.delete(m.id);
    }
  }
  private async register(id: string, generation: number) {
    try {
      let row = this.get(id)!;
      const job = await this.library.registerArxiv(
        "cloud:" + id + ":" + generation,
        row.source,
        { title: row.title },
      );
      row = this.get(id)!;
      if (row.generation !== generation) return;
      this.db
        .prepare(
          "UPDATE cloud_imports SET job_id=? WHERE id=? AND generation=?",
        )
        .run(job.id, id, generation);
      if (row.cancelled) {
        await this.finishCancelled(this.get(id)!);
        return;
      }
      let current = job;
      if (["failed", "cancelled"].includes(job.status) && !row.retry_done) {
        this.db
          .prepare(
            "UPDATE cloud_imports SET retry_done=1 WHERE id=? AND generation=?",
          )
          .run(id, generation);
        current = await this.library.retry(job.id);
      }
      row = this.get(id)!;
      if (row.generation !== generation) return;
      if (row.cancelled) {
        await this.finishCancelled(row);
        return;
      }
      this.report(row, current, true);
    } catch (error) {
      const row = this.get(id);
      if (!row || row.generation !== generation) return;
      if (row.cancelled) {
        await this.finishCancelled(row);
        return;
      }
      this.saveFrame(
        row,
        {
          type: "library_result",
          id,
          generation,
          phase: "failed",
          error: code(error),
        },
        true,
      );
    }
  }
  private saveFrame(row: Row, frame: unknown, force = false) {
    const value = JSON.stringify(frame);
    if (row.frame !== value)
      this.db
        .prepare("UPDATE cloud_imports SET frame=? WHERE id=? AND generation=?")
        .run(value, row.id, row.generation);
    if (row.frame !== value || force) this.send(frame);
  }
  private report(row: Row, job: ImportJob, force = false) {
    this.saveFrame(
      row,
      {
        type: "library_result",
        id: row.id,
        generation: row.generation,
        phase: job.status,
        ...(job.status === "published"
          ? {
              paperId: job.paper_id,
              indexVersion: job.version,
              source: job.source,
              ...(job.content_sha ? { contentSha256: job.content_sha } : {}),
            }
          : {}),
        ...(job.error
          ? {
              error: /^[A-Z_]{1,80}$/.test(job.error)
                ? job.error
                : "IMPORT_FAILED",
            }
          : {}),
      },
      force,
    );
  }
  private async cancel(id: string, generation: number) {
    const row = this.get(id);
    if (row && row.generation > generation) return;
    if (!row || row.generation < generation)
      this.db
        .prepare(
          "INSERT INTO cloud_imports(id,generation,source,title,cancelled) VALUES(?,?,'','',1) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,source='',title='',job_id='',done=0,cancelled=1,frame=''",
        )
        .run(id, generation);
    else
      this.db
        .prepare("UPDATE cloud_imports SET cancelled=1,done=0 WHERE id=?")
        .run(id);
    if (!this.inflight.has(id)) await this.finishCancelled(this.get(id)!);
  }
  private async finishCancelled(row: Row) {
    if (
      row.job_id &&
      !this.db
        .prepare(
          "SELECT id FROM cloud_imports WHERE job_id=? AND id!=? AND cancelled=0 AND done=0 LIMIT 1",
        )
        .get(row.job_id, row.id)
    ) {
      const job = await this.library.cancelRemote(row.job_id);
      if (job.status === "cancelled") this.abort(row.job_id);
    }
    const current = this.get(row.id);
    if (!current || current.generation !== row.generation || !current.cancelled)
      return;
    this.saveFrame(
      current,
      { type: "library_cancelled", id: row.id, generation: row.generation },
      true,
    );
  }
  async flush(force = false) {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const rows = this.db
        .prepare("SELECT * FROM cloud_imports WHERE done=0 LIMIT 100")
        .all() as unknown as Row[];
      const ids = [
        ...new Set(
          rows.filter((r) => r.job_id && !r.cancelled).map((r) => r.job_id),
        ),
      ];
      const jobs = ids.length ? await this.library.statuses(ids) : [];
      for (const row of rows) {
        const current = this.get(row.id);
        if (!current || current.generation !== row.generation || current.done)
          continue;
        if (current.cancelled) {
          if (!this.inflight.has(current.id))
            await this.finishCancelled(current);
          continue;
        }
        const job = jobs.find((j) => j.id === current.job_id);
        if (job) this.report(current, job, force || terminal(job.status));
        else if (
          current.frame &&
          (force || terminal(JSON.parse(current.frame).phase))
        )
          this.send(JSON.parse(current.frame));
      }
    } finally {
      this.flushing = false;
    }
  }
}
