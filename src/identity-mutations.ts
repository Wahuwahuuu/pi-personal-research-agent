import {digest} from "./auth.ts";
import {Problem,text} from "./domain.ts";
import type {IdentityStore} from "./identity-store.ts";
type Receipt={owner:string;request_id:string;operation:string;input_hash:string;proof:string;resource:string;expires:number};
/** Retryable account settings, with only digests and resource IDs persisted. */
export class IdentityMutations {
 readonly store:IdentityStore;
 constructor(store:IdentityStore){this.store=store;store.db.sql.exec("CREATE TABLE IF NOT EXISTS identity_mutations(owner TEXT NOT NULL,request_id TEXT NOT NULL,operation TEXT NOT NULL,input_hash TEXT NOT NULL,proof TEXT NOT NULL,resource TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(owner,request_id))");}
 private account(owner:string){const a=this.store.account(owner);if(!a)throw new Problem("UNAUTHORIZED",401);return a;}
 private request(value:unknown){return value===undefined?crypto.randomUUID():text(value,128);}
 private previous(owner:string,id:string,operation:string,inputHash:string){
  const r=this.store.db.sql.exec<Receipt>("SELECT * FROM identity_mutations WHERE owner=? AND request_id=?",owner,id).toArray()[0];
  if(r&&(r.operation!==operation||r.input_hash!==inputHash))throw new Problem("IDEMPOTENCY_CONFLICT",409);return r;
 }
 private record(r:Receipt){this.store.db.sql.exec("INSERT INTO identity_mutations VALUES(?,?,?,?,?,?,?)",r.owner,r.request_id,r.operation,r.input_hash,r.proof,r.resource,r.expires);}
 private async codes(secret:string,owner:string,id:string,kind:string,count:number){
  if(!secret||secret.length<32)throw new Problem("IDENTITY_RETRY_NOT_CONFIGURED",503);
  const encoder=new TextEncoder(),key=await crypto.subtle.importKey("raw",encoder.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  return Promise.all(Array.from({length:count},async(_,i)=>{const value=await crypto.subtle.sign("HMAC",key,encoder.encode(JSON.stringify(["pra-identity-setting-v1",kind,owner,id,i])));return Array.from(new Uint8Array(value),b=>b.toString(16).padStart(2,"0")).join("").slice(0,kind==="recovery"?32:64);}));
 }
 async invite(owner:string,secret:string,body:{requestId?:unknown;name?:unknown},now=Date.now()){
  if(this.account(owner).role!=="owner")throw new Problem("FORBIDDEN",403);
  const id=this.request(body.requestId),name=text(body.name,80),operation="invite",inputHash=await digest(JSON.stringify({name}));
  const [code]=await this.codes(secret,owner,id,operation,1),proof=await digest(code);
  const receipt=this.store.db.transactionSync(()=>{
   const old=this.previous(owner,id,operation,inputHash);
   if(old){if(old.proof!==proof)throw new Problem("IDENTITY_RETRY_KEY_CHANGED",409);if(old.expires<=now||this.store.invite(proof,now)?.user_id!==old.resource)throw new Problem("INVITATION_UNAVAILABLE",409);return old;}
   const r={owner,request_id:id,operation,input_hash:inputHash,proof,resource:this.store.addInvite(proof,name,now),expires:now+7*86400000};
   this.store.audit(owner,"invitation_created",now);this.record(r);return r;
  });
  return{code,userId:receipt.resource,expires:receipt.expires,expiresInDays:Math.ceil((receipt.expires-now)/86400000)};
 }
 async recovery(owner:string,secret:string,body:{requestId?:unknown},now=Date.now()){
  this.account(owner);const id=this.request(body.requestId),operation="recovery",inputHash=await digest("{}");
  const recoveryCodes=await this.codes(secret,owner,id,operation,8),hashes=await Promise.all(recoveryCodes.map(digest)),proof=await digest(JSON.stringify(hashes));
  this.store.db.transactionSync(()=>{
   const old=this.previous(owner,id,operation,inputHash);
   if(old){
    if(old.proof!==proof)throw new Problem("IDENTITY_RETRY_KEY_CHANGED",409);
    const current=this.store.db.sql.exec<{hash:string;used:number}>("SELECT hash,used FROM identity_recovery WHERE user_id=?",owner).toArray();
    if(current.length!==hashes.length||hashes.some(hash=>!current.some(row=>row.hash===hash&&row.used===0)))throw new Problem("RECOVERY_CODES_CHANGED",409);return;
   }
   this.store.setRecovery(owner,hashes);this.store.audit(owner,"recovery_codes_rotated",now);
   this.record({owner,request_id:id,operation,input_hash:inputHash,proof,resource:"",expires:0});
  });
  return{recoveryCodes};
 }
 async revoke(owner:string,credentialId:string,body:{requestId?:unknown}){
  this.account(owner);const id=this.request(body.requestId),operation="credential:revoke",resource=text(credentialId,2048),inputHash=await digest(JSON.stringify({id:resource}));
  return this.store.db.transactionSync(()=>{
   if(this.previous(owner,id,operation,inputHash))return{ok:true};
   this.store.removeCredential(owner,resource);this.record({owner,request_id:id,operation,input_hash:inputHash,proof:"",resource,expires:0});return{ok:true};
  });
 }
}
