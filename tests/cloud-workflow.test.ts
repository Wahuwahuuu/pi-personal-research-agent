import {test} from "node:test";
import assert from "node:assert/strict";
import {nodeCatalog} from "../local/catalog.ts";
import {newWorkflow,advanceWorkflow,interruptWorkflow,reserveComparisonCheck,workflowPrompt,workflowInstruction,workflowTools,type WorkflowContext} from "../packages/research/cloud-workflow.ts";
const catalog=await nodeCatalog(undefined,true);
function setup(input="Explain the method"):WorkflowContext{return {id:"turn1",input,calls:1,evidence:[],catalog,conversation:{id:"c",title:"research",projectId:"p",scope:[],created:0,history:[]},memories:[],operations:[]};}
const prepared=(intent="answer",targets:string[]=[])=>JSON.stringify({intent,targets,rewrite:"Explain the method",queries:[],constraints:[]});
test("model memory context retains source provenance while distinguishing text validity from semantic support",()=>{
 const context=setup("What did we conclude?"),w=newWorkflow();
 context.memories=[{kind:"reading",content:"Prior finding",category:"conclusion",sourceStatus:"stale",semanticStatus:"user_modified",paper_ids:["fixture-paper"]}];
 const prompt=JSON.parse(workflowPrompt(w,context));
 assert.equal(prompt.memory[0].sourceStatus,"stale");assert.equal(prompt.memory[0].semanticStatus,"user_modified");
 assert.deepEqual(prompt.memory[0].paper_ids,["fixture-paper"]);assert.match(prompt.memory_rule,/NOT semantic proof/);
});
test("preparation uses migrated NLU and survives checkpoints; tools remain model-selected",()=>{
 const c=setup(),w=newWorkflow();
 assert.equal(JSON.parse(workflowPrompt(w,c)).stage,"prepare");
 assert.deepEqual(workflowTools(w,0),[]);
 advanceWorkflow(w,c,prepared("answer",["fixture-paper"]));
 const restored=JSON.parse(JSON.stringify(w));
 assert.equal(restored.prepared.frame.ordered_targets[0],"fixture-paper");
 assert.equal(c.conversation.domain?.current_paper?.paper_id,"fixture-paper");
 assert.deepEqual(workflowTools(restored,2),["search_papers","retrieve_chunks"]);
 assert.deepEqual(workflowTools(restored,5),[]);
 assert.equal(JSON.parse(workflowPrompt(restored,c)).frame.question_text,c.input);
});
test("valid conversational answers need no fabricated paper citation",()=>{
 const c=setup("你好"),w=newWorkflow();advanceWorkflow(w,c,prepared("session_update"));
 const out=advanceWorkflow(w,c,JSON.stringify({execution:{state:"complete",remaining_needs:[],needs_sources:false},answer:"你好，可以一起研究论文。"}));
 assert.equal(out.status,"completed");assert.equal(c.conversation.history.length,1);
 assert.equal(w.progress?.phase,"completed");
});
test("plain Markdown goes through original semantic completion check; budget exhaustion stays partial",()=>{
 const c=setup(),w=newWorkflow();advanceWorkflow(w,c,prepared());
 c.calls=2;advanceWorkflow(w,c,"I will search for this.");
 assert.equal(w.phase,"completion");
 c.calls=3;advanceWorkflow(w,c,JSON.stringify({state:"working",remaining_needs:["Read evidence"],needs_sources:true}));
 assert.equal(w.phase,"agent");assert.equal(w.tracker?.decisions,1);
 const restored=JSON.parse(JSON.stringify(w));c.calls=6;
 const outcome=advanceWorkflow(restored,c,"No original evidence was available.");
 assert.equal(outcome.status,"waiting_user");assert.equal(restored.execution.state,"partial");
 assert.equal(restored.progress.phase,"partial");
});
test("completion guard rejects invented citations and carries no-progress state across restart",()=>{
 const c=setup(),w=newWorkflow();advanceWorkflow(w,c,prepared());
 const output=JSON.stringify({execution:{state:"complete",remaining_needs:[],needs_sources:true},answer:"Claim [cite:made-up]"});
 c.calls=2;assert.equal(advanceWorkflow(w,c,output).status,undefined);
 const restored=JSON.parse(JSON.stringify(w));c.calls=3;
 const outcome=advanceWorkflow(restored,c,output);
 assert.equal(outcome.status,"waiting_user");assert.equal(restored.execution.stop_reason,"no_execution_progress");
 assert.ok(!outcome.answer?.includes("[cite:made-up]"));
});
test("known invalid sources go directly to repair without spending a semantic completion request",()=>{
 const c=setup(),w=newWorkflow();advanceWorkflow(w,c,prepared());
 c.evidence=[{paper_id:"fixture-paper",chunk_id:"method",paragraph_id:"p",section:"Methods",text:"The method combines two encoders.",start:0,end:33}];
 c.calls=3;advanceWorkflow(w,c,"Accuracy reached 98% [cite:method].");
 assert.equal(w.phase,"agent");assert.equal(w.execution?.origin,"host");
 assert.ok(w.citationRepair);assert.equal(w.citationRepair.claims.length,1);
 const restored=JSON.parse(JSON.stringify(w));c.calls=4;
 const repaired=advanceWorkflow(restored,c,JSON.stringify({execution:{state:"complete",remaining_needs:[],needs_sources:true},answer:"The method combines two encoders. [cite:method]"}));
 assert.equal(repaired.status,"completed");assert.equal(c.calls,4);
});
test("source repair cannot escape the request cap or mark an invalid final answer complete",()=>{
 const c=setup(),w=newWorkflow();advanceWorkflow(w,c,prepared());
 c.evidence=[{paper_id:"fixture-paper",chunk_id:"method",paragraph_id:"p",section:"Methods",text:"Two encoders.",start:0,end:13}];
 c.calls=6;const result=advanceWorkflow(w,c,"Accuracy reached 98% [cite:method].");
 assert.equal(result.status,"waiting_user");assert.equal(w.execution?.stop_reason,"remaining_allowance");
 assert.match(result.answer!,/依据待核对/);
});
test("a readable clarification waits for the user before checking completion or comparison",()=>{
 for(const hasEvidence of [false,true])for(const execution of [undefined,{state:"complete",remaining_needs:[],needs_sources:true},{state:"clarification",remaining_needs:["Choose the comparison dimension"],needs_sources:true}]){
  const c=setup("Compare the selected papers"),w=newWorkflow();
  c.catalog={...catalog,papers:[{paper_id:"a",title:"Paper A",abstract:"A"},{paper_id:"b",title:"Paper B",abstract:"B"}]};
  advanceWorkflow(w,c,JSON.stringify({intent:"compare",targets:["a","b"],rewrite:c.input,queries:[],constraints:[],comparison_dimensions:["method"]}));
  if(hasEvidence)c.evidence=[{paper_id:"a",chunk_id:"source-a",paragraph_id:"p",section:"Methods",text:"Method A.",start:0,end:9,index_version:catalog.indexVersion,citation:"[cite:source-a]",truncated:false}];
  c.calls=2;
  const question="Which comparison dimension should I use?";
  const out=advanceWorkflow(w,c,JSON.stringify({status:"clarification",answer:question,execution}));
  assert.deepEqual(out,{status:"waiting_user",userWait:"RESEARCH_CLARIFICATION",answer:question});
  assert.equal(w.phase,"finished");assert.equal(w.execution?.state,"clarification");assert.equal(w.execution?.needs_sources,false);
  assert.equal(w.progress?.phase,"clarification");assert.equal(w.comparison,undefined);assert.equal(w.memory,undefined);
  assert.equal(c.conversation.history.at(-1)?.final_answer,question);
  const note=c.conversation.domain?.reading_notes?.at(-1);
  assert.equal(note?.status,"clarification");assert.deepEqual(note?.paper_ids,[]);
 }
});
test("an explicit evidence refusal preserves the reply as an open research task",()=>{
 const c=setup(),w=newWorkflow();advanceWorkflow(w,c,prepared("answer",["fixture-paper"]));c.calls=2;
 const message="The available materials do not establish the requested result.";
 const out=advanceWorkflow(w,c,JSON.stringify({status:"refusal",answer:message,execution:{state:"complete",remaining_needs:[],needs_sources:true}}));
 assert.deepEqual(out,{status:"waiting_user",userWait:"RESEARCH_REFUSAL",answer:message});
 assert.equal(w.execution?.state,"partial");assert.equal(w.progress?.phase,"partial");assert.equal(w.memory,undefined);
 const note=c.conversation.domain?.reading_notes?.at(-1);assert.equal(note?.status,"refusal");assert.deepEqual(note?.paper_ids,[]);
});
test("a wait label cannot publish an invalid reference, an unverified metric, or a protocol object",()=>{
 for(const [status,answer] of [["clarification","Which setting [cite:unknown]?"],["refusal","Accuracy reached 99% [cite:fixture-chunk]."],["clarification",{internal:"system field"}],["refusal",'{"unreadable":["field"]}'],["clarification",'["option","internal field"]'],["clarification","<analysis>private test marker</analysis>"]]){
  const c=setup(),w=newWorkflow();advanceWorkflow(w,c,prepared("answer",["fixture-paper"]));
  c.evidence=[{paper_id:"fixture-paper",chunk_id:"fixture-chunk",paragraph_id:"p",section:"Method",text:"A method.",start:0,end:9,index_version:catalog.indexVersion,citation:"[cite:fixture-chunk]",truncated:false}];c.calls=2;
  const out=advanceWorkflow(w,c,JSON.stringify({status,answer,execution:{state:"clarification",remaining_needs:[],needs_sources:false}}));
  assert.equal(out.status,undefined);assert.equal(w.phase,"agent");assert.equal(c.conversation.history.length,0);
 }
 const c=setup(),w=newWorkflow();advanceWorkflow(w,c,prepared());c.calls=2;
 const out=advanceWorkflow(w,c,JSON.stringify({status:"answer",answer:"The treatment improved results.",execution:{state:"complete",remaining_needs:[],needs_sources:false}}));
 assert.equal(out.status,undefined);assert.equal(w.execution?.state,"working");assert.equal(w.execution?.needs_sources,true);
});

