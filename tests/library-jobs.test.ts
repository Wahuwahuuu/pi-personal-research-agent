import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { LibraryJobs } from "../src/library-jobs.ts";
import type { StateStorage } from "../src/state-store.ts";
function setup() {
  const db = new DatabaseSync(":memory:");
  let writes = 0;
  const storage: StateStorage = {
    sql: {
      exec<T>(q: string, ...b: any[]) {
        const s = db.prepare(q);
        let v: T[] = [];
        if (s.columns().length) v = s.all(...b) as T[];
        else writes += Number(s.run(...b).changes);
        return { toArray: () => v };
      },
    },
    transactionSync(fn) {
      db.exec("BEGIN");
      try {
        const v = fn();
        db.exec("COMMIT");
        return v;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { db, storage, jobs: new LibraryJobs(storage), writes: () => writes };
}
test("cloud import queue survives reconnect and remains idempotent without a model call", () => {
  const f = setup();
  try {
    const j = f.jobs.create(
      "one",
      { projectId: "default", arxivId: "2401.00001v2" },
      1000,
    );
    assert.equal(
      f.jobs.create("one", { projectId: "default", arxivId: "2401.00001v2" })
        .id,
      j.id,
    );
    assert.throws(
      () =>
        f.jobs.create("one", { projectId: "default", arxivId: "2401.00002v2" }),
      /REQUEST_CONFLICT/,
    );
    assert.throws(
      () =>
        f.jobs.create("bad", {
          projectId: "default",
          arxivId: "https://arxiv.org/pdf/2401.00001",
        }),
      /INVALID_TEXT|VERSIONED/,
    );
    assert.equal(f.jobs.dispatch("device", 2000)[0].id, j.id);
    const received = f.jobs.receive(
      "device",
      { id: j.id, generation: 0, phase: "indexing" },
      3000,
    );
    assert.equal(received.job.status, "processing");
    const before = f.writes();
    f.jobs.receive(
      "device",
      { id: j.id, generation: 0, phase: "indexing" },
      4000,
    );
    assert.equal(f.writes(), before);
    const reopened = new LibraryJobs(f.storage);
    reopened.reconnect("device");
    assert.equal(reopened.dispatch("device", 5000)[0].id, j.id);
    assert.equal(
      reopened.receive("other", {
        id: j.id,
        generation: 0,
        phase: "published",
        paperId: "2401.00001v2",
        indexVersion: "new",
      }).accepted,
      false,
    );
    assert.throws(
      () =>
        reopened.receive("device", {
          id: j.id,
          generation: 0,
          phase: "published",
          paperId: "2401.00001v1",
          indexVersion: "new",
        }),
      /IMPORT_SOURCE_CHANGED/,
    );
    const done = reopened.receive("device", {
      id: j.id,
      generation: 0,
      phase: "published",
      paperId: "2401.00001v2",
      indexVersion: "new",
    });
    assert.equal(done.job.status, "published");
    const count = f.writes();
    for (let n = 0; n < 50; n++)
      reopened.receive("device", {
        id: j.id,
        generation: 0,
        phase: "published",
        paperId: "2401.00001v2",
        indexVersion: "new",
      });
    assert.equal(f.writes(), count);
  } finally {
    f.db.close();
  }
});
test("cancelled imports reject late results and retry has a durable generation boundary", () => {
  const f = setup();
  try {
    const j = f.jobs.create("one", {
      projectId: "default",
      arxivId: "2401.00001v1",
    });
    f.jobs.dispatch("device");
    f.jobs.action(j.id, "cancel", "cancel");
    assert.equal(
      f.jobs.receive("device", {
        id: j.id,
        generation: 0,
        phase: "published",
        paperId: "2401.00001",
        indexVersion: "new",
      }).accepted,
      false,
    );
    assert.throws(
      () => f.jobs.action(j.id, "retry", "retry"),
      /LOCAL_CANCEL_PENDING/,
    );
    f.jobs.cancelled(j.id, 0, "device");
    const retry = f.jobs.action(j.id, "retry", "retry");
    assert.equal(retry.generation, 1);
    assert.equal(f.jobs.action(j.id, "retry", "retry").generation, 1);
    f.jobs.dispatch("device");
    assert.equal(
      f.jobs.receive("device", { id: j.id, generation: 0, phase: "failed" })
        .accepted,
      false,
    );
    assert.equal(
      f.jobs.receive("device", {
        id: j.id,
        generation: 1,
        phase: "published",
        paperId: "2401.00001",
        indexVersion: "new",
      }).job.status,
      "published",
    );
  } finally {
    f.db.close();
  }
});
test("unacknowledged registrations stop after bounded attempts and each owner uses a separate store", () => {
  const a = setup(),
    b = setup();
  try {
    const j = a.jobs.create(
      "r",
      { projectId: "default", arxivId: "2401.00001v1" },
      0,
    );
    for (let n = 0; n < 3; n++) {
      a.jobs.dispatch("node", n * 60001);
      a.jobs.expire((n + 1) * 60001);
    }
    assert.equal(a.jobs.get(j.id).status, "failed");
    assert.equal(a.jobs.dispatch("node").length, 0);
    assert.throws(() => b.jobs.get(j.id), /NOT_FOUND/);
    assert.equal(b.jobs.page().items.length, 0);
    assert.equal("deviceHash" in a.jobs.page().items[0], false);
  } finally {
    a.db.close();
    b.db.close();
  }
});

test("arXiv duplicate content keeps a verifiable alias to a previously selected local PDF", () => {
  const f = setup();
  try {
    const j = f.jobs.create("alias", {
      projectId: "default",
      arxivId: "2401.00001v2",
    });
    f.jobs.dispatch("device");
    const hash = "a".repeat(64);
    const result = {
      id: j.id,
      generation: 0,
      phase: "published",
      paperId: "local-" + hash,
      indexVersion: "index",
      source: "arxiv:2401.00001v2",
      contentSha256: hash,
    };
    assert.throws(
      () =>
        f.jobs.receive("device", { ...result, source: "arxiv:2401.00002v2" }),
      /IMPORT_SOURCE_CHANGED/,
    );
    assert.equal(f.jobs.receive("device", result).job.contentSha256, hash);
  } finally {
    f.db.close();
  }
});

test("project deletion removes import metadata and retains only cancellation tombstones", () => {
  const f = setup();
  try {
    const job = f.jobs.create("sensitive-request", {
      projectId: "project",
      arxivId: "2401.00001v1",
      title: "private research title",
    });
    f.jobs.dispatch("device");
    assert.deepEqual(f.jobs.removeProject("project"), [job.id]);
    assert.equal(f.jobs.page().items.length, 0);
    assert.equal(f.jobs.deleted(job.id), true);
    assert.equal(
      f.db.prepare("SELECT COUNT(*) n FROM pra_library_requests").get()!.n,
      0,
    );
    assert.equal(f.jobs.cancellations().length, 1);
    assert.equal(f.jobs.cancelled(job.id, 0, "wrong"), false);
    assert.equal(f.jobs.cancelled(job.id, 0, "device"), true);
    assert.equal(f.jobs.cancellations().length, 0);
  } finally {
    f.db.close();
  }
});

test("revocation cannot leave a cancelled import waiting forever for an invalid credential", () => {
  const f = setup();
  try {
    const j = f.jobs.create("r", {
      projectId: "default",
      arxivId: "2401.00001v1",
    });
    f.jobs.dispatch("old");
    f.jobs.action(j.id, "cancel", "c");
    f.jobs.revokeDevice("old");
    assert.equal(f.jobs.get(j.id).cancelPending, false);
    assert.equal(f.jobs.action(j.id, "retry", "again").generation, 1);
    f.jobs.dispatch("new");
    assert.equal(
      f.jobs.receive("old", {
        id: j.id,
        generation: 0,
        phase: "published",
        paperId: "2401.00001v1",
        indexVersion: "new",
      }).accepted,
      false,
    );
    f.jobs.revokeDevice("new");
    assert.equal(f.jobs.get(j.id).error, "IMPORT_DEVICE_REVOKED");
  } finally {
    f.db.close();
  }
});

test("pending import count spans hidden pages and respects project and cancellation boundaries",()=>{
 const f=setup();try{
  const active=f.jobs.create("active",{projectId:"a",arxivId:"2401.00001v1"},1);
  const other=f.jobs.create("other",{projectId:"b",arxivId:"2401.00002v1"},2);
  const recent=f.jobs.create("recent",{projectId:"a",arxivId:"2401.00003v1"},3);
  f.jobs.action(recent.id,"cancel","cancel-recent");
  const page=f.jobs.page("a",0,1);assert.equal(page.items[0].id,recent.id);assert.equal(page.pendingCount,1);
  assert.equal(f.jobs.page(undefined,0,1).pendingCount,2);
  f.jobs.action(active.id,"cancel","cancel-active");assert.equal(f.jobs.page("a").pendingCount,0);
  assert.equal(f.jobs.page("b").pendingCount,1);assert.equal(f.jobs.page("b").items[0].id,other.id);
 }finally{f.db.close();}
});
