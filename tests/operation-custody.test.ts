import {test} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initialState,submit,operation} from "../src/domain.ts";
import {DeletionStore,deleteConversationState} from "../src/deletion.ts";
import type {StateStorage} from "../src/state-store.ts";
function setup(db=new DatabaseSync(":memory:")){
 let depth=0;const storage:StateStorage={sql:{exec<T>(q:string,...b:any[]){const s=db.prepare(q),rows=(s.columns().length?s.all(...b):(s.run(...b),[])) as T[];return{toArray:()=>rows};}},transactionSync<T>(fn:()=>T){if(depth)return fn();db.exec("BEGIN");depth++;try{const value=fn();db.exec("COMMIT");return value;}catch(e){db.exec("ROLLBACK");throw e;}finally{depth--;}}};
 const d=new DeletionStore(storage),s=initialState(),t=submit(s,"private input","request","research");t.conversationId="c";
 s.conversations=[{id:"c",title:"private",projectId:"default",created:0,scope:[],history:[]}];
 const op=operation(s,t,"index","retrieve_chunks",{query:"private"});
 return{db,storage,d,s,t,op};
}
test("each possible device holder must independently acknowledge deletion, across restart and replay",()=>{
 const f=setup();
 try{
  f.d.custody.dispatch(f.op,"A");f.d.custody.dispatch(f.op,"B");
  f.d.request(f.s,"c");deleteConversationState(f.s,"c");f.d.cloudDone("c");
  assert.deepEqual(f.d.operationIds("c","A"),[f.op.id]);assert.deepEqual(f.d.operationIds("c","B"),[f.op.id]);
  assert.deepEqual(f.d.operationIds("c","unrelated"),[]);
  assert.throws(()=>f.d.localDone("c",[f.op.id],"unrelated"),/OPERATION_DEVICE_MISMATCH/);
  f.d.localDone("c",[f.op.id],"B");assert.equal(f.d.get("c")!.status,"cloud_complete");
  const reopened=new DeletionStore(f.storage);assert.equal(reopened.get("c")!.status,"cloud_complete");
  for(let i=0;i<5;i++)reopened.localDone("c",[f.op.id],"B");
  assert.deepEqual(reopened.operationIds("c","A"),[f.op.id]);
  reopened.localDone("c",[f.op.id],"A");assert.equal(reopened.get("c")!.status,"completed");
  reopened.lateOperation(f.op.id,"A");assert.equal(reopened.get("c")!.status,"completed");
  assert.throws(()=>reopened.lateOperation(f.op.id,"unrelated"),/OPERATION_DEVICE_MISMATCH/);
  assert.throws(()=>reopened.custody.dispatch(f.op,"A"),/OPERATION_DELETED/);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM pra_operation_holders").get()!.n,2);
 }finally{f.db.close();}
});
test("50 operations replayed five times cannot be cleared by the wrong device or a partially valid receipt",()=>{
 const f=setup();
 try{
  const ids=Array.from({length:50},(_,i)=>"operation-"+i);
  f.s.operations=ids.map(id=>({...f.op,id}));for(const op of f.s.operations)f.d.custody.dispatch(op,"A");
  f.d.request(f.s,"c");f.d.cloudDone("c");
  assert.throws(()=>f.d.localDone("c",[ids[0],"unknown"],"A"),/OPERATION_DEVICE_MISMATCH/);
  assert.equal(f.d.operationIds("c","A").length,50);
  assert.throws(()=>f.d.localDone("other-deletion",ids,"A"),/OPERATION_DEVICE_MISMATCH/);
  for(let i=0;i<5;i++)f.d.localDone("c",ids,"A");
  assert.equal(f.d.get("c")!.status,"completed");assert.equal(f.d.operationIds("c").length,0);
  assert.ok(!JSON.stringify(f.db.prepare("SELECT * FROM pra_operation_holders").all()).includes("private"));
 }finally{f.db.close();}
});
test("an operation created under delivery tracking needs no device acknowledgment if never dispatched",()=>{
 const f=setup();
 try{f.d.request(f.s,"c");f.d.cloudDone("c");assert.equal(f.d.get("c")!.status,"completed");assert.equal(f.d.deletedOperation(f.op.id),true);}
 finally{f.db.close();}
});
test("legacy acknowledgments and late receipts cannot prove an unknown historical device list",()=>{
 const db=new DatabaseSync(":memory:");
 db.exec("CREATE TABLE pra_deletions(id TEXT PRIMARY KEY,session_id TEXT,status TEXT NOT NULL,created INTEGER NOT NULL,error TEXT,local_pending INTEGER NOT NULL);INSERT INTO pra_deletions VALUES('old',NULL,'completed',0,NULL,0);CREATE TABLE pra_deleted_operations(id TEXT PRIMARY KEY,deletion_id TEXT NOT NULL,purged INTEGER NOT NULL DEFAULT 0);INSERT INTO pra_deleted_operations VALUES('old-op','old',1)");
 const f=setup(db);
 try{
  assert.equal(f.d.get("old")!.status,"cloud_complete");assert.equal(f.d.get("old")!.error,"LEGACY_DEVICE_OWNERSHIP_UNKNOWN");
  assert.throws(()=>f.d.localDone("old",["old-op"],"new-device"),/OPERATION_DEVICE_MISMATCH/);
  f.d.lateOperation("old-op","old-device");assert.deepEqual(f.d.operationIds("old","old-device"),["old-op"]);
  f.d.localDone("old",["old-op"],"old-device");assert.equal(f.d.get("old")!.status,"cloud_complete");
  assert.equal(new DeletionStore(f.storage).get("old")!.local_pending,1);
  delete f.op.deliveryVersion;f.op.state="done";f.d.custody.receive(f.op,"known-one");
  f.d.request(f.s,"c");f.d.cloudDone("c");f.d.localDone("c",[f.op.id],"known-one");
  assert.equal(f.d.get("c")!.status,"cloud_complete");assert.equal(f.d.get("c")!.error,"LEGACY_DEVICE_OWNERSHIP_UNKNOWN");
 }finally{db.close();}
});
test("results, errors and deferrals on new operations require a recorded authenticated recipient",()=>{
 const f=setup();
 try{
  assert.throws(()=>f.d.custody.receive(f.op,"B"),/OPERATION_DEVICE_MISMATCH/);
  f.d.custody.dispatch(f.op,"A");f.d.custody.receive(f.op,"A");
  assert.throws(()=>f.d.custody.receive(f.op,"B"),/OPERATION_DEVICE_MISMATCH/);
 }finally{f.db.close();}
});
