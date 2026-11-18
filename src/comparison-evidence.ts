import type { ResearchWorkflow } from "../packages/research/cloud-workflow.ts";
import type { Chunk, Paper } from "../packages/research/core.ts";

export type CoverageReport = Pick<
  NonNullable<ResearchWorkflow["comparison"]>,
  "papers" | "dimensions" | "cells"
>;
type Cell = CoverageReport["cells"][number];
export type CoverageCell = Pick<
  Cell,
  "dimension" | "status" | "summary" | "citations"
>;
export interface PaperCoverageView {
  id: string;
  title: string;
  cells: CoverageCell[];
}

export interface ComparisonSnapshot {
  indexVersion: string;
  papers: PaperCoverageView[];
}

export const coverageLabels: Record<CoverageCell["status"], string> = {
  supported: "已关联原文",
  partial: "部分有依据",
  missing: "缺少原文",
  pending: "待核对",
};

function retainedCell(
  dimension: string,
  saved: Cell | undefined,
  retained?: Set<string>,
): CoverageCell {
  if (!saved || saved.status === "pending")
    return { dimension, status: "pending", summary: "", citations: [] };
  const cited = [...new Set(saved.citations)];
  const citations = cited.filter((id) => retained?.has(id));
  if (!citations.length || saved.status === "missing")
    return { dimension, status: "missing", summary: "", citations: [] };
  if (citations.length !== cited.length)
    return { dimension, status: "partial", summary: "", citations };
  return { dimension, status: saved.status, summary: saved.summary, citations };
}

/** Project AsterCite's existing coverage onto the original evidence still available to this task. */
export function comparisonEvidence(
  report: CoverageReport,
  index: string | undefined,
  sources: readonly Pick<Chunk, "chunk_id" | "paper_id" | "index_version">[],
  catalog: readonly Pick<Paper, "paper_id" | "title">[],
): PaperCoverageView[] {
  const retained = new Map<string, Set<string>>();
  for (const source of sources) {
    if (!index || source.index_version !== index) continue;
    const set = retained.get(source.paper_id) ?? new Set<string>();
    set.add(source.chunk_id);
    retained.set(source.paper_id, set);
  }
  const saved = new Map(
    report.cells.map((cell) => [
      JSON.stringify([cell.paper_id, cell.dimension]),
      cell,
    ]),
  );
  const titles = new Map(catalog.map((paper) => [paper.paper_id, paper.title]));
  return report.papers.map((id) => ({
    id,
    title: titles.get(id) || id,
    cells: report.dimensions.map((dimension) =>
      retainedCell(
        dimension,
        saved.get(JSON.stringify([id, dimension])),
        retained.get(id),
      ),
    ),
  }));
}
