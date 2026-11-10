import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createLocalReading } from "../packages/research/local-reading.ts";
import { checkedResult } from "../src/research-coordinator.ts";
import { readingSources, withReadingSources } from "../src/reading-sources.ts";
import type { Operation } from "../src/domain.ts";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
test("complete abstract, long original table, pagination and PDF reuse the migrated reading module", async () => {
  const root = await mkdtemp(join(tmpdir(), "pra-reading-")),
    paper = "2401.00001",
    index = "reading-v1";
  const abstract = "Complete original abstract. ".repeat(100),
    table = "| Model | Value |\n| --- | --- |\n" + "| A | 1 |\n".repeat(300),
    original = "<article>synthetic table</article>";
  const blocks = [
      { kind: "table", text: table, section: "Results", locator: "T1" },
    ],
    hash = sha(original),
    directory = join(
      root,
      ".cache/scientific-reading",
      sha(index).slice(0, 16),
    );
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, paper + ".html"), original);
  await writeFile(
    join(directory, paper + ".json"),
    JSON.stringify({
      version: "scientific-html-v1",
      index_version: index,
      paper_id: paper,
      original_sha256: hash,
      source_url: "https://arxiv.org/html/" + paper + "v1",
      blocks,
      blocks_sha256: sha(JSON.stringify(blocks)),
    }),
  );
  const chunk_id =
    index +
    ":scientific-v1:" +
    paper +
    ":" +
    hash.slice(0, 16) +
    ":0:c0-" +
    table.length;
  const source = {
    paper_id: paper,
    paragraph_id: paper + ":scientific-v1:" + hash.slice(0, 16) + ":0",
    chunk_id,
    text: table,
    section: "Results",
    start: 0,
    end: table.length,
    index_version: index,
    citation: "[" + chunk_id + "]",
    truncated: false,
    content_type: "table",
    format: "markdown",
    source_url: "https://arxiv.org/html/" + paper + "v1#T1",
  };
  const c = {
    indexVersion: index,
    papers: [{ paper_id: paper, title: "Synthetic study", abstract }],
    evidence: [],
  };
  let textReads = 0,
    downloads = 0;
  const reading = await createLocalReading({
    root,
    indexVersion: index,
    papers: c.papers,
    evidence: [],
    worker: {
      async request() {
        textReads++;
        throw Error("Unexpected text fallback");
      },
      async readScientificSources(p) {
        return {
          backend: "scientific-html-v1",
          index_version: index,
          chunks: p.offset ? [] : [source],
          selection: {
            offset: p.offset,
            returned: p.offset ? 0 : 1,
            total: 1,
            next_offset: 1,
            has_more: false,
            unavailable_papers: [],
          },
        };
      },
    },
    fetcher: (async (url) => {
      assert.equal(url, "https://arxiv.org/pdf/" + paper + "v1");
      downloads++;
      return new Response("%PDF-fixture");
    }) as typeof fetch,
  });
  const op = (params: Record<string, unknown>): Operation => ({
    id: "op",
    taskId: "task",
    tool: "retrieve_chunks",
    params,
    indexVersion: index,
    state: "pending",
    deadline: 1,
  });
  try {
    const abs = await reading.execute(
      "retrieve_chunks",
      { paper_ids: [paper], section: "abstract" },
      new AbortController().signal,
    );
    const verified = checkedResult(
      op({ paper_ids: [paper], section: "abstract" }),
      abs.result,
      c,
    );
    assert.ok("chunks" in verified);
    assert.equal(verified.chunks[0].text, abstract);
    assert.equal(textReads, 0);
    const params = {
      query: "table",
      paper_ids: [paper],
      content_type: "table",
      top_k: 1,
    };
    const first = await reading.execute(
      "retrieve_chunks",
      params,
      new AbortController().signal,
    );
    assert.equal(first.sources.length, 1);
    assert.throws(() => checkedResult(op(params), first.result, c));
    const trusted = withReadingSources(
      c,
      readingSources(c, op(params), first.sources),
    );
    assert.equal(
      (checkedResult(op(params), first.result, trusted) as any).chunks[0].text,
      table,
    );
    const next = await reading.execute(
      "retrieve_chunks",
      { ...params, offset: 1 },
      new AbortController().signal,
    );
    assert.equal((next.result as any).chunks.length, 0);
    assert.equal(textReads, 0);
    assert.throws(() =>
      readingSources(c, op(params), [
        {
          ...first.sources[0],
          source_url: "https://evil.example/html/" + paper + "v1",
        },
      ]),
    );
    await reading.pdf(paper);
    await reading.pdf(paper);
    assert.equal(downloads, 1);
    await assert.rejects(() => reading.pdf("2401.99999"));
    await writeFile(join(directory, paper + ".html"), "tampered");
    await assert.rejects(() =>
      reading.execute("retrieve_chunks", params, new AbortController().signal),
    );
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + requireSeparator()));
    await rm(root, { recursive: true, force: true });
  }
});
function requireSeparator() {
  return process.platform === "win32" ? "\\" : "/";
}
