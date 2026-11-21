import type {Chunk} from './contracts.ts';

const normalized=(text:string)=>text.normalize('NFKC').replace(/[‘’]/gu,"'").replace(/[“”]/gu,'"').replace(/\s+/gu,' ').trim();

/** Ellipses omit text; they never allow fragments to be reordered. */
export function containsQuotation(source:string,quote:string):boolean {
  const text=normalized(source),parts=quote.split(/\.{3,}|…+/u).map(normalized).filter(Boolean);
  if(!parts.length)return false;
  let offset=0;
  for(const part of parts){const at=text.indexOf(part,offset);if(at<0)return false;offset=at+part.length;}
  return true;
}

/** Only explicit original quotations are checked. This does not judge paraphrase entailment. */
export function inspectQuoteAttribution(answer:string,evidence:ReadonlyMap<string,Chunk>):{answer:string;issues:string[];corrected:number;checked:number} {
  const issues:string[]=[];let corrected=0,checked=0,fence:string|undefined;
  const lines=answer.split('\n').map(line=>{
    const boundary=/^\s*(?:>\s*)?(`{3,}|~{3,})/u.exec(line);
    if(boundary){if(!fence)fence=boundary[1];else if(boundary[1][0]===fence[0]&&boundary[1].length>=fence.length)fence=undefined;return line;}
    if(fence)return line;
    // A quoted block or an explicitly labelled original quote, followed only by its citations.
    const match=/^(\s*(?:>\s*)?(?:(?:引用原文|原文引用|原文|Original quote)\s*[:：]\s*)?)(["“「])(.+?)(["”」])([ \t]*(?:\[cite:[^\]\n]+\][ \t]*)*)([。.]?[ \t]*)$/iu.exec(line);
    if(!match||!/^\s*>/u.test(line)&&!/(?:引用原文|原文引用|原文|Original quote)\s*[:：]/iu.test(match[1]))return line;
    if(({ '"':'"','“':'”','「':'」'} as Record<string,string>)[match[2]]!==match[4])return line;
    checked++;
    const ids=[...match[5].matchAll(/\[cite:([^\]\n]+)\]/gu)].map(row=>row[1]);
    const sources=ids.map(id=>evidence.get(id));
    if(sources.length&&sources.every(source=>source&&containsQuotation(source.text,match[3])))return line;
    // A single wrong link can be corrected only within its own paper and visible evidence.
    const origin=sources.length===1?sources[0]:undefined;
    const candidates=origin&&normalized(match[3]).length>=12?[...evidence].filter(([,source])=>source.paper_id===origin.paper_id&&source.index_version===origin.index_version&&containsQuotation(source.text,match[3])):[];
    if(candidates.length===1){corrected++;return match[1]+match[2]+match[3]+match[4]+` [cite:${candidates[0][0]}]`+match[6];}
    issues.push('exact_quote_source_mismatch:'+checked);
    return match[1]+match[2]+match[3]+match[4]+'〔逐字引文依据待核对〕'+match[6];
  });
  return {answer:lines.join('\n'),issues,corrected,checked};
}
