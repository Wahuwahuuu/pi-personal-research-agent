import {test} from 'node:test';
import assert from 'node:assert/strict';
import {citationLabels,expandVisibleCitations} from '../packages/research/visible-citations.ts';
const source='permanent-index-version:paper:paragraph:chunk-100-200';
const label=citationLabels('task','index',new Set([source])).get(source)!;
const window={visibleSourceIds:[source],citationLabels:[label]};
test('one task-bound source reference resolves answer and structured identity fields after restart',()=>{
 const input={answer:`Quote [cite:${label}]`,execution:{state:'complete',goal_updates:[{source_ids:[label]}]},exact_quotes:[{chunk_id:label,quote:'Source'}],paper_coverage:[{paper_id:label,citations:[label]}],unrelated:[label]};
 const result=JSON.parse(expandVisibleCitations(JSON.stringify(input),JSON.parse(JSON.stringify(window))));
 assert.equal(result.answer,`Quote [cite:${source}]`);assert.deepEqual(result.execution.goal_updates[0].source_ids,[source]);
 assert.equal(result.exact_quotes[0].chunk_id,source);assert.deepEqual(result.paper_coverage[0].citations,[source]);
 assert.equal(result.paper_coverage[0].paper_id,label);assert.deepEqual(result.unrelated,[label]);
});
test('source aliases do not cross tasks, indexes, visibility boundaries or ordinary prose',()=>{
 const output=JSON.stringify({execution:{goal_updates:[{source_ids:[label]}]}});
 for(const [task,index] of [['different','index'],['task','new-index']]){
  const other=citationLabels(task,index,new Set([source])).get(source)!;
  assert.equal(expandVisibleCitations(output,{visibleSourceIds:[source],citationLabels:[other]}),output);
 }
 assert.equal(expandVisibleCitations(output,{visibleSourceIds:[],citationLabels:[]}),output);
 assert.equal(expandVisibleCitations('The name is '+label,window),'The name is '+label);
 assert.equal(expandVisibleCitations('{"answer":',window),'{"answer":');
});
