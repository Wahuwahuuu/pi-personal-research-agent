import {CloudImports} from "./cloud-imports.ts";
import {timingSafeEqual,randomUUID} from "node:crypto";
import {LibraryClient,type ImportJob} from "./library-client.ts";
import {SnapshotManager} from "./snapshots.ts";
import { bindNodeAccount } from "./account-binding.ts";
import { createLocalReading } from "../packages/research/local-reading.ts";
import { readingSources, withReadingSources } from "../src/reading-sources.ts";
import { nodeCatalog, catalogPages } from "./catalog.ts";
import { checkedResult, researchContext } from "../src/research-coordinator.ts";
import { validatePaperParams } from "../packages/research/core.ts";
import WebSocket from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import { DatabaseSync } from "node:sqlite";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { createServer,type IncomingMessage,type ServerResponse } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PythonBridge, type PythonConfig } from "./python.ts";
import { validateEvidence, type Operation } from "../src/domain.ts";
interface Config {
  endpoint: string;
  secretFile?: string;
  dataDir: string;
  port?: number;
  fixture?: boolean;
  python?: PythonConfig;
  proxy?: string;
  libraryRoot?:string;
  libraryPython?:string;
  localSecretFile?:string;
}
const configPath = resolve(process.argv[2] ?? ".local/node.json");
const config = JSON.parse(await readFile(configPath, "utf8")) as Config;
const url = new URL(config.endpoint);
if (
  url.protocol !== "https:" &&
  !(
    ["localhost", "127.0.0.1"].includes(url.hostname) &&
    url.protocol === "http:"
  )
)
  throw new Error("HTTPS_REQUIRED");
if (url.username || url.password || url.search)
  throw new Error("INVALID_ENDPOINT");
let token = process.env.PRA_DEVICE_TOKEN;
if (!token && config.secretFile && process.platform === "win32") {
  const output = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../scripts/read-secret.ps1",
      ),
      resolve(config.secretFile),
    ],
    { windowsHide: true, encoding: "utf8" },
  );
  if (output.status === 0) token = output.stdout.trim();
}
if (!token || token.length < 32) throw new Error("DEVICE_CREDENTIAL_REQUIRED");
await mkdir(resolve(config.dataDir), { recursive: true });
// OS-owned singleton lock disappears after termination; no stale PID files.
let reading: Awaited<ReturnType<typeof createLocalReading>> | undefined;
let localHandler:((req:IncomingMessage,res:ServerResponse)=>Promise<boolean>)|undefined;
const lock = createServer(async (req, res) => {
  try {
    if (
      req.headers.host !== "127.0.0.1:" + (config.port ?? 48731) ||
      (req.headers.origin && req.headers.origin !== url.origin)
    ) {
      res.writeHead(403).end();
      return;
    }
    if (req.headers.origin === url.origin) {
      res.setHeader("Access-Control-Allow-Origin", url.origin);
      res.setHeader("Access-Control-Allow-Private-Network", "true");
    }
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET");
      res.writeHead(204).end();
      return;
    }
    if(localHandler&&await localHandler(req,res))return;
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    if (req.url === "/health") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ready: !!reading }));
      return;
    }
    const match = req.url?.match(/^\/papers\/(\d{4}\.\d{4,5}(?:v[1-9]\d{0,3})?)$/);
    if (!match || !reading) {
      res.writeHead(404).end();
      return;
    }
    const bytes = await reading.pdf(match[1]);
    res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    });
    res.end(bytes);
  } catch {
    res.writeHead(502).end("PAPER_UNAVAILABLE");
  }
});
await new Promise<void>((ok, no) => {
  lock.once("error", () => no(new Error("NODE_ALREADY_RUNNING")));
  lock.listen(config.port ?? 48731, "127.0.0.1", ok);
});
const db = new DatabaseSync(join(resolve(config.dataDir), "node.sqlite"));
db.exec(
  "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,frame TEXT NOT NULL,acked INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS notices(id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS deleted_operations(id TEXT PRIMARY KEY);",
);
const snapshots=config.python&&!config.fixture?new SnapshotManager(config.python,resolve(config.dataDir),config.libraryRoot):undefined;
if(!snapshots&&!config.fixture)throw Error("PYTHON_CONFIG_REQUIRED");
await snapshots?.refresh();
let catalog=snapshots?(await snapshots.runtime(snapshots.activeVersion)).catalog:await nodeCatalog(undefined,true);
let pages=catalogPages(catalog),indexVersion=catalog.indexVersion;
reading=snapshots?(await snapshots.runtime(indexVersion)).reading:await createLocalReading({
 root:resolve(config.dataDir),indexVersion,papers:catalog.papers,evidence:catalog.evidence,
 worker:{request:async(tool)=>tool==="search_papers"?{
  backend:"fixture",index_version:indexVersion,papers:catalog.papers
 }:{
  backend:"fixture",index_version:indexVersion,chunks:[{
   paper_id:"fixture-paper",chunk_id:"fixture-chunk",paragraph_id:"p1",citation:"[fixture-chunk]",
   truncated:false,section:"abstract",start:0,end:9,text:"Evidence.",index_version:indexVersion
  }]
 }}
});
const library=config.libraryRoot&&config.python?.models?new LibraryClient({
 root:resolve(config.libraryRoot),executable:config.libraryPython??config.python.executable,
 models:config.python.models,device:config.python.device,proxy:config.proxy,baseCorpus:config.python.corpus
}):undefined;
let paused=false,building=false,polling=false,preparing=false,catalogAcknowledged=false,announcedReady=false,lastLocalError="",importJobs:ImportJob[]=[],importAbort:AbortController|undefined,activeImport:string|undefined;
let controlToken=process.env.PRA_LOCAL_TOKEN;
if(!controlToken&&!config.fixture&&process.platform==="win32"){
 const file=resolve(config.localSecretFile??join(config.dataDir,"local.secret"));
 const read=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-File",join(dirname(fileURLToPath(import.meta.url)),"../scripts/read-secret.ps1"),file],{windowsHide:true,encoding:"utf8",stdio:["pipe","pipe","pipe"]});
 if(read.status===0)controlToken=read.stdout.trim();
 else{
  controlToken=randomUUID()+randomUUID();
  const saved=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-File",join(dirname(fileURLToPath(import.meta.url)),"../scripts/write-secret.ps1"),file],{windowsHide:true,input:controlToken,encoding:"utf8",stdio:["pipe","pipe","pipe"]});
  if(saved.status!==0)throw Error("LOCAL_CREDENTIAL_SAVE_FAILED");
 }
}
let socket: WebSocket | undefined,
  retry = 0,
  stopping = false,
  active: { id: string; abort: AbortController } | undefined,
  timer: ReturnType<typeof setTimeout> | undefined;