test("same conversation carries corrected constraints and original dialogue into a new task",()=>{
 const c=setup("以后请用中文回答"),w=newWorkflow();
 advanceWorkflow(w,c,JSON.stringify({intent:"session_update",targets:[],rewrite:c.input,queries:[],constraints:[{key:"language",value:"Chinese",source_quote:"中文"}]}));
 advanceWorkflow(w,c,JSON.stringify({execution:{state:"complete",remaining_needs:[],needs_sources:false},answer:"好的。"}));
 const next={...c,id:"turn2",input:"现在改成英文回答",calls:1},nw=newWorkflow();
 const prompt=JSON.parse(workflowPrompt(nw,next));assert.ok(JSON.stringify(prompt).includes("Chinese"));
 advanceWorkflow(nw,next,JSON.stringify({intent:"session_update",targets:[],rewrite:next.input,queries:[],constraints:[{key:"language",value:"English",source_quote:"英文"}]}));
 const constraints=next.conversation.domain!.user_constraints;
 assert.equal(constraints.filter(x=>!x.superseded_by).length,1);assert.equal(constraints.at(-1)?.value,"English");
});

test("a later model interruption retains a readable answer against its own saved generation window", () => {
  const c=setup(), w=newWorkflow();
  advanceWorkflow(w,c,prepared("answer",["fixture-paper"]));
  const evidence=(id:string)=>({paper_id:"fixture-paper",chunk_id:id,paragraph_id:"p1",section:"Method",
    text:"Evidence.",start:0,end:9,index_version:c.catalog.indexVersion,citation:"[cite:"+id+"]",truncated:false});
  const first=evidence("first"), later=evidence("later");c.evidence=[first,later];
  w.visibleSourceIds=[first.chunk_id];c.calls=3;
  const candidate="The passage says Evidence. [cite:first]";
  assert.deepEqual(advanceWorkflow(w,c,candidate),{});
  assert.equal(w.phase,"completion");
  const checkpoint=structuredClone(w);
  assert.deepEqual(checkpoint.candidateWindow,{taskId:c.id,indexVersion:c.catalog.indexVersion,sourceIds:["first"]});
  checkpoint.visibleSourceIds=["later"];
  const result=interruptWorkflow(checkpoint,c);
  assert.equal(result.status,"waiting_user");assert.ok(result.answer?.startsWith(candidate));assert.equal(checkpoint.phase,"completion");
  assert.equal(checkpoint.execution?.state,"partial");assert.equal(checkpoint.progress?.phase,"partial");
  assert.equal(c.conversation.history.length,0);assert.equal(checkpoint.memory,undefined);assert.equal(c.calls,3);
  for(const change of [
    {candidateWindow:undefined},
    {candidateWindow:{...w.candidateWindow!,taskId:"different"}},
    {candidateWindow:{...w.candidateWindow!,indexVersion:"different"}},
    {candidate:"Another passage [cite:later]"},
    {candidate:'{"answer":{"source":"[cite:first]"}}'},
    {candidate:'{"internal_note":"[cite:first]"}'},
    {candidate:"<analysis>private fixture marker</analysis> [cite:first]"},
  ]) {
    const out=interruptWorkflow({...structuredClone(w),...change,visibleSourceIds:["later"]},c);
    assert.deepEqual(out,{status:"waiting_user"});
  }
  assert.equal(interruptWorkflow(structuredClone(w),{...c,evidence:[{...first,index_version:"next"}]}).answer,undefined);
  assert.equal(interruptWorkflow(structuredClone(w),{...c,invalidatedMemoryTurns:[c.id]}).answer,undefined);
  // An empty working declaration must not replace the earlier readable response.
  const retry=structuredClone(w);retry.phase="agent";
  advanceWorkflow(retry,c,JSON.stringify({execution:{state:"working",remaining_needs:["more evidence"]},answer:""}));
  assert.equal(retry.candidate,candidate);assert.deepEqual(retry.candidateWindow,w.candidateWindow);
});

test("comparison validates paper-by-dimension source coverage rather than counting returned chunks",()=>{
 const c=setup("比较 Paper A 和 Paper B"),w=newWorkflow();
 c.catalog={...catalog,papers:[{paper_id:"a",title:"Paper A",abstract:"a"},{paper_id:"b",title:"Paper B",abstract:"b"}]};
 advanceWorkflow(w,c,JSON.stringify({intent:"compare",targets:["a","b"],rewrite:c.input,queries:[],constraints:[],comparison_dimensions:["方法"]}));
 c.evidence=[{paper_id:"a",chunk_id:"a1",paragraph_id:"p",section:"Methods",text:"Method A.",start:0,end:9,index_version:"fixture-v1",citation:"[cite:a1]",truncated:false}];
 c.operations=[{tool:"retrieve_chunks",params:{paper_ids:["a"],query:"method"},state:"done"}];
 c.calls=3;
 advanceWorkflow(w,c,JSON.stringify({execution:{state:"complete",remaining_needs:[],needs_sources:true},answer:"A [cite:a1]"}));
 assert.equal(w.phase,"comparison");
 c.calls=4;
 advanceWorkflow(w,c,JSON.stringify({cells:[{paper_id:"a",dimension:"方法",status:"supported",summary:"A",citations:["a1"]},{paper_id:"b",dimension:"方法",status:"supported",summary:"B",citations:["a1"]}]}));
 assert.equal(w.comparison?.cells.find(x=>x.paper_id==="b")?.status,"missing");
 c.calls=6;
 const out=advanceWorkflow(w,c,JSON.stringify({execution:{state:"complete",remaining_needs:[],needs_sources:true},answer:"A [cite:a1]"}));
 assert.equal(out.status,"waiting_user");assert.equal(w.execution?.state,"partial");
});

test("an immediately cited original block quote retains verified metrics without spreading citations to other paragraphs",async()=>{
 const {inspectCitationAttribution}=await import("../packages/research/internal/agent/citation-attribution.ts");
 const chunk={paper_id:"p",chunk_id:"c",paragraph_id:"p1",section:"Abstract",text:"The accuracy reaches 80.34\\%.",start:0,end:28,index_version:"v",citation:"[cite:c]",truncated:false};
 const evidence=new Map([["c",chunk]]);
 assert.deepEqual(inspectCitationAttribution("> The accuracy reaches 80.34\\%.\n\n[cite:c]",evidence).issues,[]);
 assert.ok(inspectCitationAttribution("The accuracy reaches 80.34%.\n\n[cite:c]",evidence).issues.length);
 assert.ok(inspectCitationAttribution("> The accuracy reaches 99%.\n\n[cite:c]",evidence).issues.length);
 assert.ok(inspectCitationAttribution("> The accuracy reaches 80.34%.\n\nUnrelated paragraph\n\n[cite:c]",evidence).issues.length);
});

