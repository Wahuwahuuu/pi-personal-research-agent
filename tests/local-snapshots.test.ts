import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,readFile,writeFile,rm} from "node:fs/promises";
import {join,relative} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {SnapshotManager} from "../local/snapshots.ts";
const sha=(v:string|Buffer)=>createHash("sha256").update(v).digest("hex");
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),"pra-snapshots-")),root=join(dir,"library");
 await mkdir(root);
 async function index(base:string,version:string,body:string){
  const corpus=join(base,"corpus"),artifacts=join(base,"index");await mkdir(corpus,{recursive:true});await mkdir(artifacts,{recursive:true});await mkdir(join(base,"manifests"),{recursive:true});
  const papers=JSON.stringify({paper_id:"local-paper",title:"Fixture paper",abstract:"",full_text:[{section_name:"Page 1",paragraphs:[body]}]})+"\n";
  const parent=JSON.stringify({paper_count:1,papers:[{paper_id:"local-paper"}],files:{"papers.jsonl":sha(papers)},index_version:"fixture-source"});
  await writeFile(join(corpus,"papers.jsonl"),papers);await writeFile(join(base,"manifests/corpus.json"),parent);
  const chunk={paper_id:"local-paper",paragraph_id:"local-paper:s0:p0",chunk_id:version+":local-paper:s0:p0:c0-"+Array.from(body).length,section:"Page 1",start:0,end:Array.from(body).length,text:body,index_version:version,text_sha256:sha(body),truncated:false};
  const chunks=JSON.stringify(chunk)+"\n",map=JSON.stringify({...chunk,paragraph_sha256:sha(body)})+"\n";
  await writeFile(join(artifacts,"chunks.jsonl"),chunks);await writeFile(join(artifacts,"source-map.jsonl"),map);
  const manifest=JSON.stringify({gold_loaded:false,model_api_calls:0,index_version:version,paper_count:1,chunk_count:1,identity:{parent:{papers_sha256:sha(papers),corpus_manifest_sha256:sha(parent)},recipe:{device:"cpu"}},files:{"chunks.jsonl":sha(chunks),"source-map.jsonl":sha(map)}});
  await writeFile(join(artifacts,"index-manifest.json"),manifest);
  return{corpus,index:artifacts,manifest_sha:sha(manifest)};
 }
 const base=await index(join(dir,"base"),"original","原有证据。");
 const next=await index(join(root,"versions/new"),"new","新增证据。");
 const descriptor={version:"new",index:relative(root,next.index),corpus:relative(root,next.corpus),manifest_sha:next.manifest_sha,job_id:"test-job"};
 const db=new DatabaseSync(join(root,"library.sqlite"));
 db.exec("CREATE TABLE versions(version TEXT PRIMARY KEY,descriptor TEXT); CREATE TABLE papers(id TEXT PRIMARY KEY,sha TEXT);");
 db.prepare("INSERT INTO versions VALUES(?,?)").run("new",JSON.stringify(descriptor));
 await writeFile(join(root,"active.json"),JSON.stringify(descriptor));
 const manager=new SnapshotManager({executable:process.execPath,corpus:base.corpus,index:base.index,indexVersion:"original",device:"cpu"},join(dir,"node"),root);
 return{dir,root,db,manager,descriptor,cleanup:async()=>{manager.stop();db.close();await rm(dir,{recursive:true,force:true});}};
}
test("a newly published catalog preserves the original snapshot and exact Unicode evidence identities",async()=>{
 const f=await fixture();try{
  assert.equal(await f.manager.refresh(),true);assert.equal(f.manager.activeVersion,"new");
  assert.deepEqual(f.manager.retained().sort(),["new","original"]);
  const prior=await f.manager.runtime("original"),next=await f.manager.runtime("new");
  assert.notEqual(prior.catalog.evidence[0].chunk_id,next.catalog.evidence[0].chunk_id);
  assert.equal(next.catalog.evidence[0].end,5);
  assert.ok(!JSON.stringify(next.catalog).includes("新增证据"));
  assert.equal(await f.manager.refresh(),false);
 }finally{await f.cleanup();}
});
test("an escaped publication path is rejected without replacing the usable active version",async()=>{
 const f=await fixture();try{
  const corrupt={...f.descriptor,index:"../base/index"};
  f.db.prepare("UPDATE versions SET descriptor=?").run(JSON.stringify(corrupt));
  await writeFile(join(f.root,"active.json"),JSON.stringify(corrupt));
  await assert.rejects(f.manager.refresh(),/UNSAFE_INDEX_PATH/);
  assert.equal(f.manager.activeVersion,"original");
 }finally{await f.cleanup();}
});
test("unregistered or modified index manifests cannot be activated",async()=>{
 const f=await fixture();try{
  await writeFile(join(f.root,f.descriptor.index,"index-manifest.json"),"{}");
  await assert.rejects(f.manager.refresh(),/INDEX_MANIFEST_CHANGED/);
  f.db.prepare("DELETE FROM versions").run();
  await assert.rejects(f.manager.refresh(),/UNREGISTERED_INDEX/);
 }finally{await f.cleanup();}
});
test("private full text is resolved only for a registered paper and verified by content hash",async()=>{
 const f=await fixture();try{
  const bytes=Buffer.from("%PDF-synthetic-local-object"),hash=sha(bytes);
  await mkdir(join(f.root,"objects"));await writeFile(join(f.root,"objects",hash+".pdf"),bytes);
  f.db.prepare("INSERT INTO papers VALUES(?,?)").run("local-paper",hash);
  await f.manager.refresh();
  assert.deepEqual(await f.manager.pdf("new","local-paper"),bytes);
  await assert.rejects(f.manager.pdf("new","../other"),/UNKNOWN_PAPER/);
  await writeFile(join(f.root,"objects",hash+".pdf"),"%PDF-forged");
  await assert.rejects(f.manager.pdf("new","local-paper"),/LIBRARY_OBJECT_CHANGED/);
 }finally{await f.cleanup();}
});

