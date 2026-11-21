import {test} from "node:test";
import assert from "node:assert/strict";
import {citationRepairTargets,applyCitationRepairs} from "../packages/research/citation-repair.ts";
import {inspectCitationAttribution} from "../packages/research/internal/agent/citation-attribution.ts";
const source={paper_id:"paper",paragraph_id:"p",chunk_id:"source",section:"Results",start:0,end:23,text:"Accuracy is 83.2."};
test("explicit edits change only their unique source-checked targets, independent of edit ordering",()=>{
 const answer="Keep the method. Accuracy reached 83.2% [cite:source]. Keep the boundary. [cite:unknown]";
 const checks=inspectCitationAttribution(answer,new Map([["source",source]])).checks;
 const targets=citationRepairTargets(answer,checks,new Set(["source"]));
 assert.equal(targets.length,2);
 const output=applyCitationRepairs(answer,targets,[{target:targets[1].id,replacement:"[cite:source]"},{target:targets[0].id,replacement:"Accuracy is reported as 83.2 [cite:source]."}]);
 assert.equal(output,"Keep the method. Accuracy is reported as 83.2 [cite:source]. Keep the boundary. [cite:source]");
 for(const edits of [[{target:"unknown",replacement:"new"}],[{target:targets[0].id,replacement:"a"},{target:targets[0].id,replacement:"b"}],[{target:targets[1].id,replacement:"invented prose"}],[]])assert.throws(()=>applyCitationRepairs(answer,targets,edits),/INVALID_CITATION_REPAIR/);
 assert.throws(()=>applyCitationRepairs("changed "+answer,targets,[{target:targets[0].id,replacement:"new"}]),/INVALID_CITATION_REPAIR/);
});
test("ambiguous repeated claims and overlapping markers do not create guessed edit locations",()=>{
 const claim="Accuracy reached 83.2% [cite:unknown].";
 const checks=inspectCitationAttribution(claim,new Map([["source",source]])).checks;
 const targets=citationRepairTargets(claim,checks,new Set(["source"]));assert.equal(targets.length,1);assert.equal(targets[0].kind,"claim");
 const repeated=citationRepairTargets(claim+" "+claim,checks,new Set(["source"]));assert.ok(repeated.every(t=>t.kind==="reference"));
});

test("older envelope drafts are edited in their decoded body without leaking control JSON",()=>{
 const body='First line.\nAccuracy reached 83.2% [cite:source].\nKeep "this" conclusion.';
 const stored=JSON.stringify({execution:{state:"complete"},answer:body});
 const checks=inspectCitationAttribution(body,new Map([["source",source]])).checks;
 const targets=citationRepairTargets(stored,checks,new Set(["source"]));
 assert.equal(targets.length,1);
 const result=applyCitationRepairs(stored,targets,[{target:targets[0].id,replacement:"Accuracy is reported as 83.2 [cite:source]."}]);
 assert.equal(result,'First line.\nAccuracy is reported as 83.2 [cite:source].\nKeep "this" conclusion.');
 assert.equal(JSON.parse(stored).answer,body);
});
