import {activeTasks,taskByRequest} from "../src/task-queries.ts";
import {ProactiveResearch} from "../src/proactive-research.ts";
import {orderedTasks} from "../src/task-control.ts";
import {resolveConversationControl,recordConversationControl} from "../src/conversation-control.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { StateRepository, type StateStorage } from "../src/state-store.ts";
import {conversationPage,taskPage,taskSummary} from "../src/workspace.ts";
import { initialState, submit } from "../src/domain.ts";
function fixture() {
  const db = new DatabaseSync(":memory:");
  let fail = false;
  const queries:Array<{sql:string;rows:number}>=[];
  const storage: StateStorage = {
    sql: { exec<T>(q: string, ...b: any[]) {
      if (fail && q.startsWith("INSERT INTO pra_changes")) throw Error("INJECTED_DISK_FAILURE");
      const stmt=db.prepare(q), rows=(stmt.columns().length ? stmt.all(...b) : (stmt.run(...b), [])) as T[];
      queries.push({sql:q,rows:rows.length});
      return {toArray:()=>rows};
    } },
    transactionSync<T>(fn:()=>T) { db.exec("BEGIN"); try {const result=fn();db.exec("COMMIT");return result;} catch(e) {db.exec("ROLLBACK");throw e;} }
  };
  return { db, storage, queries, setFail:(v:boolean)=>{fail=v;} };
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

function conversations(count:number,turns:number){return Array.from({length:count},(_,i)=>({
 id:"c"+i,title:"Conversation "+i,projectId:"p",scope:[],created:i,
 history:Array.from({length:turns},(_,j)=>({turn_id:"t"+j,user_text:"question "+j,final_answer:"answer "+j}))
}));}
const bodyReads=(f:ReturnType<typeof fixture>)=>f.queries.filter(q=>/^SELECT \* FROM pra_data_messages/.test(q.sql)).reduce((sum,q)=>sum+q.rows,0);

test("cold startup, normal saves and conversation lists do not hydrate 10000 archived turns",()=>{
 const f=fixture(),store=new StateRepository(f.storage),s=store.load();s.conversations=conversations(100,100);store.save(s);
 const cold=new StateRepository(f.storage);f.queries.length=0;const loaded=cold.load();
 assert.equal(bodyReads(f),0);assert.equal(cold.save(loaded).writes,0);assert.equal(bodyReads(f),0);
 const page=conversationPage(loaded,{limit:30},cold);assert.equal(page.items.length,30);assert.ok(page.items.every(c=>c.turns===100));assert.equal(bodyReads(f),0);
 assert.equal(loaded.conversations![17].history.length,100);assert.equal(bodyReads(f),100);
 loaded.conversations![17].history.push({turn_id:"new",user_text:"next",final_answer:"done"});
 assert.equal(cold.save(loaded).writes,1);assert.equal(bodyReads(f),100);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM pra_data_messages").get()!.n,10001);
 assert.equal(new StateRepository(f.storage).load().conversations![17].history.at(-1)!.turn_id,"new");f.db.close();
});

test("deleting an unloaded conversation removes every turn without hydrating other histories",()=>{
 const f=fixture(),store=new StateRepository(f.storage),s=store.load();s.conversations=conversations(3,20);store.save(s);
 const cold=new StateRepository(f.storage),loaded=cold.load();f.queries.length=0;loaded.conversations=loaded.conversations!.filter(c=>c.id!=="c1");
 cold.save(loaded);assert.equal(bodyReads(f),0);assert.equal(cold.page("messages","",100,"c1").items.length,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM pra_data_messages").get()!.n,40);
 assert.equal(f.db.prepare("SELECT * FROM pra_history_counts WHERE conversation_id='c1'").get(),undefined);
 assert.equal(new StateRepository(f.storage).load().conversations![1].history.length,20);f.db.close();
});

test("cold history replacement and failed transaction preserve unloaded partitions and counts",()=>{
 const f=fixture(),store=new StateRepository(f.storage),s=store.load();s.conversations=conversations(3,10);store.save(s);
 const cold=new StateRepository(f.storage),loaded=cold.load();
 // Replace the object without reading its history getter.
 loaded.conversations![1]={id:"c1",title:"replacement",projectId:"p",scope:[],created:1,history:[{turn_id:"replacement",user_text:"new",final_answer:"new"}]};
 const cursor=cold.cursor();f.setFail(true);assert.throws(()=>cold.save(loaded),/INJECTED/);
 assert.equal(cold.cursor(),cursor);assert.equal(f.db.prepare("SELECT turns FROM pra_history_counts WHERE conversation_id='c1'").get()!.turns,10);
 f.setFail(false);cold.save(loaded);
 const reopened=new StateRepository(f.storage),fresh=reopened.load();assert.equal(reopened.historyCount(fresh.conversations![1]),1);
 assert.equal(fresh.conversations![1].history[0].turn_id,"replacement");assert.equal(fresh.conversations![2].history.length,10);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM pra_data_messages").get()!.n,21);f.db.close();
});

test("schema one history counts migrate atomically without rewriting legacy message positions",()=>{
 const f=fixture(),store=new StateRepository(f.storage),s=store.load();s.conversations=conversations(2,3);store.save(s);
 f.db.exec("UPDATE pra_app_schema SET version=1; DROP TABLE pra_history_counts; UPDATE pra_data_messages SET position=position+1000 WHERE parent='c1'");
 const cold=new StateRepository(f.storage),loaded=cold.load();assert.equal(f.db.prepare("SELECT version FROM pra_app_schema").get()!.version,3);
 assert.equal(cold.historyCount(loaded.conversations![1]),3);assert.equal(loaded.conversations![1].history[0].turn_id,"t0");
 assert.equal(cold.save(loaded).writes,0);loaded.conversations![1].history.push({turn_id:"new",user_text:"q",final_answer:"a"});
 assert.equal(cold.save(loaded).writes,1);
 assert.deepEqual(f.db.prepare("SELECT position FROM pra_data_messages WHERE parent='c1' ORDER BY position").all().map(r=>r.position),[1000,1001,1002,1003]);f.db.close();
});

test("explicit body search and legacy JSON export still include complete histories",()=>{
 const f=fixture(),store=new StateRepository(f.storage),s=store.load();s.conversations=conversations(2,5);s.conversations[1].history[0].user_text="中文特征及 ÄBC";store.save(s);
 const cold=new StateRepository(f.storage),loaded=cold.load();
 assert.equal(conversationPage(loaded,{q:"äbc"},cold).items[0].id,"c1");
 const exported=JSON.parse(JSON.stringify(loaded));assert.equal(exported.conversations[0].history.length,5);assert.equal(exported.conversations[1].history.length,5);f.db.close();
});

test("a failed control commit cannot persist a cancellation without its receipt or duplicate history on retry",()=>{
 const f=fixture(),store=new StateRepository(f.storage);
 let s=store.load();s.conversations=conversations(1,0);
 const target=submit(s,"read evidence","original","research");target.conversationId="c0";store.save(s);
 const cursor=store.cursor(),selection=resolveConversationControl(s,"c0","取消当前研究")!;
 f.setFail(true);
 try{recordConversationControl(s,"c0","取消当前研究","control",selection);store.save(s);assert.fail("must fail");}
 catch(e){assert.match(String(e),/INJECTED/);s=store.load();}
 assert.equal(s.tasks[0].status,"queued");assert.equal(s.tasks.length,1);assert.equal(s.conversations![0].history.length,0);assert.equal(store.cursor(),cursor);
 f.setFail(false);recordConversationControl(s,"c0","取消当前研究","control",selection);store.save(s);
 const restored=new StateRepository(f.storage).load();assert.equal(restored.tasks[0].status,"cancelled");assert.equal(restored.tasks.length,2);assert.equal(restored.conversations![0].history.length,1);
 recordConversationControl(restored,"c0","取消当前研究"," control ",selection);
 assert.equal(restored.conversations![0].history.length,1);f.db.close();
});

test("removing one of 10000 tasks does not rewrite the remaining ordered entities",()=>{
 const f=fixture(),store=new StateRepository(f.storage),s=store.load();
 const template=submit(s,"Synthetic retained question","first","chat");
 s.tasks=Array.from({length:10000},(_,i)=>({...template,id:"task-"+i,requestId:"request-"+i}));
 store.save(s);
 const before=f.db.prepare("SELECT id,parent,position,value FROM pra_data_tasks WHERE id!='task-0' ORDER BY position,id").all();
 s.tasks.shift();const changed=store.save(s);
 assert.equal(changed.writes,1);
 assert.deepEqual(f.db.prepare("SELECT id,parent,position,value FROM pra_data_tasks ORDER BY position,id").all(),before);
 assert.deepEqual(new StateRepository(f.storage).load().tasks.map(t=>t.id),s.tasks.map(t=>t.id));
 f.db.close();
});

test("stable entity positions preserve insertion, explicit reorder and transaction retry semantics",()=>{
 const f=fixture(),store=new StateRepository(f.storage),s=store.load();
 const template=submit(s,"Ordered task","base","chat");
 s.tasks=Array.from({length:4},(_,i)=>({...template,id:"t"+i,requestId:"r"+i}));store.save(s);
 const cold=new StateRepository(f.storage),loaded=cold.load();
 loaded.tasks.splice(2,0,{...template,id:"middle",requestId:"middle"});
 assert.equal(cold.save(loaded).writes,1);
 loaded.tasks.unshift({...template,id:"start",requestId:"start"});
 loaded.tasks.push({...template,id:"end",requestId:"end"});
 assert.equal(cold.save(loaded).writes,2);
 const before=f.db.prepare("SELECT id,position FROM pra_data_tasks ORDER BY position,id").all();
 loaded.tasks.reverse();f.setFail(true);assert.throws(()=>cold.save(loaded),/INJECTED/);
 assert.deepEqual(f.db.prepare("SELECT id,position FROM pra_data_tasks ORDER BY position,id").all(),before);
 f.setFail(false);cold.save(loaded);
 assert.deepEqual(new StateRepository(f.storage).load().tasks.map(t=>t.id),loaded.tasks.map(t=>t.id));
 assert.equal(cold.save(loaded).writes,0);f.db.close();
});

test("old contiguous entity positions do not migrate eagerly and rebalance only when an insertion has no gap",()=>{
 const f=fixture(),store=new StateRepository(f.storage),s=store.load();
 const template=submit(s,"Legacy position","base","chat");
 s.tasks=Array.from({length:3},(_,i)=>({...template,id:"t"+i,requestId:"r"+i}));store.save(s);
 f.db.exec("UPDATE pra_data_tasks SET position=CAST(substr(id,2) AS INTEGER)");
 const cold=new StateRepository(f.storage),loaded=cold.load();
 assert.equal(cold.save(loaded).writes,0);
 loaded.tasks.splice(1,0,{...template,id:"middle",requestId:"middle"});cold.save(loaded);
 assert.deepEqual(new StateRepository(f.storage).load().tasks.map(t=>t.id),["t0","middle","t1","t2"]);
 assert.equal(cold.save(loaded).writes,0);
 loaded.tasks.splice(2,0,{...template,id:"second",requestId:"second"});
 assert.equal(cold.save(loaded).writes,1);f.db.close();
});

const payloadReads=(f:ReturnType<typeof fixture>,name:"tasks"|"operations")=>f.queries.filter(q=>new RegExp("^SELECT (?:id,parent,position,value|\\*) FROM pra_data_"+name).test(q.sql)).reduce((sum,q)=>sum+q.rows,0);
test("1000 archived tasks and operations stay unhydrated until a page or individual result is read",()=>{
 const f=fixture(),store=new StateRepository(f.storage),s=store.load();
 for(let i=0;i<1000;i++){
   const t=submit(s,"question "+i+" "+"q".repeat(2000),"lazy-"+i,"research",i);t.status="completed";t.answer="answer "+i+" "+"a".repeat(8000);
   t.conversationId="c";s.operations.push({id:"op-"+i,taskId:t.id,tool:"retrieve_chunks",indexVersion:"v",state:"done",deadline:0,params:{query:"q"},result:{evidence:"e".repeat(8000)}});
 }
 store.save(s);
 const cold=new StateRepository(f.storage);f.queries.length=0;const loaded=cold.load();
 assert.equal(payloadReads(f,"tasks"),0);assert.equal(payloadReads(f,"operations"),0);
 assert.equal(loaded.tasks.filter(t=>t.status==="completed").length,1000);assert.equal(orderedTasks(loaded,true).length,0);
 const proactive=new ProactiveResearch({state:()=>loaded,batches:{pending:()=>[]}} as any);proactive.tick();assert.equal(proactive.nextBudgetWake(),undefined);
 assert.equal(cold.save(loaded).writes,0);
 assert.equal(payloadReads(f,"tasks"),0);assert.equal(payloadReads(f,"operations"),0);
 const page=taskPage(loaded,{limit:10});const summaries=page.items.map(taskSummary);
 assert.equal(summaries.length,10);assert.equal(summaries[0].input,s.tasks[999].input);
 assert.equal(payloadReads(f,"tasks"),10);assert.equal(payloadReads(f,"operations"),0);
 assert.equal((loaded.operations[0].result as any).evidence,"e".repeat(8000));assert.equal(payloadReads(f,"operations"),1);
 assert.equal(cold.save(loaded).writes,0);
 assert.equal(payloadReads(f,"tasks"),10);assert.equal(payloadReads(f,"operations"),1);
 f.db.close();
});
test("lazy task and operation mutations preserve untouched payloads and failed-commit retry",()=>{
 const f=fixture(),store=new StateRepository(f.storage),s=store.load();
 const t=submit(s,"retained question","lazy-mutate","research");t.workflow={progress:"before",nested:{value:1}} as any;t.answer="retained answer";
 s.operations.push({id:"op",taskId:t.id,tool:"search_papers",indexVersion:"v",state:"done",deadline:0,params:{query:"retained query"},result:{nested:{value:1}}});
 store.save(s);const cold=new StateRepository(f.storage),loaded=cold.load();f.queries.length=0;
 loaded.tasks[0].status="cancelled";assert.equal(payloadReads(f,"tasks"),1);assert.equal(payloadReads(f,"operations"),0);
 f.setFail(true);assert.throws(()=>cold.save(loaded),/INJECTED/);f.setFail(false);
 assert.equal(cold.save(loaded).writes,1);
 (loaded.tasks[0].workflow as any).nested.value=2;(loaded.operations[0].result as any).nested.value=2;
 assert.equal(cold.save(loaded).writes,2);assert.equal(cold.save(loaded).writes,0);
 const reopened=new StateRepository(f.storage).load();
 assert.equal(reopened.tasks[0].status,"cancelled");assert.equal(reopened.tasks[0].input,"retained question");assert.equal(reopened.tasks[0].answer,"retained answer");
 assert.equal((reopened.tasks[0].workflow as any).nested.value,2);assert.equal((reopened.operations[0].result as any).nested.value,2);assert.equal(reopened.operations[0].params.query,"retained query");
 f.db.close();
});
test("removing unhydrated tasks and results deletes their text without reading unrelated bodies",()=>{
 const f=fixture(),store=new StateRepository(f.storage),s=store.load();
 for(let i=0;i<5;i++){const t=submit(s,"remove "+i,"remove-"+i,"chat");s.operations.push({id:"op"+i,taskId:t.id,tool:"search_papers",indexVersion:"v",state:"done",deadline:0,params:{query:"q"},result:{value:"delete me"}});}
 store.save(s);const cold=new StateRepository(f.storage),loaded=cold.load();f.queries.length=0;
 const id=loaded.tasks[2].id;loaded.tasks=loaded.tasks.filter(t=>t.id!==id);loaded.operations=loaded.operations.filter(o=>o.taskId!==id);
 assert.equal(cold.save(loaded).writes,2);assert.equal(payloadReads(f,"tasks"),0);assert.equal(payloadReads(f,"operations"),0);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM pra_data_tasks WHERE id=?").get(id)!.n,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM pra_data_operations WHERE parent=?").get(id)!.n,0);
 assert.equal(cold.save(loaded).writes,0);f.db.close();
});
test("schema two header migration preserves exact bodies and rolls back a failed migration",()=>{
 const f=fixture(),store=new StateRepository(f.storage),s=store.load();
 submit(s,"original source","migration","research");store.save(s);
 const original=f.db.prepare("SELECT id,parent,position,value FROM pra_data_tasks").all();
 f.db.exec("DROP INDEX pra_tasks_request; DROP INDEX pra_tasks_created; DROP INDEX pra_tasks_conversation_created; DROP INDEX pra_tasks_status_created; DROP INDEX pra_tasks_active; DROP INDEX pra_tasks_open; UPDATE pra_app_schema SET version=2; ALTER TABLE pra_data_tasks DROP COLUMN header; ALTER TABLE pra_data_operations DROP COLUMN header");
 let fail=true;
 const wrapped:StateStorage={...f.storage,sql:{exec<T>(q:string,...b:any[]){if(fail&&q.startsWith("UPDATE pra_data_tasks SET header="))throw Error("MIGRATION_INTERRUPTED");return f.storage.sql.exec<T>(q,...b);}}};
 assert.throws(()=>new StateRepository(wrapped),/MIGRATION_INTERRUPTED/);
 assert.equal(f.db.prepare("SELECT version FROM pra_app_schema").get()!.version,2);
 assert.ok(!f.db.prepare("PRAGMA table_info(pra_data_tasks)").all().some(c=>c.name==="header"));
 assert.deepEqual(f.db.prepare("SELECT id,parent,position,value FROM pra_data_tasks").all(),original);
 fail=false;const cold=new StateRepository(wrapped),loaded=cold.load();
 assert.equal(f.db.prepare("SELECT version FROM pra_app_schema").get()!.version,3);
 assert.equal(loaded.tasks[0].input,"original source");assert.equal(cold.save(loaded).writes,0);
 assert.deepEqual(f.db.prepare("SELECT id,parent,position,value FROM pra_data_tasks").all(),original);f.db.close();
});