test("large retrieval keeps complete sources once in a bounded visible window and reports archived omissions",()=>{
 const c=setup(),w=newWorkflow();advanceWorkflow(w,c,prepared("answer",["fixture-paper"]));
 c.evidence=Array.from({length:20},(_,i)=>({paper_id:"fixture-paper",chunk_id:"long"+i,paragraph_id:"p"+i,section:"Methods",text:"A method detail. ".repeat(140),start:0,end:2380,index_version:"fixture-v1",citation:"[cite:long"+i+"]",truncated:false}));
 const observations={observations:[{operationId:"op",tool:"retrieve_chunks",result:{index_version:"fixture-v1",chunks:c.evidence}}]};
 const prompt=workflowPrompt(w,c,observations),body=JSON.parse(prompt);
 assert.ok(Buffer.byteLength(prompt)<42000);assert.ok(body.evidence.length>0&&body.evidence.length<20);
 assert.equal(body.observations[0].result.chunks,undefined);
 assert.equal(body.observations[0].result.chunk_ids.length,20);
 assert.equal(body.evidence[0].text,c.evidence[0].text);
 assert.equal(body.evidence_window.omitted,20-body.evidence.length);
 assert.equal(c.evidence.length,20);
});

test("empty working answers continue into real tools instead of failing as invalid citations",()=>{
 const c=setup(),w=newWorkflow();advanceWorkflow(w,c,prepared());
 const output=JSON.stringify({execution:{state:"working",remaining_needs:["Read originals"],needs_sources:true},answer:""});
 c.calls=2;assert.deepEqual(advanceWorkflow(w,c,output),{});assert.equal(w.phase,"agent");
 assert.match(w.warnings.join(" "),/actual research tool/);
 const restored=JSON.parse(JSON.stringify(w));c.calls=3;
 assert.equal(advanceWorkflow(restored,c,output).status,"waiting_user");assert.equal(restored.execution.stop_reason,"no_execution_progress");
});


test("headings before an original quote do not detach its following citation",async()=>{
 const {inspectCitationAttribution}=await import("../packages/research/internal/agent/citation-attribution.ts");
 const e=new Map([["c",{paper_id:"p",chunk_id:"c",paragraph_id:"p",section:"Abstract",text:"accuracy 80%",start:0,end:12,index_version:"v",citation:"[cite:c]",truncated:false}]]);
 assert.deepEqual(inspectCitationAttribution("## Original\n> accuracy 80%.\n\n[cite:c]",e).issues,[]);
 assert.ok(inspectCitationAttribution("Uncited accuracy 80%.\n> quote\n\n[cite:c]",e).issues.length);
});
test("citation repair supplies the rejected claim and candidates without auto-attaching evidence",()=>{
 const c=setup(),w=newWorkflow();advanceWorkflow(w,c,prepared());
 c.evidence=[{paper_id:"p",chunk_id:"c",paragraph_id:"p",section:"Abstract",text:"accuracy 80%",start:0,end:12,index_version:"v",citation:"[cite:c]",truncated:false}];
 c.calls=3;
 advanceWorkflow(w,c,JSON.stringify({execution:{state:"complete",remaining_needs:[],needs_sources:true},answer:"accuracy 80%.\n\nSource [cite:c]"}));
 const p=JSON.parse(workflowPrompt(w,c));assert.equal(p.citation_repair.claims[0].assessment,"missing_citation");assert.deepEqual(p.citation_repair.claims[0].candidate_sources["80%"],["c"]);
 c.calls=4;
 assert.equal(advanceWorkflow(w,c,JSON.stringify({execution:{state:"complete",remaining_needs:[],needs_sources:true},answer:"accuracy 80% [cite:c]."})).status,"completed");
});

test("NLU failure retains explicitly named papers for real comparison coverage",()=>{
 const c=setup("Compare Paper A and Paper B methods"),w=newWorkflow();
 c.catalog={...catalog,papers:[{paper_id:"a",title:"Paper A",abstract:"a"},{paper_id:"b",title:"Paper B",abstract:"b"}]};
 advanceWorkflow(w,c,"invalid JSON");assert.deepEqual(w.prepared?.frame.ordered_targets,["a","b"]);
 assert.ok(JSON.parse(workflowPrompt(w,c)).comparison);
});
test("double brackets normalize exact known citation identities only",async()=>{
 const {prepareWorkbenchAnswer}=await import("../packages/research/internal/agent/workbench-answer.ts");
 const chunk={paper_id:"p",chunk_id:"c",paragraph_id:"p",section:"Abstract",text:"accuracy 80%",start:0,end:12,index_version:"v",citation:"[cite:c]",truncated:false};
 const r=prepareWorkbenchAnswer("accuracy 80% [[cite:c]].",{evidence:new Map([["c",chunk]]),allowAnswer:true})!;
 assert.equal(r.visibleCitationCount,1);assert.deepEqual(r.citationIssues,[]);assert.match(r.value.answer,/\[cite:c\]/);
 const invalid=prepareWorkbenchAnswer("Claim [[cite:invented]]",{evidence:new Map([["c",chunk]]),allowAnswer:true})!;
 assert.equal(invalid.visibleCitationCount,0);
});

test("corrected or deleted memory provenance cannot re-enter fresh model context through domain history",()=>{
 const c=setup("以后用中文回答"),w=newWorkflow();
 advanceWorkflow(w,c,JSON.stringify({intent:"session_update",targets:[],rewrite:c.input,queries:[],constraints:[{key:"language",value:"OLD_SENTINEL",source_quote:"中文"}]}));
 advanceWorkflow(w,c,JSON.stringify({execution:{state:"complete",remaining_needs:[],needs_sources:false},answer:"OLD_SENTINEL"}));
 c.conversation.history[0].user_text="OLD_SENTINEL";
 const next={...c,id:"turn2",input:"你好",invalidatedMemoryTurns:["turn1"]};
 const prompt=workflowPrompt(newWorkflow(),next);
 assert.ok(!prompt.includes("OLD_SENTINEL"));assert.ok(c.conversation.history.length===1);
});

test("plain Markdown comparison still runs dimension coverage before generic completion",()=>{
 const c=setup("Compare Paper A and Paper B"),w=newWorkflow();
 c.catalog={...catalog,papers:[{paper_id:"a",title:"Paper A",abstract:"a"},{paper_id:"b",title:"Paper B",abstract:"b"}]};
 advanceWorkflow(w,c,JSON.stringify({intent:"compare",targets:["a","b"],rewrite:c.input,queries:[],constraints:[],comparison_dimensions:["method"]}));
 c.evidence=[{paper_id:"a",chunk_id:"a1",paragraph_id:"p",section:"Methods",text:"Method A",start:0,end:8,index_version:"v",citation:"[cite:a1]",truncated:false}];
 c.calls=4;advanceWorkflow(w,c,"A method [cite:a1]. B remains unknown.");
 assert.equal(w.phase,"comparison");
});

test("invalid preference provenance does not discard valid comparison dimensions",()=>{
 const c=setup("Compare Paper A and Paper B methods"),w=newWorkflow();c.catalog={...catalog,papers:[{paper_id:"a",title:"Paper A",abstract:"a"},{paper_id:"b",title:"Paper B",abstract:"b"}]};
 advanceWorkflow(w,c,JSON.stringify({intent:"compare",targets:["a","b"],rewrite:c.input,comparison_dimensions:["methods"],constraints:[{key:"language",value:"French",source_quote:"invented"}]}));
 assert.deepEqual(w.prepared?.frame.comparison_dimensions,["methods"]);assert.deepEqual(c.conversation.domain?.user_constraints,[]);
});

