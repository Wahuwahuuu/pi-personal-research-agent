import { test } from "node:test";
import assert from "node:assert/strict";
import { discover } from "../src/discovery.ts";
const until = Date.parse("2026-11-12T00:00:00Z"),
  from = until - 7 * 86400000;
const entry = (i: number, updated: number) => ({
  id: "2601." + String(i).padStart(5, "0") + "v2",
  updated: new Date(updated).toISOString(),
});
function feed(rows: ReturnType<typeof entry>[], total = rows.length) {
  return (
    "<feed><opensearch:totalResults>" +
    total +
    "</opensearch:totalResults>" +
    rows
      .map(
        (p) =>
          "<entry><id>https://arxiv.org/abs/" +
          p.id +
          "</id><title>Public fixture</title><summary>Fixture</summary><published>2020-01-01T00:00:00Z</published><updated>" +
          p.updated +
          "</updated></entry>",
      )
      .join("") +
    "</feed>"
  );
}
test("official update ordering recovers 1000 in-window changes to old papers and counts scanned rows separately", async () => {
  const rows = [
    entry(1001, until + 60000),
    entry(1002, until + 30000),
    ...Array.from({ length: 1000 }, (_, i) => entry(i, until - i * 1000)),
    entry(1003, from - 1000),
  ];
  let offset = 0;
  const ids = new Set<string>(),
    starts: number[] = [];
  const fetcher: typeof fetch = async (input) => {
    const u = new URL(String(input));
    assert.equal(u.searchParams.get("search_query"), "all:research");
    assert.equal(u.searchParams.get("sortBy"), "lastUpdatedDate");
    assert.equal(u.searchParams.get("sortOrder"), "descending");
    assert.equal(u.searchParams.get("max_results"), "200");
    const start = Number(u.searchParams.get("start"));
    starts.push(start);
    return new Response(feed(rows.slice(start, start + 200), rows.length));
  };
  for (let i = 0; i < 7; i++) {
    const p = await discover("research", from, until, offset, fetcher);
    for (const row of p.rows) ids.add(row.id + row.version);
    offset = p.nextOffset;
    if (p.complete) break;
  }
  assert.equal(ids.size, 1000);
  assert.equal(offset, 1003);
  assert.deepEqual(starts, [0, 200, 400, 600, 800, 1000]);
  for (let i = 0; i < 1000; i++) assert.ok(ids.has(entry(i, until).id));
});
test("future-only pages advance scan offset, and an old row ends the overlap window without saving it", async () => {
  const future = await discover(
    "research",
    from,
    until,
    0,
    async () => new Response(feed([entry(1, until + 1000)], 2)),
  );
  assert.equal(future.rows.length, 0);
  assert.equal(future.complete, false);
  assert.equal(future.nextOffset, 1);
  const old = await discover(
    "research",
    from,
    until,
    1,
    async () => new Response(feed([entry(2, from - 1)], 2000)),
  );
  assert.equal(old.complete, true);
  assert.equal(old.rows.length, 0);
  assert.equal(old.nextOffset, 2);
});
test("unordered and capped source scans fail instead of claiming complete historical coverage", async () => {
  await assert.rejects(
    () =>
      discover(
        "research",
        from,
        until,
        0,
        async () => new Response(feed([entry(1, from), entry(2, until)])),
      ),
    /SOURCE_ORDER_INVALID/,
  );
  await assert.rejects(
    () =>
      discover(
        "research",
        from,
        until,
        29800,
        async () =>
          new Response(
            feed(
              Array.from({ length: 200 }, (_, i) => entry(i, until)),
              40000,
            ),
          ),
      ),
    /SOURCE_WINDOW_LIMIT/,
  );
  let requested = false;
  await assert.rejects(
    () =>
      discover("research", from, until, 30000, async () => {
        requested = true;
        return new Response("");
      }),
    /SOURCE_WINDOW_LIMIT/,
  );
  assert.equal(requested, false);
});
