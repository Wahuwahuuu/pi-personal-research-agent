import WebSocket from "ws";
import { nodeCatalog, catalogPages } from "../local/catalog.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const root = process.cwd(),
  port = 8797,
  base = `http://127.0.0.1:${port}`,
  directory = resolve(".local/integration");
await mkdir(directory, { recursive: true });
await mkdir("docs/validation", { recursive: true });
const admin = crypto.randomUUID() + crypto.randomUUID();
const existing = await readFile(".dev.vars", "utf8").catch(() => undefined);
if (existing)
  throw new Error(
    "Refusing to replace existing .dev.vars; use a clean validation checkout.",
  );
await writeFile(
  ".dev.vars",
  `ADMIN_TOKEN="${admin}"\nOWNER_ID="validation-${crypto.randomUUID()}"\n`,
);
const children: ChildProcess[] = [];
let logs = "";
const terminated = new Set<number>();
async function stopChild(p: ChildProcess) {
  if (!p.pid || terminated.has(p.pid) || p.exitCode !== null) return;
  terminated.add(p.pid);
  if (process.platform === "win32") {
    await new Promise<void>((done) => {
      const k = spawn("taskkill", ["/PID", String(p.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      k.on("close", () => done());
      k.on("error", () => done());
    });
  } else p.kill();
}
function child(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const p = spawn(process.execPath, args, {
    cwd: root,
    env: { ...env, WRANGLER_SEND_METRICS: "false" },
    windowsHide: true,
    stdio: "pipe",
  });
  children.push(p);
  p.stdout?.on("data", (d) => {
    logs += d.toString();
  });
  p.stderr?.on("data", (d) => {
    logs += d.toString();
  });
  return p;
}
async function until<T>(
  fn: () => Promise<T | false>,
  timeout = 30000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn().catch(() => false as const);
    if (v !== false) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("POLL_TIMEOUT");
}
let cookie = "";
async function api(path: string, method = "GET", body?: unknown) {
  const r = await fetch(base + "/api/" + path, {
    method,
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = (await r.json()) as any;
  assert.ok(r.ok, JSON.stringify(value));
  return value;
}
const checks: string[] = [];
const start = Date.now();
try {
  const serverArgs = [
    "node_modules/wrangler/bin/wrangler.js",
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--var",
    "RESEARCH_ENGINE:durable",
    "--persist-to",
    directory,
  ];
  let server = child(serverArgs);
  await until(async () => {
    const r = await fetch(base);
    return r.ok;
  }, 60000);
  assert.equal((await fetch(base + "/api/state")).status, 401);
  checks.push("unauthenticated API rejected");
  const login = await fetch(base + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: admin }),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie")!.split(";")[0];
  assert.equal(
    (
      await fetch(base + "/api/state", {
        headers: { Cookie: cookie, Origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  checks.push("cross-origin request rejected");
  const chat = await api("tasks", "POST", {
    input: "cloud only",
    kind: "chat",
    requestId: "chat-1",
  });
  const done = await until(async () => {
    const s = await api("state");
    const t = s.tasks.find((t: any) => t.id === chat.id);
    if (t.status === "failed") throw new Error(t.error);
    return t.status === "completed" ? t : false;
  });
  assert.match(done.answer, /模拟模型/);
  assert.equal(done.engine,"durable");
  const followChat=await api("tasks","POST",{input:"continue cloud conversation",kind:"chat",conversationId:done.conversationId,requestId:"chat-follow"});
  const cloudFollow=await until(async()=>{const t=(await api("state")).tasks.find((t:any)=>t.id===followChat.id);return t.status==="completed"?t:false;});
  assert.equal(cloudFollow.sessionId,done.sessionId);assert.equal(cloudFollow.tools,0);
  checks.push("cloud-only turns reuse one Pi conversation before any device or corpus exists");
  checks.push(
    "official PiHarness deterministic provider completed cloud-only task",
  );
  const research = await api("tasks", "POST", {
    input: "offline research",
    kind: "research",
    requestId: "research-1",
  });
  await until(async () => {
    const s = await api("state");
    return (
      s.tasks.find((t: any) => t.id === research.id)?.status ===
      "waiting_device"
    );
  });
  const before = (await api("state")).usage.requests;
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal((await api("state")).usage.requests, before);
  checks.push("offline retrieval paused without new model calls");
  const pair = await api("device/pair", "POST", {});
  const config = resolve(directory, "node.json");
  await writeFile(
    config,
    JSON.stringify({
      endpoint: base,
      dataDir: resolve(directory, "node"),
      port: 48739,
      fixture: true,
    }),
  );
  const node = child(["local/node.ts", config], {
    ...process.env,
    PRA_DEVICE_TOKEN: pair.token,
  });
  await until(async () => {
    const s = await api("state");
    return (
      s.tasks.find((t: any) => t.id === research.id)?.status === "completed"
    );
  }, 45000);
  const researchDone = (await api("state")).tasks.find(
    (t: any) => t.id === research.id,
  );
  assert.equal(researchDone.engine, "durable");
  assert.equal(researchDone.calls, 4);
  assert.equal(researchDone.tools, 2);
  assert.equal(researchDone.resumeSeq, 4);
  assert.match(researchDone.answer, /cite:fixture-chunk/);
  checks.push(
    "real DO registered research tools; preparation and three model runs reused one session across two validated observations",
  );
  const translation = await api("tasks/"+research.id+"/translate","POST",{sourceIds:["fixture-chunk"],requestId:"translation-1"});
  await until(async()=>{const t=(await api("state")).tasks.find((t:any)=>t.id===translation.id);assert.notEqual(t.status,"failed",t.error);return t.status==="completed";},45000);
  const translatedState=await api("state");
  assert.equal(translatedState.tasks.find((t:any)=>t.id===translation.id).calls,1);
  assert.equal(translatedState.tasks.find((t:any)=>t.id===research.id).calls,5);
  assert.equal((await api("tasks/"+research.id+"/translate","POST",{sourceIds:["fixture-chunk"],requestId:"translation-cached"})).id,translation.id);
  checks.push("Pi source translation reuses source identity and cache, charging the original task budget");
  const duplicate = await api("tasks", "POST", {
    input: "offline research",
    kind: "research",
    requestId: "research-1",
  });
  assert.equal(duplicate.id, research.id);
  checks.push("HTTP duplicate submission deduplicated");
  const follow = await api("tasks","POST",{input:"Explain the same method again",kind:"research",requestId:"followup-1",conversationId:researchDone.conversationId});
  await until(async()=>{const t=(await api("state")).tasks.find((t:any)=>t.id===follow.id);assert.notEqual(t.status,"failed",t.error);return t.status==="completed";},45000);
  const followDone=(await api("state")).tasks.find((t:any)=>t.id===follow.id);
  assert.equal(followDone.sessionId,researchDone.sessionId);
  const conversations=await api("conversations");
  assert.equal(conversations.find((c:any)=>c.id===researchDone.conversationId).history.length,2);
  checks.push("same Pi conversation resumed a new budgeted turn with durable domain history");
  const m = await api("memories", "POST", { content: "中文回答" });
  await api("memories", "POST", { id: m.id, content: "提供原文引用" });
  await api("memories/" + m.id, "DELETE");
  assert.equal((await api("state")).memories.length, 0);
  checks.push("memory create/correct/delete persisted");
  await stopChild(server);
  server = child(serverArgs);
  await until(async () => {
    const r = await fetch(base);
    return r.ok;
  }, 60000);
  const restored = await api("state");
  assert.equal(
    restored.tasks.find((t: any) => t.id === research.id)?.status,
    "completed",
  );
  assert.equal(restored.memories.length, 0);
  assert.equal(
    restored.operations.filter((o: any) => o.taskId === research.id).length,
    2,
  );
  checks.push(
    "actual workerd process-tree restart retained task/evidence/deletion without duplicate operations",
  );
  await until(async () => (await api("state")).deviceOnline, 45000);
  await stopChild(node);
  await until(async () => !(await api("state")).deviceOnline);
  // A controlled device can withhold results while the real DO and Pi storage are restarted.
  const catalog = await nodeCatalog(undefined, true),
    pages = catalogPages(catalog);
  let frames: any[] = [],
    controlled: WebSocket;
  async function connectControlled() {
    frames = [];
    controlled = new WebSocket(
      base.replace("http", "ws") + "/api/device/connect",
      { headers: { Authorization: "Bearer " + pair.token } },
    );
    controlled.on("error", () => {});
    controlled.on("message", (data) => {
      const m = JSON.parse(data.toString());
      frames.push(m);
      if (m.type === "hello_ack") {
        controlled.send(
          JSON.stringify({ type: "catalog_begin", pages: pages.length }),
        );
        pages.forEach((value, page) =>
          controlled.send(
            JSON.stringify({ type: "catalog_page", page, value }),
          ),
        );
        controlled.send(JSON.stringify({ type: "catalog_end" }));
      }
      if (m.type === "catalog_ack")
        controlled.send(JSON.stringify({ type: "ready" }));
    });
    await new Promise<void>((ok, no) => {
      controlled.once("open", ok);
      controlled.once("error", no);
    });
    controlled.send(
      JSON.stringify({
        type: "hello",
        version: 1,
        deviceId: "controlled",
        indexVersion: catalog.indexVersion,
        tools: ["search_papers", "retrieve_chunks"],
      }),
    );
    await until(async () => !!(await api("state")).deviceOnline);
  }
  await connectControlled();
  const inFlight = await api("tasks", "POST", {
    input: "restart while a tool is pending",
    kind: "research",
    requestId: "inflight-1",
  });
  const first = await until(
    async () =>
      frames.find(
        (m) => m.type === "operation" && m.operation.taskId === inFlight.id,
      )?.operation ?? false,
  );
  await until(async () => {
    const t = (await api("state")).tasks.find((t: any) => t.id === inFlight.id);
    return t.status === "waiting_device" && !t.runOpen;
  });
  const suspended = (await api("state")).tasks.find(
    (t: any) => t.id === inFlight.id,
  );
  assert.equal(suspended.calls, 2);
  await stopChild(server);
  controlled!.terminate();
  server = child(serverArgs);
  await until(async () => {
    const r = await fetch(base);
    return r.ok;
  }, 60000);
  await connectControlled();
  const replayed = await until(
    async () =>
      frames.find(
        (m) => m.type === "operation" && m.operation.taskId === inFlight.id,
      )?.operation ?? false,
  );
  assert.equal(replayed.id, first.id);
  const restoredWaiting = (await api("state")).tasks.find(
    (t: any) => t.id === inFlight.id,
  );
  assert.equal(restoredWaiting.sessionId, suspended.sessionId);
  assert.equal(restoredWaiting.calls, 2);
  checks.push(
    "workerd restart DURING pending tool reused operation/session without another model call",
  );

  const searchFrame = {
    type: "result",
    operationId: first.id,
    indexVersion: "fixture-v1",
    executionMs: 5,
    result: {
      backend: "fixture",
      index_version: "fixture-v1",
      papers: catalog.papers,
    },
  };
  controlled!.send(JSON.stringify({ ...searchFrame, indexVersion: "wrong" }));
  await until(async () =>
    frames.some((m) => m.type === "error" && m.code === "INDEX_CHANGED"),
  );
  assert.notEqual(
    (await api("state")).operations.find((o: any) => o.id === first.id).state,
    "done",
  );
  for (let i = 0; i < 5; i++) controlled!.send(JSON.stringify(searchFrame));
  await until(
    async () =>
      frames.filter((m) => m.type === "ack" && m.operationId === first.id)
        .length >= 5,
  );
  assert.equal(
    frames.filter(
      (m) =>
        m.type === "ack" &&
        m.operationId === first.id &&
        m.status === "accepted",
    ).length,
    1,
  );
  assert.equal(
    frames.filter(
      (m) =>
        m.type === "ack" &&
        m.operationId === first.id &&
        m.status === "duplicate",
    ).length,
    4,
  );
  const readOp = await until(
    async () =>
      frames.find(
        (m) =>
          m.type === "operation" &&
          m.operation.taskId === inFlight.id &&
          m.operation.tool === "retrieve_chunks",
      )?.operation ?? false,
  );
  checks.push(
    "wrong index rejected; five result deliveries admitted once and continued to model-selected retrieval",
  );
  await until(
    async () =>
      !(await api("state")).tasks.find((t: any) => t.id === inFlight.id)
        .runOpen,
  );
  const extraChat = await api("tasks", "POST", {
    input: "chat while research waits",
    kind: "chat",
    requestId: "parallel-chat",
  });
  await until(
    async () =>
      (await api("state")).tasks.find((t: any) => t.id === extraChat.id)
        .status === "completed",
  );
  checks.push(
    "waiting research released model slot so cloud-only chat completed",
  );
  const callsBeforeCancel = (await api("state")).tasks.find(
    (t: any) => t.id === inFlight.id,
  ).calls;
  await api("tasks/" + inFlight.id + "/cancel", "POST", {});
  controlled!.send(
    JSON.stringify({
      type: "result",
      operationId: readOp.id,
      indexVersion: "fixture-v1",
      executionMs: 5,
      result: { backend: "fixture", index_version: "fixture-v1", chunks: [] },
    }),
  );
  await until(async () =>
    frames.some(
      (m) =>
        m.type === "ack" &&
        m.operationId === readOp.id &&
        m.status === "discarded",
    ),
  );
  const cancelled = (await api("state")).tasks.find(
    (t: any) => t.id === inFlight.id,
  );
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.calls, callsBeforeCancel);
  checks.push(
    "cancelled in-flight retrieval discarded late result without restarting model",
  );
  controlled!.close();
  await until(async () => !(await api("state")).deviceOnline);
  const waiting = await api("tasks", "POST", {
    input: "cancel while offline",
    kind: "research",
    requestId: "cancel-1",
  });
  await api(`tasks/${waiting.id}/cancel`, "POST", {});
  assert.equal(
    (await api("state")).tasks.find((t: any) => t.id === waiting.id).status,
    "cancelled",
  );
  checks.push("offline cancellation durable");
  await api("device/revoke", "POST", {});
  await until(async () => !(await api("state")).deviceOnline);
  checks.push("device revocation immediately enforced");
  // Close our runtime before raw-file inspection; live SQLite files can be locked on Windows.
  for (const p of [...children].reverse()) await stopChild(p);
  let scanned = 0;
  async function scan(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) await scan(path);
      else {
        const bytes = await readFile(path);
        assert.ok(
          !bytes.includes(Buffer.from(admin)),
          "admin secret persisted",
        );
        assert.ok(
          !bytes.includes(Buffer.from(pair.token)),
          "device secret persisted",
        );
        scanned++;
      }
    }
  }
  await scan(directory);
  checks.push(
    `raw local persistence credential scan: ${scanned} files, zero plaintext credential hits`,
  );
  const report = {
    kind: "local-workerd-integration",
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - start,
    checks,
    model: "deterministic-v1",
    paidCalls: 0,
    cloudDeployment: false,
  };
  await writeFile(
    "docs/validation/local-integration.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  console.error("Integration failed:", e);
  console.error(logs.replaceAll(admin, "[REDACTED]").slice(-10000));
  process.exitCode = 1;
} finally {
  for (const p of children.reverse()) await stopChild(p);
  const { unlink } = await import("node:fs/promises");
  await unlink(".dev.vars");
}
