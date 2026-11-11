import {createHash} from "node:crypto";
import {parseMemoryDigest,MEMORY_SYNTHESIS_INSTRUCTION,readingMemoryContent,type MemoryDigest} from "./internal/agent/memory-synthesis.ts";
import {sourceMatches} from "./internal/agent/domain-memory.ts";
import type {Chunk,EvidenceIdentity,Paper} from "./core.ts";
import type {CloudMemoryEntry} from "./cloud-memory.ts";
export {parseMemoryDigest,MEMORY_SYNTHESIS_INSTRUCTION,type MemoryDigest};
export function validateMemoryDigest(text:string,version:string,identities:readonly EvidenceIdentity[],sources:readonly Chunk[]){
 const index=new Map(identities.map(i=>[i.chunk_id,i])),evidence=new Map(sources.filter(s=>sourceMatches(s,version,index)).map(s=>[s.chunk_id,s]));
 return parseMemoryDigest(text,[...new Set([...evidence.values()].map(e=>e.paper_id))],evidence);
}
/** Metadata accompanies the original memory service; the module owns all source validation. */
export function digestEntries(digest:MemoryDigest,source:readonly Chunk[],papers:readonly Paper[],session:string,turn:string,projectId:string):Array<Omit<CloudMemoryEntry,"id"|"created_at"|"updated_at">>{
 const evidence=new Map(source.map(s=>[s.chunk_id,s])),result:Array<Omit<CloudMemoryEntry,"id"|"created_at"|"updated_at">>=[];
 for(const row of digest.readings){
  const citations=row.key_points.flatMap(p=>{const chunk=evidence.get(p.chunk_id);if(!chunk||chunk.paper_id!==row.paper_id||!chunk.text.includes(p.quote))return[];const offset=Array.from(chunk.text.slice(0,chunk.text.indexOf(p.quote))).length;return[{paper_id:chunk.paper_id,paragraph_id:chunk.paragraph_id,chunk_id:chunk.chunk_id,index_version:chunk.index_version!,section:chunk.section,quote:p.quote,quote_start:chunk.start+offset,quote_end:chunk.start+offset+Array.from(p.quote).length,source_text_sha256:createHash("sha256").update(chunk.text).digest("hex"),source_start:chunk.start,source_end:chunk.end}];});
  result.push({kind:"reading",category:citations.length?"conclusion":"reading",content:readingMemoryContent(papers.find(p=>p.paper_id===row.paper_id)?.title??row.paper_id,row),paper_ids:[row.paper_id],source_session:session,source_turn:turn,slot:"reading:v2:"+row.paper_id,edited:false,projectId,sources:citations,sourceStatus:citations.length?"verified":"unavailable",semanticStatus:"unreviewed",active:true});
  for(const question of row.open_questions)result.push({kind:"note",category:"question",content:question,paper_ids:[row.paper_id],source_session:session,source_turn:turn,slot:"question:"+row.paper_id+":"+createHash("sha256").update(question).digest("hex"),edited:false,projectId,active:true,semanticStatus:"unreviewed",sourceStatus:"unavailable",sources:[]});
 }return result;
}
