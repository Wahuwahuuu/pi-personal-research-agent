import {test} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
test("local research imports never load a main model runtime or replace host networking",()=>{
 const run=spawnSync(process.execPath,["--input-type=module","-e",`
 const before=globalThis.fetch;
 await import("./local/catalog.ts");
 await import("./packages/research/local-reading.ts");
 await import("./local/python.ts");
 if(before!==globalThis.fetch)throw Error("LOCAL_IMPORT_REPLACED_FETCH");
 `],{cwd:process.cwd(),encoding:"utf8",windowsHide:true});
 assert.equal(run.status,0,run.stderr);
});
