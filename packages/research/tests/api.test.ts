import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {fauxAssistantMessage as reply} from "@earendil-works/pi-ai";
import * as publicApi from "../index.ts";
import {makeResearchModule,type ResearchOptions} from "../internal/module.ts";
import {PaperWebSession} from "../internal/agent/web-session.ts";
import {sha} from "../internal/agent/config.ts";
import {mainFixture,preparation,SOURCE_IDS} from "./agent/main-fixture.ts";

test("public facade preserves multiple turns, source identity and reopen; blocks invalid paths",async()=>{
 const root=await mkdtemp(join(tmpdir(),"research-api-")),seed=await mainFixture([]);
 const config=JSON.parse(await readFile("configs/model.example.json","utf8"));
 config.model.base_url="https://example.invalid/v1";config.model.model_id="fixture";config.session.compaction="off";
 const opts:ResearchOptions={storageRoot:root,config,credential:async()=>"synthetic-credential",
 catalog:{indexVersion:"prepared-fixture",papers:[{paper_id:"p1",title:"Paper One",abstract:"catalog"}],sources:seed.chunks,
 evidence:seed.chunks.map(c=>({...c,text_sha256:sha(c.text),index_version:"prepared-fixture"})),implementationId:"8".repeat(64)},
 transport:{async request(){return {backend:"rrf_rerank",index_version:"prepared-fixture",chunks:[seed.chunks[0]]};}}};
 const research=await makeResearchModule(opts,async params=>PaperWebSession.open({...params,createHarness:async p=>{
 const {modelRuntime,model,...rest}=p;
 return (await mainFixture(Array.from({length:2},()=>[reply(JSON.stringify(preparation)),reply(JSON.stringify({execution:{state:"complete",remaining_needs:[],needs_sources:true},answer:`说明。[cite:${SOURCE_IDS[0]}]`}))]).flat(),[[0]],rest)).harness;
 }}));
 try{
 assert.deepEqual(Object.keys(publicApi),["createResearchModule"]);
 await assert.rejects(research.openSession("../outside"),/INVALID_SESSION_ID/);
 const id=randomUUID(),[a,b]=await Promise.all([research.openSession(id),research.openSession(id)]);
 assert.equal(a,b);
 await a.configure(["p1"]);
 await a.ask("解释方法");
 const state=await a.ask("继续解释");
 assert.equal(state.turns.length,2);assert.equal(state.turns[1].status,"completed");
 assert.equal(state.turns[0].sources[0].chunk_id,SOURCE_IDS[0]);
 await assert.rejects(a.configure(["unknown"]),/Unknown paper/);
 await assert.rejects(research.translate(id,state.turns[0].turn_id!,["forged"]),/SOURCE_NOT_DELIVERED/);
 await a.close();
 await assert.rejects(a.state(),/SESSION_CLOSED/);
 const reopened=await research.openSession(id);
 assert.deepEqual((await reopened.state()).turns,state.turns);
 assert.equal(reopened.cancel(randomUUID()),false);
 await research.close();
 await assert.rejects(research.openSession(),/MODULE_CLOSED/);
 }finally{await research.close();seed.harness.dispose();await rm(root,{recursive:true,force:true});}
});
