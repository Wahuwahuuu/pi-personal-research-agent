import test from "node:test";
import assert from "node:assert/strict";
import {arxivVersion,isScientificUrl,originalPdfUrl} from "../packages/research/source-links.ts";
test("source identities bind exact arXiv version, origin and path with legacy v1 support",()=>{
 assert.equal(arxivVersion("2401.00001"),"2401.00001v1");
 assert.equal(arxivVersion("2401.00001v2"),"2401.00001v2");
 assert.equal(originalPdfUrl("local-private"),null);
 assert.ok(isScientificUrl("https://arxiv.org/html/2401.00001v2#T1","2401.00001v2"));
 for(const url of ["https://arxiv.org/html/2401.00001v20","https://arxiv.org/html/2401.00001v1","https://arxiv.org/other/2401.00001v2","https://arxiv.org/html/2401.00001v2?url=x","https://evil.example/html/2401.00001v2"]){
  assert.equal(isScientificUrl(url,"2401.00001v2"),false,url);
 }
});
