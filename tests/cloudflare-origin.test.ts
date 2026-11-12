import {test} from "node:test";
import assert from "node:assert/strict";
import {verifyCloudflareOrigin} from "../scripts/cloudflare-origin.ts";
test("deployment origin is checked against the authenticated Cloudflare account before upload",async()=>{
 const calls:string[]=[];
 const fetcher=async(url:any,init:any)=>{calls.push(String(url));assert.equal(init.redirect,"error");return Response.json({success:true,result:{subdomain:"example"}});};
 await verifyCloudflareOrigin("a".repeat(32),"worker","https://worker.example.workers.dev","synthetic-token",fetcher as any);
 await assert.rejects(verifyCloudflareOrigin("a".repeat(32),"worker","https://worker.other.workers.dev","synthetic-token",fetcher as any),/ORIGIN_MISMATCH/);
 assert.ok(calls.every(url=>url.startsWith("https://api.cloudflare.com/client/v4/accounts/")));
});
test("origin failures do not reveal transport headers or platform credentials",async()=>{
 await assert.rejects(verifyCloudflareOrigin("account","worker","https://worker.example.workers.dev","synthetic-token",(async()=>{throw Error("request included credentials");}) as any),e=>e instanceof Error&&e.message==="CLOUDFLARE_ORIGIN_UNAVAILABLE");
 await assert.rejects(verifyCloudflareOrigin("../account","worker","https://worker.example.workers.dev","synthetic-token"),/INVALID_DEPLOYMENT_IDENTITY/);
});
