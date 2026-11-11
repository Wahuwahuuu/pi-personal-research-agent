import {test} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {Artifacts,exportArtifact} from "../src/artifacts.ts";
import type {StateStorage} from "../src/state-store.ts";
function setup(){const db=new DatabaseSync(":memory:");let depth=0;const p:StateStorage={sql:{exec<T>(q:string,...b:any[]){const s=db.prepare(q),v=(s.columns().length?s.all(...b):(s.run(...b),[])) as T[];return{toArray:()=>v};}},transactionSync<T>(f:()=>T){if(depth)return f();db.exec("BEGIN");depth++;try{const v=f();db.exec("COMMIT");return v;}catch(e){db.exec("ROLLBACK");throw e;}finally{depth--;}}};return{db,a:new Artifacts(p)};}
const source={paper_id:"2501.12345",chunk_id:"source",paragraph_id:"p",section:"method",text:"Evidence.",start:0,end:9,index_version:"v1",citation:"[source]",truncated:false};
const input={projectId:"p",conversationId:"c",taskId:"t",kind:"reading" as const,title:"Reading",partial:false};
test("saved research retains source identities and immutable versions, rejecting lost edits",()=>{
 const {db,a}=setup(),first=a.create(input,"Original [cite:source]",[source]);assert.equal(a.create(input,"duplicate",[source]).id,first.id);
 const second=a.revise(first.id,1,"Edited [cite:source]","Updated");assert.equal(second.version,2);assert.equal(second.editor,"user");
 assert.equal(a.get(first.id,1).content,"Original [cite:source]");assert.deepEqual(second.sources,[source]);
 assert.throws(()=>a.revise(first.id,1,"lost update"),/VERSION_CONFLICT/);assert.equal(a.versions(first.id).length,2);db.close();
});
test("conversation deletion removes every artifact version while preserving another conversation",()=>{
 const {db,a}=setup(),first=a.create(input,"DELETE_ARTIFACT_CANARY",[source]);a.revise(first.id,1,"DELETE_REVISION_CANARY");
 const second=a.create({...input,conversationId:"other",taskId:"other"},"survives",[]);
 assert.deepEqual(a.deleteConversation("c"),[first.id]);assert.throws(()=>a.get(first.id),/NOT_FOUND/);assert.equal(a.get(second.id).content,"survives");
 assert.ok(!JSON.stringify(db.prepare("SELECT * FROM pra_artifact_versions").all()).includes("DELETE_"));db.close();
});
test("Markdown, HTML and BibTeX exports preserve evidence and do not execute edited markup or invent bibliographic metadata",()=>{
 const {db,a}=setup(),value=a.create(input,'<script>alert("unsafe")</script> [cite:source]',[source]);
 const html=exportArtifact(value,"html",[]).content;assert.ok(!html.includes("<script>"));assert.ok(html.includes("&lt;script&gt;"));assert.ok(html.includes("source"));
 assert.ok(exportArtifact(value,"md",[]).content.includes("Evidence."));
 const bib=exportArtifact(value,"bibtex",[{paper_id:source.paper_id,title:"Real { title }",abstract:""}]).content;
 assert.match(bib,/arXiv/);assert.ok(!bib.includes("author"));assert.ok(!bib.includes("Real {"));db.close();
});
