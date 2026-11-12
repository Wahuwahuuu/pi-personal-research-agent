import {test} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {Workspace,conversationPage,taskPage} from "../src/workspace.ts";
import {initialState,submit} from "../src/domain.ts";
import type {StateStorage} from "../src/state-store.ts";
function setup(){const db=new DatabaseSync(":memory:");let depth=0;const p:StateStorage={sql:{exec<T>(q:string,...b:any[]){const s=db.prepare(q),v=(s.columns().length?s.all(...b):(s.run(...b),[])) as T[];return{toArray:()=>v};}},transactionSync<T>(f:()=>T){if(depth)return f();db.exec("BEGIN");depth++;try{const v=f();db.exec("COMMIT");return v;}catch(e){db.exec("ROLLBACK");throw e;}finally{depth--;}}};return{db,workspace:new Workspace(p)};}
test("project mutations are idempotent, searchable, editable and cannot resurrect after deletion",()=>{
 const {db,workspace:w}=setup(),s=initialState();w.migrate(s);
 const input={title:"中文检索",goal:"理解证据"};const p=w.once("r","project:create",input,()=>w.createProject(input));
 assert.deepEqual(w.once("r","project:create",input,()=>{throw Error("duplicate");}),p);
 assert.throws(()=>w.once("r","project:create",{...input,title:"different"},()=>p),/REQUEST_CONFLICT/);
 w.updateProject(p.id,{pinned:true,paperIds:["a","a","b"]});assert.deepEqual(w.getProject(p.id).paperIds,["a","b"]);
 assert.equal(w.projects({q:"证据"}).items[0].id,p.id);
 s.conversations=[{id:"c",title:"kept pending",projectId:p.id,scope:[],created:0,history:[]}];
 w.deleteProject(p.id);w.migrate(s);assert.throws(()=>w.getProject(p.id),/NOT_FOUND/);
 assert.throws(()=>w.once("r","project:create",input,()=>p),/RESOURCE_DELETED/);
 assert.ok(!JSON.stringify(db.prepare("SELECT * FROM pra_mutations").all()).includes("中文检索"));
 assert.throws(()=>w.deleteProject("default"),/DEFAULT_PROJECT_REQUIRED/);db.close();
});
test("project pagination and archive, personal settings validation survive reopening",()=>{
 const {db,workspace:w}=setup();
 for(let i=0;i<55;i++)w.createProject({title:"Project "+i});
 const a=w.projects({limit:30}),b=w.projects({limit:30,after:a.nextCursor!});assert.equal(new Set([...a.items,...b.items].map(p=>p.id)).size,55);
 w.updateProject(a.items[0].id,{archived:true});assert.equal(w.projects({archived:true}).items.length,1);
 w.updateSettings({agentName:"My research",theme:"dark",researchDirection:"RAG",notifications:false,onboarded:true});
 assert.equal(new Workspace(w.db).settings().theme,"dark");assert.equal(w.settings().timezone,"Asia/Shanghai");
 assert.throws(()=>w.updateSettings({theme:"unknown"}),/INVALID_THEME/);assert.throws(()=>w.projects({limit:10000}),/INVALID_PAGE/);db.close();
});
test("conversation search includes historical discussion and honors project/archive filters without returning private domain context",()=>{
 const s=initialState();s.conversations=[{id:"a",title:"A",projectId:"p",scope:[],created:0,history:[{turn_id:"t",user_text:"中文问题",final_answer:"证据"}],domain:{} as any},{id:"b",title:"B",projectId:"q",scope:[],created:1,pinned:true,history:[]}];
 assert.equal(conversationPage(s,{q:"中文",projectId:"p"}).items[0].id,"a");
 assert.ok(!("domain" in conversationPage(s).items[0]));assert.equal(conversationPage(s).items[0].id,"b");
 s.conversations[0].archived=true;assert.equal(conversationPage(s,{archived:true}).items[0].id,"a");
});
test("messages created in the same millisecond paginate without omission or duplication",()=>{
 const s=initialState();for(let i=0;i<100;i++)submit(s,"question","r"+i,"chat",100);
 let before:string|undefined,ids:string[]=[];
 do{const p=taskPage(s,{before,limit:13});ids.push(...p.items.map(t=>t.id));before=p.nextCursor??undefined;}while(before);
 assert.equal(ids.length,100);assert.equal(new Set(ids).size,100);
});

test("project creation preserves the supplied paper scope before any conversation inherits it",()=>{
 const {db,workspace:w}=setup();
 const input={title:"Scoped research",paperIds:["paper-a","paper-a","paper-b"]};
 const p=w.once("scoped-create","project:create",input,()=>w.createProject(input));
 assert.deepEqual(p.paperIds,["paper-a","paper-b"]);
 assert.deepEqual(new Workspace(w.db).getProject(p.id).paperIds,p.paperIds);
 assert.deepEqual(w.once<typeof p>("scoped-create","project:create",input,()=>{throw Error("unexpected retry");}).paperIds,p.paperIds);
 const count=db.prepare("SELECT COUNT(*) AS n FROM pra_projects").get()!.n;
 for(const paperIds of [null,"paper-a",[""],["x".repeat(257)],Array(201).fill("a")]){
  assert.throws(()=>w.createProject({title:"Invalid",paperIds}),/INVALID_PAPERS/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pra_projects").get()!.n,count);
 }
 db.close();
});
