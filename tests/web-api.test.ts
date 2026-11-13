import {test} from "node:test";
import assert from "node:assert/strict";
import {api,mutate,ApiError,errorText} from "../web/api.ts";
test("HTML platform errors preserve HTTP status without exposing parser details or page contents",async()=>{
 const original=globalThis.fetch;
 try{for(const status of [500,503]){globalThis.fetch=async()=>new Response("<html>private platform diagnostic</html>",{status});await assert.rejects(api("state"),(e:unknown)=>e instanceof ApiError&&e.status===status&&e.message==="SERVICE_UNAVAILABLE"&&!errorText(e).includes("diagnostic"));}}
 finally{globalThis.fetch=original;}
});
test("structured errors survive and malformed error objects become a stable product error",async()=>{
 const original=globalThis.fetch;
 try{globalThis.fetch=async()=>Response.json({error:"RESOURCE_DELETED"},{status:410});await assert.rejects(api("memories"),(e:unknown)=>e instanceof ApiError&&e.status===410&&e.message==="RESOURCE_DELETED");
 for(const value of [null,{error:{raw:"private"}},{error:"<private>"}]){globalThis.fetch=async()=>Response.json(value,{status:503});await assert.rejects(api("state"),(e:unknown)=>e instanceof ApiError&&e.message==="SERVICE_UNAVAILABLE");}
 globalThis.fetch=async()=>Response.json({ok:true});assert.deepEqual(await api("state"),{ok:true});}
 finally{globalThis.fetch=original;}
});
test("non-JSON unauthorized replies still expire the application session exactly once",async()=>{
 const original=globalThis.fetch,prior=Object.getOwnPropertyDescriptor(globalThis,"window"),events=new EventTarget();let expired=0;events.addEventListener("session-expired",()=>expired++);Object.defineProperty(globalThis,"window",{value:events,configurable:true});
 try{globalThis.fetch=async()=>new Response("Unauthorized",{status:401});await assert.rejects(api("state"),(e:unknown)=>e instanceof ApiError&&e.status===401);assert.equal(expired,1);await assert.rejects(api("auth/me"));assert.equal(expired,1);}
 finally{globalThis.fetch=original;if(prior)Object.defineProperty(globalThis,"window",prior);else Reflect.deleteProperty(globalThis,"window");}
});
test("HTML failures and damaged success replies retain mutation IDs until a confirmed successful response",async()=>{
 const original=globalThis.fetch,ids:string[]=[];let call=0;
 try{globalThis.fetch=async(_input,init)=>{ids.push(JSON.parse(String(init?.body)).requestId);call++;return call===1?new Response("Unavailable",{status:503}):call===2?new Response("{broken",{status:200}):Response.json({id:"saved"});};
 await assert.rejects(mutate("memories","POST",{content:"retry fixture"}),(e:unknown)=>e instanceof ApiError&&e.status===503);
 await assert.rejects(mutate("memories","POST",{content:"retry fixture"}),(e:unknown)=>e instanceof ApiError&&e.status===502&&e.message==="INVALID_SERVER_RESPONSE");
 assert.deepEqual(await mutate("memories","POST",{content:"retry fixture"}),{id:"saved"});assert.equal(new Set(ids).size,1);
 await mutate("memories","POST",{content:"retry fixture"});assert.notEqual(ids[3],ids[0]);}
 finally{globalThis.fetch=original;}
});
