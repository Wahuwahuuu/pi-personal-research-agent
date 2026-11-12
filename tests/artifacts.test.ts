import {test} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {Artifacts,exportArtifact} from "../src/artifacts.ts";
import type {StateStorage} from "../src/state-store.ts";
function setup(){const db=new DatabaseSync(":memory:");let depth=0;const p:StateStorage={sql:{exec<T>(q:string,...b:any[]){const s=db.prepare(q),v=(s.columns().length?s.all(...b):(s.run(...b),[])) as T[];return{toArray:()=>v};}},transactionSync<T>(f:()=>T){if(depth)return f();db.exec("BEGIN");depth++;try{const v=f();db.exec("COMMIT");return v;}catch(e){db.exec("ROLLBACK");throw e;}finally{depth--;}}};return{db,a:new Artifacts(p),storage:p};}
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

test("BibTeX preserves exact versions, deduplicates legacy v1 and keeps stable citation keys without inventing metadata",()=>{
 const {db,a}=setup();
 try{
  const ids=["2501.12345v2","2501.12345","2501.12345v1","local:private","2501.12345v3"];
  const sources=ids.map((id,i)=>({...source,paper_id:id,chunk_id:"s"+i}));
  const value=a.create({...input,taskId:"versions"},"Versioned sources",sources);
  const title="A {50%} result & #1 $x_y$ ^ ~ \\input{private}";
  const papers=ids.map(paper_id=>({paper_id,title,abstract:""}));
  const exported=exportArtifact(value,"bibtex",papers);
  assert.equal(exported.extension,"bib");assert.equal((exported.content.match(/@misc{/g)??[]).length,4);
  for(const version of [1,2,3])assert.ok(exported.content.includes("eprint = {2501.12345v"+version+"}"));
  assert.ok(exported.content.includes("url = {https://arxiv.org/abs/2501.12345v2}"));
  assert.ok(exported.content.includes("A \\textbraceleft{}50\\%\\textbraceright{} result \\& \\#1 \\$x\\_y\\$ \\textasciicircum{} \\textasciitilde{} \\textbackslash{}input\\textbraceleft{}private\\textbraceright{}"));
  assert.ok(!exported.content.includes("\\input{private}"));
  assert.ok(!exported.content.includes("author ="));assert.ok(!exported.content.includes("year ="));
  const reversed=exportArtifact({...value,sources:[...sources].reverse()},"bibtex",papers).content;
  const keys=(v:string)=>[...v.matchAll(/@misc\{([^,]+),/g)].map(m=>m[1]).sort();
  assert.deepEqual(keys(exported.content),keys(reversed));
  const localEntry=exported.content.split("\n\n").find(v=>v.startsWith("@misc{local"))!;
  const unbalanced=exportArtifact(value,"bibtex",papers.map(p=>({...p,title:"Unpaired { title"}))).content;
  assert.ok(unbalanced.includes("Unpaired \\textbraceleft{} title"));
  assert.equal([...unbalanced].filter(c=>c==="{").length,[...unbalanced].filter(c=>c==="}").length);
  assert.ok(!localEntry.includes("eprint"));assert.ok(!localEntry.includes("url"));assert.ok(!localEntry.includes("local:private"));
 }finally{db.close();}
});

test("artifact tombstones stop automatic regeneration while a new explicit save has a distinct identity",()=>{
 const {db,a}=setup();
 try{
  const first=a.create(input,"Original",[]);a.delete(first.id);a.delete(first.id);
  assert.equal(a.deleted(first.id),true);
  assert.throws(()=>a.create(input,"Automatic replay",[]),/RESOURCE_DELETED/);
  const fresh=a.create(input,"Explicit new save",[],{explicitSave:true});
  assert.notEqual(fresh.id,first.id);assert.equal(a.get(fresh.id).content,"Explicit new save");
  assert.throws(()=>a.get(first.id),/NOT_FOUND/);
  a.delete(fresh.id);assert.throws(()=>a.create(input,"Late replay",[]),/RESOURCE_DELETED/);
  const records=JSON.stringify(db.prepare("SELECT * FROM pra_artifact_tombstones").all());
  assert.ok(!records.includes("Original"));assert.ok(!records.includes("Explicit new save"));
 }finally{db.close();}
});
test("live artifact tombstones hide restored old rows and reopening removes their versions and cached responses",()=>{
 const {db,a,storage}=setup();
 try{
  db.exec("CREATE TABLE pra_mutations(id TEXT PRIMARY KEY,result TEXT NOT NULL)");
  const first=a.create(input,"DELETED_ARTIFACT_RESTORE_CANARY",[]);a.revise(first.id,1,"DELETED_VERSION_RESTORE_CANARY");
  const saved=db.prepare("SELECT * FROM pra_artifacts WHERE id=?").get(first.id)!;
  const versions=db.prepare("SELECT * FROM pra_artifact_versions WHERE id=?").all(first.id);
  const survivor=a.create({...input,taskId:"independent"},"Independent record",[]);
  a.delete(first.id);
  db.prepare("INSERT INTO pra_artifacts VALUES(?,?,?,?,?,?,?,?,?,?)").run(...Object.values(saved) as any[]);
  for(const v of versions)db.prepare("INSERT INTO pra_artifact_versions VALUES(?,?,?,?,?,?)").run(...Object.values(v) as any[]);
  db.prepare("INSERT INTO pra_mutations VALUES(?,?)").run("old-save",JSON.stringify({...first,content:"DELETED_CACHE_RESTORE_CANARY"}));
  assert.throws(()=>a.get(first.id),/NOT_FOUND/);assert.throws(()=>a.versions(first.id),/NOT_FOUND/);
  assert.deepEqual(a.list().items.map(v=>v.id),[survivor.id]);
  const reopened=new Artifacts(storage);
  assert.equal(reopened.get(survivor.id).content,"Independent record");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pra_artifact_versions WHERE id=?").get(first.id)?.n,0);
  assert.deepEqual(JSON.parse(String(db.prepare("SELECT result FROM pra_mutations WHERE id='old-save'").get()?.result)),{_deleted:true});
 }finally{db.close();}
});
test("artifact creation, revision and deletion write ordered durable change events",()=>{
 const {db,a}=setup();
 try{
  const first=a.create(input,"Original",[]);a.create(input,"Retry",[]);
  a.revise(first.id,1,"Revision");a.delete(first.id);a.delete(first.id);
  const rows=db.prepare("SELECT seq,value FROM pra_changes ORDER BY seq").all();
  assert.equal(rows.length,3);assert.deepEqual(rows.map(r=>Number(r.seq)),[1,2,3]);
  assert.deepEqual(rows.map(r=>JSON.parse(String(r.value))[0]),[
   {entity:"artifacts",id:first.id},{entity:"artifacts",id:first.id},{entity:"artifacts",id:first.id,deleted:true}
  ]);
 }finally{db.close();}
});
