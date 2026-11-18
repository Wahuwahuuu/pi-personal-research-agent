import type { Memory } from "./types.ts";

export function memorySourceLabel(memory: Memory) {
  switch (memory.sourceStatus) {
    case "verified": return "引文已核对，结论含义待审阅";
    case "needs_review": return "人工修改后待重新核对原文";
    case "stale": return "原文版本已变化，需重新核对";
    default: return "";
  }
}

export function MemoryEvidence({memory}: {memory: Memory}) {
  if (!memory.sources?.length) return null;
  return (
    <details className="memory-evidence">
      <summary>原文依据 · {memory.sources.length} 处</summary>
      {memory.sources.map((s, i) => (
        <figure key={s.chunk_id + ":" + i}>
          <blockquote>{s.quote}</blockquote>
          <figcaption>
            {s.paper_id} · {s.section}
            <details className="diagnostics">
              <summary>定位详情</summary>
              <p>{s.chunk_id} · 字符 {s.quote_start}–{s.quote_end} · 版本 {s.index_version}</p>
            </details>
          </figcaption>
        </figure>
      ))}
    </details>
  );
}
