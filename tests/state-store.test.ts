import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { StateRepository, type StateStorage } from "../src/state-store.ts";
import { initialState, submit } from "../src/domain.ts";
function fixture() {
  const db = new DatabaseSync(":memory:");
  let fail = false;
  const storage: StateStorage = {
    sql: { exec<T>(q: string, ...b: any[]) {
      if (fail && q.startsWith("INSERT INTO pra_changes")) throw Error("INJECTED_DISK_FAILURE");
      const stmt=db.prepare(q), rows=(stmt.columns().length ? stmt.all(...b) : (stmt.run(...b), [])) as T[];
      return {toArray:()=>rows};
    } },
    transactionSync<T>(fn:()=>T) { db.exec("BEGIN"); try {const result=fn();db.exec("COMMIT");return result;} catch(e) {db.exec("ROLLBACK");throw e;} }
  };
  return { db, storage, setFail:(v:boolean)=>{fail=v;} };
}
test("legacy migration preserves tasks, unconfirmed operations, memory and conversation turns without duplicate legacy payload", () => {
  const f=fixture(), s=initialState(), t=submit(s,"synthetic question","r","research");
  t.status="waiting_device";
  s.operations.push({id:"op",taskId:t.id,indexVersion:"v1",tool:"search_papers",params:{query:"q"},state:"pending",deadline:0});
  s.conversations=[{id:"c",title:"c",projectId:"p",scope:[],created:1,history:[{turn_id:"a",user_text:"u",final_answer:"a"}]}];
  s.cloudMemory={enabled:true,entries:[],deletedSlots:["deleted"]};
  f.db.exec("CREATE TABLE pra_state(id INTEGER PRIMARY KEY,value TEXT)");
  f.db.prepare("INSERT INTO pra_state VALUES(1,?)").run(JSON.stringify(s));
  const store=new StateRepository(f.storage);
  assert.deepEqual(store.load(),s);
  assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name='pra_state'").all().length,0);
  assert.equal(store.save(s).writes,0);
  f.db.close();
});
test("only a changed task is rewritten; reconnect cursor and page do not lose records", () => {
  const f=fixture(),store=new StateRepository(f.storage),s=store.load();
  for(let i=0;i<120;i++) submit(s,"synthetic "+i,"r"+i,"chat");
  store.save(s);
  assert.equal(store.save(s).writes,0);
  s.tasks[0].status="running";
  const result=store.save(s);
  assert.equal(result.writes,1);
  assert.equal(store.changes(result.cursor-1).events.length,1);
  const seen=new Set<string>();let after="";
  do {const p=store.page("tasks",after,13);p.items.forEach(t=>seen.add(t.id));after=p.nextCursor??"";} while(after);
  assert.equal(seen.size,120);
  assert.throws(()=>store.page("tasks; DROP TABLE pra_meta"));
  f.db.close();
});
test("failed commit rolls back data and event atomically; retry is not hidden by a dirty cache", () => {
  const f=fixture(),store=new StateRepository(f.storage),s=store.load();
  submit(s,"question","r","chat");store.save(s);
  const cursor=store.cursor();s.tasks[0].status="cancelled";f.setFail(true);
  assert.throws(()=>store.save(s),/INJECTED/);
  assert.equal(store.cursor(),cursor);
  assert.equal(store.page("tasks").items[0].status,"queued");
  f.setFail(false);
  assert.equal(store.save(s).writes,1);
  assert.equal(new StateRepository(f.storage).load().tasks[0].status,"cancelled");
  f.db.close();
});
test("entity removal clears text and history, and events retain identifiers only", () => {
  const f=fixture(),store=new StateRepository(f.storage),s=store.load();
  s.conversations=[{id:"c",title:"title",projectId:"p",scope:[],created:0,history:[{turn_id:"t",user_text:"DELETE_ME",final_answer:"DELETE_ME"}]}];
  store.save(s);s.conversations=[];store.save(s);
  assert.equal(store.page("messages").items.length,0);
  assert.ok(!JSON.stringify(store.changes()).includes("DELETE_ME"));
  assert.deepEqual(new StateRepository(f.storage).load().conversations,[]);
  f.db.close();
});
test("unknown schema and malformed old state are never overwritten", () => {
  const f=fixture();f.db.exec("CREATE TABLE pra_app_schema(id INTEGER PRIMARY KEY,version INTEGER); INSERT INTO pra_app_schema VALUES(1,99)");
  assert.throws(()=>new StateRepository(f.storage),/UNKNOWN_STATE_SCHEMA/);
  assert.equal(f.db.prepare("SELECT version FROM pra_app_schema").get()!.version,99);f.db.close();
  const g=fixture();g.db.exec("CREATE TABLE pra_state(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO pra_state VALUES(1,'{}')");
  assert.throws(()=>new StateRepository(g.storage),/INVALID_LEGACY_STATE/);
  assert.equal(g.db.prepare("SELECT value FROM pra_state").get()!.value,"{}");g.db.close();
});
