import {test} from "node:test";
import assert from "node:assert/strict";
import {parseTranslations} from "../packages/research/translation.ts";
import {advanceWorkflow,workflowPrompt,workflowTools,type ResearchWorkflow,type WorkflowContext} from "../packages/research/cloud-workflow.ts";
test("translation keeps source identities and cannot silently accept missing or duplicate items",()=>{
 const sources=[{chunk_id:"a",text:"Equation $x=1$."},{chunk_id:"b",text:"Table | value |"}];
 const output=JSON.stringify({translations:[{chunk_id:"a",text:"公式 $x=1$。"}, {chunk_id:"b",text:"表 | 数值 |"}]});
 assert.deepEqual(parseTranslations(output,sources).map(s=>s.chunk_id),["a","b"]);
 for(const rows of [[{chunk_id:"a",text:"a"}],[{chunk_id:"a",text:"a"},{chunk_id:"a",text:"b"}],[{chunk_id:"unknown",text:"a"},{chunk_id:"b",text:"b"}]])assert.throws(()=>parseTranslations(JSON.stringify({translations:rows}),sources));
 const w:ResearchWorkflow={phase:"translation",warnings:[],translation:{sources}},c={} as WorkflowContext;
 assert.deepEqual(workflowTools(w,1),[]);
 assert.equal(JSON.parse(workflowPrompt(w,c)).stage,"translation");
 const result=advanceWorkflow(w,c,output);
 assert.equal(result.status,"completed");assert.equal(w.translation?.items?.length,2);
});
