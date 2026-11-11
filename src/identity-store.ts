import type { StateStorage } from "./state-store.ts";
import { Problem } from "./domain.ts";
export interface Account { id:string; name:string; role:"owner"|"member"; created:number }
export interface Identity extends Account { hash:string; expires:number }
export interface Challenge { id:string; kind:string; value:string; user_id:string; invite_hash:string; session_hash:string; expires:number }
export interface Credential { id:string; user_id:string; public_key:string; counter:number; transports:string; name:string; created:number }
export class IdentityStore {
 readonly db:StateStorage;
 constructor(db:StateStorage) {
  this.db=db;
  db.sql.exec("CREATE TABLE IF NOT EXISTS identity_accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL,role TEXT NOT NULL,created INTEGER NOT NULL)");
  db.sql.exec("CREATE TABLE IF NOT EXISTS identity_sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires INTEGER NOT NULL)");
  db.sql.exec("CREATE INDEX IF NOT EXISTS identity_sessions_user ON identity_sessions(user_id)");
  db.sql.exec("CREATE TABLE IF NOT EXISTS identity_credentials(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,public_key TEXT NOT NULL,counter INTEGER NOT NULL,transports TEXT NOT NULL,name TEXT NOT NULL,created INTEGER NOT NULL)");
  db.sql.exec("CREATE INDEX IF NOT EXISTS identity_credentials_user ON identity_credentials(user_id)");
  db.sql.exec("CREATE TABLE IF NOT EXISTS identity_invites(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0)");
  db.sql.exec("CREATE TABLE IF NOT EXISTS identity_challenges(id TEXT PRIMARY KEY,kind TEXT NOT NULL,value TEXT NOT NULL,user_id TEXT NOT NULL,invite_hash TEXT NOT NULL,session_hash TEXT NOT NULL,expires INTEGER NOT NULL)");
  db.sql.exec("CREATE TABLE IF NOT EXISTS identity_recovery(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0)");
  db.sql.exec("CREATE TABLE IF NOT EXISTS identity_devices(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL)");
  db.sql.exec("CREATE TABLE IF NOT EXISTS identity_rate(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL)");
  db.sql.exec("CREATE TABLE IF NOT EXISTS identity_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,event TEXT NOT NULL,created INTEGER NOT NULL)");
 }
 account(id:string){return this.db.sql.exec<Account>("SELECT * FROM identity_accounts WHERE id=?",id).toArray()[0];}
 ensure(id:string,name:string,role:"owner"|"member",now=Date.now()){
  this.db.sql.exec("INSERT OR IGNORE INTO identity_accounts VALUES(?,?,?,?)",id,name,role,now);return this.account(id)!;
 }
 credentials(userId:string){return this.db.sql.exec<Credential>("SELECT * FROM identity_credentials WHERE user_id=? ORDER BY created",userId).toArray();}
 credential(id:string){return this.db.sql.exec<Credential>("SELECT * FROM identity_credentials WHERE id=?",id).toArray()[0];}
 session(hash:string,now=Date.now()){return this.db.sql.exec<Identity>("SELECT a.*,s.hash,s.expires FROM identity_sessions s JOIN identity_accounts a ON a.id=s.user_id WHERE s.hash=? AND s.expires>?",hash,now).toArray()[0];}
 addSession(hash:string,userId:string,expires:number){this.db.sql.exec("INSERT INTO identity_sessions VALUES(?,?,?)",hash,userId,expires);}
 revokeSessions(userId:string){this.db.sql.exec("DELETE FROM identity_sessions WHERE user_id=?",userId);}
 invite(hash:string,now=Date.now()){return this.db.sql.exec<{user_id:string;name:string}>("SELECT user_id,name FROM identity_invites WHERE hash=? AND used=0 AND expires>?",hash,now).toArray()[0];}
 addInvite(hash:string,name:string,now=Date.now()){
  const id=crypto.randomUUID();this.db.sql.exec("INSERT INTO identity_invites(hash,user_id,name,expires) VALUES(?,?,?,?)",hash,id,name,now+7*86400000);return id;
 }
 challenge(c:Challenge){this.db.sql.exec("INSERT INTO identity_challenges VALUES(?,?,?,?,?,?,?)",c.id,c.kind,c.value,c.user_id,c.invite_hash,c.session_hash,c.expires);}
 getChallenge(id:string,kind:string,now=Date.now()){
  const c=this.db.sql.exec<Challenge>("SELECT * FROM identity_challenges WHERE id=? AND kind=? AND expires>?",id,kind,now).toArray()[0];
  if(!c)throw new Problem("CHALLENGE_EXPIRED",401);return c;
 }
 consume(id:string,kind:string,now=Date.now()){
  const c=this.getChallenge(id,kind,now);this.db.sql.exec("DELETE FROM identity_challenges WHERE id=?",id);return c;
 }
 register(challengeId:string,credential:Credential,now=Date.now()){
  return this.db.transactionSync(()=>{
   const c=this.consume(challengeId,"register",now);
   if(c.user_id!==credential.user_id)throw new Problem("IDENTITY_MISMATCH",403);
   if(c.invite_hash) {
    const invite=this.invite(c.invite_hash,now);if(!invite||invite.user_id!==c.user_id)throw new Problem("INVITE_EXPIRED",403);
    this.ensure(c.user_id,invite.name,"member",now);
    this.db.sql.exec("UPDATE identity_invites SET used=1 WHERE hash=?",c.invite_hash);
   } else if(!this.session(c.session_hash,now)||this.session(c.session_hash,now)!.id!==c.user_id)throw new Problem("UNAUTHORIZED",401);
   if(this.credential(credential.id))throw new Problem("CREDENTIAL_EXISTS",409);
   this.db.sql.exec("INSERT INTO identity_credentials VALUES(?,?,?,?,?,?,?)",credential.id,credential.user_id,credential.public_key,credential.counter,credential.transports,credential.name,now);
   this.audit(c.user_id,"passkey_registered",now);
   return this.account(c.user_id)!;
  });
 }
 authenticate(challengeId:string,id:string,previousCounter:number,nextCounter:number,now=Date.now()){
  return this.db.transactionSync(()=>{
   this.consume(challengeId,"login",now);const c=this.credential(id);
   if(!c||c.counter!==previousCounter)throw new Problem("AUTHENTICATION_REPLAY",401);
   this.db.sql.exec("UPDATE identity_credentials SET counter=? WHERE id=?",nextCounter,id);
   this.audit(c.user_id,"passkey_login",now);return this.account(c.user_id)!;
  });
 }
 setRecovery(userId:string,hashes:string[]){
  this.db.transactionSync(()=>{this.db.sql.exec("DELETE FROM identity_recovery WHERE user_id=?",userId);for(const hash of hashes)this.db.sql.exec("INSERT INTO identity_recovery(hash,user_id) VALUES(?,?)",hash,userId);});
 }
 recover(hash:string){
  return this.db.transactionSync(()=>{
   const row=this.db.sql.exec<{user_id:string}>("SELECT user_id FROM identity_recovery WHERE hash=? AND used=0",hash).toArray()[0];
   if(!row)throw new Problem("RECOVERY_INVALID",401);
   this.db.sql.exec("UPDATE identity_recovery SET used=1 WHERE hash=?",hash);this.revokeSessions(row.user_id);
   this.audit(row.user_id,"recovery_login");return this.account(row.user_id)!;
  });
 }
 removeCredential(userId:string,id:string){
  if(!this.credentials(userId).some(c=>c.id===id))throw new Problem("NOT_FOUND",404);
  if(this.credentials(userId).length<=1)throw new Problem("LAST_PASSKEY",409);
  this.db.sql.exec("DELETE FROM identity_credentials WHERE id=? AND user_id=?",id,userId);this.audit(userId,"passkey_revoked");
 }
 rate(key:string,limit=30,now=Date.now()){
  const row=this.db.sql.exec<{count:number;expires:number}>("SELECT * FROM identity_rate WHERE key=?",key).toArray()[0];
  if(row&&row.expires>now&&row.count>=limit)throw new Problem("TRY_LATER",429);
  this.db.sql.exec("INSERT INTO identity_rate VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,expires=excluded.expires",key,row&&row.expires>now?row.count+1:1,row&&row.expires>now?row.expires:now+60000);
 }
 clean(now=Date.now()){
  this.db.sql.exec("DELETE FROM identity_challenges WHERE expires<=?",now);
  this.db.sql.exec("DELETE FROM identity_sessions WHERE expires<=?",now);
  this.db.sql.exec("DELETE FROM identity_rate WHERE expires<=?",now);
 }
 audit(userId:string,event:string,now=Date.now()){this.db.sql.exec("INSERT INTO identity_audit(user_id,event,created) VALUES(?,?,?)",userId,event,now);}
 deviceOwner(hash:string){return this.db.sql.exec<{user_id:string}>("SELECT user_id FROM identity_devices WHERE hash=?",hash).toArray()[0]?.user_id;}
 bindDevice(hash:string,userId:string){this.db.sql.exec("INSERT INTO identity_devices VALUES(?,?) ON CONFLICT(hash) DO UPDATE SET user_id=excluded.user_id",hash,userId);}
}
