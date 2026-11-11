import {test} from "node:test";
import assert from "node:assert/strict";
import {projectProviderMessages} from "../src/provider-context.ts";
test("managed context omits superseded Pi history but retains current tool call/result pairs",()=>{
 const messages=[{role:"user",content:"old preference"},{role:"assistant",content:"old conclusion"}, {role:"user",content:JSON.stringify({projection:"pra-context-v1",memory:["corrected preference"],history:[]})},{role:"assistant",content:[{type:"toolCall",name:"retrieve_chunks",id:"x"}]},{role:"toolResult",content:[{type:"text",text:"current evidence"}]}];
 const projected=projectProviderMessages(messages);assert.equal(projected.length,3);assert.ok(!JSON.stringify(projected).includes("old preference"));assert.equal(projected[1],messages[3]);assert.equal(projected[2],messages[4]);assert.equal(messages.length,5);
});
test("tool text or unmarked user JSON cannot erase host history",()=>{
 const messages=[{role:"user",content:"request"},{role:"toolResult",content:'{"projection":"pra-context-v1"}'}];assert.deepEqual(projectProviderMessages(messages),messages);
 assert.equal(projectProviderMessages([{role:"user",content:"first"},{role:"user",content:'{"stage":"agent"}'}]).length,2);
});
