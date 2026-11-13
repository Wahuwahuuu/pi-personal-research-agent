import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {RELEASE_CONTRACT,parseReleaseContract,assertReleaseCompatible} from "../src/release-contract.ts";
import {StateRepository,type StateStorage} from "../src/state-store.ts";

test("release contract pins installed application schema and runtime dependency versions",()=>{
 const pkg=JSON.parse(readFileSync("package.json","utf8"));
 assert.equal(RELEASE_CONTRACT.runtime.agents,pkg.dependencies.agents);
 assert.equal(RELEASE_CONTRACT.runtime.piDurable,pkg.dependencies["@earendil-works/pi-durable"]);
 assert.equal(RELEASE_CONTRACT.runtime.piAi,pkg.dependencies["@earendil-works/pi-ai"]);
 const db=new DatabaseSync(":memory:");
 try{
  const storage:StateStorage={sql:{exec<T>(q:string,...b:any[]){const s=db.prepare(q),rows=s.columns().length?s.all(...b) as T[]:(s.run(...b),[]);return{toArray:()=>rows};}},transactionSync(fn){db.exec("BEGIN");try{const result=fn();db.exec("COMMIT");return result;}catch(e){db.exec("ROLLBACK");throw e;}}};
  new StateRepository(storage);
  assert.equal(db.prepare("SELECT version FROM pra_app_schema").get()!.version,RELEASE_CONTRACT.appStateSchema);
 }finally{db.close();}
});

test("a release is compatible only when its complete declared read-write contract matches",()=>{
 const reordered=Object.fromEntries(Object.entries(RELEASE_CONTRACT).reverse());
 assert.doesNotThrow(()=>assertReleaseCompatible(RELEASE_CONTRACT,reordered));
 for(const key of ["appStateSchema","piStorageSchema","nodeProtocol","nodeConfiguration"] as const){
  assert.throws(()=>assertReleaseCompatible(RELEASE_CONTRACT,{...RELEASE_CONTRACT,[key]:RELEASE_CONTRACT[key]+1}),/INCOMPATIBLE/);
 }
 assert.throws(()=>assertReleaseCompatible(RELEASE_CONTRACT,{...RELEASE_CONTRACT,family:"other-family"}),/INCOMPATIBLE/);
 assert.throws(()=>assertReleaseCompatible(RELEASE_CONTRACT,{...RELEASE_CONTRACT,runtime:{...RELEASE_CONTRACT.runtime,piDurable:"2.0.0"}}),/INCOMPATIBLE/);
});

test("missing, unknown and malformed contracts fail closed instead of inferring compatibility from schema",()=>{
 for(const raw of [undefined,null,{},[],{...RELEASE_CONTRACT,format:2},{...RELEASE_CONTRACT,extra:true},{...RELEASE_CONTRACT,family:""},
  {...RELEASE_CONTRACT,appStateSchema:2.5},{...RELEASE_CONTRACT,nodeProtocol:0},{...RELEASE_CONTRACT,runtime:{...RELEASE_CONTRACT.runtime,unknown:"1.0.0"}},
  {...RELEASE_CONTRACT,runtime:{...RELEASE_CONTRACT.runtime,piDurable:"latest"}}])
  assert.throws(()=>parseReleaseContract(raw),/UNKNOWN_RELEASE/);
});

test("effective model variables are serializable in a frozen configuration without a secret or hidden thinking option",async()=>{
 const {parseModelSettings,modelDeploymentVariables}=await import("../src/model-settings.ts");
 const settings=parseModelSettings({mode:"live",modelId:"qwen3.7-flash",baseUrl:"https://dashscope.aliyuncs.com/compatible-mode/v1",thinking:"off"});
 assert.deepEqual(modelDeploymentVariables(settings),{MODEL_MODE:"live",MODEL_ID:settings.modelId,MODEL_BASE_URL:settings.baseUrl});
 assert.deepEqual(modelDeploymentVariables(),{});
});


test("pre-transfer builds cannot be used to roll back a sealed billing ledger even with the same application schema",()=>{
 const prior={...RELEASE_CONTRACT,family:"pra-v1-state3-pi2-20261113"};
 assert.equal(prior.appStateSchema,RELEASE_CONTRACT.appStateSchema);
 assert.throws(()=>assertReleaseCompatible(RELEASE_CONTRACT,prior),/INCOMPATIBLE_RELEASE_CONTRACT/);
});

test("canonical-memory releases reject rollback to the prior state-three memory-copy format",()=>{
 assert.throws(()=>assertReleaseCompatible(RELEASE_CONTRACT,{...RELEASE_CONTRACT,appStateSchema:3,family:"pra-v1-state3-pi2-budget-transfer-20261113"}),/INCOMPATIBLE_RELEASE_CONTRACT/);
});
