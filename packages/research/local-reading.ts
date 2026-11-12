import {withPaperScope} from "./tool-scope.ts";
import {ScientificReading} from "./internal/agent/scientific-reading.ts";
import {PaperPdfCache} from "./internal/agent/paper-pdf.ts";
import {withAbstractReading} from "./internal/agent/paper-reading.ts";
import {retrieveOriginal,validatePaperParams,searchResult,type ToolContext,type OriginalReadParams} from "./internal/agent/tools.ts";
import type {WorkerTransport,Paper,EvidenceIdentity} from "./internal/agent/contracts.ts";
export {originalPdfUrl} from "./internal/agent/paper-pdf.ts";
export async function createLocalReading(options:{root:string;indexVersion:string;papers:readonly Paper[];evidence:readonly EvidenceIdentity[];worker:WorkerTransport;fetcher?:typeof fetch}){
 const ids=new Set(options.papers.map(p=>p.paper_id));
 const scientific=await ScientificReading.open(options.root,options.indexVersion,ids,options.worker);
 const p2=withAbstractReading({profile:"B",executionVersion:"full-v1",indexVersion:options.indexVersion,publicPapers:options.papers,evidenceIndex:new Map(options.evidence.map(e=>[e.chunk_id,e])),scientificSources:scientific});
 const context:ToolContext={knownPaperIds:ids,getScope:()=>[],getLedger:()=>{throw Error("NO_LOCAL_AGENT");},workbench:true,p2};
 const pdf=new PaperPdfCache(options.root,ids,options.fetcher);
 return {
  async execute(tool:"search_papers"|"retrieve_chunks",params:Record<string,unknown>,signal:AbortSignal){
   const scoped=withPaperScope(context,params.allowed_paper_ids);
   validatePaperParams(tool,params,scoped);
   if(tool==="search_papers")return {result:searchResult(await options.worker.request(tool,{query:String(params.query),limit:Number(params.limit??5),allowed_paper_ids:[...(scoped.getScope().length?scoped.getScope():ids)]},signal),scoped,Number(params.limit??5)),sources:[]};
   const result=await retrieveOriginal(options.worker,scoped,params as unknown as OriginalReadParams,signal);
   const sources=result.chunks.filter(c=>scientific.sources.has(c.chunk_id)).map(c=>({...scientific.sources.get(c.chunk_id)!}));
   // The wire carries worker-format citations; the cloud validates and formats the display citation.
   return {result:{...result,chunks:result.chunks.map(c=>({...c,citation:"["+c.chunk_id+"]"}))},sources};
  },
  pdf:(id:string)=>pdf.get(id)
 };
}