test("missing optional dimensions never add unrequested experiments or limitations",()=>{
 const c=setup("Compare Paper A and Paper B research questions"),w=newWorkflow();c.catalog={...catalog,papers:[{paper_id:"a",title:"Paper A",abstract:"a"},{paper_id:"b",title:"Paper B",abstract:"b"}]};
 advanceWorkflow(w,c,JSON.stringify({intent:"compare",targets:["a","b"],rewrite:c.input,queries:[],constraints:[]}));
 const prompt=JSON.parse(workflowPrompt(w,c));assert.match(prompt.comparison,/用户要求的比较内容/);assert.ok(!prompt.comparison.includes("方法与实验设置"));assert.equal(prompt.request,c.input);
});

test("completion checks reuse the original fenced JSON decoder",()=>{
 const c=setup("你好"),w=newWorkflow();advanceWorkflow(w,c,prepared("session_update"));c.calls=2;advanceWorkflow(w,c,"你好。");c.calls=3;
 assert.equal(advanceWorkflow(w,c,'```json\n{"state":"complete","remaining_needs":[],"needs_sources":false}\n```').status,"completed");
});

test("comparison response template preserves exact paper and requested-dimension identities",()=>{
 const c=setup("Compare A and B"),w=newWorkflow();c.catalog={...catalog,papers:[{paper_id:"a",title:"A",abstract:"a"},{paper_id:"b",title:"B",abstract:"b"}]};
 advanceWorkflow(w,c,JSON.stringify({intent:"compare",targets:["a","b"],rewrite:c.input,queries:[],constraints:[],comparison_dimensions:["core method"]}));w.phase="comparison";
 const body=JSON.parse(workflowPrompt(w,c));assert.deepEqual(body.response_template.cells.map((x:any)=>[x.paper_id,x.dimension]),[["a","core method"],["b","core method"]]);
});

test("cloud-only conversations share memory and history without requiring a local catalog or tools",()=>{
 const c=setup("cloud only"),w={...newWorkflow(),cloudOnly:true};c.catalog={indexVersion:"cloud-only",papers:[],evidence:[]};
 advanceWorkflow(w,c,prepared("answer"));assert.deepEqual(workflowTools(w,2),[]);assert.equal(JSON.parse(workflowPrompt(w,c)).cloud_only,true);
 const out=advanceWorkflow(w,c,JSON.stringify({execution:{state:"complete",remaining_needs:[],needs_sources:true},answer:"你好。"}));assert.equal(out.status,"completed");assert.equal(c.conversation.history.length,1);
});

test("valid prose survives an empty answer envelope used as trailing execution metadata",()=>{
 const c=setup("你好"),w={...newWorkflow(),cloudOnly:true};advanceWorkflow(w,c,prepared("session_update"));
 const out=advanceWorkflow(w,c,'你好，我可以帮助你研究论文。\n\n{"execution":{"state":"complete","remaining_needs":[],"needs_sources":false},"answer":""}');
 assert.equal(out.status,"completed");assert.equal(out.answer,"你好，我可以帮助你研究论文。");
});

test("optional memory respects its actual source window and budget exhaustion preserves completed answers",async()=>{
 const {beginMemory,skipMemory}=await import("../packages/research/cloud-workflow.ts");
 const c=setup(),w=newWorkflow();c.evidence=[{paper_id:"fixture-paper",paragraph_id:"p",chunk_id:"hidden",index_version:"v",section:"body",start:0,end:7,text:"omitted"}];
 const done={answer:"Known result [cite:hidden]",status:"completed" as const};
 assert.equal(beginMemory(w,done,5,c.evidence),true);assert.deepEqual(skipMemory(w,"budget_exhausted"),done);assert.equal(w.phase,"finished");
 const limited=newWorkflow();assert.equal(beginMemory(limited,done,6,c.evidence),false);assert.equal(limited.memory?.state,"budget_exhausted");
 const pending=newWorkflow();beginMemory(pending,done,4,c.evidence);pending.memory!.visibleSourceIds=[];
 const out=advanceWorkflow(pending,c,JSON.stringify({readings:[{paper_id:"fixture-paper",topic:"a",progress:"b",key_points:[{text:"c",chunk_id:"hidden",quote:"omitted"}],open_questions:[]}]}));
 assert.equal(out.answer,done.answer);assert.equal(pending.memory?.state,"failed");
});


test("imported indexed text remains discoverable when independent abstract metadata is absent",()=>{
 const c=setup(),w=newWorkflow();
 c.catalog={indexVersion:"v",papers:[{paper_id:"body",title:"Text paper",abstract:""},{paper_id:"both",title:"Both",abstract:"Original abstract"},{paper_id:"hidden",title:"Private other scope",abstract:""}],evidence:[{paper_id:"body",paragraph_id:"p",chunk_id:"c",start:0,end:4,index_version:"v",text_sha256:"a".repeat(64)}]};
 c.conversation.scope=["body","both"];
 const preparation=JSON.parse(workflowPrompt(w,c));
 assert.deepEqual(preparation.catalog.map((p:any)=>[p.paper_id,p.independent_abstract,p.indexed_text]),[["body",false,true],["both",true,false]]);
 advanceWorkflow(w,c,prepared("single_paper_qa",["body"]));
 const agent=JSON.parse(workflowPrompt(w,c));assert.deepEqual(agent.reading_availability,[{paper_id:"body",independent_abstract:false,indexed_text:true}]);
 assert.match(agent.reading_rule,/omitting section/);assert.ok(!JSON.stringify(agent.reading_availability).includes("hidden"));
 assert.deepEqual(workflowTools(w,2),["search_papers","retrieve_chunks"]);
});

test("reading capability projection stays bounded and reports omitted metadata honestly",()=>{
 const c=setup(),w=newWorkflow();c.catalog={indexVersion:"v",evidence:[],papers:Array.from({length:100},(_,i)=>({paper_id:"paper-"+i+"x".repeat(150),title:"Synthetic",abstract:""}))};
 w.phase="agent";const p=JSON.parse(workflowPrompt(w,c));assert.ok(p.reading_availability.length<100);
 assert.equal(p.reading_availability_omitted,100-p.reading_availability.length);
 assert.ok(Buffer.byteLength(JSON.stringify(p.reading_availability))<=2500);
});


test("citation repair retains its verified sources before unrelated archived chunks within the existing byte window",()=>{
 const c=setup(),w=newWorkflow();advanceWorkflow(w,c,prepared("answer",["fixture-paper"]));c.calls=4;
 c.evidence=Array.from({length:20},(_,i)=>({paper_id:"fixture-paper",paragraph_id:"paragraph-"+i,chunk_id:"chunk-"+i,index_version:c.catalog.indexVersion,section:"body",start:0,end:1800,text:"x".repeat(1800)}));
 const initial=JSON.parse(workflowPrompt(w,c));assert.ok(!initial.evidence.some((e:any)=>e.chunk_id==="chunk-19"));
 w.citationRepair={answer:"Check the supplied result [cite:chunk-19] and reject [cite:invented-id].",claims:[]};
 const p=JSON.parse(workflowPrompt(w,c));assert.equal(p.evidence[0].chunk_id,"chunk-19");
 assert.equal(p.evidence[0].text,c.evidence[19].text);assert.ok(!p.evidence.some((e:any)=>e.chunk_id==="invented-id"));
 assert.equal(p.evidence_window.omitted,c.evidence.length-p.evidence.length);assert.ok(Buffer.byteLength(JSON.stringify(p.evidence))<=22000);assert.ok(Buffer.byteLength(JSON.stringify(p))<=45000);
 assert.deepEqual(w.visibleSourceIds,p.evidence.map((e:any)=>e.chunk_id));assert.deepEqual(p.evidence.slice(1).map((e:any)=>e.chunk_id),initial.evidence.slice(0,p.evidence.length-1).map((e:any)=>e.chunk_id));
});

test("repair priority never truncates oversized evidence or invents a source for malformed citation IDs",()=>{
 const c=setup(),w=newWorkflow();advanceWorkflow(w,c,prepared("answer",["fixture-paper"]));c.calls=4;
 c.evidence=[{paper_id:"fixture-paper",paragraph_id:"p",chunk_id:"oversized",index_version:c.catalog.indexVersion,section:"body",start:0,end:24000,text:"x".repeat(24000)},{paper_id:"fixture-paper",paragraph_id:"q",chunk_id:"small",index_version:c.catalog.indexVersion,section:"body",start:0,end:5,text:"whole"}];
 w.citationRepair={answer:"Check [cite:oversized] and [cite:small] but not [cite:unknown",claims:[]};
 const p=JSON.parse(workflowPrompt(w,c));assert.deepEqual(p.evidence.map((e:any)=>e.chunk_id),["small"]);assert.equal(p.evidence[0].text,"whole");assert.equal(p.evidence_window.omitted,1);
});


