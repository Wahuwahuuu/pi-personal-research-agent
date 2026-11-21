import {createHash} from "node:crypto";
import {normalizeVisibleCitationGroups} from "./internal/agent/workbench-answer.ts";

export interface VisibleCitations {
  visibleSourceIds?: string[];
  citationLabels?: string[];
}

/** The canonical ID and source text always remain in the evidence projection. */
export function citationLabels(task: string, index: string, ids: ReadonlySet<string>): Map<string,string> {
  const byId = new Map<string,string>();
  const owners = new Map<string,string>();
  for (const id of ids) {
    if (id.length <= 24 || !/^[A-Za-z0-9_:.\/-]+$/.test(id)) continue;
    const digest = createHash("sha256").update(JSON.stringify([task,index,id])).digest("hex");
    const label = "ref-" + digest.slice(0,12);
    // A real ID always takes precedence. An ambiguous label is never issued.
    if (ids.has(label)) continue;
    const owner = owners.get(label);
    if (owner !== undefined) {
      byId.delete(owner);
    } else {
      owners.set(label,id);
      byId.set(id,label);
    }
  }
  return byId;
}

/** Expand only an exact marker actually sent in this durable generation. */
export function expandVisibleCitations(text: string, window: VisibleCitations): string {
  const {visibleSourceIds, citationLabels} = window;
  if (!citationLabels?.length || !visibleSourceIds || visibleSourceIds.length !== citationLabels.length || !text.includes("ref-")) return text;
  const canonical = new Set(visibleSourceIds);
  const byLabel = new Map<string,string>();
  citationLabels.forEach((label,i) => { if (label) byLabel.set(label,visibleSourceIds[i]); });
  const grouped = normalizeVisibleCitationGroups(text,{has: id => byLabel.has(id) || canonical.has(id)});
  const expanded=grouped.replace(/\[cite:(ref-[a-f0-9]{12})\]/g,(marker,label:string) => {
    const id = byLabel.get(label);
    return id ? "[cite:" + id + "]" : marker;
  });
  // Resolve source-identity fields only; ordinary text and paper IDs are not aliases.
  try {
    const raw=JSON.parse(expanded.trim().replace(/^```(?:json)?\s*/iu,"").replace(/\s*```$/u,""));
    if(!raw||typeof raw!=="object"||Array.isArray(raw))return expanded;
    let changed=false;
    const id=(value:unknown)=>{const canonical=typeof value==="string"?byLabel.get(value):undefined;if(canonical){changed=true;return canonical;}return value;};
    for(const update of Array.isArray(raw.execution?.goal_updates)?raw.execution.goal_updates:[])
      if(update&&typeof update==="object"&&Array.isArray(update.source_ids))update.source_ids=update.source_ids.map(id);
    for(const quote of Array.isArray(raw.exact_quotes)?raw.exact_quotes:[])
      if(quote&&typeof quote==="object")quote.chunk_id=id(quote.chunk_id);
    for(const coverage of Array.isArray(raw.paper_coverage)?raw.paper_coverage:[])
      if(coverage&&typeof coverage==="object"&&Array.isArray(coverage.citations))coverage.citations=coverage.citations.map(id);
    return changed?JSON.stringify(raw):expanded;
  }catch{return expanded;}
}
