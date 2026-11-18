import { useState } from "react";
import {
  comparisonEvidence,
  type CoverageReport,
  type CoverageCell,
} from "../src/comparison-evidence.ts";
import { useResource } from "./hooks.ts";
import type { Chunk, Paper } from "./types.ts";

const statusText: Record<CoverageCell["status"], string> = {
  supported: "已关联原文",
  partial: "部分有依据",
  missing: "缺少原文",
  pending: "待核对",
};

export function ComparisonEvidence({
  report,
  index,
  sources,
  onSource,
}: {
  report: CoverageReport;
  index?: string;
  sources: Chunk[];
  onSource: (source: Chunk, catalog?: Paper[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const catalog = useResource<Paper[]>(
    open && index
      ? "papers?indexVersion=" + encodeURIComponent(index)
      : undefined,
  );
  const papers = open
    ? comparisonEvidence(report, index, sources, catalog.value ?? [])
    : [];
  return (
    <details
      className="comparison-coverage"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>逐篇证据覆盖 · {report.papers.length} 篇</summary>
      {open && (
        <>
          <p className="help">
            覆盖状态来自本次研究对已读片段的判断。选择原文可核对结论。
          </p>
          {catalog.error && (
            <button className="text-button" onClick={catalog.reload}>
              重新读取论文题名
            </button>
          )}
          {papers.map((paper) => (
            <section
              key={paper.id}
              aria-label={paper.title}
              className="comparison-paper"
            >
              <h4>{paper.title}</h4>
              <dl>
                {paper.cells.map((cell) => (
                  <div key={cell.dimension} className="comparison-cell">
                    <dt>{cell.dimension}</dt>
                    <dd>
                      <span className={"coverage-state " + cell.status}>
                        {statusText[cell.status]}
                      </span>
                      {cell.summary && <p>{cell.summary}</p>}
                      {cell.citations.map((id, i) => (
                        <button
                          key={id}
                          className="text-button"
                          aria-label={cell.dimension + "，原文 " + (i + 1)}
                          onClick={() => {
                            const source = sources.find(
                              (s) =>
                                s.chunk_id === id &&
                                s.paper_id === paper.id &&
                                s.index_version === index,
                            );
                            if (source)
                              onSource(source, catalog.value);
                          }}
                        >
                          原文 {i + 1}
                        </button>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </>
      )}
    </details>
  );
}
