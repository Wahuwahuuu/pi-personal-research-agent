import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { IdentityStore } from "../src/identity-store.ts";
import { digest } from "../src/auth.ts";
import type { StateStorage } from "../src/state-store.ts";
function setup(){const db=new DatabaseSync(":memory:");const p:StateStorage={sql:{exec<T>(q:string,...b:any[]){const s=db.prepare(q),v=(s.columns().length?s.all(...b):(s.run(...b),[])) as T[];return{toArray:()=>v};}},transactionSync<T>(f:()=>T){db.exec("BEGIN");try{const v=f();db.exec("COMMIT");return v;}catch(e){db.exec("ROLLBACK");throw e;}}};return{db,store:new IdentityStore(p)};}
const credential=(user_id:string,id="credential")=>({user_id,id,public_key:"public",counter:0,transports:"[]",name:"test",created:100});
test("invitation admission consumes one challenge and one invitation atomically",()=>{
 const {db,store:s}=setup(),id=s.addInvite("invite-hash","Guest",100);
 s.challenge({id:"c",kind:"register",value:"challenge",user_id:id,invite_hash:"invite-hash",session_hash:"",expires:500});
 assert.equal(s.register("c",credential(id),200).role,"member");assert.equal(s.invite("invite-hash",200),undefined);
 assert.throws(()=>s.register("c",credential(id),200),/CHALLENGE_EXPIRED/);
 s.challenge({id:"d",kind:"register",value:"next",user_id:id,invite_hash:"invite-hash",session_hash:"",expires:500});
 assert.throws(()=>s.register("d",credential(id,"another"),200),/INVITE_EXPIRED/);assert.equal(s.credentials(id).length,1);db.close();
});
test("registration cannot survive logout or bind a different user",()=>{
 const {db,store:s}=setup();s.ensure("a","A","owner",100);s.addSession("session","a",500);
 s.challenge({id:"c",kind:"register",value:"challenge",user_id:"a",invite_hash:"",session_hash:"session",expires:500});
 assert.throws(()=>s.register("c",credential("b"),200),/IDENTITY_MISMATCH/);s.revokeSessions("a");
 assert.throws(()=>s.register("c",credential("a"),200),/UNAUTHORIZED/);db.close();
});
test("recovery codes are hashed, single-use and revoke every previous user session",async()=>{
 const {db,store:s}=setup();s.ensure("a","A","owner");s.ensure("b","B","member");
 s.addSession("old-a","a",Date.now()+10000);s.addSession("old-b","b",Date.now()+10000);
 const code="synthetic-recovery-secret",hash=await digest(code);s.setRecovery("a",[hash]);assert.equal(s.recover(hash).id,"a");
 assert.equal(s.session("old-a"),undefined);assert.ok(s.session("old-b"));assert.throws(()=>s.recover(hash),/RECOVERY_INVALID/);
 assert.ok(!JSON.stringify(db.prepare("SELECT * FROM identity_recovery").all()).includes(code));db.close();
});
test("credential counters and challenge consumption reject parallel replay; rate limit expires",()=>{
 const {db,store:s}=setup();s.ensure("a","A","owner",100);s.addSession("s","a",500);
 s.challenge({id:"r",kind:"register",value:"r",user_id:"a",invite_hash:"",session_hash:"s",expires:500});s.register("r",credential("a"),200);
 for(const id of ["l","m"])s.challenge({id,kind:"login",value:id,user_id:"",invite_hash:"",session_hash:"",expires:500});
 assert.equal(s.authenticate("l","credential",0,1,200).id,"a");
 assert.throws(()=>s.authenticate("m","credential",0,1,200),/AUTHENTICATION_REPLAY/);
 assert.throws(()=>s.authenticate("l","credential",1,2,200),/CHALLENGE_EXPIRED/);
 for(let i=0;i<30;i++)s.rate("ip",30,100);
 assert.throws(()=>s.rate("ip",30,100),/TRY_LATER/);s.rate("ip",30,60101);db.close();
});
