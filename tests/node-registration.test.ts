import {test} from "node:test";
import {randomUUID} from "node:crypto";
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import type {AddressInfo} from "node:net";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {basename, dirname, join, resolve} from "node:path";
import {tmpdir} from "node:os";
import {WebSocketServer, type WebSocket} from "ws";
import assert from "node:assert/strict";
import {persistentRegistrationIssue, reconnectDelay, connectionIssue} from "../local/registration-policy.ts";

test("connection failures expose fixed diagnostic codes without upstream messages or credentials",()=>{
 for(const [code,expected] of [["ECONNREFUSED","NODE_CONNECTION_REFUSED"],["EAI_AGAIN","NODE_DNS_FAILED"],["ETIMEDOUT","NODE_CONNECTION_TIMEOUT"],["CERT_HAS_EXPIRED","NODE_TLS_FAILED"],["ECONNRESET","NODE_NETWORK_INTERRUPTED"]])
   assert.equal(connectionIssue(Object.assign(new Error("credential-bearing upstream text"),{code})),expected);
 assert.equal(connectionIssue(new Error("Opening handshake has timed out")),"NODE_CONNECTION_TIMEOUT");
 assert.equal(connectionIssue(new Error("credential-bearing upstream text")),"NODE_CONNECTION_FAILED");
 assert.equal(persistentRegistrationIssue(connectionIssue({code:"ECONNREFUSED"})),undefined);
});

test("consecutive incomplete registrations back off to thirty seconds", () => {
  assert.deepEqual(Array.from({length: 9}, (_, n) => reconnectDelay(n)), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
});

test("only diagnosed permanent registration errors can surface remote error codes", () => {
  for (const code of ["PROTOCOL_MISMATCH", "CATALOG_VERSION_CONFLICT", "INVALID_CATALOG", "CATALOG_SIZE", "INDEX_CHANGED"]) {
    assert.equal(persistentRegistrationIssue(code), code);
  }
  for (const code of ["INVALID_FRAME", "CATALOG_INCOMPLETE", "untrusted message", {}, null]) {
    assert.equal(persistentRegistrationIssue(code), undefined);
  }
});

test("a refused connection is visible in the real node status and remains retryable",{timeout:15000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),"pra-node-refused-"));
 const freePort=async()=>{const server=createServer();await new Promise<void>(ok=>server.listen(0,"127.0.0.1",ok));const port=(server.address() as AddressInfo).port;await new Promise<void>(ok=>server.close(()=>ok()));return port;};
 const remote=await freePort(),port=await freePort(),config=join(dir,"node.json"),token=randomUUID()+randomUUID();
 assert.notEqual(remote,port);
 await writeFile(config,JSON.stringify({endpoint:"http://127.0.0.1:"+remote,fixture:true,proxy:"",port,dataDir:dir}));
 const child=spawn(process.execPath,[resolve("local/node.ts"),config],{windowsHide:true,stdio:"ignore",env:{...process.env,PRA_LOCAL_TOKEN:token,PRA_DEVICE_TOKEN:randomUUID()+randomUUID()}});
 try{
  let found=false;const until=Date.now()+7000;
  do{
   const state=await fetch("http://127.0.0.1:"+port+"/local/status",{headers:{Authorization:"Bearer "+token}}).then(r=>r.json() as Promise<{error:string;phase:string;connected:boolean;ready:boolean}>).catch(()=>undefined);
   if(state?.error==="NODE_CONNECTION_REFUSED"){
    assert.equal(state.phase,"reconnecting");assert.equal(state.connected,false);assert.equal(state.ready,false);found=true;break;
   }
   await new Promise(ok=>setTimeout(ok,40));
  }while(Date.now()<until);
  assert.equal(found,true);
 }finally{
  if(child.exitCode===null){const closed=new Promise(ok=>child.once("exit",ok));child.kill();await closed;}
  assert.equal(dirname(dir),resolve(tmpdir()));assert.ok(basename(dir).startsWith("pra-node-refused-"));
  await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});
 }
});

