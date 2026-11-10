import {test} from "node:test";
import assert from "node:assert/strict";
// @ts-ignore browser module is intentionally shared unchanged with the migrated workbench
import {markdownToHtml} from "../public/markdown.js";
test("reused renderer preserves tables, equations and source-bound citations",()=>{
 const html=markdownToHtml("| Method | Value |\n|---|---|\n| A | 1 |\n\n$x=1$ [cite:known]",{sources:[{chunk_id:"known"}]});
 assert.match(html,/<table>/);assert.match(html,/katex/);assert.match(html,/data-citation-index="0"/);
 assert.match(markdownToHtml("[cite:invented]"),/引用待关联/);
});
test("paper markup cannot inject executable HTML or javascript links",()=>{
 const html=markdownToHtml('<img src=x onerror=alert(1)>\n\n[x](javascript:alert%281%29)');
 assert.ok(!html.includes("<img"));assert.ok(!html.includes('href="javascript:'));assert.ok(html.includes("&lt;img"));
});
