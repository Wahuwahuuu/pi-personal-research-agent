import { XMLParser } from "fast-xml-parser";
import { Problem, type Paper } from "./domain.ts";
export async function discover(
  query: string,
  from: number,
  until: number,
  offset: number,
  fetcher: typeof fetch = fetch,
) {
  const stamp = (n: number) =>
    new Date(n).toISOString().replace(/[-:T]/g, "").slice(0, 12);
  const url = new URL("https://export.arxiv.org/api/query");
  // Query text cannot inject arXiv boolean/date operators.
  const words = query.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 20);
  if (!words?.length) throw new Problem("INVALID_QUERY");
  url.searchParams.set(
    "search_query",
    `(${words.map((w) => `all:${w}`).join(" AND ")}) AND lastUpdatedDate:[${stamp(from)} TO ${stamp(until)}]`,
  );
  url.searchParams.set("sortBy", "lastUpdatedDate");
  url.searchParams.set("sortOrder", "ascending");
  url.searchParams.set("start", String(offset));
  url.searchParams.set("max_results", "200");
  const response = await fetcher(url, {
    headers: {
      "User-Agent": "PersonalResearchAgent/0.1 (personal metadata research)",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Problem("SOURCE_UNAVAILABLE", 503);
  const xml = await response.text();
  if (xml.length > 2000000) throw new Problem("SOURCE_TOO_LARGE", 502);
  return parseFeed(xml, offset);
}
export function parseFeed(xml: string, offset = 0) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Problem("UNSAFE_XML");
  const feed = new XMLParser({
    ignoreAttributes: false,
    processEntities: false,
  }).parse(xml).feed;
  if (!feed) throw new Problem("INVALID_FEED");
  const raw = feed.entry
    ? Array.isArray(feed.entry)
      ? feed.entry
      : [feed.entry]
    : [];
  const rows: Paper[] = raw.map((p: Record<string, unknown>) => {
    const url = String(p.id),
      match = url.match(/^https?:\/\/arxiv\.org\/abs\/(.+?)(v\d+)$/);
    if (!match) throw new Problem("INVALID_ARXIV_ID");
    const published = String(p.published),
      updated = String(p.updated);
    if (
      !Number.isFinite(Date.parse(updated)) ||
      !Number.isFinite(Date.parse(published))
    )
      throw new Problem("INVALID_DATE");
    return {
      id: match[1],
      version: match[2],
      title: String(p.title).trim(),
      summary: String(p.summary).trim(),
      published,
      updated,
      url: url.replace("http:", "https:"),
    };
  });
  const total = Number(feed["opensearch:totalResults"]);
  if (!Number.isInteger(total) || total < 0)
    throw new Problem("INVALID_FEED_TOTAL");
  if (rows.length === 0 && offset < total)
    throw new Problem("INCOMPLETE_PAGE", 503);
  return { rows, complete: offset + rows.length >= total };
}
