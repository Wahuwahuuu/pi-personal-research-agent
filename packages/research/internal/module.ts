import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PaperWebSession, type WebView, type ProgressListener, type AnswerListener } from "./agent/web-session.ts";
import { parseConfig, containedPath } from "./agent/config.ts";
import type { Paper, Chunk, EvidenceIdentity, WorkerTransport, ScientificReadingPort } from "./agent/contracts.ts";
import type { LongTermMemory } from "./agent/long-term-memory.ts";
import { PaperPdfCache } from "./agent/paper-pdf.ts";
import { SourceTranslation } from "./agent/source-translation.ts";
export type ResearchState = WebView;
export type ResearchTransport = WorkerTransport;
export type ResearchMemory = Pick<LongTermMemory, "enabled"|"recall"|"remember">;
export interface ResearchCatalog {
  indexVersion:string; papers:Paper[]; evidence:EvidenceIdentity[]; sources:Chunk[];
  implementationId:string; systemPrompt?:string;
}
export interface ResearchEvents {
  progress?:ProgressListener; answer?:AnswerListener;
  tasks?:(value:NonNullable<WebView["turns"][number]["tasks"]>)=>void;
}
export interface ResearchOptions {
  storageRoot:string; config:unknown; catalog:ResearchCatalog;
  transport:ResearchTransport; credential:()=>Promise<string>;
  memory?:ResearchMemory; scientificSources?:ScientificReadingPort;
}
export interface ResearchSession {
  readonly id:string;
  ask(text:string, options?:{requestId?:string;signal?:AbortSignal;events?:ResearchEvents}):Promise<ResearchState>;
  state():Promise<ResearchState>;
  configure(scope:string[],compact?:boolean):Promise<ResearchState>;
  cancel(requestId:string):boolean;
  close():Promise<void>;
}
export interface ResearchModule {
  openSession(id?:string):Promise<ResearchSession>;
  readPdf(paperId:string):Promise<Uint8Array>;
  translate(sessionId:string,turnId:string,sourceIds:string[]):Promise<{items:{chunk_id:string;text:string}[];cached:boolean}>;
  close():Promise<void>;
}
type Open = typeof PaperWebSession.open;
/** Internal seam for deterministic testing. Never exported by the package entry point. */
export async function makeResearchModule(options:ResearchOptions, open:Open=PaperWebSession.open):Promise<ResearchModule>{
  const root=resolve(options.storageRoot), config=parseConfig(structuredClone(options.config));
  const catalog=structuredClone(options.catalog);
  const ids=new Set(catalog.papers.map(p=>p.paper_id));
  if(ids.size!==catalog.papers.length||!catalog.indexVersion||!/^\w[\w.-]*$/.test(catalog.indexVersion))throw new Error("INVALID_CATALOG");
  const sourceIds=new Set(catalog.sources.map(s=>s.chunk_id));
  if(sourceIds.size!==catalog.sources.length||catalog.sources.some(s=>!ids.has(s.paper_id)))throw new Error("INVALID_SOURCES");
  await mkdir(root,{recursive:true});
  const sessions=new Map<string,Promise<ResearchSession>>();
  let closed=false;
  let translator:Promise<SourceTranslation>|undefined;
  const validId=(id:string)=>{if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))throw new Error("INVALID_SESSION_ID");};
  const pdf=new PaperPdfCache(root,ids);
  const api:ResearchModule={
    async openSession(id=randomUUID()){
      if(closed)throw new Error("MODULE_CLOSED");validId(id);
      const existing=sessions.get(id);if(existing)return existing;
      const pending=(async()=>{
        const directory=await containedPath(root,"sessions/"+id);
        const key=await options.credential();
        const engine=await open({directory,assets:{root,indexVersion:catalog.indexVersion,publicPapers:catalog.papers,
          evidenceIndex:new Map(catalog.evidence.map(e=>[e.chunk_id,e])),implementationId:catalog.implementationId,commonPrompt:catalog.systemPrompt??""},
          config,worker:options.transport,sources:new Map(catalog.sources.map(s=>[s.chunk_id,s])),key,
          scientificSources:options.scientificSources,longTermMemory:options.memory});
        let ended=false,active:string|undefined,activeRun:Promise<ResearchState>|undefined;
        const check=()=>{if(ended||closed)throw new Error("SESSION_CLOSED");};
        return {
          id,
          async ask(text,opts={}){
            check();if(activeRun)throw new Error("SESSION_BUSY");
            active=opts.requestId??randomUUID();
            const run=engine.ask(text,opts.events?.progress,opts.events?.answer,{request_id:active,signal:opts.signal,onTasks:opts.events?.tasks});
            activeRun=run;
            try{return await run;}finally{active=undefined;activeRun=undefined;}
          },
          async state(){check();return engine.view();},
          async configure(scope,compact=false){check();return engine.configure(scope,compact);},
          cancel(requestId){return !ended&&engine.stop(requestId);},
          async close(){
            if(ended)return;ended=true;
            if(active)engine.stop(active);
            if(activeRun)await activeRun.catch(()=>{});
            try{await engine.close();}finally{sessions.delete(id);}
          }
        } satisfies ResearchSession;
      })();
      sessions.set(id,pending);
      try{return await pending;}catch(e){sessions.delete(id);throw e;}
    },
    async readPdf(id){if(closed)throw new Error("MODULE_CLOSED");return pdf.get(id);},
    async translate(sessionId,turnId,sourceIds){
      if(closed)throw new Error("MODULE_CLOSED");
      if(!sourceIds.length||new Set(sourceIds).size!==sourceIds.length)throw new Error("INVALID_SOURCES");
      const session=await api.openSession(sessionId),state=await session.state();
      const turn=state.turns.find(t=>t.turn_id===turnId);
      if(!turn)throw new Error("UNKNOWN_TURN");
      const sources=sourceIds.map(id=>{const source=turn.sources.find(s=>s.chunk_id===id);if(!source)throw new Error("SOURCE_NOT_DELIVERED");return {chunk_id:id,text:source.text};});
      translator??=options.credential().then(key=>new SourceTranslation(root,config,key));
      const result=await (await translator).translate(sources,await containedPath(root,"sessions/"+sessionId),turnId);
      return {items:result.items,cached:result.cached};
    },
    async close(){
      if(closed)return;closed=true;
      const opened=await Promise.allSettled([...sessions.values()]);
      const results=await Promise.allSettled(opened.flatMap(r=>r.status==="fulfilled"?[r.value.close()]:[]));
      const failure=results.find(r=>r.status==="rejected");
      if(failure?.status==="rejected")throw failure.reason;
    }
  };
  return api;
}
export async function createResearchModule(options:ResearchOptions):Promise<ResearchModule>{return makeResearchModule(options);}
