import { DiscoveryGate } from "./discovery-gate.ts";
import {SharedBudget} from "./shared-budget.ts";
import type {ModelUsage,BudgetLedger} from "./budget.ts";
import { DurableObject } from "cloudflare:workers";
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from "@simplewebauthn/server";
import { IdentityStore, type Account } from "./identity-store.ts";
import { cookie, digest, equal, sameOrigin } from "./auth.ts";
import { Problem, text } from "./domain.ts";
import type { Env } from "./worker.ts";
import type { StateStorage } from "./state-store.ts";
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
const publicAccount=(a:Account)=>({id:a.id,name:a.name,role:a.role});
const token=()=>crypto.randomUUID().replaceAll("-","")+crypto.randomUUID().replaceAll("-","");
export class IdentityRegistry extends DurableObject<Env> {
 store:IdentityStore;
 budget:SharedBudget;
 discovery:DiscoveryGate;
 constructor(ctx:DurableObjectState,env:Env){
  super(ctx,env);
  let depth=0;
  const db:StateStorage={sql:{exec(query,...bindings){const rows=ctx.storage.sql.exec(query,...bindings);return{toArray:()=>rows.toArray() as any};}},transactionSync:fn=>{if(depth)return fn();return ctx.storage.transactionSync(()=>{depth++;try{return fn();}finally{depth--;}});}};
  this.store=new IdentityStore(db);this.budget=new SharedBudget(db);this.discovery=new DiscoveryGate(db);
 }
 async claimDiscovery(owner:string){if(!this.store.account(owner))throw Error("UNKNOWN_ACCOUNT");return this.discovery.claim(owner);}
 async releaseDiscovery(owner:string,token:string){if(!this.store.account(owner))throw Error("UNKNOWN_ACCOUNT");this.discovery.release(owner,token);}
 async importBudget(owner:string,rows:any[]){if(!this.store.account(owner))throw Error("UNKNOWN_ACCOUNT");this.budget.import(owner,rows);}
 async reserveBudget(owner:string,request:Parameters<BudgetLedger["reserve"]>[0]){if(!this.store.account(owner))throw Error("UNKNOWN_ACCOUNT");return this.budget.reserve(owner,request);}
 async settleBudget(owner:string,id:string,usage?:ModelUsage){return this.budget.settle(owner,id,usage);}
 async budgetSnapshot(){return {...this.budget.ledger.snapshot(),scope:"application"};}
 async budgetCalls(owner:string,after:string,limit:number){return this.budget.calls(owner,after,limit);}
 async authenticate(hash:string){return this.store.session(hash)??null;}
 async deviceOwner(hash:string){return this.store.deviceOwner(hash)??null;}
 async bindDevice(hash:string,userId:string){if(!this.store.account(userId))throw new Error("UNKNOWN_ACCOUNT");this.store.bindDevice(hash,userId);}
 async sessionResponse(r:Request,a:Account,extra:Record<string,unknown>={}){
  const value=token(),hash=await digest(value),expires=Date.now()+86400000;
  this.store.addSession(hash,a.id,expires);
  await this.env.AGENTS.getByName(a.id).acceptIdentity(a.id,hash,expires);
  return new Response(JSON.stringify({account:publicAccount(a),...extra}),{headers:{"Content-Type":"application/json","Cache-Control":"no-store","Set-Cookie":`pra_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${new URL(r.url).protocol==="https:"?"; Secure":""}`}});
 }
 async body(r:Request){const raw=await r.text();if(raw.length>24000)throw new Problem("BODY_TOO_LARGE",413);try{const v=JSON.parse(raw);if(!v||typeof v!=="object"||Array.isArray(v))throw Error();return v;}catch{throw new Problem("INVALID_JSON");}}
 async fetch(r:Request){
  try{return await this.route(r);}catch(e){return json({error:e instanceof Problem?e.code:"AUTHENTICATION_FAILED"},e instanceof Problem?e.status:400);}
 }
 async route(r:Request):Promise<Response>{
  if(!sameOrigin(r))throw new Problem("ORIGIN_DENIED",403);
  const url=new URL(r.url),path=url.pathname,hash=cookie(r)?await digest(cookie(r)!):"",identity=hash?this.store.session(hash):undefined;
  const owner=this.env.OWNER_ID;
  this.store.clean();
  if(r.method==="POST")this.store.rate(await digest((r.headers.get("CF-Connecting-IP")??"local")+":"+path),30);
  if(path==="/api/auth/status"&&r.method==="GET")return json({bootstrapAvailable:this.store.credentials(owner).length===0,account:identity?publicAccount(identity):null});
  if(path==="/api/login"&&r.method==="POST"){
   if(this.store.credentials(owner).length)throw new Problem("PASSKEY_REQUIRED",403);
   if(!this.env.ADMIN_TOKEN||this.env.ADMIN_TOKEN.length<32)throw new Problem("LOGIN_NOT_CONFIGURED",503);
   const b=await this.body(r);if(!(await equal(String(b.token??""),this.env.ADMIN_TOKEN)))throw new Problem("UNAUTHORIZED",401);
   return this.sessionResponse(r,this.store.ensure(owner,"研究者","owner"),{needsPasskey:true});
  }
  if(path==="/api/auth/logout"&&r.method==="POST"){
   if(identity){this.store.db.sql.exec("DELETE FROM identity_sessions WHERE hash=?",hash);await this.env.AGENTS.getByName(identity.id).revokeIdentity(hash);}
   return new Response("{}",{headers:{"Content-Type":"application/json","Cache-Control":"no-store","Set-Cookie":`pra_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${url.protocol==="https:"?"; Secure":""}`}});
  }
  if(path==="/api/auth/register/options"&&r.method==="POST"){
   const b=await this.body(r),inviteHash=b.invite?await digest(text(b.invite,256)):"",invite=inviteHash?this.store.invite(inviteHash):undefined;
   if(!identity&&!invite)throw new Problem("INVITATION_REQUIRED",403);
   const userId=identity?.id??invite!.user_id,name=identity?.name??invite!.name;
   const options=await generateRegistrationOptions({rpName:"Personal Research Agent",rpID:url.hostname,userID:new TextEncoder().encode(userId),userName:name,
    attestationType:"none",supportedAlgorithmIDs:[-7,-257],authenticatorSelection:{residentKey:"required",userVerification:"required"},excludeCredentials:this.store.credentials(userId).map(c=>({id:c.id}))});
   const id=crypto.randomUUID();
   this.store.challenge({id,kind:"register",value:options.challenge,user_id:userId,invite_hash:identity?"":inviteHash,session_hash:identity?hash:"",expires:Date.now()+300000});
   return json({id,options});
  }
  if(path==="/api/auth/register/verify"&&r.method==="POST"){
   const b=await this.body(r),c=this.store.getChallenge(text(b.id,128),"register");
   if(c.session_hash&&c.session_hash!==hash)throw new Problem("UNAUTHORIZED",401);
   const result=await verifyRegistrationResponse({response:b.response,expectedChallenge:c.value,expectedOrigin:url.origin,expectedRPID:url.hostname,requireUserVerification:true,supportedAlgorithmIDs:[-7,-257]});
   if(!result.verified)throw new Problem("AUTHENTICATION_FAILED",401);
   const first=this.store.credentials(c.user_id).length===0,credential=result.registrationInfo.credential;
   const account=this.store.register(c.id,{id:credential.id,user_id:c.user_id,public_key:Buffer.from(credential.publicKey).toString("base64url"),counter:credential.counter,
    transports:JSON.stringify(credential.transports??[]),name:text(b.name??"我的通行密钥",80),created:Date.now()});
   let recoveryCodes:string[]|undefined;
   if(first){recoveryCodes=Array.from({length:8},()=>token().slice(0,32));this.store.setRecovery(account.id,await Promise.all(recoveryCodes.map(digest)));}
   return this.sessionResponse(r,account,recoveryCodes?{recoveryCodes}:{});
  }
  if(path==="/api/auth/login/options"&&r.method==="POST"){
   const options=await generateAuthenticationOptions({rpID:url.hostname,userVerification:"required"});
   const id=crypto.randomUUID();this.store.challenge({id,kind:"login",value:options.challenge,user_id:"",invite_hash:"",session_hash:"",expires:Date.now()+300000});return json({id,options});
  }
  if(path==="/api/auth/login/verify"&&r.method==="POST"){
   const b=await this.body(r),c=this.store.getChallenge(text(b.id,128),"login"),credential=this.store.credential(String(b.response?.id??""));
   if(!credential)throw new Problem("AUTHENTICATION_FAILED",401);
   if(b.response?.response?.userHandle&&Buffer.from(b.response.response.userHandle,"base64url").toString("utf8")!==credential.user_id)throw new Problem("AUTHENTICATION_FAILED",401);
   const result=await verifyAuthenticationResponse({response:b.response,expectedChallenge:c.value,expectedOrigin:url.origin,expectedRPID:url.hostname,requireUserVerification:true,
    credential:{id:credential.id,publicKey:new Uint8Array(Buffer.from(credential.public_key,"base64url")),counter:credential.counter,transports:JSON.parse(credential.transports)}});
   if(!result.verified)throw new Problem("AUTHENTICATION_FAILED",401);
   return this.sessionResponse(r,this.store.authenticate(c.id,credential.id,credential.counter,result.authenticationInfo.newCounter));
  }
  if(path==="/api/auth/recover"&&r.method==="POST"){
   const b=await this.body(r),a=this.store.recover(await digest(text(b.code,128).replaceAll(" ","")));
   await this.env.AGENTS.getByName(a.id).revokeIdentity();return this.sessionResponse(r,a,{recovered:true});
  }
  if(!identity)throw new Problem("UNAUTHORIZED",401);
  if(path==="/api/auth/me"&&r.method==="GET")return json({account:publicAccount(identity),credentials:this.store.credentials(identity.id).map(({id,name,created})=>({id,name,created}))});
  if(path==="/api/auth/invites"&&r.method==="POST"){
   if(identity.role!=="owner")throw new Problem("FORBIDDEN",403);
   const b=await this.body(r),code=token(),id=this.store.addInvite(await digest(code),text(b.name,80));
   this.store.audit(identity.id,"invitation_created");return json({code,userId:id,expiresInDays:7});
  }
  if(path==="/api/auth/recovery"&&r.method==="POST"){
   const recoveryCodes=Array.from({length:8},()=>token().slice(0,32));this.store.setRecovery(identity.id,await Promise.all(recoveryCodes.map(digest)));
   this.store.audit(identity.id,"recovery_codes_rotated");return json({recoveryCodes});
  }
  const credentialMatch=path.match(/^\/api\/auth\/credentials\/([^/]+)$/);
  if(credentialMatch&&r.method==="DELETE"){this.store.removeCredential(identity.id,credentialMatch[1]);return json({ok:true});}
  if(path==="/api/auth/audit"&&r.method==="GET")return json(this.store.db.sql.exec("SELECT seq,event,created FROM identity_audit WHERE user_id=? ORDER BY seq DESC LIMIT 100",identity.id).toArray());
  throw new Problem("NOT_FOUND",404);
 }
}
