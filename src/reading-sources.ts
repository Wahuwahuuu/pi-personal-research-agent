import {isScientificUrl} from "../packages/research/source-links.ts";
import { createHash } from "node:crypto";
import { Problem, type Operation } from "./domain.ts";
import type { ResearchCatalog } from "./research-catalog.ts";
import type { Chunk, EvidenceIdentity } from "../packages/research/core.ts";
/** The paired local node first verifies its HTML cache against the downloaded original. The cloud trusts that device, not model-supplied identities. */
export function readingSources(
  c: ResearchCatalog,
  op: Operation,
  raw: unknown,
): { sources: Chunk[]; identities: EvidenceIdentity[] } {
  if (!Array.isArray(raw) || raw.length > 20 || op.tool !== "retrieve_chunks")
    throw new Problem("INVALID_READING_SOURCES");
  const sources: Chunk[] = [],
    identities: EvidenceIdentity[] = [];
  for (const value of raw) {
    const v = value as Chunk;
    if (
      !v ||
      typeof v.text !== "string" ||
      Array.from(v.text).length > 16000 ||
      v.start !== 0 ||
      v.end !== Array.from(v.text).length ||
      v.end === 0 ||
      v.index_version !== c.indexVersion ||
      !["table", "equation"].includes(v.content_type ?? "") ||
      !c.papers.some((p) => p.paper_id === v.paper_id) ||
      !(op.params.paper_ids as string[])?.includes(v.paper_id) ||
      typeof v.chunk_id !== "string" ||
      !["scientific-v1","scientific-v2"].some(schema=>v.chunk_id.startsWith(c.indexVersion + ":" + schema + ":" + v.paper_id + ":")) ||
      typeof v.section !== "string" ||
      typeof v.paragraph_id !== "string" ||
      v.citation !== "[" + v.chunk_id + "]" ||
      v.truncated !== false
    )
      throw new Problem("INVALID_READING_SOURCES");
    const url = new URL(v.source_url ?? "");
    if (!isScientificUrl(url.href,v.paper_id))
      throw new Problem("INVALID_SOURCE_URL");
    const source: Chunk = {
      paper_id: v.paper_id,
      paragraph_id: v.paragraph_id,
      chunk_id: v.chunk_id,
      text: v.text,
      start: 0,
      end: v.end,
      index_version: v.index_version,
      citation: v.citation,
      truncated: false,
      section: v.section,
      format: "markdown",
      content_type: v.content_type,
      source_url: url.href,
    };
    const identity = {
      paper_id: source.paper_id,
      paragraph_id: source.paragraph_id,
      chunk_id: source.chunk_id,
      start: 0,
      end: source.end,
      index_version: c.indexVersion,
      text_sha256: createHash("sha256").update(source.text).digest("hex"),
    };
    const prior = c.evidence.find((e) => e.chunk_id === identity.chunk_id);
    if (
      prior &&
      JSON.stringify(prior) !== JSON.stringify(identity) &&
      ["text_sha256", "paper_id", "paragraph_id", "start", "end"].some(
        (k) =>
          prior[k as keyof EvidenceIdentity] !==
          identity[k as keyof EvidenceIdentity],
      )
    )
      throw new Problem("SOURCE_CONFLICT");
    sources.push(source);
    identities.push(identity);
  }
  return { sources, identities };
}
export function withReadingSources(
  c: ResearchCatalog,
  patch: ReturnType<typeof readingSources>,
): ResearchCatalog {
  return {
    ...c,
    evidence: [
      ...new Map(
        [...c.evidence, ...patch.identities].map((e) => [e.chunk_id, e]),
      ).values(),
    ],
    sources: [
      ...new Map(
        [...(c.sources ?? []), ...patch.sources].map((e) => [e.chunk_id, e]),
      ).values(),
    ],
  };
}