function send(data: unknown) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
}
const cloudImports=library?new CloudImports(db,library,send,id=>{if(activeImport===id)importAbort?.abort();}):undefined;
async function flushImports(force=false){
 if(!cloudImports||stopping||!catalogAcknowledged||socket?.readyState!==WebSocket.OPEN)return;
 try{await cloudImports.flush(force);}catch{lastLocalError="IMPORT_STATUS_UNAVAILABLE";}
}
function frame(id: string, data: unknown) {
  if(db.prepare("SELECT id FROM deleted_operations WHERE id=?").get(id))return;
  const encoded = JSON.stringify(data);
  db.prepare(
    "INSERT INTO outbox(id,frame) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET frame=excluded.frame,acked=0",
  ).run(id, encoded);
  send(data);
}
function desktop(id: string) {
  if (db.prepare("SELECT id FROM notices WHERE id=?").get(id)) return;
  db.prepare("INSERT INTO notices VALUES(?)").run(id);
  if (process.platform === "win32" && !config.fixture) {
    const p = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        join(dirname(fileURLToPath(import.meta.url)), "../scripts/notify.ps1"),
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    p.on("error", () => {});
  }
}
async function execute(op: Operation) {
  if(op&&db.prepare("SELECT id FROM deleted_operations WHERE id=?").get(op.id))return;
  const old = db.prepare("SELECT frame FROM outbox WHERE id=?").get(op.id) as
    { frame: string } | undefined;
  if (old) {
    send(JSON.parse(old.frame));
    return;
  }
  if (active?.id === op.id) return;
  if (active||building||paused) {
    announcedReady=false;
    send({ type: "operation_deferred", operationId: op.id, reason:building?"indexing":paused?"paused":"busy" });
    return;
  }
  if (
    !op ||
    !(snapshots?snapshots.retained().includes(op.indexVersion):op.indexVersion===indexVersion) ||
    !["search_papers", "retrieve_chunks"].includes(op.tool) ||
    !Number.isFinite(op.deadline)
  ) {
    send({
      type: "operation_error",
      operationId: op.id,
      code: "INVALID_OPERATION",
    });
    return;
  }
  const started = performance.now();
  const abort = new AbortController();
  active = { id: op.id, abort };
  const timeout = setTimeout(
    () => abort.abort(),
    Math.max(1, Math.min(180000, op.deadline - Date.now())),
  );
  try {
    const scopedCatalog=snapshots?(await snapshots.runtime(op.indexVersion)).catalog:catalog;
    validatePaperParams(op.tool, op.params, researchContext(scopedCatalog));
    const {result,sources}=snapshots?await snapshots.execute(op.indexVersion,op.tool,op.params,abort.signal):await reading!.execute(op.tool,op.params,abort.signal);
    if (abort.signal.aborted) throw new Error("CANCELLED");
    validateEvidence(op.tool, result, op.indexVersion);
    checkedResult(
      op,
      result,
      sources.length
        ? withReadingSources(scopedCatalog, readingSources(scopedCatalog, op, sources))
        : scopedCatalog,
    );
    frame(op.id, {
      type: "result",
      operationId: op.id,
      indexVersion:op.indexVersion,
      result,
      sources,
      executionMs: Math.ceil(performance.now() - started),
    });
  } catch {
    frame(op.id, {
      type: "operation_error",
      operationId: op.id,
      code: abort.signal.aborted ? "CANCELLED" : "RETRIEVER_FAILED",
    });
  } finally {
    clearTimeout(timeout);
    active = undefined;
    void announceReady();
  }
}
function connect() {
  const endpoint = new URL("/api/device/connect", url);
  endpoint.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const proxy = config.proxy ?? process.env.HTTPS_PROXY;
  const ws = new WebSocket(endpoint, {
    headers: { Authorization: "Bearer " + token },
    agent: proxy ? new HttpsProxyAgent(proxy) : undefined,
    maxPayload: 1000000,
    handshakeTimeout: 15000,
  });
  socket = ws;catalogAcknowledged=false;
  let pong = true;
  const heartbeat = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!pong) {
      ws.terminate();
      return;
    }
    pong = false;
    ws.send("ping");
  }, 30000);
  ws.on("open", () => {
    retry = 0;announcedReady=false;catalogAcknowledged=false;
    send({
      type: "hello",
      version: 1,
      deviceId: "windows-primary",
      indexVersion,
      retainedIndexes:snapshots?.retained()??[indexVersion],
      tools: ["search_papers", "retrieve_chunks"],
      capabilities: ["abstract-v1", "scientific-html-v1", "scientific-html-v2", "pdf-public-v1",...(cloudImports?["library-v1"]:[])],
      readerPort: config.port ?? 48731,
    });
  });
  ws.on("message", (data) => {
    try {
      const raw = data.toString();
      if (raw === "pong") {
        pong = true;
        return;
      }
      const m = JSON.parse(raw);
      if (m.type === "hello_ack") {
        try {bindNodeAccount(db,m.accountScope);}catch {stopping=true;ws.close(1008,"account mismatch");console.error("ACCOUNT_DATA_DIRECTORY_MISMATCH");return;}
        send({ type: "catalog_begin", pages: pages.length });
        pages.forEach((value, page) =>
          send({ type: "catalog_page", page, value }),
        );
        send({ type: "catalog_end" });
      } else if (m.type === "catalog_ack") {
        catalogAcknowledged=true;
        for (const r of db
          .prepare("SELECT frame FROM outbox WHERE acked=0")
          .all() as { frame: string }[])
          send(JSON.parse(r.frame));
        void announceReady();void flushImports(true);
      } else if(["library_import","library_cancel","library_ack"].includes(m.type)) {
        if(!catalogAcknowledged||!cloudImports)throw Error("IMPORT_CAPABILITY_REQUIRED");
        void cloudImports.receive(m).then(()=>{void pollLibrary();}).catch(()=>{lastLocalError="INVALID_IMPORT_COMMAND";});
      } else if(m.type==="purge_operations") {
        if(typeof m.deletionId!=="string"||!Array.isArray(m.operationIds)||m.operationIds.length>200||m.operationIds.some((id:unknown)=>typeof id!=="string"||id.length>512))throw Error("INVALID_PURGE");
        db.exec("BEGIN IMMEDIATE");
        try {for(const id of m.operationIds){db.prepare("INSERT OR IGNORE INTO deleted_operations VALUES(?)").run(id);db.prepare("DELETE FROM outbox WHERE id=?").run(id);}db.exec("COMMIT");}catch(e){db.exec("ROLLBACK");throw e;}
        if(active&&m.operationIds.includes(active.id))active.abort.abort();
        send({type:"purged",deletionId:m.deletionId,operationIds:m.operationIds});
      } else if (m.type === "ack")
        db.prepare("UPDATE outbox SET acked=1 WHERE id=?").run(m.operationId);
      else if (m.type === "operation") void execute(m.operation);
      else if (m.type === "cancel" && active && active.id === m.operationId)
        active.abort.abort();
      else if (m.type === "notice") desktop(m.notice.id);
    } catch {
      console.error("INVALID_CLOUD_FRAME");
    }
  });
  ws.on("error", () => {});
  ws.on("close", () => {
    clearInterval(heartbeat);
    if (!stopping)
      timer = setTimeout(
        connect,
        Math.min(30000, 1000 * 2 ** Math.min(retry++, 5)),
      );
  });
}
function stop() {
  stopping = true;
  clearTimeout(timer);
  active?.abort.abort();
  snapshots?.stop();importAbort?.abort();
  socket?.terminate();
  lock.close();
  setTimeout(() => {
    db.close();
    process.exit(0);
  }, 100).unref();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
connect();
const libraryTimer=setInterval(()=>{void pollLibrary();void flushImports();},5000);libraryTimer.unref();
console.log("Local research node started; credentials are never logged.");

async function announceReady(){
 const ws=socket;
 if(!ws||ws.readyState!==WebSocket.OPEN||!catalogAcknowledged||announcedReady||preparing||paused||building||active)return;
 preparing=true;
 try{
  await snapshots?.ready();
  if(socket===ws&&ws.readyState===WebSocket.OPEN&&!paused&&!building&&!active){announcedReady=true;send({type:"ready",phase:catalog.papers.length?"ready":"empty"});}
 }catch{lastLocalError="MODEL_LOADING_FAILED";ws.terminate();}
 finally{preparing=false;}
}
function unavailable(phase:"indexing"|"paused"|"loading"){
 announcedReady=false;send({type:"availability",ready:false,phase});
}
async function refreshLibrary(){
 if(!snapshots||active||building)return;
 if(await snapshots.refresh()){
  indexVersion=snapshots.activeVersion;
  const runtime=await snapshots.runtime(indexVersion);catalog=runtime.catalog;reading=runtime.reading;pages=catalogPages(catalog);
  announcedReady=false;socket?.terminate();
 }
}
async function pollLibrary(){
 if(!library||!snapshots||polling||stopping)return;
 polling=true;
 try{
  importJobs=await library.jobs();
  const queued=importJobs.find(j=>!["published","failed","cancelled"].includes(j.status));
  if(queued&&!active&&!paused&&!building&&!snapshots.busy){
   building=true;activeImport=queued.id;importAbort=new AbortController();unavailable("indexing");
   try{await snapshots.maintain(()=>library.run(importAbort!.signal));lastLocalError="";}
   catch(e){lastLocalError=e instanceof Error&&/^[A-Z_]+$/.test(e.message)?e.message:"IMPORT_PROCESS_INTERRUPTED";await library.fail(queued.id,lastLocalError==="LIBRARY_TIMEOUT"?"IMPORT_TIMEOUT":"IMPORT_PROCESS_INTERRUPTED");}
   finally{building=false;activeImport=undefined;importAbort=undefined;}
   importJobs=await library.jobs();
  }
  await refreshLibrary();
  void announceReady();
 }catch{lastLocalError="LIBRARY_UNAVAILABLE";}
 finally{polling=false;}
}
localHandler=async(req,res)=>{
 const path=new URL(req.url??"/","http://127.0.0.1").pathname;
 if(!path.startsWith("/local/"))return false;
 const received=String(req.headers.authorization??"").replace(/^Bearer /,"");
 if(!controlToken||Buffer.byteLength(received)!==Buffer.byteLength(controlToken)||!timingSafeEqual(Buffer.from(received),Buffer.from(controlToken))){
  res.writeHead(401,{"Content-Type":"application/json"}).end('{"error":"LOCAL_AUTH_REQUIRED"}');return true;
 }
 const reply=(value:unknown,status=200)=>{res.writeHead(status,{"Content-Type":"application/json","Cache-Control":"no-store"});res.end(JSON.stringify(value));};
 try{
  if(req.method==="GET"&&path==="/local/status"){
   if(library&&building)importJobs=await library.jobs();
   reply({connected:socket?.readyState===WebSocket.OPEN,ready:announcedReady,paused,phase:paused?"paused":building?"indexing":active?"reading":announcedReady?(catalog.papers.length?"ready":"empty"):"loading",error:lastLocalError,indexVersion,imports:importJobs,libraryEnabled:!!library});return true;
  }
  if(req.method==="GET"&&path==="/local/library"){
   const params=new URL(req.url!,"http://127.0.0.1").searchParams;
   const version=params.get("indexVersion")??indexVersion;
   const selected=snapshots?(await snapshots.runtime(version)).catalog:catalog;
   const query=(params.get("q")??"").slice(0,200).toLocaleLowerCase();
   const offset=Math.max(0,Math.min(100000,Number(params.get("offset"))||0));
   const all=selected.papers.filter(p=>(p.title+" "+p.paper_id).toLocaleLowerCase().includes(query));
   reply({indexVersion:version,papers:all.slice(offset,offset+50).map(p=>({paperId:p.paper_id,title:p.title})),next:offset+50<all.length?offset+50:null,total:all.length});return true;
  }
  if(req.method==="GET"&&path==="/local/pdf"){
   const params=new URL(req.url!,"http://127.0.0.1").searchParams;
   const version=params.get("indexVersion")??indexVersion,paper=params.get("paperId")??"";
   if(paper.length>256||!snapshots)throw Error("UNKNOWN_PAPER");
   const bytes=await snapshots.pdf(version,paper);
   res.writeHead(200,{"Content-Type":"application/pdf","Content-Length":bytes.length,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});res.end(bytes);return true;
  }
  if(req.method!=="POST"){reply({error:"METHOD_DENIED"},405);return true;}
  let bytes=0;const body:Buffer[]=[];for await(const part of req){bytes+=part.length;if(bytes>24000)throw Error("BODY_LIMIT");body.push(Buffer.from(part));}
  const value=JSON.parse(Buffer.concat(body).toString("utf8"));
  if(path==="/local/control"){
   if(value.action==="pause"){paused=true;unavailable("paused");}
   else if(value.action==="resume"){paused=false;void announceReady();}
   else if(value.action==="reconnect"){socket?.terminate();}
   else if(value.action==="shutdown"){reply({accepted:true});setTimeout(stop,25);return true;}
   else throw Error("ACTION_DENIED");
   reply({accepted:true});return true;
  }
  if(!library)throw Error("LIBRARY_NOT_CONFIGURED");
  if(path==="/local/import"){
   const result=value.kind==="pdf"?await library.registerPdf(value.requestId,value.path,value.metadata):
    value.kind==="arxiv"?await library.registerArxiv(value.requestId,value.arxivId,value.metadata):undefined;
   if(!result)throw Error("IMPORT_KIND_DENIED");
   reply(result);void pollLibrary();return true;
  }
  if(path==="/local/import/cancel"){
   const result=await library.cancel(value.id);if(activeImport===value.id)importAbort?.abort();reply(result);return true;
  }
  if(path==="/local/import/retry"){reply(await library.retry(value.id));void pollLibrary();return true;}
  if(path==="/local/index/rollback"){
   if(active||building)throw Error("LOCAL_BUSY");
   await snapshots!.maintain(()=>library.rollback(value.version));await refreshLibrary();reply({accepted:true});return true;
  }
  reply({error:"NOT_FOUND"},404);
 }catch(e){reply({error:e instanceof Error&&/^[A-Z_]+$/.test(e.message)?e.message:"INVALID_LOCAL_REQUEST"},400);}
 return true;
};