const headerReads=(f:ReturnType<typeof fixture>)=>f.queries.filter(q=>/^SELECT header FROM pra_data_(tasks|operations)/.test(q.sql)).reduce((n,q)=>n+q.rows,0);
test("cold identity load and unchanged save do not deserialize 10000 task headers; indexed scheduling skips terminal history",()=>{
 const f=fixture(),store=new StateRepository(f.storage),s=store.load(),template=submit(s,"large history","base","chat");
 s.tasks=Array.from({length:10000},(_,i)=>({...template,id:"t"+String(i).padStart(5,"0"),requestId:"r"+i,created:i,status:"completed" as const}));
 s.tasks[9997].status="queued";s.tasks[9998].status="waiting_device";s.tasks[9999].status="cancelled";s.tasks[9999].runOpen=true;
 store.save(s);const cold=new StateRepository(f.storage);f.queries.length=0;const loaded=cold.load();
 assert.equal(headerReads(f),0);assert.equal(payloadReads(f,"tasks"),0);assert.equal(cold.save(loaded).writes,0);assert.equal(headerReads(f),0);
 assert.deepEqual(orderedTasks(loaded,true).map(t=>t.id),["t09997","t09998"]);assert.equal(headerReads(f),2);assert.equal(payloadReads(f,"tasks"),0);
 assert.deepEqual(activeTasks(loaded,true).map(t=>t.id),["t09997","t09998","t09999"]);assert.equal(headerReads(f),2);
 const selected=f.queries.filter(q=>q.sql.startsWith("SELECT id FROM pra_data_tasks WHERE"));assert.equal(selected.reduce((n,q)=>n+q.rows,0),5);
 assert.equal(cold.save(loaded).writes,0);assert.equal(payloadReads(f,"tasks"),0);f.db.close();
});
test("SQL keyset pages preserve equal timestamps, binary ID order, filters and lazy task bodies",()=>{
 const f=fixture(),store=new StateRepository(f.storage),s=store.load(),template=submit(s,"page question","base","chat");
 s.tasks=Array.from({length:251},(_,i)=>({...template,id:(i%2?"A":"a")+String(i).padStart(4,"0"),requestId:"r"+i,created:Math.floor(i/9),conversationId:"c"+(i%3),status:i%4?"completed" as const:"queued" as const}));store.save(s);
 const cold=new StateRepository(f.storage),loaded=cold.load();f.queries.length=0;
 for(const filter of [{},{conversationId:"c1"},{status:"queued"},{conversationId:"c2",status:"completed"}]){
  const expected=taskPage(s,{...filter,limit:100});const actual=taskPage(loaded,{...filter,limit:100});assert.deepEqual(actual.items.map(t=>t.id),expected.items.map(t=>t.id));assert.equal(actual.nextCursor,expected.nextCursor);
  let before:string|undefined;const seen:string[]=[];
  do{const page=taskPage(loaded,{...filter,before,limit:7});seen.push(...page.items.map(t=>t.id));before=page.nextCursor??undefined;}while(before);
  const all=s.tasks.filter(t=>(!filter.conversationId||t.conversationId===filter.conversationId)&&(!filter.status||t.status===filter.status));assert.equal(seen.length,all.length);assert.equal(new Set(seen).size,all.length);
 }
 assert.equal(payloadReads(f,"tasks"),0);const page=taskPage(loaded,{limit:10});page.items.map(taskSummary);assert.equal(payloadReads(f,"tasks"),10);assert.equal(cold.save(loaded).writes,0);f.db.close();
});
test("uncommitted mutations, deletion, new tasks and reassigned arrays override SQL task views",()=>{
 const f=fixture(),store=new StateRepository(f.storage),s=store.load(),template=submit(s,"live mutation","base","chat");
 s.tasks=Array.from({length:40},(_,i)=>({...template,id:"t"+String(i).padStart(3,"0"),requestId:"r"+i,created:i,status:i%2?"completed" as const:"queued" as const,conversationId:"c1"}));store.save(s);
 const cold=new StateRepository(f.storage),loaded=cold.load();loaded.tasks[0].status="completed";loaded.tasks[1].status="queued";loaded.tasks[1].created=100;loaded.tasks[3].conversationId="c2";loaded.tasks[3].status="queued";
 loaded.tasks=loaded.tasks.filter(t=>t.id!=="t038");loaded.tasks.push({...template,id:"new",requestId:"new",created:101,status:"queued",conversationId:"c2"});
 const expected={...loaded,tasks:loaded.tasks.map(t=>({...t}))};const persistedCursor=cold.cursor();
 for(const filter of [{},{status:"queued"},{conversationId:"c2"},{status:"completed",conversationId:"c1"}])assert.deepEqual(taskPage(loaded,{...filter,limit:7}),taskPage(expected,{...filter,limit:7}));
 assert.deepEqual(activeTasks(loaded).map(t=>t.id),activeTasks(expected).map(t=>t.id));assert.equal(cold.cursor(),persistedCursor);
 f.setFail(true);assert.throws(()=>cold.save(loaded),/INJECTED/);assert.deepEqual(taskPage(loaded,{status:"queued",limit:7}),taskPage(expected,{status:"queued",limit:7}));f.setFail(false);cold.save(loaded);
 const reopened=new StateRepository(f.storage).load();assert.deepEqual(taskPage(reopened,{status:"queued",limit:7}),taskPage(expected,{status:"queued",limit:7}));assert.ok(!reopened.tasks.some(t=>t.id==="t038"));f.db.close();
});
test("SQL candidates cross 200-row boundaries and pagination fills gaps left by dirty and removed tasks",()=>{
 const f=fixture(),store=new StateRepository(f.storage),s=store.load(),template=submit(s,"many candidates","base","chat");
 s.tasks=Array.from({length:610},(_,i)=>({...template,id:"t"+String(i).padStart(4,"0"),requestId:"r"+i,created:i,status:"queued" as const}));store.save(s);
 const cold=new StateRepository(f.storage),loaded=cold.load();for(let i=505;i<610;i++)loaded.tasks[i].status="completed";loaded.tasks=loaded.tasks.filter(t=>!['t0503','t0504'].includes(t.id));
 const active=activeTasks(loaded);assert.equal(active.length,503);assert.equal(active.at(-1)!.id,"t0502");
 const page=taskPage(loaded,{status:"queued",limit:10});assert.deepEqual(page.items.map(t=>t.id),Array.from({length:10},(_,i)=>"t"+String(502-i).padStart(4,"0")));assert.equal(page.nextCursor,"493:t0493");assert.equal(cold.save(loaded).writes,107);f.db.close();
});
test("task SQL views use expression and partial indexes rather than temporary whole-history sorting",()=>{
 const f=fixture();new StateRepository(f.storage);
 const queries=[
  "SELECT id,json_extract(header,'$.created') AS created FROM pra_data_tasks WHERE json_extract(header,'$.created')=100 AND id<'z' ORDER BY id DESC LIMIT 11",
  "SELECT id FROM pra_data_tasks WHERE (json_extract(header,'$.status') NOT IN ('completed','failed','cancelled')) AND id>'' ORDER BY id LIMIT 200",
  "SELECT id FROM pra_data_tasks WHERE (json_extract(header,'$.status') NOT IN ('completed','failed','cancelled') OR json_extract(header,'$.runOpen')=1) AND id>'' ORDER BY id LIMIT 200",
 ];
 for(const query of queries){const plan=f.db.prepare("EXPLAIN QUERY PLAN "+query).all().map(r=>String(r.detail)).join(" ");assert.match(plan,/USING (?:COVERING )?INDEX pra_tasks_/);assert.doesNotMatch(plan,/TEMP B-TREE/);}
 f.db.close();
});

