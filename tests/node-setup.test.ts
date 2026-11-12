import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,readdir,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve,relative} from "node:path";
import {createServer} from "node:http";
import {installationConfig,persistInstallation,verifyDevice} from "../local/setup.ts";
const example=()=>({endpoint:"https://research.example",dataDir:resolve(".local/setup-data"),port:48731,python:{executable:resolve("python.exe"),models:resolve("models"),device:"cpu",bootstrap:true,indexVersion:"library-empty-v1"},libraryRoot:resolve(".local/setup-library")});
test("installation requires explicit real resources, safe endpoint and a supported configuration",()=>{
 const raw=example(),value=installationConfig(raw);assert.equal(value.configurationVersion,1);assert.equal(value.libraryPython,raw.python.executable);
 for(const endpoint of ["http://research.example","https://user:password@research.example","https://research.example/?token=value","https://research.example/path","https://research.example/#secret"])
  assert.throws(()=>installationConfig({...raw,endpoint}),/INVALID_ENDPOINT/);
 for(const change of [{apiKey:"synthetic"},{configurationVersion:2},{fixture:true},{port:0},{python:{...raw.python,corpus:resolve("existing")}}])
  assert.throws(()=>installationConfig({...raw,...change}));
 assert.throws(()=>installationConfig({...raw,python:{...raw.python,bootstrap:false,indexVersion:"existing"}}),/ABSOLUTE_LOCAL_PATH_REQUIRED/);
});
test("failed installation cleans only its own new files and successful configuration never contains credentials",async()=>{
 const base=resolve(tmpdir()),directory=await mkdtemp(join(base,"pra-setup-"));
 try{
  const file=join(directory,"node.json"),config=installationConfig(example()),token=crypto.randomUUID()+crypto.randomUUID();
  await assert.rejects(persistInstallation(config,file,token,{},()=>{throw Error("PROTECTION_FAILED");}),/PROTECTION_FAILED/);
  assert.deepEqual(await readdir(directory),[]);
  await persistInstallation(config,file,token,{ok:true},(path,value)=>{assert.equal(value,token);});
  const saved=await readFile(file,"utf8");assert.equal(saved.includes(token),false);assert.equal(JSON.parse(saved).secretFile,file+".device.secret");
  await assert.rejects(persistInstallation(config,file,"different",{},()=>{}),/NODE_ALREADY_CONFIGURED/);
  assert.equal(await readFile(file,"utf8"),saved);
  const second=join(directory,"second.json");await writeFile(second+".device.secret","prior-protected");
  await assert.rejects(persistInstallation(config,second,token,{},()=>{}),/INSTALLATION_FILE_EXISTS/);
  assert.equal(await readFile(second+".device.secret","utf8"),"prior-protected");
 }finally{assert.ok(!relative(base,directory).startsWith(".."));await rm(directory,{recursive:true,force:true});}
});
test("device verification is read-only, rejects redirects and never puts a credential in a URL",async()=>{
 const token=crypto.randomUUID()+crypto.randomUUID();let calls=0;
 const server=createServer((req,res)=>{
  calls++;assert.equal(req.url,"/api/device/verify");assert.equal(req.method,"GET");
  if(req.headers.authorization!=="Bearer "+token){res.writeHead(401,{"Content-Type":"application/json"}).end("{}");return;}
  res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({protocol:1,accountScope:"a".repeat(64)}));
 });
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
 const config={endpoint:"http://127.0.0.1:"+(server.address() as {port:number}).port};
 try{
  assert.deepEqual(await verifyDevice(config,token),{protocol:1,accountScope:"a".repeat(64)});
  await assert.rejects(verifyDevice(config,"wrong".repeat(10)),/DEVICE_CREDENTIAL_REJECTED/);
  const before=calls;await assert.rejects(verifyDevice(config,"\n"+token),/INVALID_DEVICE_CREDENTIAL/);assert.equal(calls,before);
  server.removeAllListeners("request");server.on("request",(_req,res)=>res.writeHead(302,{Location:"https://another.example"}).end());
  await assert.rejects(verifyDevice(config,token),/DEVICE_VERIFICATION_FAILED/);
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
