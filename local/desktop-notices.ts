import {createHash, type Hash} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {INBOX_NOTICE_PAGE_SIZE, type InboxNoticePage} from "../src/inbox-notices.ts";

/** Windows may suppress a notification. Receipts record a dispatch attempt independently of the site's read state. */
export class DesktopNotices {
  private readonly db: DatabaseSync;
  private pending?: {batch: string; next: number; pages: number; hash: Hash};
  private completed?: string;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec("CREATE TABLE IF NOT EXISTS notices(id TEXT PRIMARY KEY)");
    db.exec("CREATE TEMP TABLE IF NOT EXISTS pending_desktop_notices(id TEXT PRIMARY KEY) WITHOUT ROWID");
  }

  single(id: unknown) {
    if (typeof id !== "string" || !id.length) throw Error("INVALID_NOTICE_ID");
    return Number(this.db.prepare("INSERT OR IGNORE INTO notices(id) VALUES(?)").run(id).changes);
  }

  page(frame: InboxNoticePage): number {
    const {batch, page, pages, ids} = frame;
    if (typeof batch !== "string" || !/^[a-f0-9]{64}$/.test(batch) ||
        !Number.isSafeInteger(pages) || !Number.isSafeInteger(page) || page < 0 || page >= pages ||
        !Array.isArray(ids) || !ids.length || ids.length > INBOX_NOTICE_PAGE_SIZE ||
        (page + 1 < pages && ids.length !== INBOX_NOTICE_PAGE_SIZE) ||
        ids.some(id => typeof id !== "string" || !id.length)) throw Error("INVALID_NOTICE_PAGE");
    if (this.completed === batch) return 0;
    if (page === 0) {
      this.db.exec("DELETE FROM pending_desktop_notices");
      this.pending = {batch, next: 0, pages, hash: createHash("sha256")};
    }
    const pending = this.pending;
    if (!pending || pending.batch !== batch || pending.next !== page || pending.pages !== pages)
      throw Error("INCOMPLETE_NOTICE_BATCH");

    const payload = JSON.stringify(ids);
    this.db.prepare("INSERT OR IGNORE INTO pending_desktop_notices(id) SELECT value FROM json_each(?)").run(payload);
    pending.hash.update(payload);
    pending.next++;
    if (pending.next < pages) return 0;
    this.pending = undefined;
    if (pending.hash.digest("hex") !== batch) throw Error("NOTICE_BATCH_MISMATCH");

    this.db.exec("BEGIN");
    try {
      const delivered = this.db.prepare("INSERT OR IGNORE INTO notices(id) SELECT id FROM pending_desktop_notices").run();
      this.db.exec("DELETE FROM pending_desktop_notices");
      this.db.exec("COMMIT");
      this.completed = batch;
      return Number(delivered.changes);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