test("explicit grouped citations normalize only when every full source ID is visible",async()=>{
 const {prepareWorkbenchAnswer}=await import("../packages/research/internal/agent/workbench-answer.ts");
 const a={paper_id:"fixture-paper",chunk_id:"a",paragraph_id:"p",index_version:"fixture-v1",section:"body",start:0,end:13,text:"Score is 80%."};
 const b={...a,chunk_id:"b",text:"Score is 90%."};
 const evidence=new Map([["a",a],["b",b]]);
 const result=prepareWorkbenchAnswer("Reported scores: 80% and 90% [cite:a; cite:b].",{evidence,allowAnswer:true})!;
 assert.equal(result.visibleCitationCount,2);assert.equal(result.needsCitationRepair,false);assert.equal(result.value.answer,"Reported scores: 80% and 90% [cite:a][cite:b].");
 assert.ok(result.adaptations.includes("visible_citation_format_normalized"));
 for(const marker of ["[cite:a; cite:missing]","[cite:a; cite:B]","[cite:a; b]","[cite:1; cite:2]"]){
  const invalid=prepareWorkbenchAnswer("Claim "+marker,{evidence,allowAnswer:true})!;
  assert.equal(invalid.visibleCitationCount,0);assert.equal(invalid.needsCitationRepair,true);assert.ok(invalid.value.answer.includes("引用未定位"));
 }
});

test("grouped citation repair prioritizes exact archived originals without increasing the evidence window",()=>{
 const c=setup(),w=newWorkflow();advanceWorkflow(w,c,prepared("answer",["fixture-paper"]));c.calls=4;
 c.evidence=Array.from({length:20},(_,i)=>({paper_id:"fixture-paper",paragraph_id:"paragraph-"+i,chunk_id:"chunk-"+i,index_version:c.catalog.indexVersion,section:"body",start:0,end:1800,text:"x".repeat(1800)}));
 w.citationRepair={answer:"Check [cite:chunk-19; cite:chunk-18] and reject [cite:chunk-17; cite:unknown].",claims:[]};
 const prompt=JSON.parse(workflowPrompt(w,c));
 assert.deepEqual(prompt.evidence.slice(0,2).map((e:any)=>e.chunk_id),["chunk-19","chunk-18"]);
 assert.equal(prompt.evidence[0].text,c.evidence[19].text);assert.equal(prompt.evidence[1].text,c.evidence[18].text);
 assert.ok(!prompt.evidence.some((e:any)=>["chunk-17","unknown"].includes(e.chunk_id)));
 assert.ok(Buffer.byteLength(JSON.stringify(prompt.evidence))<=22000);assert.ok(Buffer.byteLength(JSON.stringify(prompt))<=45000);
});

test("personal memory projection keeps user content without exposing storage identifiers as citation candidates",()=>{
 const c=setup("Recall our project constraints"),w={...newWorkflow(),automatic:true,cloudOnly:true};
 const raw={content:"Keep the agreed scope.",kind:"note",edited:true,updated_at:"2026-01-01T00:00:00Z",id:"private-storage-id",slot:"private-storage-slot",source_session:"private-storage-session",source_turn:"private-storage-turn"};
 c.memories=[raw];c.memoryStatus="ready";
 const prompt=workflowPrompt(w,c),payload=JSON.parse(prompt);
 assert.equal(payload.memory[0].content,raw.content);assert.equal(payload.memory[0].user_confirmed,true);assert.equal(payload.memory_status,"ready");
 for(const value of [raw.id,raw.slot,raw.source_session,raw.source_turn])assert.ok(!prompt.includes(value));
 assert.equal(raw.id,"private-storage-id");assert.equal(w.contextWindow?.memories,1);
 c.memoryStatus="unavailable";c.memories=[];assert.equal(JSON.parse(workflowPrompt(w,c)).memory_status,"unavailable");
});


test("unit repair survives checkpointing and reports the actual outstanding evidence check",()=>{
 const c=setup(),w=newWorkflow();advanceWorkflow(w,c,prepared("answer",["fixture-paper"]));c.calls=4;
 const source={paper_id:"fixture-paper",paragraph_id:"p",chunk_id:"result",index_version:c.catalog.indexVersion,section:"Results",start:0,end:29,text:"Reported recall is 61.2 on A."};
 c.evidence=[source];
 const output=JSON.stringify({execution:{state:"complete",remaining_needs:[],needs_sources:true},answer:"Reported recall is 61.2% [cite:result]."});
 assert.equal(advanceWorkflow(w,c,output).status,undefined);
 const restored=JSON.parse(JSON.stringify(w));const payload=JSON.parse(workflowPrompt(restored,c));
 assert.deepEqual(payload.citation_repair.claims[0].unit_unconfirmed_values,["61.2%"]);
 assert.match(payload.instruction,/unit_unconfirmed_values/);
 assert.deepEqual(payload.evidence.map((e:any)=>e.chunk_id),["result"]);
 c.calls=6;const outcome=advanceWorkflow(restored,c,output);
 assert.equal(outcome.status,"waiting_user");assert.equal(restored.execution.stop_reason,"remaining_allowance");
 assert.ok(restored.execution.remaining_needs.includes("核对回答中的数值、单位及其原文依据"));
 assert.ok(!restored.execution.remaining_needs.includes("读取当前问题所需的论文原文"));
 assert.match(outcome.answer!,/该数值依据待核对/);
});


test("malformed answer packaging gets one bounded repair before a semantic completion check",()=>{
 const c=setup("Explain the method"),w=newWorkflow();advanceWorkflow(w,c,prepared("answer",["fixture-paper"]));
 c.evidence=[{paper_id:"fixture-paper",chunk_id:"fixture-chunk",paragraph_id:"p1",section:"Methods",text:"Evidence.",start:0,end:9,index_version:"fixture-v1",citation:"[cite:fixture-chunk]",truncated:false}];c.operations=[{tool:"retrieve_chunks",params:{paper_ids:["fixture-paper"],query:"method"},state:"done"}];
 c.calls=4;assert.deepEqual(advanceWorkflow(w,c,'{"execution":{"state":"complete","remaining_needs":[]},"answer":"Unclosed\nanswer'),{});assert.equal(w.phase,"agent");assert.equal(w.answerRepairAttempts,1);assert.match(w.warnings.join(" "),/Markdown/);assert.equal(c.calls,4);const repairPrompt=JSON.parse(workflowPrompt(w,c));assert.match(repairPrompt.answer_contract,/ordinary Markdown/);assert.ok(!workflowInstruction(w).includes("prefer one single JSON object"));
 const restored=JSON.parse(JSON.stringify(w));c.calls=5;assert.deepEqual(advanceWorkflow(restored,c,"Evidence. [cite:fixture-chunk]"),{});assert.equal(restored.phase,"completion");
 c.calls=6;const result=advanceWorkflow(restored,c,JSON.stringify({state:"complete",remaining_needs:[],needs_sources:true}));assert.equal(result.status,"completed");assert.match(result.answer!,/\[cite:fixture-chunk\]/);
});
test("format recovery cannot repeat after a checkpoint or reset the task budget",()=>{
 const c=setup("Hello"),w=newWorkflow();advanceWorkflow(w,c,prepared("session_update"));c.calls=2;
 const broken='{"execution":{"state":"complete","remaining_needs":[]},"answer":"';advanceWorkflow(w,c,broken);const restored=JSON.parse(JSON.stringify(w));c.calls=3;
 const result=advanceWorkflow(restored,c,broken);assert.equal(result.status,"waiting_user");assert.equal(restored.phase,"finished");assert.equal(restored.answerRepairAttempts,1);assert.ok(result.answer!.trim());assert.ok(!result.answer!.includes('"execution"'));assert.equal(c.calls,3);
});
test("exhausted and older completion checkpoints with invalid answers remain explicit and unfinished",()=>{
 for(const calls of [5,6]){const c=setup("Hello"),w=newWorkflow();advanceWorkflow(w,c,prepared("session_update"));w.phase="completion";w.candidate='{"answer":"unfinished';c.calls=calls;
  const result=advanceWorkflow(w,c,JSON.stringify({state:"complete",remaining_needs:[],needs_sources:false}));if(calls===5){assert.deepEqual(result,{});assert.equal(w.phase,"agent");assert.equal(w.answerRepairAttempts,1);}else{assert.equal(result.status,"waiting_user");assert.equal(w.phase,"finished");assert.equal(w.answerRepairAttempts,undefined);}}
});


