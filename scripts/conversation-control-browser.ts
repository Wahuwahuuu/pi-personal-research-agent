import { expect, type Page, type Route } from "@playwright/test";
import assert from "node:assert/strict";
export async function verifyConversationControlBrowser(base:string,page:Page,api:(path:string,method?:string,body?:any)=>Promise<any>,shot:(name:string)=>Promise<void>){
  const until=async(fn:()=>Promise<boolean>)=>{const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw new Error("CONTROL_BROWSER_TIMEOUT");};
  const a=await api("tasks","POST",{requestId:crypto.randomUUID(),input:"离线研究软件场景甲",kind:"research"});
  await until(async()=>(await api("tasks/"+a.id)).status==="waiting_device");
  const initial=(await api("state")).usage.requests;
  await page.goto(base+"/#chat/"+a.conversationId);
  const send=async(input:string)=>{
    await page.getByLabel("消息",{exact:true}).fill(input);
    await page.getByRole("button",{name:"发送消息",exact:true}).click();
    const turn=page.locator("article.turn").filter({has:page.locator(".user-message",{hasText:input})}).last();
    await expect(turn.locator(".markdown")).not.toBeEmpty();return turn;
  };
  const paused=await send("暂停当前研究");
  await expect(paused).toContainText("任务已暂停");
  await expect(paused.getByRole("button",{name:"暂停任务",exact:true})).toHaveCount(0);
  await expect(paused.getByRole("button",{name:"保存为研究成果",exact:true})).toHaveCount(0);
  assert.equal((await api("tasks/"+a.id)).status,"paused");
  await shot("control-paused-desktop");
  const b=await api("tasks","POST",{requestId:crypto.randomUUID(),input:"离线研究软件场景乙",kind:"research",conversationId:a.conversationId});
  const clarification=await send("取消当前任务");
  await expect(clarification).toContainText("这个会话有多项任务");
  await expect(clarification.getByRole("button",{name:"继续执行",exact:true})).toHaveCount(0);
  await expect(clarification.getByRole("button",{name:"停止这项工作",exact:true})).toHaveCount(0);
  await expect(clarification.getByRole("button",{name:"保存为研究成果",exact:true})).toHaveCount(0);
  await clarification.getByRole("button",{name:"选择任务",exact:true}).click();
  await expect(page.getByLabel("消息",{exact:true})).toBeFocused();
  await shot("control-selection-desktop");
  await page.setViewportSize({width:390,height:844});
  await shot("control-selection-mobile");
  await send("第二个");
  assert.equal((await api("tasks/"+a.id)).status,"cancelled");
  await until(async()=>(await api("tasks/"+b.id)).status==="waiting_device");
  const status=await send("现在做到哪了");
  await expect(status).toContainText("等待你的电脑");
  await shot("control-status-mobile");
  assert.equal((await api("state")).usage.requests,initial);
  await page.reload();
  await expect(page.locator("article.turn").filter({has:page.locator(".user-message",{hasText:"第二个"})})).toContainText("任务已取消");
  await api("tasks/"+b.id+"/cancel","POST");
  await api("conversations/"+a.conversationId,"DELETE");
  await verifyDelayedSend(base, page, api);
  return ["accepted messages preserve the active chat and new drafts while HTTP acknowledgements are pending on desktop and mobile","desktop natural-language pause persists a real task change with no model calls or misleading artifact button","multiple tasks require selection; waiting receipt has no resume control and keyboard focus returns to the composer","mobile ordinal selection, live progress and page reload preserve the same task outcome without horizontal overflow"];
}

export async function verifyDelayedSend(base: string, page: Page, api: (path: string, method?: string, body?: any) => Promise<any>) {
  const composer = page.getByRole("textbox", {name: "消息", exact: true});
  const submit = page.getByRole("button", {name: "发送消息", exact: true});
  const conversations = new Set<string>();
  const create = async (title: string) => {
    const c = await api("conversations", "POST", {requestId: crypto.randomUUID(), projectId: "default", title});
    conversations.add(c.id);
    return c;
  };
  // The Worker accepts a real message. Delay only its HTTP acknowledgement to the browser.
  async function sendWithDelay(text: string, afterAccepted: () => Promise<void>) {
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    let accepted: {id: string; conversationId: string} | undefined;
    const path = "**/api/tasks";
    const handler = async (route: Route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      assert.ok(response.ok());
      accepted = await response.json();
      await gate;
      await route.fulfill({response});
    };
    await page.route(path, handler);
    try {
      await composer.fill(text);
      await submit.click();
      await expect.poll(() => !!accepted).toBe(true);
      conversations.add(accepted!.conversationId);
      const finished = page.waitForEvent("requestfinished", req => req.method() === "POST" && new URL(req.url()).pathname === "/api/tasks");
      try { await afterAccepted(); } finally { release(); await finished; }
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      return accepted!;
    } finally { release(); await page.unroute(path, handler); }
  }
  try {
    for (const width of [1440, 390]) {
      await page.setViewportSize({width, height: width === 390 ? 844 : 900});
      const working = await create("研究讨论 " + width);
      await page.goto(base + "/#chat");
      const sent = await sendWithDelay("查看我的研究进度", async () => {
        await expect(composer).not.toBeEditable();
        await page.goto(base + "/#chat/" + working.id);
        await expect(page.getByRole("heading", {name: working.title, exact: true})).toBeVisible();
        await composer.fill("在另一场讨论里撰写的新问题");
      });
      await expect(page).toHaveURL(base + "/#chat/" + working.id);
      await expect(composer).toHaveValue("在另一场讨论里撰写的新问题");
      assert.notEqual(sent.conversationId, working.id);
      assert.equal((await api("tasks/" + sent.id)).conversationId, sent.conversationId);

      await sendWithDelay("看看当前任务进展", async () => { await composer.fill("发送后写下的下一条补充"); });
      await expect(composer).toHaveValue("发送后写下的下一条补充");
      await expect(submit).toBeEnabled();
      await expect(page.locator(".user-message").filter({hasText: "看看当前任务进展"})).toHaveCount(1);

      const repeated = "再次查看任务状态";
      await sendWithDelay(repeated, async () => { await composer.fill(""); await composer.fill(repeated); });
      await expect(composer).toHaveValue(repeated);

      await page.goto(base + "/#chat");
      const opened = await sendWithDelay("请记录这次讨论", async () => {
        await expect(composer).not.toBeEditable();
      });
      await expect(page).toHaveURL(base + "/#chat/" + opened.conversationId);
      await expect(composer).toBeEditable();
      await expect(composer).toHaveValue("");
    }
  } finally {
    await page.goto(base + "/#conversations");
    for (const id of conversations) await api("conversations/" + id, "DELETE");
  }
}
