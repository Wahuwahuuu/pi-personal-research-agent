import {
  coverageLabels,
  type ComparisonSnapshot,
} from "./comparison-evidence.ts";
import type { Chunk } from "../packages/research/core.ts";

const columns = ["论文", "比较维度", "覆盖状态", "研究时的记录", "原文"];
const comparisonHeading = "保存时的比较证据";

function markdownCell(value: string) {
  return value
    .replace(/[\r\n]+/g, " ")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\\|*\x60_~[\]!]/g, "\\$&");
}

export function exportComparison(
  snapshot: ComparisonSnapshot,
  sources: readonly Chunk[],
  format: "md" | "html",
  escapeHtml: (s: string) => string,
) {
  const references = new Map<string, number>();
  for (const [i, s] of sources.entries()) {
    if (s.index_version === snapshot.indexVersion)
      references.set(JSON.stringify([s.paper_id, s.chunk_id]), i + 1);
  }
  const rows = snapshot.papers.flatMap((p) =>
    p.cells.map((cell) => {
      const links = cell.citations.flatMap((id) => {
        const n = references.get(JSON.stringify([p.id, id]));
        return n === undefined ? [] : ["出处 " + n];
      });
      return [
        p.title,
        cell.dimension,
        coverageLabels[cell.status],
        cell.summary || "—",
        links.join("、") || "—",
      ];
    }),
  );
  if (format === "html") {
    return (
      "<section><h2>" +
      comparisonHeading +
      "</h2><table><thead><tr>" +
      columns
        .map((c) => '<th scope="col">' + escapeHtml(c) + "</th>")
        .join("") +
      "</tr></thead><tbody>" +
      rows
        .map(
          (row) =>
            "<tr>" +
            row.map((c) => "<td>" + escapeHtml(c) + "</td>").join("") +
            "</tr>",
        )
        .join("") +
      "</tbody></table></section>"
    );
  }
  const line = (values: string[]) =>
    "| " + values.map(markdownCell).join(" | ") + " |";
  return (
    "## " +
    comparisonHeading +
    "\n\n" +
    [line(columns), line(columns.map(() => "---")), ...rows.map(line)].join(
      "\n",
    )
  );
}
