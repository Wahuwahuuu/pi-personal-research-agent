import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,relative,resolve} from "node:path";
import {prepareRuntime,runtimeEnvironment,type RuntimeCommand,type RuntimeRunner} from "../local/runtime-install.ts";
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),"pra-runtime-"));
 await mkdir(join(directory,"packages/retrieval"),{recursive:true});await mkdir(join(directory,"local"));
 await mkdir(join(directory,"models"));
 await writeFile(join(directory,"packages/retrieval/pyproject.toml"),"definition");
 await writeFile(join(directory,"packages/retrieval/uv.lock"),"lock");
 await writeFile(join(directory,"local/check-runtime.py"),"resource check");
 return directory;
}
async function remove(directory:string){
 assert.ok(relative(resolve(tmpdir()),resolve(directory)).startsWith("pra-runtime-"));await rm(directory,{recursive:true,force:true});
}
async function manifests(root:string){
 const base=join(root,".local/runtimes"),names=await readdir(base);
 return Promise.all(names.map(async name=>JSON.parse(await readFile(join(base,name,"status.json"),"utf8"))));
}
function runner(commands:RuntimeCommand[]):RuntimeRunner{return async command=>{
 commands.push(command);
 if(command.args[0]==="--version")return "uv 0.10.12 (fixture)";
 if(command.args[0]==="sync"){
  const scripts=join(command.env.UV_PROJECT_ENVIRONMENT!,"Scripts");await mkdir(scripts,{recursive:true});
  await writeFile(join(scripts,"python.exe"),"");await writeFile(join(scripts,"pythonw.exe"),"");return "";
 }
 return JSON.stringify({ok:true,python:"3.12.13",inventorySha256:"a".repeat(64),cudaAvailable:true,versions:{},models:[]});
};}
test("runtime installation uses a locked isolated environment, verifies resources and leaves existing configuration intact",async()=>{
 const root=await fixture(),commands:RuntimeCommand[]=[];
 try{
  await mkdir(join(root,".local"),{recursive:true});await writeFile(join(root,".local/node.json"),"existing-config");
  const result=await prepareRuntime({models:join(root,"models"),device:"cuda"},{projectRoot:root,platform:"win32",run:runner(commands)});
  assert.equal(result.activated,false);assert.equal((await manifests(root))[0].status,"ready");
  assert.equal(await readFile(join(root,".local/node.json"),"utf8"),"existing-config");
  const install=commands[1];assert.ok(install.args.includes("--locked"));assert.ok(install.args.includes("--no-install-project"));
  assert.equal(install.env.UV_LINK_MODE,"copy");assert.notEqual(install.cwd,install.env.UV_PROJECT_ENVIRONMENT);
  assert.ok(result.python.startsWith(install.env.UV_PROJECT_ENVIRONMENT!));
  assert.equal(commands[2].env.HF_HUB_OFFLINE,"1");assert.deepEqual(JSON.parse(commands[2].input!),{models:join(root,"models"),device:"cuda"});
  assert.equal(await readFile(join(install.args[2],"uv.lock"),"utf8"),"lock");
 }finally{await remove(root);}
});
test("dependency failures and changed definitions never publish a ready environment or leak raw subprocess output",async()=>{
 for(const failure of ["install","changed","bad-check"]){
  const root=await fixture(),commands:RuntimeCommand[]=[],normal=runner(commands);
  try{
   const run:RuntimeRunner=async c=>{
    if(c.args[0]==="sync"&&failure==="install")throw Error("private-install-log-with-credential");
    const output=await normal(c);
    if(c.args[0]==="sync"&&failure==="changed")await writeFile(join(root,"packages/retrieval/uv.lock"),"changed");
    if(c.args[0]!=="sync"&&c.args[0]!=="--version"&&failure==="bad-check")return '{"ok":false}';
    return output;
   };
   await assert.rejects(prepareRuntime({models:join(root,"models"),device:"cpu"},{projectRoot:root,platform:"win32",run}),/RUNTIME_(INSTALL_FAILED|SOURCE_CHANGED|CHECK_FAILED)/);
   const rows=await manifests(root);assert.equal(rows.length,1);assert.equal(rows[0].status,"failed");assert.ok(!JSON.stringify(rows).includes("private-install-log"));
  }finally{await remove(root);}
 }
});
test("runtime installation rejects unsupported tools, paths, device and private-directory junction escape",async()=>{
 const root=await fixture(),outside=await fixture(),run=runner([]);
 try{
  const base={models:join(root,"models"),device:"cpu" as const},controls={projectRoot:root,platform:"win32",run};
  await assert.rejects(prepareRuntime({...base,models:"relative"},controls),/MODEL_DIRECTORY_REQUIRED/);
  await assert.rejects(prepareRuntime({...base,device:"other" as any},controls),/RETRIEVAL_DEVICE_REQUIRED/);
  await assert.rejects(prepareRuntime(base,{...controls,platform:"linux"}),/WINDOWS_REQUIRED/);
  await assert.rejects(prepareRuntime(base,{...controls,run:async()=>"uv 9.9.9"}),/UV_VERSION_UNSUPPORTED/);
  await symlink(outside,join(root,".local"),process.platform==="win32"?"junction":"dir");
  await assert.rejects(prepareRuntime(base,controls),/RUNTIME_DIRECTORY_ESCAPE/);
  assert.ok(!(await readdir(outside)).includes("runtimes"));
 }finally{await remove(root);await remove(outside);}
});
test("runtime subprocesses receive only selected OS fields and an explicit credential-free proxy",()=>{
 const key="PIPAPER_API_KEY",previous=process.env[key];process.env[key]="SYNTHETIC_SECRET";
 try{
  assert.equal(runtimeEnvironment()[key],undefined);assert.equal(runtimeEnvironment().HTTPS_PROXY,undefined);
  assert.equal(runtimeEnvironment("http://127.0.0.1:7890").HTTPS_PROXY,"http://127.0.0.1:7890");
  for(const proxy of ["http://u:p@localhost:7890","http://localhost/?token=x","file:///tmp","socks5://localhost:7890"])
   assert.throws(()=>runtimeEnvironment(proxy),/INVALID_PROXY/);
 }finally{if(previous===undefined)delete process.env[key];else process.env[key]=previous;}
});
