import {test} from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,dirname,resolve,sep} from "node:path";
import {prepareApplicationRelease,verifyApplicationRelease} from "../local/application-release.ts";
import {APPLICATION_CONTRACT} from "../local/application-contract.ts";

async function fixture(t:any){
 const root=await mkdtemp(join(tmpdir(),"pra-app-release-"));
 t.after(async()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep+"pra-app-release-"));await rm(root,{recursive:true,force:true,maxRetries:4,retryDelay:100});});
 const files:Record<string,string>={
  ".gitignore":".local/\n",
  "package.json":'{"type":"module","dependencies":{"example":"1.0.0"}}',"package-lock.json":'{"lockfileVersion":3}',
  "local/node.ts":"export {};","local/application-contract.ts":"export const contract="+JSON.stringify(APPLICATION_CONTRACT),
  "local/desktop/main.py":"pass","local/check-runtime.py":"pass",
  "packages/research/package.json":'{"type":"module"}',"packages/research/package-lock.json":'{"lockfileVersion":3}',
  "src/domain.ts":"export {};","packages/research/core.ts":"export {};","local/catalog.ts":"export {};",
  "packages/retrieval/uv.lock":"version = 1","packages/retrieval/pyproject.toml":"[project]",
  "local/test_sample.py":"assert True","tests/test.ts":"private test fixture",
  "docs/specs/development.md":"not a product input","scripts/read-secret.ps1":"# DPAPI reader"
 };
 for(const [path,content] of Object.entries(files)){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),content);}
 const git=(args:string[])=>execFileSync("git",["-C",root,...args],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
 git(["init","-q"]);git(["add","--",...Object.keys(files)]);
 git(["-c","user.name=Fixture","-c","user.email=fixture@users.noreply.github.com","commit","-qm","fixture"]);
 await mkdir(join(root,".local"));await writeFile(join(root,".local/private.secret"),"not-for-release");
 const calls:any[]=[];
 const controls={projectRoot:root,npmCli:"synthetic-npm-cli.js",run:async(command:any)=>{
  calls.push(command);
  if(command.args.includes("ci")){
   await mkdir(join(command.cwd,"node_modules/example"),{recursive:true});
   await writeFile(join(command.cwd,"node_modules/example/index.js"),"export {};");
  }
  return "";
 }};
 return{root,git,calls,controls};
}
test("application preparation freezes committed product files and installed dependency bytes, excluding local/private materials",async t=>{
 const f=await fixture(t),release=await prepareApplicationRelease(f.controls);
 assert.equal(release.manifest.build,f.git(["rev-parse","HEAD"]).toString().trim());
 assert.ok(release.manifest.files.some(v=>v.path==="node_modules/example/index.js"));
 assert.ok(!release.manifest.files.some(v=>/private|docs\/|tests\/|test_sample/.test(v.path)));
 assert.ok(f.calls[0].args.includes("--ignore-scripts"));assert.ok(f.calls[0].args.includes("--omit=dev"));
 assert.equal(f.calls[0].env.PIPAPER_API_KEY,undefined);
 assert.equal(f.calls[1].cwd,join(release.directory,"packages/research"));
 assert.equal(f.calls[2].args[0],"--input-type=module");
 assert.equal((await verifyApplicationRelease(f.root,release.directory)).digest,release.digest);
});
test("changed or additional source and dependency files invalidate a previously ready release",async t=>{
 for(const kind of ["source","dependency","extra","missing","contract"]){
  const f=await fixture(t),r=await prepareApplicationRelease(f.controls);
  if(kind==="source")await writeFile(join(r.directory,"local/node.ts"),"changed");
  if(kind==="dependency")await writeFile(join(r.directory,"node_modules/example/index.js"),"changed");
  if(kind==="extra")await writeFile(join(r.directory,"local/unreviewed.ts"),"extra");
  if(kind==="missing")await rm(join(r.directory,"local/node.ts"));
  if(kind==="contract"){const m={...r.manifest,contract:{...APPLICATION_CONTRACT,family:"unknown"}};await writeFile(join(r.directory,"release.json"),JSON.stringify(m));}
  await assert.rejects(verifyApplicationRelease(f.root,r.directory),kind==="contract"?/INCOMPATIBLE/:/CHANGED/);
 }
});
test("dirty source, failed dependency installation, or changes during installation cannot become ready releases",async t=>{
 for(const kind of ["dirty","install","concurrent"]){
  const f=await fixture(t);
  if(kind==="dirty")await writeFile(join(f.root,"src/domain.ts"),"dirty");
  const run=f.controls.run;
  f.controls.run=async c=>{
   if(kind==="install")throw Error("untrusted install output");
   if(kind==="concurrent")await writeFile(join(f.root,"src/domain.ts"),"changed during preparation");
   return run(c);
  };
  await assert.rejects(prepareApplicationRelease(f.controls),kind==="dirty"?/COMMITTED_BUILD/:/PREPARATION_FAILED/);
  const parent=join(f.root,".local/node-releases");
  for(const name of await readdir(parent).catch(()=>[]))await assert.rejects(readFile(join(parent,name,"release.json")),/ENOENT/);
 }
});
test("unknown or outside release directories and changed manifest rows are refused",async t=>{
 const f=await fixture(t),r=await prepareApplicationRelease(f.controls);
 await assert.rejects(verifyApplicationRelease(f.root,f.root),/PATH_ESCAPE/);
 const raw={...r.manifest,files:[{path:"../escape",bytes:1,sha256:"a".repeat(64)}]};
 await writeFile(join(r.directory,"release.json"),JSON.stringify(raw));
 await assert.rejects(verifyApplicationRelease(f.root,r.directory),/INVALID/);
});
