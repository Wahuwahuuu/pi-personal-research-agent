import { verifyProactiveBrowser } from "./proactive-browser.ts";
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from "miniflare";
import { freezeWorker } from "./freeze-worker.ts";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import assert from "node:assert/strict";
const directory = resolve(".local/proactive-check", crypto.randomUUID());
await mkdir(directory, { recursive: true });
const config = JSON.parse(
  (await readFile("wrangler.jsonc", "utf8")).replace(/,\s*([}\]])/g, "$1"),
);
config.main = resolve("src/worker.ts");
config.assets.directory = resolve(directory, "assets");
await cp(resolve("dist/web"), config.assets.directory, { recursive: true });
const configFile = resolve(directory, "wrangler.json");
await writeFile(configFile, JSON.stringify(config));
await freezeWorker(configFile, resolve(directory, "bundle"));
const token = crypto.randomUUID() + crypto.randomUUID(),
  report: any = {
    started: new Date().toISOString(),
    kind: "real-workerd-pi-proactive-chain",
    sourceFixture: true,
    deviceFixture: true,
    paidCalls: 0,
    cloudDeployment: false,
    checks: [],
  };
const now = new Date().toISOString();
let sourceCalls = 0;
const sourceStarts: number[] = [];
const options = convertV4MiniflareOptions({
  name: "proactive-check",
  scriptPath: resolve(directory, "bundle/worker.js"),
  modules: true,
  compatibilityDate: config.compatibility_date,
  compatibilityFlags: config.compatibility_flags,
  cf: false,
  port: 0,
  host: "127.0.0.1",
  bindings: {
    ADMIN_TOKEN: token,
    OWNER_ID: "proactive-" + crypto.randomUUID(),
    MODEL_MODE: "mock",
    RESEARCH_ENGINE: "durable",
    RESOURCE_WORKER_NAME: "proactive-check",
  },
  durableObjects: {
    AGENTS: { className: "PersonalAgent", useSQLite: true },
    IDENTITIES: { className: "IdentityRegistry", useSQLite: true },
  },
  serviceBindings: {
    ASSETS: async (request) => {
      const path = new URL(request.url).pathname;
      const file =
        path === "/"
          ? "index.html"
          : /^\/assets\/[a-zA-Z0-9._-]+$/.test(path)
            ? path.slice(1)
            : undefined;
      if (!file) return new Response("Not found", { status: 404 });
      try {
        return new Response(
          await readFile(resolve(config.assets.directory, file)),
          {
            headers: {
              "Content-Type": file.endsWith(".js")
                ? "text/javascript"
                : file.endsWith(".css")
                  ? "text/css"
                  : "text/html",
            },
          },
        );
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  },
  outboundService: async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "export.arxiv.org" || url.pathname !== "/api/query")
      throw Error("UNEXPECTED_EXTERNAL_REQUEST");
    sourceCalls++;
    sourceStarts.push(Date.now());
    const q = url.searchParams.get("search_query") ?? "";
    if (q.includes("sourcefail"))
      return new Response("Unavailable", { status: 503 });
    const silent = q.includes("nochange"),
      id = silent ? "2601.00002v1" : "2601.00001v1";
    return new Response(
      '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>1</opensearch:totalResults><entry><id>https://arxiv.org/abs/' +
        id +
        "</id><title>Public software fixture " +
        (silent ? "B" : "A") +
        "</title><summary>Source-grounded research protocol fixture.</summary><published>" +
        now +
        "</published><updated>" +
        now +
        "</updated></entry></feed>",
      { headers: { "Content-Type": "application/atom+xml" } },
    );
  },
});
options.resourcePersistencePath = resolve(directory, "storage");
options.log = new Log(LogLevel.ERROR);
options.telemetry = { enabled: false };
const mf = new Miniflare(options);
let ws: WebSocket | undefined,
  cookie = "",
  base = "",
  lastStatus: any,
  peerError = "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => Promise<any>, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (peerError) throw Error(peerError);
    const value = await fn();
    if (value) return value;
    await sleep(300);
  }
  throw Error("PROACTIVE_TIMEOUT " + JSON.stringify(lastStatus));
}
async function api(path: string, method = "GET", body?: any) {
  const r = await fetch(base + "/api/" + path, {
    method,
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (path === "login")
    cookie = r.headers.get("set-cookie")?.split(";")[0] ?? "";
  const raw = await r.text();
  let v: any;
  try {
    v = JSON.parse(raw);
  } catch {
    throw Error(
      "NON_JSON_RESPONSE " +
        path +
        ":" +
        r.status +
        ":" +
        raw.replaceAll(token, "[REDACTED]").slice(0, 600),
    );
  }
  if (!r.ok) throw Error(path + ":" + r.status + ":" + v.error);
  return v;
}
const papers = ["2601.00001v1", "2601.00002v1"].map((id, i) => ({
  paper_id: id,
  title: "Public software fixture " + (i ? "B" : "A"),
  abstract: "Protocol fixture.",
}));
const evidence = papers.map((p, i) => ({
  paper_id: p.paper_id,
  chunk_id: "proactive-fixture-" + i,
  paragraph_id: "p" + i,
  start: 0,
  end: 9,
  index_version: "proactive-fixture",
  text_sha256: createHash("sha256").update("Evidence.").digest("hex"),
}));
let target = papers[0].paper_id;
async function connect() {
  const pair = await api("device/pair", "POST", {
    requestId: crypto.randomUUID(),
    label: "Proactive deterministic peer",
  });
  ws = new WebSocket(base.replace("http", "ws") + "/api/device/connect", {
    headers: { Authorization: "Bearer " + pair.token },
  });
  ws.on("error", () => {});
  const send = (value: any) => ws!.send(JSON.stringify(value));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "error") {
      peerError = "DEVICE_PROTOCOL_" + m.code;
      return;
    }
    if (m.type === "hello_ack") {
      send({ type: "catalog_begin", pages: 1 });
      send({
        type: "catalog_page",
        page: 0,
        value: JSON.stringify({
          indexVersion: "proactive-fixture",
          papers,
          evidence,
        }),
      });
      send({ type: "catalog_end" });
    }
    if (m.type === "catalog_ack") send({ type: "ready" });
    if (m.type === "library_import") {
      target = m.arxivId;
      for (let i = 0; i < 5; i++)
        send({
          type: "library_result",
          id: m.id,
          generation: m.generation,
          phase: "published",
          paperId: m.arxivId,
          indexVersion: "proactive-fixture",
        });
    }
    if (m.type === "operation") {
      const o = m.operation,
        paper = papers.find((p) => p.paper_id === target)!,
        chunk = evidence.find((e) => e.paper_id === target)!;
      const result =
        o.tool === "search_papers"
          ? {
              backend: "fixture",
              index_version: o.indexVersion,
              papers: [paper],
            }
          : {
              backend: "fixture",
              index_version: o.indexVersion,
              chunks: [
                {
                  ...chunk,
                  text: "Evidence.",
                  section: "Methods",
                  citation: "[" + chunk.chunk_id + "]",
                  truncated: false,
                },
              ],
            };
      send({
        type: "result",
        operationId: o.id,
        indexVersion: o.indexVersion,
        result,
        executionMs: 1,
      });
    }
  });
  await new Promise<void>((ok, no) => {
    ws!.once("open", ok);
    ws!.once("error", no);
  });
  send({
    type: "hello",
    version: 1,
    deviceId: "proactive-fixture",
    indexVersion: "proactive-fixture",
    tools: ["search_papers", "retrieve_chunks"],
    capabilities: ["library-v1","scoped-search-v1"],
  });
}
async function batchTask(planId: string) {
  const rows = (await api("research-batches?plan=" + planId)).items;
  if (!rows[0]?.taskId) {
    lastStatus = {
      batches: rows.map((b: any) => ({
        status: b.status,
        discovered: b.discovered,
        error: b.error,
      })),
    };
    return undefined;
  }
  const t = await api("tasks/" + rows[0].taskId);
  lastStatus = {
    phase: t.proactive?.stage,
    status: t.status,
    error: t.error,
    calls: t.calls,
    tools: t.tools,
    workflow: t.workflow?.phase,
  };
  return { batch: rows[0], task: t };
}
try {
  base = String(await mf.ready).replace(/\/$/, "");
  await api("login", "POST", { token });
  const plan = await api("plans", "POST", {
    requestId: crypto.randomUUID(),
    query: "agents",
    objective: "Verify source-supported research",
    autoProcess: true,
    maxPapers: 1,
  });
  const waiting = await until(async () => {
    const value = await batchTask(plan.id);
    return value?.task.proactive?.stage === "imports" ? value : false;
  });
  assert.equal(waiting.task.calls, 1);
  const calls = (await api("state")).usage.requests;
  await sleep(3500);
  assert.equal((await api("state")).usage.requests, calls);
  report.checks.push(
    "metadata screening uses one Pi request; offline import wait makes no extra model calls",
  );
  const measured=(limit:boolean)=>{
    const at=new Date().toISOString(),counts=Object.fromEntries(["workerRequests","doRequestUpperEstimate","doDuration","sqliteRowsRead","sqliteRowsWritten","sqliteStoredBytes"].map(k=>[k,{status:"observed",value:1}]));
    return{version:1,source:"Cloudflare GraphQL Analytics API",accountScope:"a".repeat(64),scriptName:"proactive-check",observedAt:at,window:{day:at.slice(0,10),timezone:"UTC",start:at.slice(0,10)+"T00:00:00.000Z",end:at},account:counts,project:{...counts,sqliteRowsRead:{status:"observed",value:limit?500000:1}}};
  };
  const sourceBefore=sourceCalls;
  await api("platform","POST",{requestId:crypto.randomUUID(),report:measured(true)});
  assert.equal((await api("tasks/"+waiting.task.id)).error,"PLATFORM_RESOURCE_LIMIT");
  const heldPlan=await api("plans","POST",{requestId:crypto.randomUUID(),query:"held-metadata",autoProcess:false});
  await connect();
  const foreground=await api("tasks","POST",{requestId:crypto.randomUUID(),kind:"chat",input:"Hello"});
  await until(async()=>{const t=await api("tasks/"+foreground.id);assert.notEqual(t.status,"failed");return t.status==="completed";});
  const afterForeground=(await api("state")).usage.requests;
  await sleep(3500);
  assert.equal((await api("state")).usage.requests,afterForeground);
  assert.equal(sourceCalls,sourceBefore);
  assert.equal((await api("tasks/"+waiting.task.id)).calls,waiting.task.calls);
  assert.equal((await api("research-batches?plan="+heldPlan.id)).items.length,0);
  assert.equal((await api("tasks/"+waiting.task.id)).proactive.stage,"imports");
  const resumeDenied=await fetch(base+"/api/tasks/"+waiting.task.id+"/resume",{method:"POST",headers:{Cookie:cookie,"Content-Type":"application/json"},body:JSON.stringify({requestId:crypto.randomUUID()})});
  assert.equal(resumeDenied.status,429);
  await api("plans/"+heldPlan.id,"PATCH",{requestId:crypto.randomUUID(),enabled:false});
  await api("platform","POST",{requestId:crypto.randomUUID(),report:measured(false)});
  assert.equal((await api("platform")).blocked,false);
  report.checks.push("shared resource threshold blocks metadata, imports and new background model steps; foreground completes, repeated waiting adds zero model calls, fresh measured headroom resumes the same task");
  const done = await until(async () => {
    const value = await batchTask(plan.id);
    if (["failed", "waiting_user"].includes(value?.task.status))
      throw Error("BACKGROUND_TASK_STOPPED " + JSON.stringify(lastStatus));
    return value?.task.proactive?.stage === "done" ? value : false;
  });
  assert.equal(done.task.id, waiting.task.id);
  assert.ok(done.task.sessionId);
  assert.equal(done.task.status, "completed");
  assert.ok(done.task.calls <= 24);
  assert.equal(done.task.tools, 2);
  assert.equal(done.batch.status, "completed");
  assert.ok(done.batch.artifactId);
  const brief = await api("artifacts/" + done.batch.artifactId);
  assert.ok(brief.sources.length);
  assert.match(brief.content, /\[cite:proactive-fixture-0\]/);
  const notices = (await api("state")).notices.filter(
    (n: any) => n.batchId === done.batch.id,
  );
  assert.equal(notices.length, 1);
  report.checks.push(
    "the same Pi task resumes through import, autonomous search/read, structured memory and cited impact brief; duplicated import receipts create one notice",
  );
  const silent = await api("plans", "POST", {
    requestId: crypto.randomUUID(),
    query: "nochange",
    objective: "[mock:no-change] Verify quiet cycle",
    autoProcess: true,
    maxPapers: 1,
  });
  const quiet = await until(async () => {
    const v = await batchTask(silent.id);
    if (["failed", "waiting_user"].includes(v?.task.status))
      throw Error("QUIET_TASK_STOPPED " + JSON.stringify(lastStatus));
    return v?.task.proactive?.stage === "done" ? v : false;
  });
  assert.equal(
    (await api("state")).notices.filter(
      (n: any) => n.batchId === quiet.batch.id,
    ).length,
    0,
  );
  assert.ok(quiet.batch.artifactId);
  report.checks.push(
    "no-change assessment saves a brief without an inbox or desktop notification",
  );
  const failed = await api("plans", "POST", {
    requestId: crypto.randomUUID(),
    query: "sourcefail",
    objective: "Source failure",
    autoProcess: true,
  });
  await until(
    async () =>
      (await api("overview")).plans.find((p: any) => p.id === failed.id)
        ?.sourceError === "SOURCE_UNAVAILABLE",
  );
  assert.equal(
    (await api("research-batches?plan=" + failed.id)).items[0].discovered,
    0,
  );
  report.checks.push(
    "source failure retains the discovery checkpoint and exposes the coverage gap",
  );
  const paced = await Promise.all(["pacealpha", "pacebeta"].map(query =>
    api("plans", "POST", {requestId:crypto.randomUUID(),query,autoProcess:false})));
  await until(async () => {
    for(const p of paced) if(!(await api("research-batches?plan="+p.id)).items.some((b:any)=>b.discovered===1)) return false;
    return true;
  });
  for(let i=1;i<sourceStarts.length;i++) assert.ok(sourceStarts[i]-sourceStarts[i-1]>=2950,"arXiv calls were not separated");
  report.checks.push("simultaneously due metadata topics share a persisted source permit with a three-second gap");
  if (process.env.PRA_PROACTIVE_BROWSER === "1") {
    await api("settings", "PATCH", {
      requestId: crypto.randomUUID(),
      onboarded: true,
      theme: "light",
    });
    report.checks.push(
      ...(await verifyProactiveBrowser(
        base,
        cookie,
        api,
        directory,
        plan.id,
        failed.id,
      )),
    );
    report.browser =
      "installed Microsoft Edge; deterministic source and device";
  }
  report.success = true;
  report.sourceCalls = sourceCalls;
  report.modelRequests = (await api("state")).usage.requests;
} catch (e) {
  report.success = false;
  report.failure = e instanceof Error ? e.message : String(e);
  report.lastStatus = lastStatus;
  process.exitCode = 1;
} finally {
  report.sourceCalls = sourceCalls;
  ws?.terminate();
  await mf.dispose();
  report.finished = new Date().toISOString();
  await writeFile(
    resolve(directory, "report.json"),
    JSON.stringify(report, null, 2),
  );
  if (report.success)
    await writeFile(
      process.env.PRA_PROACTIVE_BROWSER === "1"
        ? "docs/validation/proactive-browser.json"
        : "docs/validation/proactive-local-chain.json",
      JSON.stringify(report, null, 2),
    );
  console.log(JSON.stringify(report, null, 2));
}