test("an explicit first-run library answers empty searches without spawning a Python model",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"pra-empty-")),root=join(dir,"empty-library");
 const manager=new SnapshotManager({executable:join(dir,"not-installed-python.exe"),models:join(dir,"models"),bootstrap:true,indexVersion:"library-empty-v1"},join(dir,"node"),root);
 try{
  assert.equal(await manager.refresh(),false);
  const runtime=await manager.ready();assert.equal(runtime.bridge,undefined);assert.deepEqual(runtime.catalog.papers,[]);
  const value=await manager.execute("library-empty-v1","search_papers",{query:"first research",limit:3},AbortSignal.timeout(1000));
  assert.deepEqual((value.result as any).papers,[]);
  await assert.rejects(manager.pdf("library-empty-v1","unknown"),/UNKNOWN_PAPER/);
 }finally{manager.stop();await rm(dir,{recursive:true,force:true});}
});
test("empty library switches only after a verified publication and retains the original empty snapshot",async()=>{
 const f=await fixture();
 const manager=new SnapshotManager({executable:process.execPath,bootstrap:true,indexVersion:"library-empty-v1",device:"cpu"},join(f.dir,"fresh-node"),f.root);
 try{
  assert.equal((await manager.runtime("library-empty-v1")).bridge,undefined);
  await manager.refresh();assert.equal(manager.activeVersion,"new");
  assert.equal((await manager.runtime("new")).catalog.papers.length,1);
  assert.deepEqual((await manager.runtime("library-empty-v1")).catalog.papers,[]);
  assert.deepEqual(manager.retained().sort(),["library-empty-v1","new"]);
 }finally{manager.stop();await f.cleanup();}
});
test("missing legacy configuration never silently falls back to empty, and conflicting bootstrap is rejected",async()=>{
 const f=await fixture();try{
  const missing=new SnapshotManager({executable:process.execPath,indexVersion:"old"},join(f.dir,"missing"));
  await assert.rejects(missing.runtime("old"),/VERIFIED_INDEX_REQUIRED/);
  const conflict=new SnapshotManager({...f.manager.base,bootstrap:true},join(f.dir,"conflict"));
  await assert.rejects(conflict.runtime("original"),/INVALID_EMPTY_LIBRARY_CONFIG/);
 }finally{await f.cleanup();}
});
