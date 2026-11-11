import {test} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {bindNodeAccount} from "../local/account-binding.ts";
test("local data directories bind once, survive credential rotation and reject another account before outbox replay",()=>{
 const db=new DatabaseSync(":memory:");bindNodeAccount(db,"a".repeat(64));bindNodeAccount(db,"a".repeat(64));
 assert.throws(()=>bindNodeAccount(db,"b".repeat(64)),/ACCOUNT_DATA_DIRECTORY_MISMATCH/);
 assert.throws(()=>bindNodeAccount(db,undefined),/ACCOUNT_SCOPE_REQUIRED/);
 assert.equal(db.prepare("SELECT scope FROM node_identity").get()!.scope,"a".repeat(64));db.close();
});
