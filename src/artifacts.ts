import {ARTIFACT_CONTENT_LIMIT, ARTIFACT_TITLE_LIMIT, artifactKinds, type ArtifactKind} from "./artifact-contract.ts";
import {appendChanges, initializeChangeFeed} from "./change-feed.ts";
import {createHash} from "node:crypto";
import {comparisonEvidence,type CoverageReport,type ComparisonSnapshot} from "./comparison-evidence.ts";
import {exportComparison} from "./comparison-export.ts";
import {arxivVersion} from "../packages/research/source-links.ts";
import type {StateStorage} from "./state-store.ts";
import {Problem,text} from "./domain.ts";
import type {Chunk,Paper} from "../packages/research/core.ts";
export {artifactKinds};
export interface Artifact {id:string;projectId:string;conversationId:string;taskId:string;kind:ArtifactKind;title:string;created:number;updated:number;version:number;partial:boolean}
// Keep the original revision table writable by previously deployed Workers.
function initializeVersionTitles(db:StateStorage) {
 if(db.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='pra_artifact_version_titles'").toArray().length)return;
 db.transactionSync(()=>{
  db.sql.exec(`CREATE TABLE pra_artifact_version_titles(
    id TEXT NOT NULL,version INTEGER NOT NULL,title TEXT NOT NULL,PRIMARY KEY(id,version),
    FOREIGN KEY(id,version) REFERENCES pra_artifact_versions(id,version) ON DELETE CASCADE
  ) WITHOUT ROWID`);
  if(!db.sql.exec("SELECT id FROM pra_artifacts WHERE version>1 LIMIT 1").toArray().length)return;
  const columns=db.sql.exec<{name:string}>("PRAGMA table_info(pra_mutations)").toArray();
  if(!columns.some(c=>c.name==="operation")||!columns.some(c=>c.name==="result"))return;
  // Old saves kept a copy of the response in the idempotency receipt. Only accept matching revisions.
  db.sql.exec(`WITH receipts AS (
    SELECT operation,json_extract(result,'$.id') AS id,json_extract(result,'$.version') AS version,
      json_extract(result,'$.title') AS title,json_extract(result,'$.content') AS content,
      json_extract(result,'$.editor') AS editor
    FROM pra_mutations WHERE operation GLOB 'artifact:*' AND json_valid(result)
  )
  INSERT INTO pra_artifact_version_titles(id,version,title)
  SELECT v.id,v.version,MIN(r.title)
  FROM receipts r JOIN pra_artifact_versions v ON v.id=r.id AND v.version=r.version
    JOIN pra_artifacts a ON a.id=v.id
  WHERE (r.operation='artifact:create' OR r.operation='artifact:'||v.id)
    AND v.version<a.version AND r.content=v.content AND r.editor=v.editor
    AND typeof(r.title)='text' AND length(trim(r.title)) BETWEEN 1 AND 150
  GROUP BY v.id,v.version HAVING MIN(r.title)=MAX(r.title)`);
 });
}
interface SaveOptions {
 explicitSave?:boolean;
 coverage?:{indexVersion:string;report:CoverageReport;papers:()=>readonly Pick<Paper,"paper_id"|"title">[]};
}
export class Artifacts {
 readonly db:StateStorage;
 constructor(db:StateStorage){this.db=db;
  db.sql.exec("CREATE TABLE IF NOT EXISTS pra_artifacts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,conversation_id TEXT NOT NULL,task_id TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,version INTEGER NOT NULL,partial INTEGER NOT NULL)");
  db.sql.exec("CREATE INDEX IF NOT EXISTS pra_artifacts_project ON pra_artifacts(project_id,updated)");
  db.sql.exec("CREATE TABLE IF NOT EXISTS pra_artifact_versions(id TEXT NOT NULL,version INTEGER NOT NULL,content TEXT NOT NULL,sources TEXT NOT NULL,editor TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(id,version))");
  db.sql.exec("CREATE TABLE IF NOT EXISTS pra_artifact_tombstones(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,kind TEXT NOT NULL,deleted INTEGER NOT NULL)");
  db.sql.exec("CREATE INDEX IF NOT EXISTS pra_artifact_tombstones_origin ON pra_artifact_tombstones(task_id,kind)");
  db.sql.exec("CREATE TABLE IF NOT EXISTS pra_artifact_comparisons(id TEXT PRIMARY KEY REFERENCES pra_artifacts(id) ON DELETE CASCADE,snapshot TEXT NOT NULL) WITHOUT ROWID");
  initializeChangeFeed(db);
  initializeVersionTitles(db);
  this.purgeDeleted();

 }
 private changed(id:string,deleted=false){appendChanges(this.db,[{entity:"artifacts",id,...(deleted?{deleted:true as const}:{})}]);}
 deleted(id:string){return this.db.sql.exec("SELECT id FROM pra_artifact_tombstones WHERE id=?",id).toArray().length>0;}
 /** Only application restores which preserve the live tombstones can use this reconciliation. */
 purgeDeleted(){
  this.db.transactionSync(()=>{
   this.db.sql.exec("DELETE FROM pra_artifact_versions WHERE id IN (SELECT id FROM pra_artifact_tombstones)");
   this.db.sql.exec("DELETE FROM pra_artifacts WHERE id IN (SELECT id FROM pra_artifact_tombstones)");
   if(this.db.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='pra_mutations'").toArray().length)
    this.db.sql.exec("UPDATE pra_mutations SET result=? WHERE json_extract(result,'$.id') IN (SELECT id FROM pra_artifact_tombstones)",JSON.stringify({_deleted:true}));
  });
 }
 private parse(r:any):Artifact{return{id:r.id,projectId:r.project_id,conversationId:r.conversation_id,taskId:r.task_id,kind:r.kind,title:r.title,created:r.created,updated:r.updated,version:r.version,partial:!!r.partial};}
 get(id:string,version?:number){
  if(this.deleted(id))throw new Problem("NOT_FOUND",404);
  const r=this.db.sql.exec<any>("SELECT * FROM pra_artifacts WHERE id=?",id).toArray()[0];if(!r)throw new Problem("NOT_FOUND",404);
  const v=this.db.sql.exec<any>(`SELECT v.*,t.title AS versionTitle FROM pra_artifact_versions v
    LEFT JOIN pra_artifact_version_titles t ON t.id=v.id AND t.version=v.version
    WHERE v.id=? AND v.version=?`,id,version??r.version).toArray()[0];if(!v)throw new Problem("NOT_FOUND",404);
  const title=v.version===r.version?r.title:v.versionTitle??"历史标题未记录";
  const snapshot=r.kind==="comparison" ? this.db.sql.exec<{snapshot:string}>("SELECT snapshot FROM pra_artifact_comparisons WHERE id=?",id).toArray()[0] : undefined;
  const comparison:ComparisonSnapshot|undefined=snapshot?JSON.parse(snapshot.snapshot):undefined;
  return{...this.parse(r),...(comparison?{comparison}:{}),version:v.version,title:title as string,updated:v.created as number,content:v.content as string,sources:JSON.parse(v.sources) as Chunk[],editor:v.editor as string};
 }
 list(projectId?:string,after=0,limit=30){
  if(!Number.isInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>100)throw new Problem("INVALID_PAGE");
  const rows=this.db.sql.exec<any>("SELECT * FROM pra_artifacts WHERE id NOT IN (SELECT id FROM pra_artifact_tombstones) "+(projectId?"AND project_id=? ":"")+"ORDER BY updated DESC,id LIMIT ? OFFSET ?",...(projectId?[projectId]:[]),limit+1,after).toArray();
  return{items:rows.slice(0,limit).map(r=>this.parse(r)),nextCursor:rows.length>limit?after+limit:null};
 }
 create(input:Omit<Artifact,"id"|"created"|"updated"|"version">,content:string,sources:readonly Chunk[],options:SaveOptions={}){
  if(!artifactKinds.includes(input.kind))throw new Problem("INVALID_ARTIFACT_KIND");text(content,ARTIFACT_CONTENT_LIMIT);text(input.title,ARTIFACT_TITLE_LIMIT);
  if(sources.length>100)throw new Problem("TOO_MANY_SOURCES");
  const prior=this.db.sql.exec<{id:string}>("SELECT id FROM pra_artifacts WHERE task_id=? AND kind=? AND id NOT IN (SELECT id FROM pra_artifact_tombstones)",input.taskId,input.kind).toArray()[0];
  if(prior)return this.get(prior.id);
  if(!options.explicitSave&&this.db.sql.exec("SELECT id FROM pra_artifact_tombstones WHERE task_id=? AND kind=? LIMIT 1",input.taskId,input.kind).toArray().length)
   throw new Problem("RESOURCE_DELETED",410);
  const id=crypto.randomUUID(),now=Date.now();
  this.db.transactionSync(()=>{
   this.db.sql.exec("INSERT INTO pra_artifacts VALUES(?,?,?,?,?,?,?,?,1,?)",id,input.projectId,input.conversationId,input.taskId,input.kind,input.title,now,now,Number(input.partial));
   this.db.sql.exec("INSERT INTO pra_artifact_versions VALUES(?,1,?,?,'agent',?)",id,content,JSON.stringify(sources),now);
   this.db.sql.exec("INSERT INTO pra_artifact_version_titles VALUES(?,1,?)",id,input.title);
   const coverage=options.coverage;
   if(input.kind==="comparison" && coverage){
    const snapshot:ComparisonSnapshot={indexVersion:coverage.indexVersion,papers:comparisonEvidence(coverage.report,coverage.indexVersion,sources,coverage.papers())};
    this.db.sql.exec("INSERT INTO pra_artifact_comparisons(id,snapshot) VALUES(?,?)",id,JSON.stringify(snapshot));
   }
   this.changed(id);
  });return this.get(id);
 }
 createAutomatic(input:Omit<Artifact,"id"|"created"|"updated"|"version">,content:string,sources:readonly Chunk[]){
  try{return this.create(input,content,sources);}
  catch(error){if(error instanceof Problem&&error.code==="RESOURCE_DELETED")return undefined;throw error;}
 }
 revise(id:string,expected:number,content:string,title?:string){
  const a=this.get(id);if(expected!==a.version)throw new Problem("VERSION_CONFLICT",409);text(content,ARTIFACT_CONTENT_LIMIT);if(title!==undefined)text(title,ARTIFACT_TITLE_LIMIT);
  this.db.transactionSync(()=>{const now=Date.now();
   this.db.sql.exec("INSERT INTO pra_artifact_versions VALUES(?,?,?,?,'user',?)",id,expected+1,content,JSON.stringify(a.sources),now);
   const nextTitle=title??a.title;
   this.db.sql.exec("INSERT OR IGNORE INTO pra_artifact_version_titles VALUES(?,?,?),(?,?,?)",id,expected,a.title,id,expected+1,nextTitle);
   this.db.sql.exec("UPDATE pra_artifacts SET version=?,title=?,updated=? WHERE id=?",expected+1,nextTitle,now,id);
   this.changed(id);
  });return this.get(id);
 }
 versions(id:string){this.get(id);return this.db.sql.exec("SELECT version,editor,created FROM pra_artifact_versions WHERE id=? ORDER BY version DESC",id).toArray();}
 delete(id:string){
  const row=this.db.sql.exec<{task_id:string;kind:string}>("SELECT task_id,kind FROM pra_artifacts WHERE id=?",id).toArray()[0];
  if(!row){if(this.deleted(id))return;throw new Problem("NOT_FOUND",404);}
  this.db.transactionSync(()=>{
   this.db.sql.exec("INSERT OR IGNORE INTO pra_artifact_tombstones VALUES(?,?,?,?)",id,row.task_id,row.kind,Date.now());
   this.db.sql.exec("DELETE FROM pra_artifact_versions WHERE id=?",id);this.db.sql.exec("DELETE FROM pra_artifacts WHERE id=?",id);this.changed(id,true);
  });
 }
 deleteTasks(tasks:readonly string[]){const ids=this.db.sql.exec<{id:string}>("SELECT id FROM pra_artifacts WHERE task_id IN (SELECT value FROM json_each(?))",JSON.stringify(tasks)).toArray().map(r=>r.id);for(const id of ids)this.delete(id);return ids;}
 deleteConversation(id:string){const ids=this.db.sql.exec<{id:string}>("SELECT id FROM pra_artifacts WHERE conversation_id=?",id).toArray().map(r=>r.id);for(const a of ids)this.delete(a);return ids;}
}
const escape=(v:string)=>v.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
export function exportArtifact(a:ReturnType<Artifacts["get"]>,format:string,papers:readonly Paper[]){
 if(format==="bibtex"){
  const frozenTitles=new Map(a.comparison?.papers.map(p=>[p.id,p.title]));
  const refs=[...new Set(a.sources.map(s=>s.paper_id))].map(id=>({paper_id:id,title:frozenTitles.get(id)??papers.find(p=>p.paper_id===id)?.title??id}));
  const escapeTex=(value:string)=>value.replace(/[\u0000-\u001f\u007f]/g," ").replace(/[\\{}%&#_$^~]/g,c=>({
    "\\":"\\textbackslash{}","{":"\\textbraceleft{}","}":"\\textbraceright{}","%":"\\%","&":"\\&","#":"\\#","_":"\\_","$":"\\$","^":"\\textasciicircum{}","~":"\\textasciitilde{}",
  }[c]!));
  const unique=new Map(refs.map(p=>[arxivVersion(p.paper_id)??p.paper_id,p]));
  const content=[...unique].map(([identity,p])=>{
    const version=arxivVersion(p.paper_id),key=version?"arxiv"+version.replace(".","_"):"local"+createHash("sha256").update(identity).digest("hex").slice(0,16);
    const fields=["title = {"+escapeTex(p.title)+"}"];
    if(version)fields.push("eprint = {"+version+"}","archivePrefix = {arXiv}","url = {https://arxiv.org/abs/"+version+"}");
    return "@misc{"+key+",\n  "+fields.join(",\n  ")+"\n}";
  }).join("\n\n");
  return{type:"application/x-bibtex; charset=utf-8",extension:"bib",content};
 }
 const heading="# "+a.title+"\n\n"+a.content;
 const evidence="## 证据出处\n\n"+a.sources.map((s,i)=>"["+(i+1)+"] "+s.paper_id+" · "+s.section+" · "+s.chunk_id+" · "+s.start+"–"+s.end+"\n\n> "+s.text.replaceAll("\n","\n> ")).join("\n\n");
 if(format==="md"){
  const matrix=a.comparison ? [exportComparison(a.comparison,a.sources,"md",escape)] : [];
  return{type:"text/markdown; charset=utf-8",extension:"md",content:[heading,...matrix,evidence].join("\n\n")};
 }
 if(format==="html")return{type:"text/html; charset=utf-8",extension:"html",content:'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>'+escape(a.title)+'</title><style>body{font:17px/1.75 system-ui;max-width:80ch;margin:3rem auto;padding:0 1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}table{border-collapse:collapse;width:100%;font-size:.92em}th,td{border:1px solid #aaa;padding:.35em;text-align:start;vertical-align:top;overflow-wrap:anywhere}</style><body><pre>'+escape(heading)+(a.comparison?'</pre>'+exportComparison(a.comparison,a.sources,"html",escape)+'<pre>':'\n\n')+escape(evidence)+'</pre></body></html>'};
 throw new Problem("INVALID_EXPORT_FORMAT");
}
