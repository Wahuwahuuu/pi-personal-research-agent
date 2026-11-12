import type { DatabaseSync } from "node:sqlite";
export interface LocalReaderRequest {
  id: string;
  paperId: string;
  indexVersion: string;
  page?: number;
  expires: number;
  status: "queued" | "claimed" | "opened" | "failed";
  error?: string;
  acked: boolean;
}
/** Claim-before-open trades automatic retry for avoiding duplicate native windows after a crash. */
export class ReaderQueue {
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec("CREATE TABLE IF NOT EXISTS reader_purges(id TEXT PRIMARY KEY,deletion_id TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0,acked INTEGER NOT NULL DEFAULT 0)");
    db.exec(
      "CREATE TABLE IF NOT EXISTS reader_requests(id TEXT PRIMARY KEY,value TEXT NOT NULL)",
    );
    for (const r of this.all())
      if (r.status === "claimed") {
        r.status = "failed";
        r.error = "READER_INTERRUPTED";
        this.put(r);
      }
  }
  all() {
    return (
      this.db.prepare("SELECT value FROM reader_requests").all() as {
        value: string;
      }[]
    ).map((r) => JSON.parse(r.value) as LocalReaderRequest);
  }
  get(id: string) {
    const r = this.db
      .prepare("SELECT value FROM reader_requests WHERE id=?")
      .get(id) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as LocalReaderRequest) : undefined;
  }
  private put(r: LocalReaderRequest) {
    this.db
      .prepare(
        "INSERT INTO reader_requests VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(r.id, JSON.stringify(r));
  }
  receive(m: any, now = Date.now()) {
    if (
      !m ||
      typeof m.id !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(m.id) ||
      !["paperId", "indexVersion"].every(
        (k) =>
          typeof m[k] === "string" && m[k].length > 0 && m[k].length <= 256,
      ) ||
      !Number.isSafeInteger(m.expires) ||
      m.expires > now + 100000 ||
      (m.page !== undefined &&
        (!Number.isInteger(m.page) || m.page < 1 || m.page > 1000))
    )
      throw Error("INVALID_READER_REQUEST");
    if(this.db.prepare("SELECT id FROM reader_purges WHERE id=?").get(m.id))return;
    const old = this.get(m.id);
    if (old) {
      if (
        old.paperId !== m.paperId ||
        old.indexVersion !== m.indexVersion ||
        old.page !== m.page ||
        old.expires !== m.expires
      )
        throw Error("READER_ID_CONFLICT");
      return;
    }
    this.put({
      id: m.id,
      paperId: m.paperId,
      indexVersion: m.indexVersion,
      page: m.page,
      expires: m.expires,
      status: m.expires > now ? "queued" : "failed",
      error: m.expires > now ? undefined : "READER_EXPIRED",
      acked: false,
    });
  }
  claim(now = Date.now()) {
    this.expire(now);
    const pending = this.all();
    if (pending.some((r) => r.status === "claimed")) return null;
    const r = pending.find((r) => r.status === "queued");
    if (!r) return null;
    r.status = "claimed";
    this.put(r);
    return {
      id: r.id,
      paperId: r.paperId,
      indexVersion: r.indexVersion,
      page: r.page,
      expires: r.expires,
    };
  }
  finish(id: string, opened: boolean, now = Date.now()) {
    const r = this.get(id);
    if (!r || r.status !== "claimed") return;
    r.status = opened && r.expires > now ? "opened" : "failed";
    r.error =
      r.expires <= now
        ? "READER_EXPIRED"
        : opened
          ? undefined
          : "PDF_UNAVAILABLE";
    this.put(r);
  }
  cancel(id: string) {
    const r = this.get(id);
    if (r && (r.status === "queued" || r.status === "claimed")) {
      r.status = "failed";
      r.error = "READER_UNAVAILABLE";
      this.put(r);
    }
  }
  expire(now = Date.now()) {
    for (const r of this.all())
      if (
        (r.status === "queued" || r.status === "claimed") &&
        r.expires <= now
      ) {
        r.status = "failed";
        r.error = "READER_EXPIRED";
        this.put(r);
      }
  }
  results() {
    this.expire();
    return this.all()
      .filter(
        (r) => !r.acked && (r.status === "opened" || r.status === "failed"),
      )
      .map((r) => ({
        type: "reader_result",
        id: r.id,
        status: r.status,
        error: r.error,
      }));
  }
  purge(deletionId:unknown,ids:unknown){
    if(typeof deletionId!=="string"||!deletionId||deletionId.length>128||!Array.isArray(ids)||!ids.length||ids.length>200||ids.some(id=>typeof id!=="string"||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)))throw Error("INVALID_READER_PURGE");
    this.db.exec("BEGIN IMMEDIATE");
    try{
      for(const id of ids){
        const old=this.db.prepare("SELECT deletion_id FROM reader_purges WHERE id=?").get(id);
        if(old&&old.deletion_id!==deletionId)throw Error("READER_PURGE_CONFLICT");
        this.db.prepare("INSERT INTO reader_purges(id,deletion_id) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET acked=0").run(id,deletionId);
        this.db.prepare("DELETE FROM reader_requests WHERE id=?").run(id);
      }
      this.db.exec("COMMIT");
    }catch(e){this.db.exec("ROLLBACK");throw e;}
  }
  pendingPurges(){return (this.db.prepare("SELECT id FROM reader_purges WHERE done=0 LIMIT 200").all() as {id:string}[]).map(r=>r.id);}
  purged(id:string){
    if(!this.db.prepare("SELECT id FROM reader_purges WHERE id=?").get(id))throw Error("UNKNOWN_READER_PURGE");
    this.db.prepare("UPDATE reader_purges SET done=1 WHERE id=?").run(id);
  }
  purgeResults(){
    const groups=new Map<string,string[]>();
    for(const r of this.db.prepare("SELECT id,deletion_id FROM reader_purges WHERE done=1 AND acked=0 LIMIT 200").all() as {id:string;deletion_id:string}[])
      groups.set(r.deletion_id,[...(groups.get(r.deletion_id)??[]),r.id]);
    return [...groups].map(([deletionId,requestIds])=>({type:"reader_purged",deletionId,requestIds}));
  }
  ackPurges(ids:unknown){
    if(!Array.isArray(ids)||ids.length>200||ids.some(id=>typeof id!=="string"))throw Error("INVALID_READER_PURGE_ACK");
    for(const id of ids)this.db.prepare("UPDATE reader_purges SET acked=1 WHERE id=? AND done=1").run(id);
  }
  ack(id: string) {
    const r = this.get(id);
    if (r) {
      r.acked = true;
      this.put(r);
    }
  }
}
