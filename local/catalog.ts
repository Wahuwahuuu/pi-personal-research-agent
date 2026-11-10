import { createHash } from "node:crypto";
import { loadCorpusIndex } from "../packages/research/catalog.ts";
import {
  validateCatalog,
  type ResearchCatalog,
} from "../src/research-catalog.ts";
import type { PythonConfig } from "./python.ts";
export async function nodeCatalog(
  config?: PythonConfig,
  fixture = false,
): Promise<ResearchCatalog> {
  if (fixture)
    return validateCatalog({
      indexVersion: "fixture-v1",
      papers: [
        {
          paper_id: "fixture-paper",
          title: "Deterministic research fixture",
          abstract: "Not a scientific evaluation.",
        },
      ],
      evidence: [
        {
          paper_id: "fixture-paper",
          chunk_id: "fixture-chunk",
          paragraph_id: "p1",
          start: 0,
          end: 9,
          index_version: "fixture-v1",
          text_sha256: createHash("sha256").update("Evidence.").digest("hex"),
        },
      ],
    });
  if (!config?.index) throw Error("VERIFIED_INDEX_REQUIRED");
  const c = await loadCorpusIndex(config.corpus, config.index, config.device);
  if (c.indexVersion !== config.indexVersion) throw Error("INDEX_CHANGED");
  return validateCatalog({
    indexVersion: c.indexVersion,
    papers: c.publicPapers,
    evidence: [...c.evidenceIndex.values()],
  });
}
export function catalogPages(c: ResearchCatalog): string[] {
  const raw = JSON.stringify(c);
  if (Buffer.byteLength(raw) > 16000000) throw Error("CATALOG_SIZE");
  const pages: string[] = [];
  for (let i = 0; i < raw.length; i += 200000)
    pages.push(raw.slice(i, i + 200000));
  return pages;
}
