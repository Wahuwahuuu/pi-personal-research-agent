import {IdentityMutations} from "./identity-mutations.ts";
import {readBudgetDeployment,type BudgetDeployment} from "./budget-transfer.ts";
import {BUDGET_STOPS} from "./budget.ts";
import {PlatformResources,type PlatformStatus} from "./platform-resources.ts";
import {collectPlatformMetrics} from "./platform-analytics.ts";
import {RecoveryStore,type RecoveryCheckpoint} from "./recovery-store.ts";
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
 mutations:IdentityMutations;
 budget:SharedBudget;
 discovery:DiscoveryGate;
 recovery:RecoveryStore;
 platform:PlatformResources;
 private budgetConfiguration?:BudgetDeployment;
 private configureBudget(){
  if(!this.budgetConfiguration){const config=readBudgetDeployment(this.env.BUDGET_DEPLOYMENT);this.budget.transfer.apply(config.carryovers);this.budgetConfiguration=config;}
  return this.budgetConfiguration;
 }
 private platformRefresh?:Promise<PlatformStatus>;
 constructor(ctx:DurableObjectState,env:Env){
  super(ctx,env);
  let depth=0;
  const db:StateStorage={sql:{exec(query,...bindings){const rows=ctx.storage.sql.exec(query,...bindings);return{toArray:()=>rows.toArray() as any};}},transactionSync:fn=>{if(depth)return fn();return ctx.storage.transactionSync(()=>{depth++;try{return fn();}finally{depth--;}});}};
  this.store=new IdentityStore(db);this.mutations=new IdentityMutations(this.store);this.budget=new SharedBudget(db);this.discovery=new DiscoveryGate(db);this.recovery=new RecoveryStore(db);this.platform=new PlatformResources(db);
 }
 async refreshPlatform(requestId?:string):Promise<PlatformStatus>{
  if(requestId&&this.platform.knownRequest(requestId))return this.platform.status();
  if(this.platformRefresh){await this.platformRefresh;if(!requestId||this.platform.knownRequest(requestId))return this.platform.status();}
  const token=this.env.CLOUDFLARE_METRICS_TOKEN;
  if(!token)return this.platform.status();
  const pending=(async()=>{
   try{
    if(!this.env.CLOUDFLARE_ACCOUNT_ID||!this.env.RESOURCE_WORKER_NAME)throw Error("PLATFORM_CONFIGURATION_REQUIRED");
    const report=await collectPlatformMetrics({accountId:this.env.CLOUDFLARE_ACCOUNT_ID,token,scriptName:this.env.RESOURCE_WORKER_NAME});
    this.platform.record(requestId??crypto.randomUUID(),report,this.env.RESOURCE_WORKER_NAME);
    return this.platform.status();
   }catch{return{enabled:true,blocked:true,reason:"PLATFORM_METRICS_UNAVAILABLE",nextCheck:Date.now()+60000};}
  })();
  this.platformRefresh=pending;
  try{return await pending;}finally{this.platformRefresh=undefined;}
 }
 async platformStatus():Promise<PlatformStatus>{
  if(this.env.CLOUDFLARE_METRICS_TOKEN&&(!this.env.CLOUDFLARE_ACCOUNT_ID||!this.env.RESOURCE_WORKER_NAME))return{enabled:true,blocked:true,reason:"PLATFORM_METRICS_UNAVAILABLE",nextCheck:Date.now()+60000};
  if(this.env.CLOUDFLARE_METRICS_TOKEN&&!this.platform.snapshot())return this.refreshPlatform();
  return this.platform.status();
 }
 private recoveryAccount(owner:string){if(!this.store.account(owner))throw new Problem("UNKNOWN_ACCOUNT",404);}
 async recoveryView(owner:string){this.recoveryAccount(owner);return this.recovery.view(owner);}
 async recoveryCheckpoint(owner:string,id:string){this.recoveryAccount(owner);return this.recovery.checkpoint(owner,id);}
 async recoveryCheckpointRequest(owner:string,id:string){this.recoveryAccount(owner);return this.recovery.byRequest(owner,id)??null;}
 async addRecoveryCheckpoint(owner:string,c:RecoveryCheckpoint){this.recoveryAccount(owner);return this.recovery.add(owner,c);}
 async pendingRecovery(owner:string){this.recoveryAccount(owner);const job=this.recovery.pending(owner);return job?JSON.stringify(job):null;}
 async recoveryJob(owner:string,id:string){this.recoveryAccount(owner);const j=this.recovery.job(owner,id);return j?{id:j.id,checkpointId:j.checkpointId,status:j.status}:null;}
 async prepareRecovery(owner:string,id:string,checkpointId:string,guard:string){this.recoveryAccount(owner);const j=this.recovery.prepare(owner,id,checkpointId,JSON.parse(guard));return{id:j.id,status:j.status};}
 async finishRecovery(owner:string,id:string){this.recoveryAccount(owner);this.recovery.complete(owner,id);}
 async failRecovery(owner:string,id:string,code:string){this.recoveryAccount(owner);this.recovery.fail(owner,id,code);}
 async claimDiscovery(owner:string){if(!this.store.account(owner))throw Error("UNKNOWN_ACCOUNT");const status=await this.platformStatus();if(status.blocked)return{ok:false as const,retryAt:status.nextCheck};return this.discovery.claim(owner);}
 async releaseDiscovery(owner:string,token:string){if(!this.store.account(owner))throw Error("UNKNOWN_ACCOUNT");this.discovery.release(owner,token);}
 async importBudget(owner:string,rows:any[]){if(!this.store.account(owner))throw Error("UNKNOWN_ACCOUNT");this.budget.import(owner,rows);}
 async prepareBudgets(){
  // RPC reads yield safely; the final reserve below is a single synchronous transaction.
  // No account may spend before every pre-existing account's history is represented.
  const missing=this.store.db.sql.exec<{id:string}>("SELECT id FROM identity_accounts WHERE id NOT IN (SELECT owner FROM pra_validation_imports) ORDER BY id LIMIT 21").toArray();
  for(const account of missing.slice(0,20)){
   const baseline=await this.env.AGENTS.getByName(account.id).budgetBaseline();
   this.store.db.transactionSync(()=>{this.budget.import(account.id,baseline.rows);this.budget.validation.import(account.id,baseline.usage);});
  }
  return !this.store.db.sql.exec("SELECT id FROM identity_accounts WHERE id NOT IN (SELECT owner FROM pra_validation_imports) LIMIT 1").toArray().length;
 }
 async reserveBudget(owner:string,request:Parameters<BudgetLedger["reserve"]>[0]){
  if(!this.store.account(owner))throw Error("UNKNOWN_ACCOUNT");
  try{if(this.configureBudget().frozen)return{ok:false as const,error:"BUDGET_FROZEN"};}catch(error){if(error instanceof Problem&&BUDGET_STOPS.has(error.code))return{ok:false as const,error:error.code};throw error;}
  if(request.background){const resources=await this.platformStatus();if(resources.blocked)return{ok:false as const,error:resources.reason!};}
  if(!await this.prepareBudgets())return{ok:false as const,error:"VALIDATION_MIGRATION_REQUIRED"};
  return this.budget.reserve(owner,request);
 }
 async settleBudget(owner:string,id:string,usage?:ModelUsage){return this.budget.settle(owner,id,usage);}
 async budgetSnapshot(){const config=this.configureBudget();return{...this.budget.snapshot(),admissionFrozen:config.frozen};}
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
 async body(r:Request,optional=false){const raw=await r.text();if(optional&&!raw)return {};if(raw.length>24000)throw new Problem("BODY_TOO_LARGE",413);try{const v=JSON.parse(raw);if(!v||typeof v!=="object"||Array.isArray(v))throw Error();return v;}catch{throw new Problem("INVALID_JSON");}}
 async fetch(r:Request){
  try{return await this.route(r);}catch(e){return json({error:e instanceof Problem?e.code:"AUTHENTICATION_FAILED"},e instanceof Problem?e.status:400);}
 }
 async route(r:Request):Promise<Response>{
  if(!sameOrigin(r))throw new Problem("ORIGIN_DENIED",403);
  const url=new URL(r.url),path=url.pathname,hash=cookie(r)?await digest(cookie(r)!):"",identity=hash?this.store.session(hash):undefined;
  const owner=this.env.OWNER_ID;
  this.store.clean();
  if(r.method==="POST")this.store.rate(await digest((r.headers.get("CF-Connecting-IP")??"local")+":"+path),30);
  if(path==="/api/budget/transfer"){
   if(!identity)throw new Problem("UNAUTHORIZED",401);
   if(identity.role!=="owner")throw new Problem("FORBIDDEN",403);
   const config=this.configureBudget();
   if(r.method==="GET")return json({...this.budget.transfer.view(),admissionFrozen:config.frozen});
   if(r.method==="POST"){
    const b=await this.body(r);text(b.requestId,128);
    if(!config.frozen)throw new Problem("BUDGET_FREEZE_REQUIRED",409);
    if(!await this.prepareBudgets())throw new Problem("VALIDATION_MIGRATION_REQUIRED",503);
    return json(this.budget.sealTransfer());
   }
   throw new Problem("METHOD_NOT_ALLOWED",405);
  }
  if(path==="/api/platform"||path==="/api/platform/refresh"){
   if(!identity)throw new Problem("UNAUTHORIZED",401);
   if(path==="/api/platform"&&r.method==="GET")return json({...this.platform.view(),...await this.platformStatus(),workerName:this.env.RESOURCE_WORKER_NAME,cloudMonitoringConfigured:!!(this.env.CLOUDFLARE_METRICS_TOKEN&&this.env.CLOUDFLARE_ACCOUNT_ID&&this.env.RESOURCE_WORKER_NAME)});
   if(r.method==="POST"){
    if(identity.role!=="owner")throw new Problem("FORBIDDEN",403);
    if(path==="/api/platform/refresh"){const b=await this.body(r),status=await this.refreshPlatform("refresh:"+await digest(text(b.requestId,128)));await this.env.AGENTS.getByName(identity.id).resourcesChanged();return json({...this.platform.view(),...status});}
    const b=await this.body(r),result=this.platform.record(b.requestId,b.report,this.env.RESOURCE_WORKER_NAME);
    await this.env.AGENTS.getByName(identity.id).resourcesChanged();
    return json(result);
   }
   throw new Problem("METHOD_NOT_ALLOWED",405);
  }
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
   return json(await this.mutations.invite(identity.id,this.env.ADMIN_TOKEN,await this.body(r)));
  }
  if(path==="/api/auth/recovery"&&r.method==="POST"){
   return json(await this.mutations.recovery(identity.id,this.env.ADMIN_TOKEN,await this.body(r,true)));
  }
  const credentialMatch=path.match(/^\/api\/auth\/credentials\/([^/]+)$/);
  if(credentialMatch&&r.method==="DELETE")return json(await this.mutations.revoke(identity.id,credentialMatch[1],await this.body(r,true)));
  if(path==="/api/auth/audit"&&r.method==="GET")return json(this.store.db.sql.exec("SELECT seq,event,created FROM identity_audit WHERE user_id=? ORDER BY seq DESC LIMIT 100",identity.id).toArray());
  throw new Problem("NOT_FOUND",404);
 }
}
