import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialState,
  submit,
  cancel,
  operation,
  acceptResult,
  expire,
  reserve,
  settle,
  memory,
  notice,
  startBatch,
  commitPage,
  type Paper,
} from "../src/domain.ts";
import { parseFeed } from "../src/discovery.ts";
test("100 RPCs preserve identity; 50 operations replay five times", () => {
  const s = initialState();
  for (let i = 0; i < 100; i++) {
    const t = submit(s, "q" + i, "req" + i, "research");
    const o = operation(s, t, "v1", "retrieve_chunks", {});
    const result = {
      index_version: "v1",
      chunks: [
        { paper_id: "p", chunk_id: "c", text: "证据", start: 0, end: 2 },
      ],
    };
    assert.equal(acceptResult(s, o.id, "v1", result), "accepted");
    if (i < 50)
      for (let k = 0; k < 5; k++)
        assert.equal(acceptResult(s, o.id, "v1", result), "duplicate");
    assert.deepEqual(t.evidence, result);
  }
  assert.equal(s.operations.length, 100);
});
test("100 serialized state roundtrips preserve submission idempotency (not crash injection)", () => {
  for (let i = 0; i < 100; i++) {
    const s = initialState();
    const t = submit(s, "q", "r", "chat");
    const restored = JSON.parse(JSON.stringify(s));
    assert.equal(submit(restored, "q", "r", "chat").id, t.id);
    assert.equal(restored.tasks.length, 1);
    assert.throws(() => submit(restored, "other", "r", "chat"));
  }
});
test("30 offline expiries and cancelled late results", () => {
  const s = initialState();
  for (let i = 0; i < 30; i++) {
    const t = submit(s, "q", "r" + i, "research");
    const o = operation(s, t, "v1", "search_papers", {});
    o.state = "sent";
    o.deadline = 50;
    t.status = "running";
    expire(s, 51);
    assert.equal(t.status, "waiting_device");
    assert.equal(t.calls, 0);
    cancel(s, t.id);
    assert.equal(acceptResult(s, o.id, "v1", {}), "discarded");
  }
});
test("20 budget loop cases stop at six model calls", () => {
  for (let k = 0; k < 20; k++) {
    const s = initialState(),
      t = submit(s, "q", "r", "chat");
    for (let i = 0; i < 6; i++) {
      reserve(s, t, 100, 20);
      settle(s, 100, 20, { input: 80, output: 10 });
    }
    assert.throws(() => reserve(s, t, 100, 20));
    assert.equal(s.usage.requests, 6);
    assert.equal(s.usage.input, 480);
  }
});
test("budget reserves unknown billed output conservatively", () => {
  const s = initialState(),
    t = submit(s, "q", "r", "chat");
  s.usage.output = 999990;
  assert.throws(() => reserve(s, t, 100, 20));
  assert.equal(t.calls, 0);
});
test("execution budget counts local work once and excludes disconnected wall time", () => {
  const s = initialState(),
    t = submit(s, "q", "r", "research"),
    op = operation(s, t, "v1", "search_papers", {});
  const result = { index_version: "v1", papers: [] };
  acceptResult(s, op.id, "v1", result, 86400000, 179999);
  acceptResult(s, op.id, "v1", result, 172800000, 179999);
  assert.equal(t.activeMs, 179999);
  t.activeMs++;
  assert.throws(() => reserve(s, t, 100, 20));
});
test("1000 unique records, duplicates, page checkpoints and 50 summary repeats", () => {
  const s = initialState(),
    p = { id: "p", query: "agents", enabled: true, cursor: 0, next: 0 };
  s.plans.push(p);
  startBatch(p, 1000);
  const rows: Paper[] = Array.from({ length: 1000 }, (_, i) => ({
    id: String(i),
    version: "v1",
    title: "Paper",
    summary: "s",
    published: "2026-01-01",
    updated: "2026-01-01",
    url: "https://arxiv.org/abs/" + i + "v1",
  }));
  for (let i = 0; i < 5; i++)
    commitPage(s, p, rows.slice(i * 200, i * 200 + 200), false);
  assert.equal(p.cursor, 0);
  commitPage(s, p, rows.slice(0, 20), true, 1000);
  assert.equal(Object.keys(s.papers).length, 1000);
  assert.equal(p.cursor, 1000);
  assert.equal(s.notices.length, 1);
  for (let i = 0; i < 50; i++) notice(s, s.notices[0].id, "updated");
  assert.equal(s.notices.length, 1);
  startBatch(p, 2000);
  commitPage(s, p, rows, true, 2000);
  assert.equal(s.notices.length, 1);
});
test("memory corrections and deletions do not resurrect from state", () => {
  const s = initialState();
  for (let i = 0; i < 20; i++) memory(s, undefined, "old" + i, "user");
  for (let i = 0; i < 10; i++) memory(s, s.memories[i].id, "new" + i, "user");
  s.memories.splice(10);
  const restored = JSON.parse(JSON.stringify(s));
  assert.equal(restored.memories.length, 10);
  assert.ok(
    restored.memories.every((m: { content: string }) =>
      m.content.startsWith("new"),
    ),
  );
});
test("separate domain states do not alias (not cross-user HTTP authorization coverage)", () => {
  const a = initialState(),
    b = initialState();
  for (let i = 0; i < 100; i++) memory(a, undefined, "private" + i, "user");
  assert.equal(b.memories.length, 0);
});
test("arXiv parser rejects entities and incomplete pages", () => {
  assert.throws(() => parseFeed("<!DOCTYPE x><feed/>"));
  assert.throws(() =>
    parseFeed(
      "<feed><opensearch:totalResults>2</opensearch:totalResults></feed>",
    ),
  );
});