test("agent evidence window counts JSON string escaping and preserves complete source identities",()=>{
 const c=setup('Compare quoted measurements and equations'),w=newWorkflow();advanceWorkflow(w,c,prepared('answer',['fixture-paper']));c.calls=2;
 c.evidence=Array.from({length:20},(_,i)=>({paper_id:'fixture-paper',chunk_id:'quoted-'+i,paragraph_id:'p'+i,section:'Methods',text:'\\'.repeat(1500)+'原文🧪',start:0,end:1503,index_version:'fixture-v1',citation:'[cite:quoted-'+i+']',truncated:false}));
 const stored=JSON.stringify(c.evidence);const encoded=workflowPrompt(w,c),body=JSON.parse(encoded);
 assert.ok(Buffer.byteLength(JSON.stringify(encoded))<=40000);assert.ok(body.evidence.length>0&&body.evidence.length<c.evidence.length);
 assert.deepEqual(w.visibleSourceIds,body.evidence.map((e:any)=>e.chunk_id));assert.equal(body.evidence_window.omitted,c.evidence.length-body.evidence.length);
 for(const e of body.evidence)assert.deepEqual(e,c.evidence.find(s=>s.chunk_id===e.chunk_id));assert.equal(JSON.stringify(c.evidence),stored);assert.equal(body.request,c.input);
});
test("configured system contract is not duplicated in the managed agent prompt and irreducible input is refused",()=>{
 const c=setup('Keep the full current correction'),w=newWorkflow();advanceWorkflow(w,c,prepared('answer',['fixture-paper']));c.calls=2;
 const independent=JSON.parse(workflowPrompt(w,c));assert.ok(independent.instruction);
 const managed=JSON.parse(workflowPrompt(w,c,undefined,{systemInstructionProvided:true}));assert.equal(managed.instruction,undefined);assert.equal(managed.request,c.input);assert.equal(managed.answer_contract,independent.answer_contract);
 c.input='🧪'.repeat(12000);assert.throws(()=>workflowPrompt(w,c,undefined,{systemInstructionProvided:true}),/CONTEXT_LIMIT/);assert.equal(c.calls,2);
});

test("newlines in a complete answer envelope retain execution state at the last request", () => {
  const c = setup(), w = newWorkflow();
  advanceWorkflow(w, c, prepared());
  c.calls = 6;
  c.evidence = [{
    paper_id: "fixture-paper", chunk_id: "source-a", paragraph_id: "p",
    section: "Methods", text: "The method uses paired observations.", start: 0, end: 36,
    index_version: catalog.indexVersion, citation: "[cite:source-a]", truncated: false,
  }];
  const response = [
    '{"execution":{"state":"complete","remaining_needs":[]},"answer":"A method description.',
    'It uses paired observations [cite:source-a]."}',
  ].join("\n");
  const outcome = advanceWorkflow(w, c, response);
  assert.equal(outcome.status, "completed");
  assert.equal(w.execution?.origin, "model");
  assert.match(outcome.answer!, /description\.\nIt uses/);
  assert.equal(c.calls, 6);
});

test("recovering an execution envelope still validates its shape and citations", async () => {
  const {executionFromOutput} = await import("../packages/research/internal/agent/turn-execution.ts");
  const metadata = '{"state":"complete","remaining_needs":[]}';
  const multiline = '{"execution":' + metadata + ',"answer":"Line one\nLine two"}';
  assert.equal(executionFromOutput("```json\n" + multiline + "\n```")?.state, "complete");
  assert.equal(executionFromOutput(multiline.slice(0, -1)), undefined);
  assert.equal(executionFromOutput("Quoted example: " + multiline), undefined);
  assert.equal(executionFromOutput('{"execution":{"state":"working","state":"complete"},"answer":"example"}'), undefined);
  assert.equal(executionFromOutput('{"execution":"invalid","answer":"text\ncontinued"}'), undefined);
  const c = setup(), w = newWorkflow();
  advanceWorkflow(w, c, prepared());
  c.calls = 6;
  assert.equal(advanceWorkflow(w, c, multiline).status, "waiting_user");
});

test("long source citations resolve to the original chunk in answers, checkpoints and later dialogue", () => {
  const c = setup(), w = newWorkflow();
  const id = "volume:local-" + "abcd".repeat(16) + ":page:120-180";
  const source = {paper_id:"fixture-paper",chunk_id:id,paragraph_id:"p",section:"Methods",text:"We use paired observations.",start:0,end:27,index_version:catalog.indexVersion,citation:"[cite:"+id+"]"};
  c.evidence = [source];
  advanceWorkflow(w, c, prepared());
  const item = JSON.parse(workflowPrompt(w, c)).evidence[0];
  assert.match(item.answer_citation, /^\[cite:ref-[a-f0-9]{12}\]$/);
  assert.equal(item.chunk_id, id);
  assert.equal(item.text, source.text);
  assert.equal(item.citation, source.citation);
  assert.equal("answer_citation" in source, false);
  const saved = JSON.parse(JSON.stringify(w));
  assert.equal(JSON.parse(workflowPrompt(saved,c)).evidence[0].answer_citation,item.answer_citation);
  const plain = "Paired observations. " + item.answer_citation;
  assert.deepEqual(advanceWorkflow(saved,c,plain),{});
  assert.equal(saved.candidate,"Paired observations. "+source.citation);
  c.calls=6;
  const result=advanceWorkflow(saved,c,JSON.stringify({state:"complete",remaining_needs:[],needs_sources:true}));
  assert.equal(result.status,"completed");
  assert.equal(result.answer,saved.candidate);
  assert.equal(c.conversation.history.at(-1)?.final_answer,result.answer);
});

test("a compact citation cannot name an omitted source, another task or a different index", () => {
  const c=setup(), w=newWorkflow();
  const ids=["canonical-long-source-"+ "a".repeat(45),"canonical-long-source-"+ "b".repeat(45)];
  c.evidence=ids.map((chunk_id,i)=>({chunk_id,paper_id:"fixture-paper",paragraph_id:"p"+i,section:"Methods",text:"Evidence.",start:0,end:9,citation:"[cite:"+chunk_id+"]",index_version:catalog.indexVersion}));
  advanceWorkflow(w,c,prepared());
  const entries=JSON.parse(workflowPrompt(w,c)).evidence;
  const labels=entries.map((s:{answer_citation:string})=>s.answer_citation);
  assert.ok(labels.every((v:string)=>v?.startsWith("[cite:ref-")));
  const fresh=(context:WorkflowContext)=>{
    const copy=structuredClone(w);
    const prompt=JSON.parse(workflowPrompt(copy,context));
    const output=JSON.stringify({execution:{state:"complete",remaining_needs:[]},answer:"A finding. "+labels[1]});
    return {prompt,result:advanceWorkflow(copy,{...context,calls:6},output)};
  };
  assert.equal(fresh({...c,evidence:[c.evidence[0]]}).result.status,"waiting_user");
  assert.equal(fresh({...c,id:"another-task"}).result.status,"waiting_user");
  assert.equal(fresh({...c,catalog:{...c.catalog,indexVersion:"another-index"}}).result.status,"waiting_user");
  const grouped=labels[0].slice(0,-1)+"; "+labels[1].slice(1);
  const answer=advanceWorkflow(w,{...c,calls:6},JSON.stringify({execution:{state:"complete"},answer:"Both. "+grouped}));
  assert.equal(answer.status,"completed");
  assert.equal(answer.answer,"Both. [cite:"+ids[0]+"][cite:"+ids[1]+"]");
});

