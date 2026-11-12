import {DeletionStore} from "../src/deletion.ts";
import {initialState} from "../src/domain.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  ReaderRequests,
  readerView,
  READER_TTL,
} from "../src/reader-requests.ts";
import { ReaderQueue } from "../local/reader-queue.ts";
import type { StateStorage } from "../src/state-store.ts";
function setup() {
  const db = new DatabaseSync(":memory:");
  const storage: StateStorage = {
    sql: {
      exec<T>(q: string, ...b: any[]) {
        const s = db.prepare(q),
          v = (s.columns().length ? s.all(...b) : (s.run(...b), [])) as T[];
        return { toArray: () => v };
      },
    },
    transactionSync<T>(f: () => T) {
      return f();
    },
  };
  return { db, storage, r: new ReaderRequests(storage) };
}
const target = {
  paperId: "local-paper",
  indexVersion: "immutable-v1",
  page: 3,
  conversationId: "c",
};
test("50 reader requests redelivered five times open once and require the bound device's actual receipt", () => {
  const { db, r } = setup(),
    localDb = new DatabaseSync(":memory:"),
    q = new ReaderQueue(localDb);
  for (let i = 0; i < 50; i++) {
    const id = crypto.randomUUID(),
      created = r.create(id, target, "device", "Computer");
    for (let j = 0; j < 5; j++) {
      assert.equal(r.create(id, target, "different", "Other").id, id);
      q.receive(created);
    }
    assert.equal(r.get(id).status, "queued");
    const received = q.claim()!;
    assert.equal(received.id, id);
    assert.equal(received.page, 3);
    assert.equal(q.claim(), null);
    assert.throws(
      () => r.receive("different", id, "opened"),
      /READER_DEVICE_MISMATCH/,
    );
    q.finish(id, true);
    const message = q.results()[0];
    assert.equal(message.id, id);
    r.receive("device", id, message.status);
    q.ack(id);
    assert.equal(r.get(id).status, "opened");
    assert.equal(q.results().length, 0);
    q.receive(created);
    assert.equal(q.claim(), null);
    assert.equal(r.receive("device", id, "failed").status, "opened");
    assert.ok(!JSON.stringify(readerView(r.get(id))).includes("deviceHash"));
  }
  db.close();
  localDb.close();
});
test("restoration never reopens a claimed window; expiration, revocation and deletion reject late success", () => {
  const { db, storage, r } = setup(),
    localDb = new DatabaseSync(":memory:");
  let q = new ReaderQueue(localDb);
  const id = crypto.randomUUID(),
    created = r.create(id, target, "device", "Computer");
  q.receive(created);
  assert.ok(q.claim());
  q = new ReaderQueue(localDb);
  assert.equal(q.claim(), null);
  assert.equal(q.results()[0].error, "READER_INTERRUPTED");
  const restored = new ReaderRequests(storage);
  assert.equal(restored.get(id).status, "queued");
  assert.equal(restored.get(id, created.expires).status, "expired");
  assert.equal(
    restored.receive("device", id, "opened", undefined, created.expires).status,
    "expired",
  );
  for (const filter of [{ hash: "device" }, { conversationId: "c" }]) {
    const another = r.create(crypto.randomUUID(), target, "device", "Computer");
    assert.ok(r.invalidate(filter).includes(another.id));
    assert.equal(r.receive("device", another.id, "opened").status, "cancelled");
  }
  const stale = {
    ...created,
    id: crypto.randomUUID(),
    expires: Date.now() - 1,
  };
  q.receive(stale);
  assert.equal(q.get(stale.id)!.error, "READER_EXPIRED");
  db.close();
  localDb.close();
});
test("reader identities, page bounds and immutable idempotency payloads cannot become paths or commands", () => {
  const { db, r } = setup(),
    localDb = new DatabaseSync(":memory:"),
    q = new ReaderQueue(localDb),
    id = crypto.randomUUID();
  const created = r.create(id, target, "device", "Computer");
  assert.throws(
    () => r.create(id, { ...target, page: 4 }, "device", "Computer"),
    /IDEMPOTENCY_CONFLICT/,
  );
  assert.throws(
    () =>
      r.create(
        crypto.randomUUID(),
        { ...target, page: 0 },
        "device",
        "Computer",
      ),
    /INVALID_PDF_PAGE/,
  );
  assert.throws(
    () => q.receive({ ...created, id: crypto.randomUUID(), page: 1001 }),
    /INVALID_READER_REQUEST/,
  );
  q.receive({ ...created, path: "C:/secret.pdf", command: "arbitrary" });
  assert.ok(!JSON.stringify(q.claim()).includes("secret"));
  assert.ok(!JSON.stringify(q.all()).includes("command"));
  assert.throws(
    () => q.receive({ ...created, paperId: "different" }),
    /READER_ID_CONFLICT/,
  );
  assert.throws(
    () => r.receive("device", id, "received"),
    /INVALID_READER_RESULT/,
  );
  db.close();
  localDb.close();
});