test("idempotent submission consults the request index without reading historical task headers",()=>{
 const f=fixture(),store=new StateRepository(f.storage),s=store.load(),template=submit(s,"original prompt","base","chat");s.tasks=Array.from({length:1000},(_,i)=>({...template,id:"t"+i,requestId:"r"+i,created:i,status:"completed" as const}));store.save(s);
 const cold=new StateRepository(f.storage),loaded=cold.load();f.queries.length=0;
 assert.equal(submit(loaded,"original prompt","r999","chat").id,"t999");assert.equal(headerReads(f),0);assert.equal(payloadReads(f,"tasks"),1);assert.equal(loaded.tasks.length,1000);
 f.queries.length=0;const added=submit(loaded,"new prompt","new-request","chat");assert.equal(headerReads(f),0);assert.equal(taskByRequest(loaded,"new-request"),added);assert.equal(cold.save(loaded).writes,1);f.db.close();
});
test("request lookup honors modified IDs and removal before commit rather than resurrecting the SQL match",()=>{
 const f=fixture(),store=new StateRepository(f.storage),s=store.load();const a=submit(s,"a","a","chat"),b=submit(s,"b","b","chat");store.save(s);
 const cold=new StateRepository(f.storage),loaded=cold.load();loaded.tasks[0].requestId="changed";loaded.tasks=loaded.tasks.filter(t=>t.id!==b.id);
 assert.equal(taskByRequest(loaded,"a"),undefined);assert.equal(taskByRequest(loaded,"b"),undefined);assert.equal(taskByRequest(loaded,"changed")!.id,a.id);f.db.close();
});