test("two remaining calls can verify a comparison before the final answer even if prior steps only called tools",()=>{
  const context=setup("Compare methods in Paper A and Paper B"), workflow=newWorkflow();
  const papers=[{paper_id:"a",title:"Paper A",abstract:""},{paper_id:"b",title:"Paper B",abstract:""}];
  context.catalog={...catalog,papers};
  advanceWorkflow(workflow,context,JSON.stringify({intent:"compare",targets:["a","b"],rewrite:context.input,queries:[],constraints:[],comparison_dimensions:["method"]}));
  const evidence=papers.map(paper=>{
    const text="The method uses "+paper.title+".", id=paper.paper_id+"1";
    return {paper_id:paper.paper_id,chunk_id:id,paragraph_id:"p",section:"Methods",text,
      start:0,end:Array.from(text).length,index_version:"fixture-v1",citation:"[cite:"+id+"]",truncated:false};
  });
  context.evidence=evidence;
  context.operations=papers.map(p=>({tool:"retrieve_chunks",params:{paper_ids:[p.paper_id],query:"method"},state:"done"}));
  context.calls=3;
  reserveComparisonCheck(workflow,context);
  assert.equal(workflow.phase,"agent");
  reserveComparisonCheck(workflow,{...context,calls:5});
  assert.equal(workflow.phase,"agent","the last call remains available for an answer");
  context.calls=4;
  reserveComparisonCheck(workflow,{...context,evidence:evidence.slice(0,1)});
  reserveComparisonCheck(workflow,{...context,operations:context.operations.slice(0,1)});
  assert.equal(workflow.phase,"agent","every target needs both a returned retrieval and actual source text");
  const repair={...workflow,answerRepairPending:true};
  reserveComparisonCheck(repair,context);
  assert.equal(repair.phase,"agent");
  reserveComparisonCheck(workflow,context);
  assert.equal(workflow.phase,"comparison");
  assert.deepEqual(workflowTools(workflow,context.calls),[]);
  const check=JSON.parse(workflowPrompt(workflow,context));
  assert.deepEqual(check.evidence.map((chunk:{chunk_id:string})=>chunk.chunk_id),["a1","b1"]);
  context.calls=5;
  advanceWorkflow(workflow,context,JSON.stringify({cells:check.response_template.cells.map((cell:{paper_id:string})=>({...cell,status:"supported",summary:"Method verified",citations:[cell.paper_id+"1"]}))}));
  const final=JSON.parse(workflowPrompt(workflow,context,{observations:[{operationId:"returned",tool:"retrieve_chunks",result:{chunks:evidence}}]}));
  assert.equal(final.stage,"agent");
  assert.deepEqual(final.observations[0].result.chunk_ids,["a1","b1"]);
  assert.equal(final.remaining_model_requests,1);
  assert.deepEqual(workflowTools(workflow,context.calls),[]);
  context.calls=6;
  const answer=advanceWorkflow(workflow,context,JSON.stringify({execution:{state:"complete",remaining_needs:[],needs_sources:true},answer:"Paper A uses its method [cite:a1]. Paper B uses its method [cite:b1]."}));
  assert.equal(answer.status,"completed");
  assert.equal(workflow.comparison?.cells.filter(cell=>cell.status==="supported").length,2);
});

test("citation repair shows the original numerical candidate with a copyable marker without attributing the claim",async()=>{
  const {inspectCitationAttribution}=await import("../packages/research/internal/agent/citation-attribution.ts");
  const c=setup(),w=newWorkflow();
  advanceWorkflow(w,c,prepared("answer",["fixture-paper"]));
  const chunks=Array.from({length:22},(_,i)=>{
    const text=i===21?"The reported success rate is 31%.":i===20?"The rate is 31%. "+"x".repeat(24000):"unrelated ".repeat(185);
    return {paper_id:"fixture-paper",paragraph_id:"p",chunk_id:"long-fixed-source-identity-for-repair-"+i,index_version:c.catalog.indexVersion,section:"Results",start:0,end:text.length,text};
  });
  c.evidence=chunks;c.calls=5;
  const claims=inspectCitationAttribution("The reported success rate was 31% [cite:incorrect].",new Map(chunks.map(chunk=>[chunk.chunk_id,chunk]))).checks;
  assert.deepEqual(claims[0].candidate_sources["31%"],[chunks[20].chunk_id,chunks[21].chunk_id]);
  // A stale checkpoint may name candidates no longer in this index. They cannot consume the prompt budget.
  claims[0].candidate_sources["31%"].push(...Array.from({length:700},(_,i)=>("absent-from-current-source-window-").repeat(3)+i));
  w.citationRepair={answer:"The reported success rate was 31% [cite:incorrect].",claims};
  const archived=structuredClone(w.citationRepair);
  const prompt=JSON.parse(workflowPrompt(w,c));
  const matched=prompt.evidence.filter((chunk:{values_to_verify?:string[]})=>chunk.values_to_verify?.includes("31%"));
  assert.equal(matched.length,1);
  assert.equal(matched[0].chunk_id,chunks[21].chunk_id);
  assert.equal(matched[0].text,chunks[21].text);
  assert.match(matched[0].answer_citation,/^\[cite:ref-[a-f0-9]{12}\]$/);
  assert.ok(!JSON.stringify(prompt.citation_repair.claims).includes(chunks[20].chunk_id));
  assert.deepEqual(w.citationRepair,archived);
  c.calls=6;
  const out=advanceWorkflow(w,c,JSON.stringify({execution:{state:"complete",remaining_needs:[],needs_sources:true},answer:"The reported result was 31% [cite:incorrect]."}));
  assert.equal(out.status,"waiting_user","a matching candidate cannot silently repair a citation or validate the answer");
});

test("automatic routing keeps ungrounded discovery rewrites out of cloud-only conversations",()=>{
 const request="Please use a shorter introduction next time.";
 for(const discovery_request_quote of [undefined,"nonexistent scientific topic"]){
  const c=setup(request),w={...newWorkflow(),automatic:true,cloudOnly:true};
  const proposal={intent:"find_papers",rewrite:"Search the literature for concise introductions",targets:[],queries:["writing studies"],needs:["find papers"],constraints:[],discovery_request_quote};
  advanceWorkflow(w,c,JSON.stringify(proposal));
  assert.equal(w.cloudOnly,true);assert.deepEqual(workflowTools(w,c.calls),[]);
  assert.equal(w.prepared?.rewrite,request);assert.equal(w.prepared?.frame.intent,"session_control");
  assert.ok(w.prepared?.warnings.includes("discovery_request_unconfirmed"));
  assert.ok(!JSON.stringify(w.prepared).includes("writing studies"));
 }
 for(const [request,quote] of [
  ["Find papers on acoustics; keep the reply short.",undefined],
  ["帮我找两篇电池论文，简要列出。",undefined],
  ["Batteries with solid electrolytes — recent work?","solid electrolytes"],
 ]){
  const c=setup(request!),w={...newWorkflow(),automatic:true,cloudOnly:true};
  advanceWorkflow(w,c,JSON.stringify({intent:"find_papers",targets:[],rewrite:request,queries:[],constraints:[],discovery_request_quote:quote}));
  assert.equal(w.cloudOnly,false);assert.equal(w.prepared?.frame.intent,"paper_discovery");
  assert.deepEqual(workflowTools(w,c.calls),["search_papers","retrieve_chunks"]);
 }
 for(const [request,quote] of [["Please elaborate.","elaborate"],["先不要搜索文献，请简单说明。","搜索文献"]]){
  const c=setup(request),w={...newWorkflow(),automatic:true,cloudOnly:true};
  advanceWorkflow(w,c,JSON.stringify({intent:"find_papers",targets:[],rewrite:"Find sources",constraints:[],discovery_request_quote:quote}));
  assert.equal(w.cloudOnly,true);assert.equal(w.prepared?.rewrite,request);
 }
 const explicit=setup("Continue the library search"),research=newWorkflow();
 advanceWorkflow(research,explicit,prepared("find_papers"));
 assert.equal(research.prepared?.frame.intent,"paper_discovery");
});

