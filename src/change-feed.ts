import { Problem } from "./domain.ts";
import type { StateStorage } from "./state-store.ts";

/** These are invalidation hints, not research history or deletion tombstones. */
export const CHANGE_WINDOW = 10_000;
export const CHANGE_CLEANUP_BATCH = 200;
export interface EntityChange { entity: string; id: string; deleted?: true }
export interface ChangePage {
  events: Array<{ seq: number; created: number; changes: EntityChange[] }>;
  cursor: number;
  latest: number;
  oldestCursor: number;
  resetRequired: boolean;
  reason?: "retention" | "cursor_ahead";
}

export function changeCursor(db: StateStorage): number {
  return db.sql.exec<{ seq: number }>("SELECT COALESCE(MAX(seq),0) AS seq FROM pra_changes").toArray()[0].seq;
}

/** Caller owns the transaction. Legacy backlogs drain without one unbounded delete. */
function compactChanges(db: StateStorage, latest: number) {
  const cutoff = latest - CHANGE_WINDOW;
  if (cutoff <= 0) return;
  db.sql.exec(
    "DELETE FROM pra_changes WHERE seq IN (SELECT seq FROM pra_changes WHERE seq<=? ORDER BY seq LIMIT ?)",
    cutoff, CHANGE_CLEANUP_BATCH,
  );
}

/** Append and compact inside the originating business transaction. */
export function appendChanges(db: StateStorage, changes: EntityChange[], after?: number): number {
  if (after !== undefined && (!Number.isSafeInteger(after) || after < 0 || after >= Number.MAX_SAFE_INTEGER))
    throw new Problem("INVALID_CURSOR");
  if (!changes.length) return changeCursor(db);
  if (after === undefined) {
    db.sql.exec("INSERT INTO pra_changes(created,value) VALUES(?,?)", Date.now(), JSON.stringify(changes));
  } else {
    // Recovery advances past both the restored database and the live protection record.
    const next = Math.max(changeCursor(db), after) + 1;
    if (!Number.isSafeInteger(next)) throw new Problem("INVALID_CURSOR");
    db.sql.exec("INSERT INTO pra_changes(seq,created,value) VALUES(?,?,?)", next, Date.now(), JSON.stringify(changes));
  }
  const latest = changeCursor(db);
  compactChanges(db, latest);
  return latest;
}

export function readChanges(db: StateStorage, after = 0, limit = 100): ChangePage {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Problem("INVALID_CURSOR");
  return db.transactionSync(() => {
    const latest = changeCursor(db);
    compactChanges(db, latest);
    const first = db.sql.exec<{ seq: number }>("SELECT seq FROM pra_changes ORDER BY seq LIMIT 1").toArray()[0]?.seq ?? 1;
    // Apply the logical window immediately, even while a legacy physical backlog is draining.
    const oldestCursor = Math.max(0, first - 1, latest - CHANGE_WINDOW);
    const reason = after > latest ? "cursor_ahead" : after < oldestCursor ? "retention" : undefined;
    if (reason) return { events: [], cursor: latest, latest, oldestCursor, resetRequired: true, reason };
    const rows = db.sql.exec<{ seq: number; created: number; value: string }>(
      "SELECT seq,created,value FROM pra_changes WHERE seq>? ORDER BY seq LIMIT ?", after, limit,
    ).toArray();
    return {
      events: rows.map(({ value, ...row }) => ({ ...row, changes: JSON.parse(value) as EntityChange[] })),
      cursor: rows.at(-1)?.seq ?? after, latest, oldestCursor, resetRequired: false,
    };
  });
}
