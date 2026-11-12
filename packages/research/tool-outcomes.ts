export interface ToolOutcomeOperation {
  id?:string; tool:string; params:Record<string,unknown>; state:string; result?:unknown; attempts?:number;
}
const size=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).length;
function identities(values:unknown[]){
  const valid=[...new Set(values.filter((v):v is string=>typeof v==="string"&&v.length>0&&v.length<=256))];
  return {values:valid.slice(0,8),omitted:valid.length-Math.min(valid.length,8),invalid:values.filter(v=>typeof v!=="string"||!v||v.length>256).length};
}
/** Adapt the original AsterCite completion-check contract: execution metadata, never full tool payloads. */
export function projectToolOutcomes(operations:readonly ToolOutcomeOperation[]){
  const summaries=operations.map((op,index)=>{
    const result=op.result&&typeof op.result==="object"?op.result as Record<string,unknown>:undefined;
    const raw=op.state==="done"?(op.tool==="retrieve_chunks"?result?.chunks:op.tool==="search_papers"?result?.papers:undefined):undefined;
    const records=Array.isArray(raw)?raw:undefined;
    const papers=identities((records??[]).map(r=>r?.paper_id));
    const chunks=identities(op.tool==="retrieve_chunks"?(records??[]).map(r=>r?.chunk_id):[]);
    const requested=identities(Array.isArray(op.params.paper_ids)?op.params.paper_ids:[]);
    const executed=op.state==="sent"||op.state==="done"||(op.attempts??0)>0?true:
      op.attempts===0?false:null;
    return {ordinal:index+1,...(op.id&&op.id.length<=128?{id:op.id}:{}),tool:op.tool,state:op.state,executed,
      requested_paper_ids:requested.values,requested_papers_omitted:requested.omitted+requested.invalid,
      result_state:op.state!=="done"?"not_completed":records?"available":"not_recorded",
      returned_records:records?.length??null,paper_ids:papers.values,chunks:chunks.values,
      paper_ids_omitted:papers.omitted+papers.invalid,chunk_ids_omitted:chunks.omitted+chunks.invalid};
  });
  const visible:typeof summaries=[];
  for(const row of [...summaries].reverse())if(size([row,...visible])<=8000)visible.unshift(row);
  const states:Record<string,number>=Object.create(null);
  for(const op of operations)states[op.state]=(states[op.state]??0)+1;
  return {tools:visible,tool_window:{archived:operations.length,visible:visible.length,omitted:operations.length-visible.length,
    bytes:size(visible),state_counts:states,instruction:"These are execution outcomes, not paper evidence. executed=null and not_recorded mean unknown. Empty results do not establish evidence coverage. Omitted operations and identifiers are not visible; do not infer their findings."}};
}
