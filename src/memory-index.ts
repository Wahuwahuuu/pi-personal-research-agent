import {persistedEntityHash} from "./lazy-entity.ts";
import {createHash} from "node:crypto";
import type {StateStorage} from "./state-store.ts";
import type {CloudMemoryEntry} from "../packages/research/cloud-memory.ts";
import {Problem} from "./domain.ts";
export function memoryTokens(text:string):string[]{
 const normalized=text.normalize("NFKC").toLocaleLowerCase(),terms=new Set<string>();
 for(const word of normalized.match(/[a-z0-9_]+/g)??[])if(word.length>1)terms.add(word.slice(0,80));
 for(const run of normalized.match(/[\p{Script=Han}]+/gu)??[]){
  const chars=Array.from(run);if(chars.length===1)terms.add(run);
  for(let n=2;n<=3;n++)for(let i=0;i+n<=chars.length;i++)terms.add(chars.slice(i,i+n).join(""));
 }
 return [...terms].slice(0,800);
}
const fingerprint=(e:CloudMemoryEntry)=>persistedEntityHash(e)??createHash("sha256").update(JSON.stringify(e)).digest("hex");
export class MemoryIndex{
 readonly db:StateStorage;private known:Map<string,string>;
 constructor(db:StateStorage){this.db=db;
  db.sql.exec("CREATE TABLE IF NOT EXISTS pra_memory_index(id TEXT PRIMARY KEY,hash TEXT NOT NULL,project TEXT NOT NULL,category TEXT NOT NULL,papers TEXT NOT NULL,updated TEXT NOT NULL,edited INTEGER NOT NULL,active INTEGER NOT NULL,value TEXT NOT NULL)");
  db.sql.exec("CREATE VIRTUAL TABLE IF NOT EXISTS pra_memory_fts USING fts5(id UNINDEXED,tokens)");
  db.sql.exec("CREATE TABLE IF NOT EXISTS pra_memory_revisions(id TEXT NOT NULL,revision INTEGER NOT NULL,value TEXT NOT NULL,changed INTEGER NOT NULL,PRIMARY KEY(id,revision))");
  db.transactionSync(()=>{
   db.sql.exec("CREATE TABLE IF NOT EXISTS pra_memory_index_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL)");
   const version=db.sql.exec<{version:number}>("SELECT version FROM pra_memory_index_schema WHERE id=1").toArray()[0]?.version??0;
   if(version>1)throw new Problem("UNKNOWN_MEMORY_INDEX_SCHEMA",503);
   if(version===0){
    // Pin FTS rowids to the indexed canonical IDs, so an update never scans every unindexed FTS id.
    db.sql.exec("DELETE FROM pra_memory_fts");
    let after=0;
    for(;;){const rows=db.sql.exec<{rowid:number;id:string;value:string}>("SELECT rowid,id,value FROM pra_memory_index WHERE rowid>? ORDER BY rowid LIMIT 200",after).toArray();if(!rows.length)break;
     for(const row of rows)db.sql.exec("INSERT INTO pra_memory_fts(rowid,id,tokens) VALUES(?,?,?)",row.rowid,row.id,memoryTokens(JSON.parse(row.value).content).join(" "));
     after=rows.at(-1)!.rowid;
    }
    db.sql.exec("INSERT INTO pra_memory_index_schema VALUES(1,1)");
   }
  });
  this.known=new Map(db.sql.exec<{id:string;hash:string}>("SELECT id,hash FROM pra_memory_index").toArray().map(r=>[r.id,r.hash]));
 }
 sync(entries:readonly CloudMemoryEntry[]){
  const current=new Map(entries.map(e=>[e.id,fingerprint(e)]));
  this.db.transactionSync(()=>{
   for(const id of this.known.keys())if(!current.has(id)){this.db.sql.exec("DELETE FROM pra_memory_fts WHERE rowid=(SELECT rowid FROM pra_memory_index WHERE id=?)",id);this.db.sql.exec("DELETE FROM pra_memory_index WHERE id=?",id);this.db.sql.exec("DELETE FROM pra_memory_revisions WHERE id=?",id);}
   for(const e of entries){const hash=current.get(e.id)!;if(this.known.get(e.id)===hash)continue;
    this.db.sql.exec("DELETE FROM pra_memory_fts WHERE rowid=(SELECT rowid FROM pra_memory_index WHERE id=?)",e.id);
    const value=JSON.stringify(e);
    this.db.sql.exec("INSERT INTO pra_memory_index VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash,project=excluded.project,category=excluded.category,papers=excluded.papers,updated=excluded.updated,edited=excluded.edited,active=excluded.active,value=excluded.value",e.id,hash,e.projectId??"",e.category??(e.kind==="preference"?"preference":"reading"),JSON.stringify(e.paper_ids),e.updated_at,Number(e.edited),Number(e.active!==false),value);
    this.db.sql.exec("INSERT INTO pra_memory_fts(rowid,id,tokens) SELECT rowid,?,? FROM pra_memory_index WHERE id=?",e.id,memoryTokens(e.content).join(" "),e.id);
    this.db.sql.exec("INSERT INTO pra_memory_revisions SELECT ?,COALESCE(MAX(revision),0)+1,?,? FROM pra_memory_revisions WHERE id=?",e.id,value,Date.now(),e.id);
   }
  });this.known=current;
 }
 page(options:{query?:string;projectId?:string;category?:string;after?:number;limit?:number;includeInactive?:boolean;paperIds?:readonly string[]}={}){
  const after=options.after??0,limit=options.limit??30;if(!Number.isInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>100)throw new Problem("INVALID_PAGE");
  const terms=memoryTokens(options.query??"").slice(0,40),where:string[]=[],args:unknown[]=[];
  let from="pra_memory_index m",rank="m.edited DESC,m.updated DESC,m.id";
  if(terms.length){from+=" JOIN pra_memory_fts ON pra_memory_fts.id=m.id";where.push("pra_memory_fts MATCH ?");args.push(terms.map(t=>'"'+t.replaceAll('"','""')+'"').join(" OR "));rank="m.edited DESC,bm25(pra_memory_fts),m.updated DESC,m.id";}
  if(!options.includeInactive)where.push("m.active=1");
  if(options.projectId!==undefined){where.push("(m.project='' OR m.project=?)");args.push(options.projectId);}
  if(options.category){where.push("m.category=?");args.push(options.category);}
  if(options.paperIds?.length){where.push("(json_array_length(m.papers)=0 OR EXISTS(SELECT 1 FROM json_each(m.papers) p WHERE p.value IN ("+options.paperIds.map(()=>"?").join(",")+")))");args.push(...options.paperIds);}
  const rows=this.db.sql.exec<{value:string}>("SELECT m.value FROM "+from+(where.length?" WHERE "+where.join(" AND "):"")+" ORDER BY "+rank+" LIMIT ? OFFSET ?",...args,limit+1,after).toArray();
  return{items:rows.slice(0,limit).map(r=>JSON.parse(r.value) as CloudMemoryEntry),nextCursor:rows.length>limit?after+limit:null};
 }
 recall(query:string,paperIds:readonly string[],projectId:string,preferencesOnly=false,recent=false){
  const relevant=this.page({query,projectId,paperIds,limit:20}).items;
  const preferences=this.page({projectId,category:"preference",limit:8}).items;
  const recentItems=recent?this.page({projectId,paperIds,limit:10}).items:[];
  return [...preferences,...(preferencesOnly?[]:[...relevant,...recentItems])].filter((e,i,a)=>a.findIndex(v=>v.id===e.id)===i).slice(0,20);
 }
 revisions(id:string){if(!this.known.has(id))throw new Problem("NOT_FOUND",404);return this.db.sql.exec<{revision:number;changed:number;value:string}>("SELECT * FROM pra_memory_revisions WHERE id=? ORDER BY revision DESC LIMIT 100",id).toArray().map(r=>({revision:r.revision,changed:r.changed,entry:JSON.parse(r.value)}));}
}
