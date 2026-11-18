import { useState } from "react";
import {
  comparisonEvidence,
  coverageLabels,
  type CoverageReport,
  type ComparisonSnapshot,
  type PaperCoverageView,
} from "../src/comparison-evidence.ts";
import { useResource } from "./hooks.ts";
import type { Chunk, Paper } from "./types.ts";

function CoverageRows({
  papers,
  index,
  sources,
  onSource,
}: {
  papers: PaperCoverageView[];
  index?: string;
  sources: Chunk[];
  onSource: (source: Chunk, paper: PaperCoverageView) => void;
}) {
  return papers.map((paper) => (
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
                {coverageLabels[cell.status]}
              </span>
              {cell.summary && <p>{cell.summary}</p>}
              {cell.citations.map((id, i) => {
                const original = sources.find(
                  (s) =>
                    s.chunk_id === id &&
                    s.paper_id === paper.id &&
                    s.index_version === index,
                );
                return (
                  original && (
                    <button
                      key={id}
                      className="text-button"
                      aria-label={cell.dimension + "，原文 " + (i + 1)}
                      onClick={() => onSource(original, paper)}
                    >
                      原文 {i + 1}
                    </button>
                  )
                );
              })}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  ));
}

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
          <CoverageRows
            papers={comparisonEvidence(
              report,
              index,
              sources,
              catalog.value ?? [],
            )}
            index={index}
            sources={sources}
            onSource={(source) => onSource(source, catalog.value)}
          />
        </>
      )}
    </details>
  );
}

export function SavedComparisonEvidence({
  snapshot,
  sources,
  onSource,
}: {
  snapshot: ComparisonSnapshot;
  sources: Chunk[];
  onSource: (source: Chunk, title: string) => void;
}) {
  return (
    <details className="comparison-coverage">
      <summary>保存时的比较证据 · {snapshot.papers.length} 篇</summary>
      <p className="help">
        这些记录来自首次保存成果时的研究。你可以打开当时的原文，核对各项依据。
      </p>
      <CoverageRows
        papers={snapshot.papers}
        index={snapshot.indexVersion}
        sources={sources}
        onSource={(source, paper) => onSource(source, paper.title)}
      />
    </details>
  );
}
