import assert from "node:assert/strict";
import { expect, type Page, type BrowserContext } from "@playwright/test";
import WebSocket from "ws";
import { nodeCatalog, catalogPages } from "../local/catalog.ts";

export async function verifyLibraryReaderVersion(
  base: string, page: Page, context: BrowserContext,
  api: (path:string, method?:string, body?:any) => Promise<any>,
) {
  const fixture = await nodeCatalog(undefined, true);
  const pair = await api("device/pair","POST",{requestId:crypto.randomUUID(),label:"目录切换检查"});
  const socket = new WebSocket(base.replace("http","ws")+"/api/device/connect",{headers:{Authorization:"Bearer "+pair.token}});
  const opened = new Promise<void>((resolve,reject)=>{socket.once("open",resolve);socket.once("error",reject);});
  const frames:any[] = [];
  const send = (frame:any) => socket.send(JSON.stringify(frame));
  socket.on("message", raw => {if (raw.toString()!=="pong") frames.push(JSON.parse(raw.toString()));});
  const mobile = await context.newPage();
  const updatedTitle = "已更新的论文标题";
  async function publish(version:string, title?:string) {
    const data = { indexVersion:version, papers:title ? fixture.papers.map(p => ({...p,title})) : [],
      evidence:title ? fixture.evidence.map(e => ({...e,index_version:version})) : [] };
    const start=frames.length;
    send({type:"hello",version:1,deviceId:"reader-versions",indexVersion:version,tools:["search_papers","retrieve_chunks"],capabilities:["reader-v1"]});
    await expect.poll(()=>frames.slice(start).some(f=>f.type==="hello_ack")).toBe(true);
    const pages=catalogPages(data);
    send({type:"catalog_begin",pages:pages.length});
    pages.forEach((value,page)=>send({type:"catalog_page",page,value}));send({type:"catalog_end"});
    await expect.poll(()=>frames.slice(start).some(f=>f.type==="catalog_ack"&&f.indexVersion===version)).toBe(true);
    send({type:"ready"});send({type:"reader_status",ready:true});
    await expect.poll(async()=>(await api("reader/status?indexVersion="+version)).available).toBe(true);
  }
  try {
    await opened;
    await publish("reader-version-one",fixture.papers[0].title);
    await page.setViewportSize({width:1440,height:900});
    await mobile.setViewportSize({width:390,height:844});
    const tabs=[page,mobile];
    for(const tab of tabs) {
      await tab.goto(base+"/#papers");
      await tab.getByRole("button",{name:fixture.papers[0].title,exact:true}).click();
      await expect(tab.getByRole("button",{name:"在已连接电脑打开",exact:true})).toBeEnabled();
    }
    await publish("reader-version-two",updatedTitle);
    assert.equal((await api("papers"))[0].title,updatedTitle);
    for(const tab of tabs) {
      const detail=tab.getByLabel("原文与证据",{exact:true});
      await expect(detail.getByRole("heading",{name:updatedTitle,exact:true})).toBeVisible({timeout:12000});
      await expect(detail.getByRole("button",{name:"在已连接电脑打开",exact:true})).toBeEnabled();
    }
    await publish("reader-version-empty");
    for(const tab of tabs) {
      const detail=tab.getByLabel("原文与证据",{exact:true});
      await expect(detail.getByText("这篇论文已从当前目录移除。",{exact:true})).toBeVisible({timeout:12000});
      await expect(detail.getByRole("button",{name:"在已连接电脑打开",exact:true})).toHaveCount(0);
    }
    await publish("reader-version-two",updatedTitle);
    for(const tab of tabs) {
      await expect(tab.getByRole("button",{name:"在已连接电脑打开",exact:true})).toBeEnabled({timeout:12000});
      assert.equal(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    }
    assert.deepEqual(frames.filter(f=>f.type==="error"),[]);
    return "Open library details follow the same paper across catalog replacement, removal and restoration on two screen widths.";
  } finally {
    socket.terminate();await mobile.close();
    await api("device/revoke","POST",{requestId:crypto.randomUUID(),id:pair.id});
  }
}