test("a real node stays offline on a catalog conflict, then accepts a manual registration and clears readiness on disconnect", {timeout: 15000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pra-node-registration-"));
  const server = createServer();
  const cloud = new WebSocketServer({server});
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const probe = createServer();
  await new Promise<void>(done => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>(done => probe.close(() => done()));
  const token = randomUUID() + randomUUID(), config = join(dir, "node.json");
  let connections = 0, confirms = 0, uploads = 0, release = false, current: WebSocket | undefined;
  cloud.on("connection", socket => {
    const attempt = ++connections;
    current = socket;
    socket.on("message", raw => {
      if (raw.toString() === "ping") return socket.send("pong");
      const frame = JSON.parse(raw.toString());
      if (frame.type === "hello") socket.send(JSON.stringify({type: "hello_ack", accountScope: "a".repeat(64), catalogMatch: release ? frame.catalogDigest : undefined}));
      if (frame.type === "catalog_confirm") {
        confirms++;
        socket.send(JSON.stringify({type: attempt === 2 ? "catalog_upload_required" : "catalog_ack", indexVersion:"fixture-v1"}));
      }
      if (frame.type === "catalog_end") {
        uploads++;
        socket.send(JSON.stringify(release ? {type: "catalog_ack", indexVersion: "fixture-v1"} : {type: "error", code: "CATALOG_VERSION_CONFLICT"}));
      }
    });
  });
  await writeFile(config, JSON.stringify({endpoint: "http://127.0.0.1:" + (server.address() as AddressInfo).port, fixture: true, proxy: "", port, dataDir: dir}));
  const launchTime = Date.now();
  const child = spawn(process.execPath, [resolve("local/node.ts"), config], {windowsHide: true, stdio: "ignore", env: {...process.env, PRA_LOCAL_TOKEN: token, PRA_DEVICE_TOKEN: randomUUID() + randomUUID()}});
  const base = "http://127.0.0.1:" + port + "/local/", headers = {Authorization: "Bearer " + token};
  type LocalStatus = {
    ready: boolean; connected: boolean; error: string; phase: string;
    startup: {startedAtMs: number; firstCloudHelloMs: number | null; firstCatalogAckMs: number | null; firstReadySentMs: number | null};
  };
  async function waitFor(predicate: (state: LocalStatus) => boolean) {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      const state = await fetch(base + "status", {headers}).then(r => r.json() as Promise<LocalStatus>).catch(() => undefined);
      if (state && predicate(state)) return state;
      await new Promise(done => setTimeout(done, 25));
    }
    assert.fail("expected local node state was never observed");
  }
  try {
    const blocked = await waitFor(s => s.phase === "registration_blocked" && s.error === "CATALOG_VERSION_CONFLICT" && !s.ready && !s.connected);
    assert.ok(blocked.startup.startedAtMs >= launchTime - 5 && blocked.startup.startedAtMs <= Date.now());
    assert.ok(Number.isSafeInteger(blocked.startup.firstCloudHelloMs));
    assert.equal(blocked.startup.firstCatalogAckMs, null);
    assert.equal(blocked.startup.firstReadySentMs, null);
    await new Promise(done => setTimeout(done, 1150));
    assert.equal(connections, 1);
    release = true;
    assert.equal((await fetch(base + "control", {method: "POST", headers, body: JSON.stringify({action: "reconnect"})})).status, 200);
    const first = await waitFor(s => s.connected && s.ready && s.error === "");
    assert.equal(first.startup.startedAtMs, blocked.startup.startedAtMs);
    assert.equal(first.startup.firstCloudHelloMs, blocked.startup.firstCloudHelloMs);
    assert.ok(first.startup.firstCatalogAckMs! >= first.startup.firstCloudHelloMs!);
    assert.ok(first.startup.firstReadySentMs! >= first.startup.firstCatalogAckMs!);
    assert.ok(first.startup.startedAtMs + first.startup.firstReadySentMs! <= Date.now() + 5);
    assert.equal(connections, 2);
    current!.close(1012);
    await waitFor(s => !s.ready && !s.connected && s.phase === "reconnecting");
    const again = await waitFor(s => s.ready && s.connected);
    assert.deepEqual(again.startup, first.startup);
    assert.deepEqual({connections, confirms, uploads}, {connections:3, confirms:2, uploads:2});
  } finally {
    if (child.exitCode === null) {
      const closed = new Promise(done => child.once("exit", done));
      child.kill();
      await closed;
    }
    for (const ws of cloud.clients) ws.terminate();
    await new Promise<void>(done => cloud.close(() => done()));
    await new Promise<void>(done => server.close(() => done()));
    assert.equal(dirname(dir), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("pra-node-registration-"));
    await rm(dir, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});
  }
});
