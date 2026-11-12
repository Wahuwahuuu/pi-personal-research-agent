import {test} from "node:test";
import assert from "node:assert/strict";
import {Harness,createRegistry} from "@earendil-works/pi-durable";
import {openNodeSqliteStorage} from "@earendil-works/pi-durable/storage/sqlite/node";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {BACKGROUND_CONTEXT as context} from "@earendil-works/chord/context";
import {mockModels,MODEL} from "../src/model.ts";
import {managedRuntimeSettings} from "../src/runtime-settings.ts";

test("managed context projections reuse a persistent Pi conversation without hidden compaction requests",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"pra-managed-context-")),file=join(directory,"pi.sqlite");
  const openStorage=()=>openNodeSqliteStorage(file,{prefix:"pi_"});
  let requests=0;
  const models=mockModels(()=>{requests++;},()=>{});
  let storage=await openStorage();
  let harness=await Harness.open(storage,{models,registry:createRegistry(),settings:managedRuntimeSettings},context);
  try{
    let conversation=await harness.root(context,{agent:{model:{provider:MODEL.provider,modelId:MODEL.id},tools:[]}});
    const id=conversation.id;
    const counts:number[]=[];
    for(let turn=0;turn<8;turn++){
      if(turn===4){
        await harness.close(context);
        storage=await openStorage();
        harness=await Harness.open(storage,{models,registry:createRegistry(),settings:managedRuntimeSettings},context);
        conversation=(await harness.conversation(id,context))!;
        assert.equal(conversation.id,id);
      }
      const before=requests;
      const projection=JSON.stringify({projection:"pra-context-v1",stage:"agent",cloud_only:true,request:"Continue the same discussion",conversation:{turn,retained:"synthetic ".repeat(4300)}});
      assert.ok(new TextEncoder().encode(projection).length<45000);
      const result=await(await conversation.submit({type:"input",content:projection},context)).wait(context);
      assert.equal(result.status,"done");
      await harness.waitForIdle(context);
      counts.push(requests-before);
    }
    const archived=await storage.scanEntries({conversationId:id},100,undefined,context);
    assert.equal(archived.items.flatMap(e=>e.model??[]).filter(m=>m.role==="user").length,8,"all submitted projections remain stored in the same conversation");
    assert.deepEqual(counts,Array(8).fill(1),"archive growth must not add model requests outside the host projection");
  }finally{await harness.close(context);}
});