test("comparison projects each retrieval in rank order and identifies its paper after a restart", () => {
 const c=setup("Compare Paper A and Paper B"), w=newWorkflow();
 c.catalog={...catalog,papers:[{paper_id:"a",title:"Paper A",abstract:""},{paper_id:"b",title:"Paper B",abstract:""}]};
 advanceWorkflow(w,c,JSON.stringify({intent:"compare",targets:["a","b"],rewrite:c.input,queries:[],constraints:[],comparison_dimensions:["Method"]}));
 const chunk=(paper:string,id:string)=>{
   const text=id+" evidence. ".repeat(135);
   return {paper_id:paper,chunk_id:id,paragraph_id:id,section:"Results",text,start:0,end:text.length,
     index_version:"fixture-v1",citation:"[cite:"+id+"]",truncated:false};
 };
 const a=Array.from({length:9},(_,i)=>chunk("a","a"+i)), b=Array.from({length:9},(_,i)=>chunk("b","b"+i));
 const supplemental=chunk("b","new"), legacy=chunk("a","archived");
 c.evidence=[legacy,...a,...b,supplemental];
 const operation=(paper:string,query:string,chunks:typeof a)=>({tool:"retrieve_chunks",state:"done",params:{paper_ids:[paper],query},result:{chunks}});
 c.operations=[{tool:"retrieve_chunks",state:"done",params:{paper_ids:["a"],query:"archive"}},
   operation("a","initial A",a),operation("b","initial B",b),operation("b","supplement",[supplemental,b[0],b[1]]),operation("a","empty",[])];
 const restored=structuredClone(w);restored.phase="comparison";
 const prompt=JSON.parse(workflowPrompt(restored,c)), visible=prompt.evidence.map((s:{chunk_id:string})=>s.chunk_id);
 assert.deepEqual(prompt.comparison_papers,[{paper_id:"a",title:"Paper A"},{paper_id:"b",title:"Paper B"}]);
 assert.deepEqual(visible.slice(0,6),["a0","new","a1","b0","a2","b1"]);
 assert.equal(visible.length,new Set(visible).size);
 assert.equal(prompt.workspace.duplicate_chunks,2);
 assert.equal(prompt.workspace.unique_chunks,c.evidence.length);
 assert.ok(visible.length<c.evidence.length);
 advanceWorkflow(restored,c,JSON.stringify({cells:[{paper_id:"a",dimension:"Method",status:"supported",summary:"A method",citations:["a2"]},{paper_id:"b",dimension:"Method",status:"supported",summary:"Wrong paper",citations:["a0"]}]}));
 assert.equal(restored.comparison?.cells[1].status,"missing");
 const final=JSON.parse(workflowPrompt(restored,c));const answers=final.evidence.map((s:{chunk_id:string})=>s.chunk_id);
 assert.deepEqual(answers.slice(0,4),["a0","new","a2","b0"]);
 assert.ok(answers.includes("a2"));
 c.operations=[{tool:"retrieve_chunks",state:"done",params:{paper_ids:["a","b"],query:"older record"}}];
 restored.phase="comparison";
 assert.equal(JSON.parse(workflowPrompt(restored,c)).workspace.unique_chunks,c.evidence.length);
});

test("final comparison gives checked originals from both papers precedence over subsequent retrieval ranks", () => {
  const c = setup("Compare Paper A and Paper B"), w = newWorkflow();
  c.catalog = {...catalog, papers: ["a","b"].map(id => ({paper_id:id, title:"Paper "+id.toUpperCase(), abstract:""}))};
  advanceWorkflow(w, c, JSON.stringify({intent:"compare", targets:["a","b"], rewrite:c.input, comparison_dimensions:["method"]}));
  const chunk = (paper:string, id:string) => {
    const text = id + " original passage".repeat(97);
    return {paper_id:paper, chunk_id:id, paragraph_id:id, section:"Method", text, start:0, end:text.length, index_version:"v", citation:"[cite:"+id+"]", truncated:false};
  };
  const checked = ["a","b"].flatMap(id => Array.from({length:3}, (_,i) => chunk(id,id+"-checked-"+i)));
  const supplement = ["a","b"].flatMap(id => Array.from({length:9}, (_,i) => chunk(id,id+"-later-"+i)));
  const ops = (name:string, sources:typeof checked) => ["a","b"].map(id => ({tool:"retrieve_chunks", params:{query:name, paper_ids:[id]}, state:"done", result:{chunks:sources.filter(s => s.paper_id===id)}}));
  c.evidence = checked; c.operations = ops("original",checked); c.calls = 4; w.phase = "comparison";
  const checking = JSON.parse(workflowPrompt(w,c));
  assert.equal(checking.evidence.length,checked.length);
  advanceWorkflow(w,c,JSON.stringify({cells:checking.response_template.cells.map((cell:{paper_id:string}) => ({...cell,status:"supported",summary:"Checked methods",citations:checked.filter(s => s.paper_id===cell.paper_id).map(s=>s.chunk_id)}))}));
  c.evidence = [...checked,...supplement]; c.operations = [...ops("original",checked),...ops("new passages",supplement)];
  const supplemental = JSON.parse(workflowPrompt(w,c));
  assert.deepEqual(supplemental.evidence.slice(0,2).map((s:{chunk_id:string})=>s.chunk_id),["a-later-0","b-later-0"]);
  c.calls=5;
  const stored = structuredClone(w.comparison), final = JSON.parse(workflowPrompt(w,c));
  assert.deepEqual(final.evidence.slice(0,6).map((s:{chunk_id:string})=>s.chunk_id),[0,1,2].flatMap(i=>["a-checked-"+i,"b-checked-"+i]));
  const allowed = new Set(final.evidence.map((s:{chunk_id:string})=>s.chunk_id));
  assert.equal(allowed.size,final.evidence.length);
  assert.ok(final.evidence.every((s:{chunk_id:string;text:string})=>c.evidence.some(e=>e.chunk_id===s.chunk_id&&e.text===s.text)));
  assert.ok(final.progress.items.every((i:{source_ids:string[]})=>i.source_ids.every(id=>allowed.has(id))));
  assert.deepEqual(w.comparison,stored);
  assert.ok(w.progress!.items.some(i=>i.source_ids.some(id=>!allowed.has(id))));
  // The request and its corrections can leave less space than the earlier coverage check did.
  const bounded = {...c, input:c.input+" Required context.".repeat(1000)};
  w.execution = {state:"working",remaining_needs:["explain sources"],goal_updates:[{need_id:"methods",status:"working",source_ids:checked.map(s=>s.chunk_id)}]};
  const encoded = workflowPrompt(w,bounded), small = JSON.parse(encoded), visible = new Set(small.evidence.map((s:{chunk_id:string})=>s.chunk_id));
  const rows = JSON.parse(small.comparison.split("\n")[1]).cells;
  assert.ok(checked.some(s=>!visible.has(s.chunk_id)), "fixture must omit at least one checked original");
  assert.ok(rows.every((row:{citations:string[]})=>row.citations.every(id=>visible.has(id))));
  assert.ok(rows.some((row:{status:string})=>row.status!=="supported"));
  assert.ok(small.execution.goal_updates[0].source_ids.every((id:string)=>visible.has(id)));
  assert.equal(w.execution?.goal_updates?.[0].source_ids.length,6);
  assert.deepEqual(w.comparison,stored);
  assert.ok(Buffer.byteLength(JSON.stringify(encoded))<=40000);
});

test("a parsed reading digest does not report persistence before the host saves it",()=>{
 const c=setup(), w=newWorkflow();
 w.phase="memory";w.memory={answer:"Retained answer",status:"completed",state:"pending",visibleSourceIds:[]};
 assert.deepEqual(advanceWorkflow(w,c,'{"readings":[]}'),{answer:"Retained answer",status:"completed"});
 assert.equal(w.memory.state,"pending");
 assert.deepEqual(w.memory.digest,{version:2,readings:[]});
});

test("empty published catalogs and offline routing never prepare a paperless tool request", () => {
  for (const indexVersion of ["library-empty-v1", "cloud-only"]) {
    for (const queries of [[], ["method or experiment"]]) {
      const c = setup();
      c.catalog = {indexVersion, papers: [], evidence: []};
      const w = {...newWorkflow(), automatic: indexVersion === "cloud-only", cloudOnly: indexVersion === "cloud-only"};
      advanceWorkflow(w, c, JSON.stringify({intent:"answer", targets:[], rewrite:c.input, queries, constraints:[]}));
      assert.deepEqual(w.prepared?.frame.queries, []);
      assert.equal(w.prepared?.retrieval_plan?.reason, "target_discovery_required");
      assert.equal(w.preparedIndex, indexVersion);
      assert.equal(w.phase, "agent");
      assert.equal(w.cloudOnly, false);
    }
  }
});
