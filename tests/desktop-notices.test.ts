import assert from "node:assert/strict";
import test from "node:test";
import {DatabaseSync} from "node:sqlite";
import {DesktopNotices} from "../local/desktop-notices.ts";
import {inboxNoticeBatch, type InboxNoticePage} from "../src/inbox-notices.ts";

function pages(ids: string[]): InboxNoticePage[] {
  const snapshot = inboxNoticeBatch(ids);
  return snapshot.pages.map((part, page) => ({
    type: "inbox_notices", batch: snapshot.batch, page, pages: snapshot.pages.length, ids: part,
  }));
}

function receipts(db: DatabaseSync) {
  return Number(db.prepare("SELECT COUNT(*) AS count FROM notices").get()!.count);
}

test("the last page registers one dispatch count across old and new receipt formats", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const notices = new DesktopNotices(db);
    const ids = Array.from({length: 273}, (_, i) => "notice-" + i);
    assert.equal(notices.single(ids[0]), 1);
    const frames = pages(ids);
    assert.deepEqual(frames.map(f => notices.page(f)), [0, 0, 272]);
    assert.equal(receipts(db), 273);
    assert.deepEqual(frames.map(f => notices.page(f)), [0, 0, 0]);
    assert.equal(notices.single(ids[7]), 0);
    const reconnect = new DesktopNotices(db);
    assert.deepEqual(pages([...ids.slice(1), "new"]).map(f => reconnect.page(f)), [0, 0, 1]);
    assert.equal(receipts(db), 274);
  } finally { db.close(); }
});

test("partial, missing or inconsistent pages cannot register a desktop dispatch", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const frames = pages(Array.from({length: 257}, (_, i) => "notice-" + i));
    const first = new DesktopNotices(db);
    assert.equal(first.page(frames[0]), 0);
    assert.throws(() => first.page(frames[2]), /INCOMPLETE_NOTICE_BATCH/);
    const next = new DesktopNotices(db);
    assert.throws(() => next.page(frames[1]), /INCOMPLETE_NOTICE_BATCH/);
    assert.equal(next.page(frames[0]), 0);
    assert.throws(() => next.page({...frames[1], pages: 4}), /INCOMPLETE_NOTICE_BATCH/);
    assert.equal(next.page(frames[1]), 0);
    assert.throws(() => next.page({...frames[2], ids: ["other"]}), /NOTICE_BATCH_MISMATCH/);
    assert.throws(() => next.page({...frames[0], ids: []}), /INVALID_NOTICE_PAGE/);
    assert.equal(receipts(db), 0);
    assert.deepEqual(frames.map(f => next.page(f)), [0, 0, 257]);
  } finally { db.close(); }
});

test("a failed receipt write leaves the whole batch available for a retry", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const notices = new DesktopNotices(db);
    assert.equal(notices.single("old"), 1);
    const [frame] = pages(["a", "b", "old"]);
    db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON notices WHEN NEW.id='b' BEGIN SELECT RAISE(ABORT,'test failure'); END");
    assert.throws(() => notices.page(frame), /test failure/);
    assert.equal(receipts(db), 1);
    db.exec("DROP TRIGGER fail_receipt");
    assert.equal(notices.page(frame), 2);
    assert.equal(notices.page(frame), 0);
    assert.equal(receipts(db), 3);
  } finally { db.close(); }
});
