import {fileHash,loadCorpusIndex} from "./catalog-assets.ts";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha, containedPath, type AppConfig } from "./config.ts";
import { RuntimeFailure, type Paper, type EvidenceIdentity } from "./contracts.ts";
import { PythonWorkerClient } from "./worker-client.ts";

export const PROJECT_ROOT=fileURLToPath(new URL("../",import.meta.url));
export const CORE_FILES=["agent/contracts.ts","agent/domain-memory.ts","agent/final-answer.ts","agent/full-stages-main-v2.ts","agent/full-stages.ts","agent/ledger.ts","agent/main-controls.ts","agent/main-r2-check-v2.ts","agent/main-reliability-v2.ts","agent/p2-r2.ts","agent/p2-stages.ts","agent/pipeline-trace-prepared-v1.ts","agent/pipeline-trace.ts","agent/question-preparation.ts","agent/session-main-v2.ts","agent/session-memory.ts","agent/tools.ts","agent/worker-client.ts"];
CORE_FILES.push("agent/execution-trace.ts","agent/selected-scope.ts","agent/workbench-answer.ts","agent/paper-reading.ts","agent/citation-attribution.ts","agent/workbench-context.ts","agent/answer-stream.ts","agent/context-compaction.ts","agent/multi-paper.ts","agent/scientific-reading.ts","agent/long-term-memory.ts","agent/memory-synthesis.ts","agent/preparation-history.ts");
export interface Assets {root:string;indexVersion:string;publicPapers:Paper[];evidenceIndex:Map<string,EvidenceIdentity>;implementationId:string;commonPrompt:string}
CORE_FILES.push('agent/turn-execution.ts','agent/task-progress.ts');
CORE_FILES.push('web/answer-format.js');
export {fileHash} from "./catalog-assets.ts";
export async function loadAssets(root:string,config:AppConfig):Promise<Assets>{
  const indexRoot=await containedPath(root,config.retrieval.index_dir);
  const {indexVersion,publicPapers,evidenceIndex}=await loadCorpusIndex(await containedPath(root,config.retrieval.corpus_dir),indexRoot,config.retrieval.device);
  const commonPrompt=await readFile(join(root,"prompts/full-common-v1.md"),"utf8");
  const hashes=await Promise.all([...CORE_FILES,"agent/config.ts","agent/assets.ts","agent/cli.ts","agent/budget.ts","retriever/p2.py","retriever/worker.py","retriever/scientific_reading.py","retriever/long_memory.py","package-lock.json","uv.lock"].map(async p=>[p,await fileHash(join(root,p))]));
  const implementationId=sha(JSON.stringify({config,hashes,prompt:sha(commonPrompt),index:indexVersion,manifest:await fileHash(join(indexRoot,"index-manifest.json"))}));
  return {root,indexVersion,publicPapers,evidenceIndex,implementationId,commonPrompt};
}
export async function createWorker(assets:Assets,config:AppConfig):Promise<PythonWorkerClient>{
  let py=join(assets.root,".venv",process.platform==="win32"?"Scripts":"bin",process.platform==="win32"?"python.exe":"python");
  const bundled=await containedPath(assets.root,".runtime/python/python.exe");
  if(process.platform==="win32"){try{await access(bundled);py=bundled;}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}}
  const worker=new PythonWorkerClient({pythonPath:py,workerPath:join(assets.root,"retriever/worker.py"),
    corpusDir:await containedPath(assets.root,config.retrieval.corpus_dir),indexDir:await containedPath(assets.root,config.retrieval.index_dir),
    modelsDir:await containedPath(assets.root,config.retrieval.models_dir),scientificCacheDir:await containedPath(assets.root,'.cache/scientific-reading'),memoryDir:await containedPath(assets.root,'.local/memory/qdrant'),profile:config.retrieval.profile,device:config.retrieval.device,expectReady:true,readyTimeoutMs:180000,timeoutMs:config.retrieval.device==="cpu"?180000:60000});
  try{const ready=await worker.ready();if(ready?.index_version!==assets.indexVersion)throw new RuntimeFailure("INVALID_INDEX","Worker loaded a different index");return worker;}catch(e){worker.close();throw e;}
}
