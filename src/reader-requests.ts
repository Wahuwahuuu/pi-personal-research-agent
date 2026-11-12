import {ReaderPurges} from "./reader-purges.ts";
import { Problem, text } from "./domain.ts";
import type { StateStorage } from "./state-store.ts";
export interface ReaderTarget {
  paperId: string;
  indexVersion: string;
  page?: number;
  conversationId?: string;
}
export interface ReaderRequest extends ReaderTarget {
  id: string;
  deviceHash: string;
  deviceLabel: string;
  created: number;
  expires: number;
  status: "queued" | "opened" | "failed" | "expired" | "cancelled";
  error?: string;
}
export const READER_TTL = 90000;
/** A short user-initiated action; receipt of a socket message never implies an opened window. */
export class ReaderRequests {
  readonly db: StateStorage;
  readonly purges: ReaderPurges;
  constructor(db: StateStorage) {
    this.db = db;
    this.purges = new ReaderPurges(db);
    db.sql.exec(
      "CREATE TABLE IF NOT EXISTS pra_reader_requests(id TEXT PRIMARY KEY,device_hash TEXT NOT NULL,expires INTEGER NOT NULL,value TEXT NOT NULL)",
    );
    db.sql.exec(
      "CREATE INDEX IF NOT EXISTS pra_reader_device_expiry ON pra_reader_requests(device_hash,expires)",
    );
  }
  private put(r: ReaderRequest) {
    this.db.sql.exec(
      "INSERT INTO pra_reader_requests VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      r.id,
      r.deviceHash,
      r.expires,
      JSON.stringify(r),
    );
  }
  get(id: string, now = Date.now()) {
    if(this.purges.get(id))throw new Problem("READER_CANCELLED",410);
    const row = this.db.sql
      .exec<{ value: string }>(
        "SELECT value FROM pra_reader_requests WHERE id=?",
        text(id, 128),
      )
      .toArray()[0];
    if (!row) throw new Problem("NOT_FOUND", 404);
    const r = JSON.parse(row.value) as ReaderRequest;
    if (r.status === "queued" && r.expires <= now) {
      r.status = "expired";
      r.error = "READER_EXPIRED";
      this.put(r);
    }
    return r;
  }
  create(
    id: string,
    target: ReaderTarget,
    hash: string,
    label: string,
    now = Date.now(),
  ) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Problem("INVALID_REQUEST_ID");
    if(this.purges.get(id))throw new Problem("READER_CANCELLED",410);
    text(target.paperId, 256);
    text(target.indexVersion, 256);
    if (
      target.page !== undefined &&
      (!Number.isInteger(target.page) || target.page < 1 || target.page > 1000)
    )
      throw new Problem("INVALID_PDF_PAGE");
    const old = this.db.sql
      .exec<{ value: string }>(
        "SELECT value FROM pra_reader_requests WHERE id=?",
        id,
      )
      .toArray()[0];
    if (old) {
      const r = this.get(id, now);
      if (
        r.paperId !== target.paperId ||
        r.indexVersion !== target.indexVersion ||
        r.page !== target.page ||
        r.conversationId !== target.conversationId
      )
        throw new Problem("IDEMPOTENCY_CONFLICT", 409);
      return r;
    }
    const r: ReaderRequest = {
      ...target,
      id,
      deviceHash: hash,
      deviceLabel: label,
      created: now,
      expires: now + READER_TTL,
      status: "queued",
    };
    this.put(r);
    return r;
  }
  pending(hash: string, now = Date.now()) {
    return this.db.sql
      .exec<{ id: string }>(
        "SELECT id FROM pra_reader_requests WHERE device_hash=? AND expires>? ORDER BY rowid",
        hash,
        now,
      )
      .toArray()
      .map((r) => this.get(r.id, now))
      .filter((r) => r.status === "queued");
  }
  receive(
    hash: string,
    id: string,
    status: unknown,
    error?: unknown,
    now = Date.now(),
  ) {
    const r = this.get(id, now);
    if (r.deviceHash !== hash) throw new Problem("READER_DEVICE_MISMATCH", 403);
    if (status !== "opened" && status !== "failed")
      throw new Problem("INVALID_READER_RESULT");
    if (r.status !== "queued") return r;
    r.status = status;
    if (status === "failed")
      r.error =
        typeof error === "string" &&
        [
          "READER_INTERRUPTED",
          "READER_EXPIRED",
          "PDF_UNAVAILABLE",
          "INDEX_UNAVAILABLE",
          "READER_UNAVAILABLE",
        ].includes(error)
          ? error
          : "PDF_UNAVAILABLE";
    this.put(r);
    return r;
  }
  removeConversations(conversations:readonly string[],deletionId:string){
    const rows=this.db.sql.exec<{value:string}>("SELECT value FROM pra_reader_requests WHERE json_extract(value,'$.conversationId') IN (SELECT value FROM json_each(?))",JSON.stringify(conversations)).toArray();
    return this.db.transactionSync(()=>{
      const ids:string[]=[];
      for(const row of rows){const r=JSON.parse(row.value) as ReaderRequest;this.purges.record(r.id,deletionId,r.deviceHash);this.db.sql.exec("DELETE FROM pra_reader_requests WHERE id=?",r.id);ids.push(r.id);}
      return ids;
    });
  }
  invalidate(filter: { hash?: string; conversationId?: string }) {
    const rows = this.db.sql
      .exec<{ id: string }>(
        "SELECT id FROM pra_reader_requests" +
          (filter.hash ? " WHERE device_hash=?" : ""),
        ...(filter.hash ? [filter.hash] : []),
      )
      .toArray();
    const ids: string[] = [];
    for (const row of rows) {
      const r = this.get(row.id);
      if (filter.conversationId && r.conversationId !== filter.conversationId)
        continue;
      if (r.status === "queued") {
        r.status = "cancelled";
        r.error = "READER_CANCELLED";
        this.put(r);
        ids.push(r.id);
      }
    }
    return ids;
  }
}
export function readerView(r: ReaderRequest) {
  const { deviceHash, conversationId, ...v } = r;
  return v;
}