test("50 opened readers are purged idempotently, survive restart and need the original device's cleanup confirmation",()=>{
 const {db,storage,r}=setup(),localDb=new DatabaseSync(":memory:");
 let q=new ReaderQueue(localDb);const deletions=new DeletionStore(storage),state=initialState();
 state.conversations=[{id:"c",title:"Source",projectId:"default",scope:[],created:0,history:[]}];
 try{
  const frames=Array.from({length:50},()=>r.create(crypto.randomUUID(),target,"original-device","Original"));
  for(const f of frames){q.receive(f);assert.equal(q.claim()!.id,f.id);q.finish(f.id,true);q.ack(f.id);r.receive("original-device",f.id,"opened");}
  deletions.request(state,"c");const ids=r.removeConversations(["c"],"c");deletions.cloudDone("c");
  assert.equal(deletions.get("c")!.status,"cloud_complete");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pra_reader_requests").get()!.n,0);
  assert.equal(deletions.readers.pending("other-device","c").length,0);
  assert.throws(()=>deletions.readersDone("c",ids,"other-device"),/READER_DEVICE_MISMATCH/);
  for(let i=0;i<5;i++)q.purge("c",ids);
  q=new ReaderQueue(localDb);
  assert.equal(q.pendingPurges().length,50);assert.equal(q.purgeResults().length,0);assert.equal(q.results().length,0);
  for(const f of frames){q.receive(f);q.finish(f.id,true);assert.throws(()=>r.create(f.id,target,"original-device","Original"),/READER_CANCELLED/);}
  assert.equal(q.claim(),null);assert.equal(q.all().length,0);
  for(const id of ids)q.purged(id);
  q=new ReaderQueue(localDb);const receipt=q.purgeResults()[0];assert.equal(receipt.requestIds.length,50);
  deletions.readersDone(receipt.deletionId,receipt.requestIds,"original-device");
  assert.equal(deletions.get("c")!.status,"completed");q.ackPurges(receipt.requestIds);
  assert.equal(q.purgeResults().length,0);
  q.purge("c",ids);assert.equal(q.pendingPurges().length,0);assert.equal(q.purgeResults()[0].requestIds.length,50);
  assert.ok(!JSON.stringify(db.prepare("SELECT * FROM pra_deleted_readers").all()).includes(target.paperId));
 }finally{db.close();localDb.close();}
});
test("reader purge is atomic on conflicting deletion ids and never accepts a filename",()=>{
 const db=new DatabaseSync(":memory:"),q=new ReaderQueue(db),a=crypto.randomUUID(),b=crypto.randomUUID();
 try{
  q.purge("first",[b]);
  assert.throws(()=>q.purge("different",[a,b]),/READER_PURGE_CONFLICT/);
  assert.deepEqual(q.pendingPurges(),[b]);
  assert.throws(()=>q.purge("first",["../../private.pdf"]),/INVALID_READER_PURGE/);
  assert.throws(()=>q.purged(a),/UNKNOWN_READER_PURGE/);
  assert.equal(q.purgeResults().length,0);
 }finally{db.close();}
});
