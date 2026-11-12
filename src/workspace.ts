import {createHash} from "node:crypto";
import type {StateStorage} from "./state-store.ts";
import {Problem,text,type State,type Task} from "./domain.ts";
export interface Project {id:string;title:string;goal:string;paperIds:string[];pinned:boolean;archived:boolean;created:number;updated:number}
export interface Settings {agentName:string;researchDirection:string;theme:"system"|"light"|"dark";notifications:boolean;onboarded:boolean;timezone:"Asia/Shanghai"}
export const defaultSettings:Settings={agentName:"Aster",researchDirection:"",theme:"system",notifications:true,onboarded:false,timezone:"Asia/Shanghai"};
export class Workspace {
 readonly db:StateStorage;
 constructor(db:StateStorage){
  this.db=db;
  db.sql.exec("CREATE TABLE IF NOT EXISTS pra_projects(id TEXT PRIMARY KEY,title TEXT NOT NULL,goal TEXT NOT NULL,papers TEXT NOT NULL,pinned INTEGER NOT NULL,archived INTEGER NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL)");
  db.sql.exec("CREATE TABLE IF NOT EXISTS pra_project_tombstones(id TEXT PRIMARY KEY)");
  db.sql.exec("CREATE TABLE IF NOT EXISTS pra_settings(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL)");
  db.sql.exec("CREATE TABLE IF NOT EXISTS pra_mutations(id TEXT PRIMARY KEY,operation TEXT NOT NULL,input TEXT NOT NULL,result TEXT NOT NULL,created INTEGER NOT NULL)");
 }
 once<T>(id:unknown,operation:string,input:unknown,fn:()=>T):T{
  const key=text(id,128),encoded=createHash("sha256").update(JSON.stringify(input)).digest("hex"),old=this.db.sql.exec<{operation:string;input:string;result:string}>("SELECT operation,input,result FROM pra_mutations WHERE id=?",key).toArray()[0];
  if(old){if(old.operation!==operation||old.input!==encoded)throw new Problem("REQUEST_CONFLICT",409);const result=JSON.parse(old.result);if(result?._deleted)throw new Problem("RESOURCE_DELETED",410);return result;}
  return this.db.transactionSync(()=>{const result=fn();this.db.sql.exec("INSERT INTO pra_mutations VALUES(?,?,?,?,?)",key,operation,encoded,JSON.stringify(result),Date.now());return result;});
 }
 settings():Settings {return this.db.sql.exec<{value:string}>("SELECT value FROM pra_settings WHERE id=1").toArray().map(r=>JSON.parse(r.value))[0]??{...defaultSettings};}
 updateSettings(patch:any){
  const s=this.settings();
  if(patch.agentName!==undefined)s.agentName=text(patch.agentName,40);
  if(patch.researchDirection!==undefined){if(typeof patch.researchDirection!=="string"||patch.researchDirection.length>2000)throw new Problem("INVALID_DIRECTION");s.researchDirection=patch.researchDirection.trim();}
  if(patch.theme!==undefined){if(!["system","light","dark"].includes(patch.theme))throw new Problem("INVALID_THEME");s.theme=patch.theme;}
  for(const k of ["notifications","onboarded"] as const)if(patch[k]!==undefined){if(typeof patch[k]!=="boolean")throw new Problem("INVALID_SETTING");s[k]=patch[k];}
  this.db.sql.exec("INSERT INTO pra_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",JSON.stringify(s));return s;
 }
 private project(row:any):Project{return{id:row.id,title:row.title,goal:row.goal,paperIds:JSON.parse(row.papers),pinned:!!row.pinned,archived:!!row.archived,created:row.created,updated:row.updated};}
 getProject(id:string){const row=this.db.sql.exec<any>("SELECT * FROM pra_projects WHERE id=?",id).toArray()[0];if(!row)throw new Problem("NOT_FOUND",404);return this.project(row);}
 migrate(s:State){
  const ids=new Set(["default",...(s.conversations??[]).map(c=>c.projectId)]);
  this.db.transactionSync(()=>{for(const id of ids)if(!this.db.sql.exec("SELECT id FROM pra_project_tombstones WHERE id=?",id).toArray().length)this.db.sql.exec("INSERT OR IGNORE INTO pra_projects VALUES(?,?,?,'[]',0,0,?,?)",id,id==="default"?"我的研究":id,"",0,0);});
 }
 projects(options:{q?:string;archived?:boolean;after?:number;limit?:number}={}){
  const limit=options.limit??50,after=options.after??0;if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(after)||after<0)throw new Problem("INVALID_PAGE");
  const where="archived=? AND (instr(lower(title),lower(?))>0 OR instr(lower(goal),lower(?))>0)",args=[options.archived?1:0,options.q??"",options.q??""];
  const rows=this.db.sql.exec<any>("SELECT * FROM pra_projects WHERE "+where+" ORDER BY pinned DESC,updated DESC,id LIMIT ? OFFSET ?",...args,limit+1,after).toArray();
  return{items:rows.slice(0,limit).map(r=>this.project(r)),nextCursor:rows.length>limit?after+limit:null};
 }
 createProject(input:any){
  const now=Date.now(),id=crypto.randomUUID(),title=text(input.title,100),goal=input.goal===undefined?"":text(input.goal,4000);
  this.db.sql.exec("INSERT INTO pra_projects VALUES(?,?,?,'[]',0,0,?,?)",id,title,goal,now,now);return this.getProject(id);
 }
 updateProject(id:string,input:any){
  const p=this.getProject(id);
  if(input.title!==undefined)p.title=text(input.title,100);
  if(input.goal!==undefined){if(typeof input.goal!=="string"||input.goal.length>4000)throw new Problem("INVALID_GOAL");p.goal=input.goal.trim();}
  if(input.paperIds!==undefined){if(!Array.isArray(input.paperIds)||input.paperIds.length>200||input.paperIds.some((v:unknown)=>typeof v!=="string"||!v||v.length>256))throw new Problem("INVALID_PAPERS");p.paperIds=[...new Set(input.paperIds)] as string[];}
  for(const key of ["pinned","archived"] as const)if(input[key]!==undefined){if(typeof input[key]!=="boolean")throw new Problem("INVALID_SETTING");p[key]=input[key];}
  p.updated=Date.now();this.db.sql.exec("UPDATE pra_projects SET title=?,goal=?,papers=?,pinned=?,archived=?,updated=? WHERE id=?",p.title,p.goal,JSON.stringify(p.paperIds),Number(p.pinned),Number(p.archived),p.updated,id);return p;
 }
 forgetEntity(id:string){this.db.sql.exec("UPDATE pra_mutations SET result=? WHERE json_extract(result,'$.id')=?",JSON.stringify({_deleted:true}),id);}
 deleteProject(id:string){if(id==="default")throw new Problem("DEFAULT_PROJECT_REQUIRED",409);this.getProject(id);this.db.sql.exec("INSERT OR IGNORE INTO pra_project_tombstones VALUES(?)",id);this.db.sql.exec("DELETE FROM pra_projects WHERE id=?",id);this.db.sql.exec("UPDATE pra_mutations SET result=? WHERE json_extract(result,\'$.id\')=?",JSON.stringify({_deleted:true}),id);}
}
export function taskSummary(t:Task){
 const {id,conversationId,input,kind,status,created,updated,calls,tools,activeMs,answer,preview,error,origin}=t;
 return {id,conversationId,input,kind,status,created,updated,calls,tools,activeMs,answer,preview,error,origin,control:t.control,amendments:t.amendments,runOpen:t.runOpen,priority:t.priority,goal:t.goal,pauseRequested:t.pauseRequested,progress:t.workflow?.progress??null};
}
export function conversationPage(s:State,options:{q?:string;projectId?:string;archived?:boolean;after?:number;limit?:number}={},reader?:{historyCount:(c:NonNullable<State["conversations"]>[number])=>number}){
 const after=options.after??0,limit=options.limit??30;if(!Number.isInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>100)throw new Problem("INVALID_PAGE");
 const q=(options.q??"").toLocaleLowerCase();
 const filtered=(s.conversations??[]).filter(c=>Boolean(c.archived)===Boolean(options.archived)&&(!options.projectId||c.projectId===options.projectId)&&(!q||c.title.toLocaleLowerCase().includes(q)||c.history.some(h=>(h.user_text+" "+h.final_answer).toLocaleLowerCase().includes(q))))
 .sort((a,b)=>Number(b.pinned??false)-Number(a.pinned??false)||(b.updated??b.created)-(a.updated??a.created)||a.id.localeCompare(b.id));
 return {items:filtered.slice(after,after+limit).map(c=>({...(Object.fromEntries(Object.keys(c).filter(k=>k!=="history"&&k!=="domain").map(k=>[k,(c as any)[k]])) as Omit<NonNullable<State["conversations"]>[number],"history"|"domain">),turns:reader?reader.historyCount(c):c.history.length})),nextCursor:filtered.length>after+limit?after+limit:null};
}

export function taskPage(s:State,options:{conversationId?:string;status?:string;before?:string;limit?:number}={}){
 const limit=options.limit??30;if(!Number.isInteger(limit)||limit<1||limit>100)throw new Problem("INVALID_PAGE");
 let timestamp=Number.MAX_SAFE_INTEGER,id="~";
 if(options.before){const split=options.before.indexOf(":");timestamp=Number(options.before.slice(0,split));id=options.before.slice(split+1);if(split<1||!Number.isSafeInteger(timestamp)||timestamp<0||id.length>128)throw new Problem("INVALID_PAGE");}
 const rows=s.tasks.filter(t=>(!options.conversationId||t.conversationId===options.conversationId)&&(!options.status||t.status===options.status)&&(t.created<timestamp||t.created===timestamp&&t.id<id))
 .sort((a,b)=>b.created-a.created||b.id.localeCompare(a.id));
 return{items:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].created+":"+rows[limit-1].id:null};
}
