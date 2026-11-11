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
import { createServer } from "node:http";
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
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    if (req.url === "/health") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ready: !!reading }));
      return;
    }
    const match = req.url?.match(/^\/papers\/(\d{4}\.\d{4,5})$/);
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
if (config.python)
  config.python.scientificCacheDir = resolve(
    config.dataDir,
    ".cache/scientific-reading",
  );
const bridge = config.python ? new PythonBridge(config.python) : undefined;
if (!bridge && !config.fixture) throw new Error("PYTHON_CONFIG_REQUIRED");
const catalog = await nodeCatalog(config.python, config.fixture);
const pages = catalogPages(catalog);
const indexVersion = config.fixture
  ? "fixture-v1"
  : config.python!.indexVersion;
reading = await createLocalReading({
  root: resolve(config.dataDir),
  indexVersion: catalog.indexVersion,
  papers: catalog.papers,
  evidence: catalog.evidence,
  worker: {
    request: async (tool, params, signal) => {
      if (!config.fixture)
        return bridge!.request(
          tool,
          { ...params },
          signal ?? AbortSignal.timeout(60000),
        );
      return tool === "search_papers"
        ? {
            backend: "fixture",
            index_version: indexVersion,
            papers: [
              {
                paper_id: "fixture-paper",
                title: "Deterministic research fixture",
                abstract: "Not a scientific evaluation.",
              },
            ],
          }
        : {
            backend: "fixture",
            index_version: indexVersion,
            chunks: [
              {
                paper_id: "fixture-paper",
                chunk_id: "fixture-chunk",
                paragraph_id: "p1",
                citation: "[fixture-chunk]",
                truncated: false,
                section: "abstract",
                start: 0,
                end: 9,
                text: "Evidence.",
                index_version: indexVersion,
              },
            ],
          };
    },
    ...(bridge
      ? {
          readScientificSources: (params: any, signal?: AbortSignal) =>
            bridge.readScientificSources(params, signal),
        }
      : {}),
  },
});
let socket: WebSocket | undefined,
  retry = 0,
  stopping = false,
  active: { id: string; abort: AbortController } | undefined,
  timer: ReturnType<typeof setTimeout> | undefined;
function send(data: unknown) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
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
  if (active) {
    send({ type: "operation_error", operationId: op.id, code: "BUSY" });
    return;
  }
  if (
    !op ||
    op.indexVersion !== indexVersion ||
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
    validatePaperParams(op.tool, op.params, researchContext(catalog));
    const { result, sources } = await reading!.execute(
      op.tool,
      op.params,
      abort.signal,
    );
    if (abort.signal.aborted) throw new Error("CANCELLED");
    validateEvidence(op.tool, result, indexVersion);
    checkedResult(
      op,
      result,
      sources.length
        ? withReadingSources(catalog, readingSources(catalog, op, sources))
        : catalog,
    );
    frame(op.id, {
      type: "result",
      operationId: op.id,
      indexVersion,
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
  socket = ws;
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
    retry = 0;
    send({
      type: "hello",
      version: 1,
      deviceId: "windows-primary",
      indexVersion,
      tools: ["search_papers", "retrieve_chunks"],
      capabilities: ["abstract-v1", "scientific-html-v1", "pdf-public-v1"],
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
        send({ type: "catalog_begin", pages: pages.length });
        pages.forEach((value, page) =>
          send({ type: "catalog_page", page, value }),
        );
        send({ type: "catalog_end" });
      } else if (m.type === "catalog_ack") {
        for (const r of db
          .prepare("SELECT frame FROM outbox WHERE acked=0")
          .all() as { frame: string }[])
          send(JSON.parse(r.frame));
        void (bridge?.ready() ?? Promise.resolve())
          .then(() => {
            if (socket === ws && ws.readyState === WebSocket.OPEN)
              send({ type: "ready" });
          })
          .catch(() => ws.terminate());
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
  bridge?.stop();
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
console.log("Local research node started; credentials are never logged.");
