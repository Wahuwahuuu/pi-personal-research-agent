import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DevicePairings } from "../src/device-pairings.ts";
import type { StateStorage } from "../src/state-store.ts";
function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE pra_auth(hash TEXT PRIMARY KEY,kind TEXT NOT NULL,expires INTEGER NOT NULL); CREATE TABLE pra_devices(id TEXT PRIMARY KEY,hash TEXT UNIQUE NOT NULL,label TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0)");
  let fail = false;
  const port: StateStorage = {sql:{exec<T>(q:string,...b:any[]){
    if (fail && q.startsWith("INSERT INTO pra_device_pairs")) throw Error("INJECTED_WRITE_FAILURE");
    const s=db.prepare(q),v=(s.columns().length?s.all(...b):(s.run(...b),[])) as T[]; return {toArray:()=>v};
  }},transactionSync<T>(f:()=>T){
    db.exec("BEGIN");try{const v=f();db.exec("COMMIT");return v;}catch(e){db.exec("ROLLBACK");throw e;}
  }};
  return {db, pairs:new DevicePairings(port), inject:(v:boolean)=>{fail=v;}};
}
const secret=()=>crypto.randomUUID()+crypto.randomUUID();
test("parallel retries return one credential with its original expiry and no persisted credential", async()=>{
  const f=setup(), key=secret(), b={requestId:"same-request",label:"My node"};
  try {
    const results=await Promise.all(Array.from({length:25},()=>f.pairs.issue("owner",key,b,100)));
    for(const v of results)assert.deepEqual(v,results[0]);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM pra_devices").get()!.n,1);
    const next=await f.pairs.issue("owner",key,b,100+86400000);
    assert.equal(next.expires,results[0].expires);assert.equal(next.expiresInDays,89);
    const stored=JSON.stringify(["pra_auth","pra_devices","pra_device_pairs"].map(t=>f.db.prepare("SELECT * FROM "+t).all()));
    assert.ok(!stored.includes(results[0].token));assert.ok(!stored.includes(key));
    const other=setup();try{assert.notEqual((await other.pairs.issue("other",key,b,100)).token,results[0].token);}finally{other.db.close();}
  }finally{f.db.close();}
});
test("parameter conflicts, credential rotation, expiry and revocation cannot recreate a device", async()=>{
  const f=setup(), key=secret(), b={requestId:"request",label:"Node"};
  try {
    const p=await f.pairs.issue("owner",key,b,100);
    await assert.rejects(f.pairs.issue("owner",key,{...b,label:"changed"},100),/IDEMPOTENCY_CONFLICT/);
    await assert.rejects(f.pairs.issue("owner",secret(),b,100),/PAIRING_KEY_CHANGED/);
    await assert.rejects(f.pairs.issue("owner",key,b,p.expires),/PAIRING_EXPIRED/);
    f.db.prepare("UPDATE pra_devices SET revoked=1 WHERE id=?").run(p.id);
    f.db.prepare("DELETE FROM pra_auth WHERE hash=?").run(p.hash);
    await assert.rejects(f.pairs.issue("owner",key,b,101),/PAIRING_REVOKED/);
    assert.throws(()=>f.pairs.active(p.id,p.hash,101),/PAIRING_REVOKED/);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM pra_auth").get()!.n,0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM pra_devices").get()!.n,1);
  }finally{f.db.close();}
});
test("failed writes roll back credential and device together, then the same request can recover", async()=>{
  const f=setup(),key=secret(),b={requestId:"recover"};
  try{
    f.inject(true);await assert.rejects(f.pairs.issue("owner",key,b),/INJECTED_WRITE_FAILURE/);
    for(const table of ["pra_auth","pra_devices","pra_device_pairs"])assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM "+table).get()!.n,0);
    f.inject(false);const p=await f.pairs.issue("owner",key,b);assert.equal(f.pairs.active(p.id,p.hash).id,p.id);
  }finally{f.db.close();}
});
test("legacy clients create distinct devices while invalid keyed requests make no writes", async()=>{
  const f=setup(),key=secret();
  try{
    await assert.rejects(f.pairs.issue("owner","short",{requestId:"a"}),/PAIRING_NOT_CONFIGURED/);
    await assert.rejects(f.pairs.issue("owner",key,{requestId:""}));
    await assert.rejects(f.pairs.issue("owner",key,{requestId:"a".repeat(129)}));
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM pra_devices").get()!.n,0);
    const a=await f.pairs.issue("owner",key,{}),b=await f.pairs.issue("owner",key,{});
    assert.notEqual(a.id,b.id);assert.notEqual(a.token,b.token);
  }finally{f.db.close();}
});
