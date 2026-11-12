import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile, access, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer } from "ws";
import { stopNode } from "../local/stop-node.ts";
import { controlDirectory } from "../local/lifecycle.ts";

const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function freePort() {
  const server=createServer();await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  const port=(server.address() as {port:number}).port;
  await new Promise<void>(r=>server.close(()=>r()));return port;
}
test("authenticated stopping targets one real node, preserves its outbox and remains idempotent", {timeout:30000}, async()=>{
  const directory=await mkdtemp(join(tmpdir(),"pra-stop-"));
  const server=createServer();const ws=new WebSocketServer({server});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  const cloudPort=(server.address() as {port:number}).port;
  const token=randomUUID()+randomUUID(),previous=process.env.PRA_LOCAL_TOKEN;
  const children:ChildProcess[]=[];
  const nodes:{config:string;data:string;port:number;child:ChildProcess}[]=[];
  try {
    for(let i=0;i<2;i++){
      const data=join(directory,String(i)),config=join(directory,"node-"+i+".json"),port=await freePort();
      await writeFile(config,JSON.stringify({endpoint:"http://127.0.0.1:"+cloudPort,fixture:true,dataDir:data,port}));
      const child=spawn(process.execPath,["local/node.ts",config],{cwd:resolve("."),windowsHide:true,stdio:"ignore",
        env:{...process.env,PRA_DEVICE_TOKEN:randomUUID()+randomUUID(),PRA_LOCAL_TOKEN:token}});
      children.push(child);nodes.push({config,data,port,child});
      const until=Date.now()+10000;let ready=false;
      while(Date.now()<until){
        ready=await fetch("http://127.0.0.1:"+port+"/local/status",{headers:{Authorization:"Bearer "+token}})
          .then(r=>r.status===200).catch(()=>false);
        if(ready)break;
        if(child.exitCode!==null)throw Error("NODE_START_FAILED");
        await delay(50);
      }
      assert.equal(ready,true);
    }
    const [a,b]=nodes;
    process.env.PRA_LOCAL_TOKEN="wrong-credential-".repeat(4);
    await assert.rejects(stopNode(a.config),/LOCAL_AUTH_REQUIRED/);
    await assert.rejects(access(join(controlDirectory(a.config,a.data),"stop")));
    assert.equal(a.child.exitCode,null);
    process.env.PRA_LOCAL_TOKEN=token;
    const mismatch=join(directory,"mismatch.json");
    await writeFile(mismatch,await readFile(a.config,"utf8"));
    await assert.rejects(stopNode(mismatch),/LOCAL_CONFIGURATION_MISMATCH/);
    const database=new DatabaseSync(join(a.data,"node.sqlite"));
    database.prepare("INSERT INTO outbox(id,frame) VALUES (?,?)").run("pending-result","saved-result");database.close();
    assert.deepEqual(await stopNode(a.config),{stopped:true});
    assert.deepEqual(await stopNode(a.config),{stopped:true});
    const state=await fetch("http://127.0.0.1:"+b.port+"/local/status",{headers:{Authorization:"Bearer "+token}});
    assert.equal(state.status,200);assert.equal(b.child.exitCode,null);
    await access(join(controlDirectory(a.config,a.data),"stop"));
    await assert.rejects(access(join(controlDirectory(b.config,b.data),"stop")));
    const persisted=new DatabaseSync(join(a.data,"node.sqlite"),{readOnly:true});
    assert.equal(persisted.prepare("SELECT frame FROM outbox WHERE id=?").get("pending-result")?.frame,"saved-result");
    persisted.close();
    await stopNode(b.config);
  } finally {
    if(previous===undefined)delete process.env.PRA_LOCAL_TOKEN;else process.env.PRA_LOCAL_TOKEN=previous;
    for(const child of children)if(child.exitCode===null)child.kill();
    for(const socket of ws.clients)socket.terminate();
    await new Promise<void>(r=>ws.close(()=>r()));await new Promise<void>(r=>server.close(()=>r()));
    await delay(200);await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
