import {test} from "node:test";import assert from "node:assert/strict";
import {verifyBundleSources,freezeSourceWorker} from "../scripts/source-provenance.ts";
test("source proof checks every embedded application and research module against its commit",()=>{
 const source=new Map([["src/worker.ts","worker\n"],["packages/research/core.ts","research\n"]]);
 const map={sources:["../../src/worker.ts","../../packages/research/core.ts","../../node_modules/library/src/index.ts","../../packages/research/node_modules/typebox/index.mjs"],sourcesContent:["worker\r\n","research\n","dependency","nested dependency"]};
 const proof=verifyBundleSources(map,p=>source.get(p)!);assert.equal(proof.files,2);assert.match(proof.digest,/^[a-f0-9]{64}$/);
 assert.throws(()=>verifyBundleSources({...map,sourcesContent:["stale worker","research\n","dependency","nested dependency"]},p=>source.get(p)!),/BUNDLE_SOURCE_MISMATCH/);
 assert.throws(()=>verifyBundleSources(map,p=>{if(p.startsWith("packages"))throw Error("missing");return source.get(p)!;}),/BUNDLE_SOURCE_NOT_COMMITTED/);
});
test("missing source maps, absent worker and source path traversal are rejected",()=>{
 for(const map of [{},{sources:[],sourcesContent:[]},{sources:["../../src/../private"],sourcesContent:["x"]}])
  assert.throws(()=>verifyBundleSources(map,()=>"x"),/SOURCE_/);
});
test("source compilation rejects an unknown commit before running a build",async()=>{
 await assert.rejects(freezeSourceWorker("missing","missing","development"),/SOURCE_COMMIT_REQUIRED/);
});
