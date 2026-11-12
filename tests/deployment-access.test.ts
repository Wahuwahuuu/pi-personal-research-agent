import {test} from "node:test";
import assert from "node:assert/strict";
import {deploymentAccess,waitForDeployment,deploymentBuild} from "../scripts/deployment-access.ts";
const token="d".repeat(64),cookie="pra_session="+"c".repeat(64),build="a".repeat(40),base="https://worker.example";
const reply=(v:unknown,status=200,headers?:Record<string,string>)=>new Response(JSON.stringify(v),{status,headers});
test("post-Passkey deployment uses read-only device verification without login or WebSocket",async()=>{
 const calls:string[]=[];const fetcher=async(url:any,init:any)=>{
  calls.push(String(url));assert.equal(init.redirect,"error");assert.equal(init.headers.Authorization,"Bearer "+token);
  return reply({protocol:1,accountScope:"f".repeat(64),build});
 };
 const access=await deploymentAccess(base,{deviceToken:token,bootstrapToken:"admin"},fetcher as any);
 assert.equal(access.kind,"device");await waitForDeployment(base,access,build,{fetcher:fetcher as any});
 assert.equal(calls.length,2);assert.ok(calls.every(u=>u.endsWith("/api/device/verify")));
});
test("an explicit existing session can replace a revoked device without reopening bootstrap",async()=>{
 const calls:string[]=[];const fetcher=async(url:any,init:any)=>{calls.push(String(url));return String(url).endsWith("/verify")?reply({},401):(assert.equal(init.headers.Cookie,cookie),reply({build}));};
 const access=await deploymentAccess(base,{deviceToken:token,sessionCookie:cookie,bootstrapToken:"admin"},fetcher as any);
 assert.equal(access.kind,"session");assert.equal(calls.length,2);
});
test("enrolled Passkey with no valid deployment credential fails before any login or mutation",async()=>{
 const calls:any[]=[];const fetcher=async(url:any,init:any)=>{calls.push({url,method:init?.method});return reply({bootstrapAvailable:false});};
 await assert.rejects(deploymentAccess(base,{bootstrapToken:"admin"},fetcher as any),/DEPLOYMENT_AUTH_REQUIRED/);
 assert.equal(calls.length,1);assert.ok(calls[0].url.endsWith("/api/auth/status"));assert.equal(calls[0].method,undefined);
});
for(const legacy of [false,true])test("bootstrap authentication is compatible with "+(legacy?"legacy deployments":"a new account"),async()=>{
 const calls:string[]=[];const fetcher=async(url:any,init:any)=>{
  const path=new URL(url).pathname;calls.push(path);
  if(path==="/api/auth/status")return legacy?reply({},404):reply({bootstrapAvailable:true});
  if(path==="/api/login"){assert.equal(init.method,"POST");assert.deepEqual(JSON.parse(init.body),{token:"admin"});return reply({},200,{"set-cookie":cookie+"; HttpOnly; Secure"});}
  assert.equal(init.headers.Cookie,cookie);return reply({build});
 };
 const access=await deploymentAccess(base,{bootstrapToken:"admin"},fetcher as any);assert.equal(access.kind,"session");assert.deepEqual(calls,["/api/auth/status","/api/login","/api/state"]);
});
test("wrong credentials and redirect failures are bounded and never included in errors",async()=>{
 await assert.rejects(deploymentAccess(base,{deviceToken:"bad\nsecret"},async()=>{throw Error("must not fetch");}),/INVALID_DEPLOYMENT_CREDENTIAL/);
 await assert.rejects(deploymentAccess("http://remote.invalid",{deviceToken:token},async()=>{throw Error("must not fetch");}),/INVALID_DEPLOYMENT_ORIGIN/);
 const redirect=async(_url:any,init:any)=>{assert.equal(init.redirect,"error");throw Error("transport contains private data");};
 await assert.rejects(deploymentBuild(base,{kind:"device",path:"/api/device/verify",headers:{Authorization:"Bearer "+token}},redirect as any),e=>e instanceof Error&&e.message==="DEPLOYMENT_PROBE_UNAVAILABLE");
});
test("uploaded build is not success until the selected personal DO serves it, and rejection stops retries",async()=>{
 const access={kind:"session" as const,path:"/api/state",headers:{Cookie:cookie}};let calls=0;
 await waitForDeployment(base,access,build,{intervalMs:1,timeoutMs:100,fetcher:(async()=>reply({build:++calls===1?"old":build})) as any});assert.equal(calls,2);
 await assert.rejects(waitForDeployment(base,access,build,{intervalMs:1,timeoutMs:5,fetcher:(async()=>reply({build:"old"})) as any}),/DEPLOYED_BUILD_NOT_SERVING/);
 calls=0;await assert.rejects(waitForDeployment(base,access,build,{fetcher:(async()=>{calls++;return reply({},401);}) as any}),/DEPLOYMENT_AUTH_REJECTED/);assert.equal(calls,1);
});
