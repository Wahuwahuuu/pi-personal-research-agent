import test from "node:test";import assert from "node:assert/strict";
import {mkdtemp,mkdir,readFile,writeFile,rm} from "node:fs/promises";import {join,resolve,relative} from "node:path";import {tmpdir} from "node:os";import {spawn,type ChildProcess} from "node:child_process";import {createServer} from "node:net";import {createHash,randomUUID} from "node:crypto";import {WebSocketServer,type WebSocket} from "ws";
const hash=(v:string)=>createHash("sha256").update(v).digest("hex");
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until<T>(fn:()=>Promise<T|false>,ms=8000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value!==false)return value;await delay(25);}throw Error("TEST_WAIT_TIMEOUT");}
test("cancelled retrieval reports loading until a replacement worker is ready and the next operation succeeds",{timeout:30000},async()=>{
 const root=await mkdtemp(join(tmpdir(),"pra-cancel-ready-")),corpus=join(root,"corpus"),index=join(root,"index"),worker=join(root,"worker.mjs"),count=join(root,"starts.json"),active=join(root,"active.json");
 await mkdir(corpus);await mkdir(index);await mkdir(join(root,"manifests"));
 const paper={paper_id:"local-paper",title:"Synthetic paper",abstract:"",full_text:[{section_name:"Page 1",paragraphs:["Evidence."]}]},papers=JSON.stringify(paper)+"\n";
 const parent=JSON.stringify({paper_count:1,papers:[{paper_id:paper.paper_id}],files:{"papers.jsonl":hash(papers)},index_version:"fixture-source"});
 await writeFile(join(corpus,"papers.jsonl"),papers);await writeFile(join(root,"manifests/corpus.json"),parent);
 const chunk={paper_id:paper.paper_id,paragraph_id:"local-paper:s0:p0",chunk_id:"v1:local-paper:s0:p0:c0-9",citation:"[v1:local-paper:s0:p0:c0-9]",section:"Page 1",start:0,end:9,text:"Evidence.",index_version:"v1",text_sha256:hash("Evidence."),truncated:false},chunks=JSON.stringify(chunk)+"\n",map=JSON.stringify({...chunk,paragraph_sha256:hash("Evidence.")})+"\n";
 await writeFile(join(index,"chunks.jsonl"),chunks);await writeFile(join(index,"source-map.jsonl"),map);await writeFile(join(index,"index-manifest.json"),JSON.stringify({gold_loaded:false,model_api_calls:0,index_version:"v1",paper_count:1,chunk_count:1,identity:{parent:{papers_sha256:hash(papers),corpus_manifest_sha256:hash(parent)},recipe:{device:"cpu"}},files:{"chunks.jsonl":hash(chunks),"source-map.jsonl":hash(map)}}));
 await writeFile(worker,[
  'import {readFileSync,writeFileSync} from "node:fs";',
  'const count='+JSON.stringify(count)+',active='+JSON.stringify(active)+';let starts=0;try{starts=JSON.parse(readFileSync(count,"utf8")).starts;}catch{}starts++;writeFileSync(count,JSON.stringify({starts,pid:process.pid}));',
  'setTimeout(()=>{process.stdout.write(JSON.stringify({version:1,type:"ready",backend:"fixture",index_version:"v1"})+"\\n");let buffer="";process.stdin.setEncoding("utf8");process.stdin.on("data",part=>{buffer+=part;let at;while((at=buffer.indexOf("\\n"))>=0){const q=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);writeFileSync(active,JSON.stringify({id:q.request_id,starts}));if(starts===1)continue;process.stdout.write(JSON.stringify({version:1,request_id:q.request_id,result:{backend:"fixture",index_version:"v1",chunks:['+JSON.stringify(chunk)+']}})+"\\n");}});},starts===1?0:1500);'
 ].join("\n"));
 const portServer=createServer();await new Promise<void>(r=>portServer.listen(0,"127.0.0.1",r));const port=(portServer.address() as any).port;await new Promise<void>(r=>portServer.close(()=>r()));
 const cloud=new WebSocketServer({host:"127.0.0.1",port:0});await new Promise<void>(r=>cloud.once("listening",r));const endpoint="http://127.0.0.1:"+(cloud.address() as any).port;
 const credential=randomUUID()+randomUUID(),control=randomUUID()+randomUUID(),frames:any[]=[];let socket:WebSocket|undefined,node:ChildProcess|undefined;
 cloud.on("connection",ws=>{socket=ws;ws.on("message",raw=>{if(raw.toString()==="ping"){ws.send("pong");return;}const m=JSON.parse(raw.toString());frames.push(m);if(m.type==="hello")ws.send(JSON.stringify({type:"hello_ack",accountScope:"a".repeat(64)}));if(m.type==="catalog_end")ws.send(JSON.stringify({type:"catalog_ack"}));if(["result","operation_error"].includes(m.type))ws.send(JSON.stringify({type:"ack",operationId:m.operationId}));});});
 const config=join(root,"node.json");await writeFile(config,JSON.stringify({endpoint,dataDir:join(root,"data"),port,python:{executable:process.execPath,worker,corpus,index,models:root,device:"cpu",indexVersion:"v1"}}));
 const status=async()=>{const r=await fetch("http://127.0.0.1:"+port+"/local/status",{headers:{Authorization:"Bearer "+control}});return r.json() as Promise<any>;};
 const operation=(id:string)=>({type:"operation",operation:{id,taskId:"task-"+id,tool:"retrieve_chunks",params:{query:"evidence",paper_ids:[paper.paper_id],top_k:1},indexVersion:"v1",state:"sent",deadline:Date.now()+20000}});
 try{
  node=spawn(process.execPath,[resolve("local/node.ts"),config],{cwd:resolve("."),windowsHide:true,stdio:"ignore",env:{...process.env,HTTPS_PROXY:"",HTTP_PROXY:"",PRA_DEVICE_TOKEN:credential,PRA_LOCAL_TOKEN:control}});
  await until(async()=>frames.some(m=>m.type==="ready")?true:false);socket!.send(JSON.stringify(operation("first")));
  await until(async()=>{try{return JSON.parse(await readFile(active,"utf8")).starts===1?true:false;}catch{return false;}});socket!.send(JSON.stringify({type:"cancel",operationId:"first"}));
  await until(async()=>frames.some(m=>m.type==="operation_error"&&m.operationId==="first"&&m.code==="CANCELLED")?true:false);
  await until(async()=>frames.some(m=>m.type==="availability"&&m.phase==="loading"&&m.ready===false)?true:false,2000);
  const loading=await status();assert.equal(loading.ready,false);assert.equal(loading.phase,"loading");
  await until(async()=>frames.filter(m=>m.type==="ready").length===2?true:false);assert.equal((await status()).ready,true);assert.equal(JSON.parse(await readFile(count,"utf8")).starts,2);
  socket!.send(JSON.stringify(operation("second")));const result=await until(async()=>frames.find(m=>m.type==="result"&&m.operationId==="second")??false);assert.equal(result.result.chunks[0].text,"Evidence.");assert.equal(frames.filter(m=>m.type==="result"&&m.operationId==="first").length,0);
 }finally{
  if(node?.pid&&node.exitCode===null){const child=node,closed=new Promise<void>(r=>child.once("exit",()=>r()));if(process.platform==="win32"){const kill=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});await new Promise(r=>kill.once("exit",r));}else child.kill();await closed;}
  for(const ws of cloud.clients)ws.terminate();await new Promise<void>(r=>cloud.close(()=>r()));assert.ok(!relative(tmpdir(),root).startsWith(".."));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
});
