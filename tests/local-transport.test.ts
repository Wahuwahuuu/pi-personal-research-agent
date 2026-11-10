import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PythonBridge } from "../local/python.ts";
test("reused AsterCite transport separates readiness, strips model secrets, and restarts after cancellation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pra-transport-")),
    worker = join(dir, "worker.mjs");
  const source = [
    "setTimeout(()=>{",
    'process.stdout.write(JSON.stringify({version:1,type:"ready",backend:"fixture",index_version:"v1"})+"\\n");',
    'let buffer="";process.stdin.setEncoding("utf8");process.stdin.on("data",part=>{buffer+=part;let at;while((at=buffer.indexOf("\\n"))>=0){const request=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);if(request.params.query==="slow")continue;process.stdout.write(JSON.stringify({version:1,request_id:request.request_id,result:{index_version:"v1",hasModelKey:!!process.env.MODEL_API_KEY,params:request.params}})+"\\n");}});',
    "},300);",
  ].join("\n");
  await writeFile(worker, source);
  const prior = process.env.MODEL_API_KEY;
  process.env.MODEL_API_KEY = "synthetic-secret";
  const bridge = new PythonBridge({
    executable: process.execPath,
    worker,
    corpus: dir,
    index: dir,
    models: dir,
    indexVersion: "v1",
    device: "cpu",
  });
  try {
    await bridge.ready();
    const result = (await bridge.request(
      "retrieve_chunks",
      { query: "q", paper_ids: ["p"], top_k: 1, offset: 2 },
      AbortSignal.timeout(500),
    )) as any;
    assert.equal(result.hasModelKey, false);
    assert.equal(result.params.reading_mode, "workbench-v1");
    assert.equal(result.params.offset, 2);
    await assert.rejects(
      () =>
        bridge.request(
          "search_papers",
          { query: "q", path: "forbidden" },
          AbortSignal.timeout(100),
        ),
      /PARAMETER_DENIED/,
    );
    const abort = new AbortController();
    const pending = bridge.request(
      "search_papers",
      { query: "slow" },
      abort.signal,
    );
    setTimeout(() => abort.abort(), 20);
    await assert.rejects(() => pending);
    await bridge.ready();
    const again = (await bridge.request(
      "search_papers",
      { query: "again" },
      AbortSignal.timeout(500),
    )) as any;
    assert.equal(again.params.query, "again");
  } finally {
    bridge.stop();
    if (prior === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = prior;
    await rm(dir, { recursive: true, force: true });
  }
});
