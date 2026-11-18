import test from "node:test";
import assert from "node:assert/strict";
import {
  comparisonEvidence,
  type CoverageReport,
} from "../src/comparison-evidence.ts";

const report: CoverageReport = {
  papers: ["second", "first"],
  dimensions: ["Method", "Result", "Limit"],
  cells: [
    {
      paper_id: "first",
      dimension: "Method",
      status: "supported",
      summary: "Retained statement",
      citations: ["source-a", "source-a"],
    },
    {
      paper_id: "first",
      dimension: "Result",
      status: "supported",
      summary: "Incomplete citation set",
      citations: ["source-a", "out-of-date", "wrong-paper"],
    },
    {
      paper_id: "second",
      dimension: "Method",
      status: "supported",
      summary: "Incorrect attribution",
      citations: ["source-a"],
    },
    {
      paper_id: "second",
      dimension: "Result",
      status: "partial",
      summary: "Only the setting was found",
      citations: ["wrong-paper"],
    },
    {
      paper_id: "second",
      dimension: "Limit",
      status: "missing",
      summary: "Unverified absence",
      citations: [],
    },
  ],
};
const sources = [
  { paper_id: "first", chunk_id: "source-a", index_version: "idx" },
  { paper_id: "first", chunk_id: "out-of-date", index_version: "old" },
  { paper_id: "second", chunk_id: "wrong-paper", index_version: "idx" },
];

test("comparison coverage preserves the task axes and only links retained evidence from the correct paper and index", () => {
  const papers = comparisonEvidence(report, "idx", sources, [
    { paper_id: "first", title: "A title" },
  ]);
  assert.deepEqual(
    papers.map((p) => [p.id, p.title]),
    [
      ["second", "second"],
      ["first", "A title"],
    ],
  );
  assert.deepEqual(
    papers[0].cells.map((c) => c.dimension),
    report.dimensions,
  );
  assert.deepEqual(
    papers[0].cells.map((c) => [c.status, c.summary, c.citations]),
    [
      ["missing", "", []],
      ["partial", "Only the setting was found", ["wrong-paper"]],
      ["missing", "", []],
    ],
  );
  assert.deepEqual(
    papers[1].cells.map((c) => [c.status, c.summary, c.citations]),
    [
      ["supported", "Retained statement", ["source-a"]],
      ["partial", "", ["source-a"]],
      ["pending", "", []],
    ],
  );
});

test("lost or unversioned evidence never leaves a supported conclusion, and recreating the view does not edit the report", () => {
  const frozen = structuredClone(report);
  for (const version of [undefined, "unavailable"]) {
    const view = comparisonEvidence(report, version, sources, []);
    assert.ok(
      view
        .flatMap((p) => p.cells)
        .every(
          (c) =>
            !c.citations.length &&
            !c.summary &&
            !["supported", "partial"].includes(c.status),
        ),
    );
  }
  const old = comparisonEvidence(
    report,
    "idx",
    [{ paper_id: "first", chunk_id: "source-a" }],
    [],
  );
  assert.equal(old[1].cells[0].status, "missing");
  assert.deepEqual(report, frozen);
});
