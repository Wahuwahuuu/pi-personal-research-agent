import {test} from "node:test";
import assert from "node:assert/strict";
import {nodeCatalog} from "../local/catalog.ts";
import {newWorkflow,advanceWorkflow,workflowPrompt,workflowTools,type WorkflowContext} from "../packages/research/cloud-workflow.ts";
const catalog=await nodeCatalog(undefined,true);
function setup(input="Explain the method"):WorkflowContext{return {id:"turn1",input,calls:1,evidence:[],catalog,conversation:{id:"c",title:"research",projectId:"p",scope:[],created:0,history:[]},memories:[],operations:[]};}
const prepared=(intent="answer",targets:string[]=[])=>JSON.stringify({intent,targets,rewrite:"Explain the method",queries:[],constraints:[]});
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
