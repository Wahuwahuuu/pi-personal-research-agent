import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
// Synthetic authenticator signs real WebAuthn challenges. This is protocol verification,
// not a claim that Windows Hello or any physical authenticator has been exercised.
function authenticator(origin:string){
 const {privateKey,publicKey}=generateKeyPairSync("ec",{namedCurve:"prime256v1"}),jwk=publicKey.export({format:"jwk"}),id=randomBytes(32),rp=new URL(origin).hostname;
 const cose=isoCBOR.encode(new Map<number,any>([[1,2],[3,-7],[-1,1],[-2,new Uint8Array(Buffer.from(jwk.x!,"base64url"))],[-3,new Uint8Array(Buffer.from(jwk.y!,"base64url"))]]));
 let counter=0,userHandle="";
 const client=(type:string,challenge:string,site=origin)=>Buffer.from(JSON.stringify({type,challenge,origin:site,crossOrigin:false}));
 const header=(flags:number,n:number)=>{const c=Buffer.alloc(4);c.writeUInt32BE(n);return Buffer.concat([createHash("sha256").update(rp).digest(),Buffer.from([flags]),c]);};
 return{
  register(options:any){
   userHandle=options.user.id;const length=Buffer.alloc(2);length.writeUInt16BE(id.length);
   const auth=Buffer.concat([header(0x45,0),Buffer.alloc(16),length,id,cose]);
   const attestation=isoCBOR.encode(new Map<string,any>([["fmt","none"],["attStmt",new Map()],["authData",new Uint8Array(auth)]]));
   return{id:id.toString("base64url"),rawId:id.toString("base64url"),type:"public-key",clientExtensionResults:{},response:{clientDataJSON:client("webauthn.create",options.challenge).toString("base64url"),attestationObject:Buffer.from(attestation).toString("base64url"),transports:["internal"]}};
  },
  login(options:any,site=origin){
   const data=client("webauthn.get",options.challenge,site),auth=header(5,++counter),signed=Buffer.concat([auth,createHash("sha256").update(data).digest()]);
   return{id:id.toString("base64url"),rawId:id.toString("base64url"),type:"public-key",clientExtensionResults:{},response:{clientDataJSON:data.toString("base64url"),authenticatorData:auth.toString("base64url"),signature:sign("sha256",signed,privateKey).toString("base64url"),userHandle}};
  }
 };
}
export async function verifyIdentity(base:string,initialCookie:string,admin:string){
 const checks:string[]=[],secrets:string[]=[];
 async function request(path:string,cookie="",method="GET",body?:unknown,extra:Record<string,string>={}){
  const r=await fetch(base+"/api/"+path,{method,headers:{Cookie:cookie,"Content-Type":"application/json",...extra},body:body===undefined?undefined:JSON.stringify(body)});
  const value=await r.json() as any;return{r,value,cookie:r.headers.get("set-cookie")?.split(";")[0]??cookie};
 }
 async function ok(path:string,cookie="",method="GET",body?:unknown){const v=await request(path,cookie,method,body);assert.ok(v.r.ok,JSON.stringify(v.value));return v;}
 const owner=authenticator(base),member=authenticator(base);
 const start=await ok("auth/register/options",initialCookie,"POST",{});
 const registered=await ok("auth/register/verify",initialCookie,"POST",{id:start.value.id,response:owner.register(start.value.options)});
 const ownerCookie=registered.cookie;secrets.push(...registered.value.recoveryCodes);
 assert.equal((await request("auth/register/verify",initialCookie,"POST",{id:start.value.id,response:owner.register(start.value.options)})).r.status,401);
 assert.equal((await request("login","","POST",{token:admin})).value.error,"PASSKEY_REQUIRED");
 const login=await ok("auth/login/options","","POST",{});
 assert.equal((await request("auth/login/verify","","POST",{id:login.value.id,response:owner.login(login.value.options,"https://wrong.example")})).r.ok,false);
 const signed=owner.login(login.value.options),ownerLogin=await ok("auth/login/verify","","POST",{id:login.value.id,response:signed});
 assert.equal((await request("auth/login/verify","","POST",{id:login.value.id,response:signed})).r.status,401);
 checks.push("real WebAuthn registration and signature verified; wrong origin, replay and bootstrap after enrollment rejected");
 const invite=await ok("auth/invites",ownerCookie,"POST",{name:"Synthetic member"});secrets.push(invite.value.code);
 const memberStart=await ok("auth/register/options","","POST",{invite:invite.value.code});
 const memberRegistered=await ok("auth/register/verify","","POST",{id:memberStart.value.id,response:member.register(memberStart.value.options)});
 const memberCookie=memberRegistered.cookie;secrets.push(...memberRegistered.value.recoveryCodes);
 assert.notEqual(memberRegistered.value.account.id,registered.value.account.id);
 assert.equal((await request("auth/register/options","","POST",{invite:invite.value.code})).r.status,403);
 assert.equal((await request("auth/invites",memberCookie,"POST",{name:"Unauthorized"})).r.status,403);
 const victim=await ok("tasks",ownerCookie,"POST",{requestId:"isolation-victim",kind:"chat",input:"OWNER_ONLY_CANARY"});
 const attacker=await ok("tasks",memberCookie,"POST",{requestId:"isolation-victim",kind:"chat",input:"MEMBER_ONLY_CANARY",userId:registered.value.account.id});
 assert.notEqual(victim.value.id,attacker.value.id);
 const mem=await ok("memories",ownerCookie,"POST",{content:"OWNER_MEMORY_CANARY"});
 const attempts=[
  ["tasks/"+victim.value.id+"/cancel","POST",{}],
  ["tasks/"+victim.value.id+"/continue","POST",{}],
  ["conversations/"+victim.value.conversationId,"DELETE",undefined],
  ["conversations/"+victim.value.conversationId,"PATCH",{title:"attacked"}],
  ["memories/"+mem.value.id,"DELETE",undefined]
 ] as const;
 for(let i=0;i<100;i++){
  const [path,method,body]=attempts[i%attempts.length];
  const v=await request(path,memberCookie,method,body,{"X-User-Id":registered.value.account.id,"X-Pra-User":registered.value.account.id});
  assert.ok(!v.r.ok,"cross-user mutation succeeded");
 }
 const memberState=await ok("state",memberCookie);
 assert.ok(!JSON.stringify(memberState.value).includes("OWNER_ONLY_CANARY"));
 assert.ok(!JSON.stringify(memberState.value).includes("OWNER_MEMORY_CANARY"));
 assert.ok((await ok("state",ownerCookie)).value.memories.some((m:any)=>m.id===mem.value.id));
 checks.push("two separately authenticated passkeys routed to isolated DOs; 100 cross-user mutation attempts denied");
 const devA=await ok("device/pair",ownerCookie,"POST",{label:"Owner device A"});
 const devB=await ok("device/pair",ownerCookie,"POST",{label:"Owner device B"});
 secrets.push(devA.value.token,devB.value.token);
 const verified=await request("device/verify","","GET",undefined,{Authorization:"Bearer "+devB.value.token});
 assert.equal(verified.r.status,200);assert.equal(verified.value.protocol,1);assert.match(verified.value.accountScope,/^[a-f0-9]{64}$/);
 assert.equal((await request("device/verify",ownerCookie)).r.status,401);
 assert.equal((await request("device/verify","","POST",{}, {Authorization:"Bearer "+devB.value.token})).r.status,405);
 await ok("device/revoke",ownerCookie,"POST",{id:devA.value.id});
 assert.equal((await request("device/verify","","GET",undefined,{Authorization:"Bearer "+devA.value.token})).r.status,401);
 const devices=await ok("devices",ownerCookie);
 assert.equal(devices.value.find((d:any)=>d.id===devA.value.id).revoked,1);
 assert.equal(devices.value.find((d:any)=>d.id===devB.value.id).revoked,0);
 assert.equal((await ok("devices",memberCookie)).value.length,0);
 assert.equal((await request("device/revoke",memberCookie,"POST",{id:devB.value.id})).r.status,404);
 checks.push("device credentials are account-scoped; post-Passkey installation verification accepts only active device credentials and revocation preserves the other device");
 const recovered=await ok("auth/recover","","POST",{code:registered.value.recoveryCodes[0]});
 assert.equal((await request("state",ownerCookie)).r.status,401);assert.equal((await request("state",ownerLogin.cookie)).r.status,401);
 assert.equal((await request("auth/recover","","POST",{code:registered.value.recoveryCodes[0]})).r.status,401);
 await ok("state",recovered.cookie);await ok("state",memberCookie);
 await ok("auth/logout",recovered.cookie,"POST",{});
 assert.equal((await request("state",recovered.cookie)).r.status,401);
 checks.push("one-time recovery revoked every old owner session; logout and another account's isolation verified");
 return{checks,secrets};
}
