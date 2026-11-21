import assert from 'node:assert/strict';
import test from 'node:test';
import type {Chunk} from '../../internal/agent/contracts.ts';
import {containsQuotation,inspectQuoteAttribution} from '../../internal/agent/quote-attribution.ts';
import {prepareWorkbenchAnswer} from '../../internal/agent/workbench-answer.ts';
const quote='The corpus contains twelve tasks from researcher projects.';
const chunk=(id:string,text:string,paper='paper'):Chunk=>({chunk_id:id,paper_id:paper,text,section:'Results'} as Chunk);
const wrong=chunk('page1','Twelve project-based tasks are evaluated.'),right=chunk('page2',quote);
const evidence=new Map([['page1',wrong],['page2',right]]);
const quoted=(id:string)=>`> 引用原文："${quote}" [cite:${id}]`;

test('an explicit exact quotation repairs only a unique same-paper source and preserves original output',()=>{
  const input=quoted('page1'),result=prepareWorkbenchAnswer(input,{evidence,allowAnswer:true})!;
  assert.equal(result.original,input);assert.equal(result.value.answer,quoted('page2'));
  assert.deepEqual(result.citationIssues,[]);assert.equal(result.needsCitationRepair,false);
  assert.ok(result.adaptations.includes('exact_quote_source_corrected'));
  assert.equal(prepareWorkbenchAnswer(quoted('page2'),{evidence,allowAnswer:true})!.value.answer,quoted('page2'));
});
test('whitespace and typographic punctuation normalize while ellipsis fragments remain ordered',()=>{
  assert.equal(containsQuotation('The researchers’  projects\nare complete.',"The researchers' projects...complete."),true);
  assert.equal(containsQuotation('Alpha before Beta','Beta...Alpha'),false);
  assert.equal(containsQuotation('ab cd','bc'),false);
  assert.equal(containsQuotation('some text','...'),false);
});
test('ambiguous, absent and cross-paper quotations remain unresolved and lose misleading links',()=>{
  for(const items of [new Map([['page1',wrong]]),new Map([...evidence,['other',chunk('other',quote)]]),
    new Map([['page1',wrong],['other',chunk('other',quote,'another-paper')]])]){
    const result=prepareWorkbenchAnswer(quoted('page1'),{evidence:items,allowAnswer:true})!;
    assert.equal(result.value.status,'partial');assert.equal(result.needsCitationRepair,true);
    assert.match(result.value.answer,/逐字引文依据待核对/);assert.ok(!result.value.answer.includes('[cite:'));
  }
});
test('uncited original quotations are flagged without inventing a paper identity',()=>{
  const result=inspectQuoteAttribution(`原文：“${quote}”`,evidence);
  assert.equal(result.issues.length,1);assert.equal(result.corrected,0);
});
test('ordinary terminology, paraphrases and fenced code are outside exact quotation checks',()=>{
  const input=`The phrase "researcher projects" is discussed [cite:page1].\n> 这是转述 [cite:page1]\n\`\`\`text\n${quoted('page1')}\n\`\`\``;
  const result=inspectQuoteAttribution(input,evidence);
  assert.equal(result.answer,input);assert.equal(result.checked,0);
});
test('multiple source links do not hide a wrong source or permit automatic reassignment',()=>{
  const input=quoted('page1')+' [cite:page2]',result=inspectQuoteAttribution(input,evidence);
  assert.equal(result.issues.length,1);assert.equal(result.corrected,0);assert.ok(!result.answer.includes('[cite:'));
});
test('automatic correction cannot cross index versions',()=>{
  const sources=new Map([['page1',{...wrong,index_version:'old'}],['page2',{...right,index_version:'new'}]]);
  assert.equal(inspectQuoteAttribution(quoted('page1'),sources).corrected,0);
  assert.equal(inspectQuoteAttribution(quoted('page1'),sources).issues.length,1);
});
