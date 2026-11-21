import assert from "node:assert/strict";
import { expect, type Page, type WebSocketRoute } from "@playwright/test";

export async function verifyPreviewBrowser(base: string, page: Page,
  api: (path: string, method?: string, body?: any) => Promise<any>) {
  const submitted = await api("tasks", "POST", {requestId:crypto.randomUUID(),kind:"chat",input:"Preview transport check"});
  let task = await api("tasks/"+submitted.id);
  const deadline = Date.now()+45000;
  while(task.status!=="completed"&&Date.now()<deadline) {
    await page.waitForTimeout(200);
    task=await api("tasks/"+submitted.id);
  }
  assert.equal(task.status,"completed");
  let socket: WebSocketRoute | undefined, projectRunning = true;
  const path="**/api/conversations/"+task.conversationId+"/messages?*";
  await page.route(path, async route => {
    const response=await route.fetch(), body=await response.json();
    if(projectRunning) body.items=body.items.map((t:any)=>t.id===task.id
      ? {...t,status:"running",runOpen:true,answer:undefined,preview:undefined,modelOperation:"preview-check"}:t);
    await route.fulfill({response,json:body});
  });
  await page.routeWebSocket("**/api/events?*", client=>{
    socket=client;
    const server=client.connectToServer();
    server.onMessage(message=>client.send(message));
  });
  const counts={overview:0,messages:0};
  const count=(request:any)=>{
    const url=new URL(request.url());
    if(request.method()!=="GET") return;
    if(url.pathname==="/api/overview") counts.overview++;
    if(url.pathname.endsWith("/messages")) counts.messages++;
  };
  page.on("request",count);
  try {
    await page.goto("about:blank");
    await page.goto(base+"/#chat/"+task.conversationId);
    await expect(page.locator("article.turn")).toHaveCount(1);
    await expect.poll(()=>Boolean(socket)).toBe(true);
    await page.waitForTimeout(1600);
    assert.ok(socket);
    const original={...counts};
    for(let i=0;i<20;i++) {
      socket!.send(JSON.stringify({type:"change",readerChanged:false,cursor:1,active:[]}));
      await page.waitForTimeout(110);
    }
    await page.waitForTimeout(1200);
    const control={overview:counts.overview-original.overview,messages:counts.messages-original.messages};
    assert.ok(control.overview>0&&control.messages>0);
    const state={type:"change",cursor:1,active:[],readerChanged:false,
      deviceState:{connected:true,ready:true,canImport:true,phase:"ready"}};
    socket!.send(JSON.stringify(state));
    await page.waitForTimeout(1400);
    const beforeRepeated={...counts};
    for(let i=0;i<20;i++) {
      socket!.send(JSON.stringify(state));
      await page.waitForTimeout(110);
    }
    await page.waitForTimeout(1200);
    const repeated={overview:counts.overview-beforeRepeated.overview,messages:counts.messages-beforeRepeated.messages};
    assert.deepEqual(repeated,{overview:0,messages:0});
    socket!.send(JSON.stringify({...state,deviceState:{connected:false,ready:false,canImport:false,phase:"offline"}}));
    await expect.poll(()=>counts.overview).toBeGreaterThan(beforeRepeated.overview);
    await expect.poll(()=>counts.messages).toBeGreaterThan(beforeRepeated.messages);
    await page.waitForTimeout(300);
    const baseline={...counts};
    for(let i=0;i<20;i++) {
      socket!.send(JSON.stringify({type:"task-preview",id:task.id,conversationId:task.conversationId,
        operation:"preview-check",updated:task.updated,text:"Preview "+i}));
      await page.waitForTimeout(110);
    }
    await expect(page.locator(".stream-preview")).toHaveText("Preview 19");
    await page.waitForTimeout(1200);
    const preview={overview:counts.overview-baseline.overview,messages:counts.messages-baseline.messages};
    assert.deepEqual(preview,{overview:0,messages:0});
    projectRunning=false;
    socket!.send(JSON.stringify({type:"change",readerChanged:false,cursor:1,active:[]}));
    await expect(page.locator(".stream-preview")).toHaveCount(0);
    await expect(page.locator(".assistant-message")).toContainText(task.answer);
    const terminal={overview:counts.overview-baseline.overview,messages:counts.messages-baseline.messages};
    assert.ok(terminal.overview>0&&terminal.messages>0);
    socket!.send(JSON.stringify({type:"task-preview",id:task.id,conversationId:task.conversationId,
      operation:"preview-check",updated:task.updated,text:"Late answer"}));
    await page.waitForTimeout(150);
    await expect(page.locator(".stream-preview")).toHaveCount(0);
    return {frames:20,control,repeated,preview,terminal,deviceOnlyRefresh:true,latePreviewRejected:true};
  } finally {
    page.off("request",count);
    await page.unroute(path);
    await api("conversations/"+task.conversationId,"DELETE",{requestId:crypto.randomUUID()});
  }
}
