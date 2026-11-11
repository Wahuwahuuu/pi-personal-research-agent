import {test} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {DeviceIndexes} from "../src/device-indexes.ts";
import type {StateStorage} from "../src/state-store.ts";
test("retained index inventory is credential-scoped, delta-written and compatible with an established legacy connection",()=>{
 const db=new DatabaseSync(":memory:");let writes=0;
 const storage:StateStorage={sql:{exec<T>(q:string,...b:any[]){const s=db.prepare(q);let v:T[]=[];if(s.columns().length)v=s.all(...b) as T[];else{const r=s.run(...b);writes+=Number(r.changes);}return{toArray:()=>v};}},transactionSync(fn){db.exec("BEGIN");try{const v=fn();db.exec("COMMIT");return v;}catch(e){db.exec("ROLLBACK");throw e;}}};
 try{
  const registry=new DeviceIndexes(storage);
  assert.equal(registry.supports("a","old","old"),true);
  assert.equal(registry.supports("a","foreign","old"),false);
  registry.declare("a","new",["old","new"]);
  assert.ok(registry.supports("a","old","new"));
  assert.equal(registry.supports("b","old","new"),false);
  const before=writes;registry.declare("a","new",["old","new"]);assert.equal(writes,before);
  assert.throws(()=>registry.declare("a","new",["wrong"]),/INVALID_INDEX_INVENTORY/);
  assert.ok(registry.supports("a","old","new"));
  registry.declare("a","new",["new"]);assert.equal(registry.supports("a","old","new"),false);
  assert.ok(registry.supports("a","new","new"));
 }finally{db.close();}
});
