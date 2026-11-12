import {createHash} from "node:crypto";
import {arxivVersion} from "../packages/research/source-links.ts";
import type {StateStorage} from "./state-store.ts";
import {Problem,text} from "./domain.ts";
import type {Chunk,Paper} from "../packages/research/core.ts";
export const artifactKinds=["reading","comparison","review","brief"] as const;
export interface Artifact {id:string;projectId:string;conversationId:string;taskId:string;kind:typeof artifactKinds[number];title:string;created:number;updated:number;version:number;partial:boolean}
export class Artifacts {
 readonly db:StateStorage;
 constructor(db:StateStorage){this.db=db;
  db.sql.exec("CREATE TABLE IF NOT EXISTS pra_artifacts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,conversation_id TEXT NOT NULL,task_id TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,version INTEGER NOT NULL,partial INTEGER NOT NULL)");
  db.sql.exec("CREATE INDEX IF NOT EXISTS pra_artifacts_project ON pra_artifacts(project_id,updated)");
  db.sql.exec("CREATE TABLE IF NOT EXISTS pra_artifact_versions(id TEXT NOT NULL,version INTEGER NOT NULL,content TEXT NOT NULL,sources TEXT NOT NULL,editor TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(id,version))");
 }
 private parse(r:any):Artifact{return{id:r.id,projectId:r.project_id,conversationId:r.conversation_id,taskId:r.task_id,kind:r.kind,title:r.title,created:r.created,updated:r.updated,version:r.version,partial:!!r.partial};}
 get(id:string,version?:number){
  const r=this.db.sql.exec<any>("SELECT * FROM pra_artifacts WHERE id=?",id).toArray()[0];if(!r)throw new Problem("NOT_FOUND",404);
  const v=this.db.sql.exec<any>("SELECT * FROM pra_artifact_versions WHERE id=? AND version=?",id,version??r.version).toArray()[0];if(!v)throw new Problem("NOT_FOUND",404);
  return{...this.parse(r),version:v.version,content:v.content as string,sources:JSON.parse(v.sources) as Chunk[],editor:v.editor as string};
 }
 list(projectId?:string,after=0,limit=30){
  if(!Number.isInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>100)throw new Problem("INVALID_PAGE");
  const rows=this.db.sql.exec<any>("SELECT * FROM pra_artifacts "+(projectId?"WHERE project_id=? ":"")+"ORDER BY updated DESC,id LIMIT ? OFFSET ?",...(projectId?[projectId]:[]),limit+1,after).toArray();
  return{items:rows.slice(0,limit).map(r=>this.parse(r)),nextCursor:rows.length>limit?after+limit:null};
 }
 create(input:Omit<Artifact,"id"|"created"|"updated"|"version">,content:string,sources:readonly Chunk[]){
  if(!artifactKinds.includes(input.kind))throw new Problem("INVALID_ARTIFACT_KIND");text(content,50000);text(input.title,150);
  if(sources.length>100)throw new Problem("TOO_MANY_SOURCES");
  const prior=this.db.sql.exec<{id:string}>("SELECT id FROM pra_artifacts WHERE task_id=? AND kind=?",input.taskId,input.kind).toArray()[0];
  if(prior)return this.get(prior.id);
  const id=crypto.randomUUID(),now=Date.now();
  this.db.transactionSync(()=>{
   this.db.sql.exec("INSERT INTO pra_artifacts VALUES(?,?,?,?,?,?,?,?,1,?)",id,input.projectId,input.conversationId,input.taskId,input.kind,input.title,now,now,Number(input.partial));
   this.db.sql.exec("INSERT INTO pra_artifact_versions VALUES(?,1,?,?,'agent',?)",id,content,JSON.stringify(sources),now);
  });return this.get(id);
 }
 revise(id:string,expected:number,content:string,title?:string){
  const a=this.get(id);if(expected!==a.version)throw new Problem("VERSION_CONFLICT",409);text(content,50000);if(title!==undefined)text(title,150);
  this.db.transactionSync(()=>{const now=Date.now();
   this.db.sql.exec("INSERT INTO pra_artifact_versions VALUES(?,?,?,?,'user',?)",id,expected+1,content,JSON.stringify(a.sources),now);
   this.db.sql.exec("UPDATE pra_artifacts SET version=?,title=?,updated=? WHERE id=?",expected+1,title??a.title,now,id);
  });return this.get(id);
 }
 versions(id:string){this.get(id);return this.db.sql.exec("SELECT version,editor,created FROM pra_artifact_versions WHERE id=? ORDER BY version DESC",id).toArray();}
 delete(id:string){this.get(id);this.db.transactionSync(()=>{this.db.sql.exec("DELETE FROM pra_artifact_versions WHERE id=?",id);this.db.sql.exec("DELETE FROM pra_artifacts WHERE id=?",id);});}
 deleteTasks(tasks:readonly string[]){const ids=this.db.sql.exec<{id:string}>("SELECT id FROM pra_artifacts WHERE task_id IN (SELECT value FROM json_each(?))",JSON.stringify(tasks)).toArray().map(r=>r.id);for(const id of ids)this.delete(id);return ids;}
 deleteConversation(id:string){const ids=this.db.sql.exec<{id:string}>("SELECT id FROM pra_artifacts WHERE conversation_id=?",id).toArray().map(r=>r.id);for(const a of ids)this.delete(a);return ids;}
}
const escape=(v:string)=>v.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
export function exportArtifact(a:ReturnType<Artifacts["get"]>,format:string,papers:readonly Paper[]){
 const refs=[...new Set(a.sources.map(s=>s.paper_id))].map(id=>papers.find(p=>p.paper_id===id)??{paper_id:id,title:id,abstract:""});
 if(format==="bibtex"){
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
 const textContent="# "+a.title+"\n\n"+a.content+"\n\n## 证据出处\n\n"+a.sources.map((s,i)=>"["+(i+1)+"] "+s.paper_id+" · "+s.section+" · "+s.chunk_id+" · "+s.start+"–"+s.end+"\n\n> "+s.text.replaceAll("\n","\n> ")).join("\n\n");
 if(format==="md")return{type:"text/markdown; charset=utf-8",extension:"md",content:textContent};
 if(format==="html")return{type:"text/html; charset=utf-8",extension:"html",content:'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>'+escape(a.title)+'</title><style>body{font:17px/1.75 system-ui;max-width:80ch;margin:3rem auto;padding:0 1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}</style><body><pre>'+escape(textContent)+'</pre></body></html>'};
 throw new Problem("INVALID_EXPORT_FORMAT");
}
