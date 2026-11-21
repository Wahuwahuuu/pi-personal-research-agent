import type {ClaimAttribution} from "./internal/agent/citation-attribution.ts";
import {readWorkbenchDraft} from "./internal/agent/workbench-answer.ts";

export interface CitationRepairTarget {id:string;kind:"claim"|"reference";original:string;start:number;end:number}
/** Targets identify exact, non-overlapping text in one stored draft, never a guessed source. */
export function citationRepairTargets(answer:string,claims:readonly ClaimAttribution[],known:ReadonlySet<string>):CitationRepairTarget[]{
 answer=readWorkbenchDraft(answer)??answer;
 const targets:CitationRepairTarget[]=[];
 const add=(original:string,start:number,kind:CitationRepairTarget["kind"])=>{
  if(start<0||!original||original.length>12000||targets.length>=24)return;
  const end=start+original.length;
  if(targets.some(t=>start<t.end&&end>t.start))return;
  targets.push({id:"repair-"+(targets.length+1),kind,original,start,end});
 };
 for(const claim of claims){
  if(!claim.unmatched_values.length)continue;
  const start=answer.indexOf(claim.claim);
  if(start===answer.lastIndexOf(claim.claim))add(claim.claim,start,"claim");
 }
 for(const marker of answer.matchAll(/\[cite:([^\]\n]+)\]/g))
  if(!known.has(marker[1]))add(marker[0],marker.index,"reference");
 return targets;
}

/** Apply explicit model edits atomically; all source/number validation still follows this step. */
export function applyCitationRepairs(answer:string,targets:readonly CitationRepairTarget[],value:unknown):string {
 answer=readWorkbenchDraft(answer)??answer;
 if(!Array.isArray(value)||!value.length||value.length>24)throw Error("INVALID_CITATION_REPAIR");
 const edits:{target:CitationRepairTarget;replacement:string}[]=[],seen=new Set<string>();
 let added=0;
 for(const row of value){
  if(!row||typeof row!=="object"||typeof row.target!=="string"||typeof row.replacement!=="string"||seen.has(row.target))throw Error("INVALID_CITATION_REPAIR");
  const target=targets.find(t=>t.id===row.target);
  if(!target||answer.slice(target.start,target.end)!==target.original||row.replacement.length>12000)throw Error("INVALID_CITATION_REPAIR");
  if(target.kind==="reference"&&row.replacement!==""&&!/^\[cite:[^\]\n]+\]$/.test(row.replacement))throw Error("INVALID_CITATION_REPAIR");
  added+=row.replacement.length;if(added>24000)throw Error("INVALID_CITATION_REPAIR");
  seen.add(row.target);edits.push({target,replacement:row.replacement});
 }
 let result=answer;
 for(const {target,replacement} of edits.sort((a,b)=>b.target.start-a.target.start))result=result.slice(0,target.start)+replacement+result.slice(target.end);
 return result;
}
