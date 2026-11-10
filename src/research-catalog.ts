import { Problem, text } from "./domain.ts";
import type {
  Paper,
  EvidenceIdentity,
  Chunk,
} from "../packages/research/core.ts";
export interface ResearchCatalog {
  indexVersion: string;
  papers: Paper[];
  evidence: EvidenceIdentity[];
  sources?: Chunk[];
}
/** Accept metadata only; never retain arbitrary device-provided fields. */
export function validateCatalog(value: unknown): ResearchCatalog {
  const v = value as ResearchCatalog;
  if (
    !v ||
    !Array.isArray(v.papers) ||
    !Array.isArray(v.evidence) ||
    v.papers.length > 5000 ||
    v.evidence.length > 50000
  )
    throw new Problem("INVALID_CATALOG");
  const indexVersion = text(v.indexVersion, 256),
    ids = new Set<string>(),
    chunks = new Set<string>();
  const papers = v.papers.map((p) => {
    const id = text(p.paper_id, 256);
    if (
      ids.has(id) ||
      typeof p.abstract !== "string" ||
      p.abstract.length > 20000
    )
      throw new Problem("INVALID_CATALOG");
    ids.add(id);
    return { paper_id: id, title: text(p.title, 2000), abstract: p.abstract };
  });
  const evidence = v.evidence.map((e) => {
    const chunk_id = text(e.chunk_id, 512),
      paper_id = text(e.paper_id, 256),
      paragraph_id = text(e.paragraph_id, 512);
    if (
      chunks.has(chunk_id) ||
      !ids.has(paper_id) ||
      e.index_version !== indexVersion ||
      !Number.isSafeInteger(e.start) ||
      !Number.isSafeInteger(e.end) ||
      e.start < 0 ||
      e.end <= e.start ||
      !/^[a-f0-9]{64}$/.test(e.text_sha256)
    )
      throw new Problem("INVALID_CATALOG");
    chunks.add(chunk_id);
    return {
      chunk_id,
      paper_id,
      paragraph_id,
      start: e.start,
      end: e.end,
      index_version: indexVersion,
      text_sha256: e.text_sha256,
    };
  });
  return { indexVersion, papers, evidence };
}
