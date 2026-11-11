import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PaperPdfCache,originalPdfUrl } from "../../internal/agent/paper-pdf.ts";

test("PDF cache accepts catalog IDs only, merges concurrent loads and reuses the original bytes",async()=>{
  const root=await mkdtemp(join(tmpdir(),"astercite-pdf-")),bytes=Buffer.from("%PDF-1.4\nexample original bytes\n%%EOF");let calls=0;
  const download=(async(url:unknown)=>{calls++;assert.equal(url,"https://arxiv.org/pdf/1611.09441v1");return new Response(bytes,{headers:{"Content-Type":"application/pdf"}});}) as typeof fetch;
  try{
    const cache=new PaperPdfCache(root,new Set(["1611.09441"]),download);
    assert.equal(originalPdfUrl("../secret"),null);
    await assert.rejects(cache.get("1908.10084"));await assert.rejects(cache.get("../../config"));assert.equal(calls,0);
    const [a,b]=await Promise.all([cache.get("1611.09441"),cache.get("1611.09441")]);assert.deepEqual(a,bytes);assert.deepEqual(b,bytes);assert.equal(calls,1);
    const reopened=new PaperPdfCache(root,new Set(["1611.09441"]),download);assert.deepEqual(await reopened.get("1611.09441"),bytes);assert.equal(calls,1);
  }finally{await rm(root,{recursive:true,force:true});}
});

test("PDF cache rejects non-PDF, oversized responses and redirects outside arXiv; failures can retry",async()=>{
  const root=await mkdtemp(join(tmpdir(),"astercite-pdf-retry-"));let attempt=0;
  const download=(async()=>{attempt++;return attempt===1?new Response("<html>not a PDF</html>"):new Response("%PDF-1.4\nvalid retry\n%%EOF");}) as typeof fetch;
  try{
    const cache=new PaperPdfCache(root,new Set(["1611.09441"]),download);await assert.rejects(cache.get("1611.09441"));assert.ok((await cache.get("1611.09441")).subarray(0,5).equals(Buffer.from("%PDF-")));
    assert.deepEqual((await readdir(join(root,".cache/papers"))).filter(f=>f.endsWith("partial")),[]);
    const redirect=new PaperPdfCache(root,new Set(["1705.02394"]),(async()=>new Response(null,{status:302,headers:{location:"http://127.0.0.1/private"}})) as typeof fetch);await assert.rejects(redirect.get("1705.02394"));
    const huge=new PaperPdfCache(root,new Set(["1705.02394"]),(async()=>new Response("%PDF-",{headers:{"Content-Length":String(40*1024*1024)}})) as typeof fetch);await assert.rejects(huge.get("1705.02394"));
    await mkdir(join(root,".cache/papers"),{recursive:true});await writeFile(join(root,".cache/papers/1705.02394v1.pdf"),"broken download");
    const repaired=new PaperPdfCache(root,new Set(["1705.02394"]),download);assert.ok((await repaired.get("1705.02394")).length>5);
  }finally{await rm(root,{recursive:true,force:true});}
});

test("versioned PDFs keep separate cache identities and reject redirects to another version",async()=>{
 const root=await mkdtemp(join(tmpdir(),"pra-pdf-version-"));const calls:string[]=[];
 try {
  const cache=new PaperPdfCache(root,new Set(["2401.00001","2401.00001v2"]),(async(url:unknown)=>{
   calls.push(String(url));return new Response("%PDF-"+String(url));
  }) as typeof fetch);
  const first=await cache.get("2401.00001"),second=await cache.get("2401.00001v2");
  assert.notDeepEqual(first,second);
  assert.deepEqual(calls,["https://arxiv.org/pdf/2401.00001v1","https://arxiv.org/pdf/2401.00001v2"]);
  assert.equal(originalPdfUrl("2401.00001v0"),null);
  const wrong=new PaperPdfCache(root,new Set(["2401.00001v3"]),(async()=>new Response(null,{status:302,headers:{location:"https://arxiv.org/pdf/2401.00001v4"}})) as typeof fetch);
  await assert.rejects(wrong.get("2401.00001v3"),/Unexpected PDF source/);
 }finally{await rm(root,{recursive:true,force:true});}
});
