import {test} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {IdentityStore} from "../src/identity-store.ts";
import {IdentityMutations} from "../src/identity-mutations.ts";
import {digest} from "../src/auth.ts";
import type {StateStorage} from "../src/state-store.ts";
const secret="synthetic-identity-key-".repeat(3);
function fixture(){
 const db=new DatabaseSync(":memory:");let depth=0,fail="";
 const storage:StateStorage={sql:{exec<T>(sql:string,...args:any[]){if(fail&&sql.startsWith(fail))throw Error("INJECTED_FAILURE");const q=db.prepare(sql),rows=(q.columns().length?q.all(...args):(q.run(...args),[])) as T[];return{toArray:()=>rows};}},transactionSync<T>(fn:()=>T){if(depth)return fn();db.exec("BEGIN");depth++;try{const v=fn();db.exec("COMMIT");return v;}catch(e){db.exec("ROLLBACK");throw e;}finally{depth--;}}};
 const store=new IdentityStore(storage);store.ensure("owner","Owner","owner");store.ensure("member","Member","member");const mutations=new IdentityMutations(store);
 const credential=(owner:string,id:string)=>db.prepare("INSERT INTO identity_credentials VALUES(?,?,?,0,'[]','fixture',0)").run(id,owner,"public");
 return{db,store,mutations,credential,fail:(sql:string)=>{fail=sql;},reopen:()=>new IdentityMutations(new IdentityStore(storage))};
}
test("concurrent invitation retries create one identity and audit record, including after reopening",async()=>{
 const f=fixture(),body={requestId:"invite",name:"Member"},values=await Promise.all(Array.from({length:10},()=>f.mutations.invite("owner",secret,body,100)));
 for(const v of values)assert.deepEqual(v,values[0]);assert.deepEqual(await f.reopen().invite("owner",secret,body,100),values[0]);
 assert.equal(f.db.prepare("SELECT count(*) AS n FROM identity_invites").get()!.n,1);assert.equal(f.db.prepare("SELECT count(*) AS n FROM identity_audit").get()!.n,1);
 await assert.rejects(f.mutations.invite("owner",secret,{...body,name:"Changed"},100),/IDEMPOTENCY_CONFLICT/);
 await assert.rejects(f.mutations.invite("member",secret,body,100),/FORBIDDEN/);
 await assert.rejects(f.mutations.recovery("owner",secret,{requestId:body.requestId}),/IDEMPOTENCY_CONFLICT/);
 const saved=JSON.stringify(f.db.prepare("SELECT * FROM identity_invites").all())+JSON.stringify(f.db.prepare("SELECT * FROM identity_mutations").all());assert.ok(!saved.includes(values[0].code)&&!saved.includes(secret));f.db.close();
});
test("used, expired or rekeyed invitation retries cannot issue replacement invitations",async()=>{
 const f=fixture(),body={requestId:"invite",name:"Member"},v=await f.mutations.invite("owner",secret,body,100);
 await assert.rejects(f.mutations.invite("owner",secret+"changed",body,100),/IDENTITY_RETRY_KEY_CHANGED/);
 await assert.rejects(f.mutations.invite("owner",secret,body,v.expires),/INVITATION_UNAVAILABLE/);
 f.db.prepare("UPDATE identity_invites SET used=1").run();await assert.rejects(f.mutations.invite("owner",secret,body,101),/INVITATION_UNAVAILABLE/);assert.equal(f.db.prepare("SELECT count(*) AS n FROM identity_invites").get()!.n,1);f.db.close();
});
test("recovery retries share eight codes but a new rotation or a consumed code invalidates old replay",async()=>{
 const f=fixture(),body={requestId:"recovery"},values=await Promise.all(Array.from({length:8},()=>f.mutations.recovery("owner",secret,body)));
 for(const v of values)assert.deepEqual(v,values[0]);assert.equal(new Set(values[0].recoveryCodes).size,8);assert.deepEqual(await f.reopen().recovery("owner",secret,body),values[0]);
 const member=await f.mutations.recovery("member",secret,body);assert.ok(member.recoveryCodes.every(c=>!values[0].recoveryCodes.includes(c)));
 await assert.rejects(f.mutations.recovery("owner",secret+"changed",body),/IDENTITY_RETRY_KEY_CHANGED/);
 const current=await f.mutations.recovery("owner",secret,{requestId:"next"});await assert.rejects(f.mutations.recovery("owner",secret,body),/RECOVERY_CODES_CHANGED/);
 const oldHash=await digest(values[0].recoveryCodes[0]);assert.throws(()=>f.store.recover(oldHash),/RECOVERY_INVALID/);
 f.store.recover(await digest(current.recoveryCodes[0]));await assert.rejects(f.mutations.recovery("owner",secret,{requestId:"next"}),/RECOVERY_CODES_CHANGED/);
 const raw=JSON.stringify(f.db.prepare("SELECT * FROM identity_recovery").all())+JSON.stringify(f.db.prepare("SELECT * FROM identity_mutations").all());assert.ok([...values[0].recoveryCodes,...current.recoveryCodes,...member.recoveryCodes].every(c=>!raw.includes(c)));f.db.close();
});
test("credential revocation retries preserve the last passkey and cannot affect another account",async()=>{
 const f=fixture();f.credential("owner","one");f.credential("owner","two");f.credential("member","other");
 for(let i=0;i<5;i++)assert.deepEqual(await f.mutations.revoke("owner","two",{requestId:"revoke"}),{ok:true});assert.deepEqual(await f.reopen().revoke("owner","two",{requestId:"revoke"}),{ok:true});
 await assert.rejects(f.mutations.revoke("owner","one",{requestId:"revoke"}),/IDEMPOTENCY_CONFLICT/);await assert.rejects(f.mutations.revoke("owner","one",{requestId:"last"}),/LAST_PASSKEY/);await assert.rejects(f.mutations.revoke("owner","other",{requestId:"cross"}),/NOT_FOUND/);
 assert.equal(f.store.credentials("owner").length,1);assert.equal(f.store.credentials("member").length,1);assert.equal(f.db.prepare("SELECT count(*) AS n FROM identity_audit").get()!.n,1);f.db.close();
});
test("receipt failures roll back invitation creation, code rotation and credential revocation",async()=>{
 const f=fixture();f.credential("owner","one");f.credential("owner","two");const original=await f.mutations.recovery("owner",secret,{requestId:"initial"});
 f.fail("INSERT INTO identity_mutations");await assert.rejects(f.mutations.invite("owner",secret,{requestId:"invite",name:"Member"}),/INJECTED_FAILURE/);assert.equal(f.db.prepare("SELECT count(*) AS n FROM identity_invites").get()!.n,0);
 await assert.rejects(f.mutations.recovery("owner",secret,{requestId:"next"}),/INJECTED_FAILURE/);await assert.rejects(f.mutations.revoke("owner","two",{requestId:"revoke"}),/INJECTED_FAILURE/);assert.equal(f.store.credentials("owner").length,2);
 f.fail("");assert.deepEqual(await f.reopen().recovery("owner",secret,{requestId:"initial"}),original);await f.mutations.invite("owner",secret,{requestId:"invite",name:"Member"});await f.mutations.recovery("owner",secret,{requestId:"next"});await f.mutations.revoke("owner","two",{requestId:"revoke"});assert.equal(f.store.credentials("owner").length,1);f.db.close();
});
