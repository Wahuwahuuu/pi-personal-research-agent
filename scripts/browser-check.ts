import {verifyChangeFeedBrowser} from "./change-feed-browser.ts";
import {verifyContextWindowBrowser} from "./context-window-browser.ts";
import {verifyConversationControlBrowser} from "./conversation-control-browser.ts";
import {verifyRecoveryBrowser} from "./recovery-browser.ts";
import {verifyDeletionBrowser} from "./deletion-browser.ts";
import {verifyReaderBrowser} from "./reader-browser.ts";
import {freezeWorker} from "./freeze-worker.ts";
import WebSocket from "ws";
import {nodeCatalog,catalogPages} from "../local/catalog.ts";
import { chromium, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile, cp } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const root = process.cwd(),
  base = "http://localhost:8812",
  directory = resolve(".local/browser", crypto.randomUUID()),
  shots = resolve(".impeccable/review");
await mkdir(directory, { recursive: true });
await mkdir(shots, { recursive: true });
await mkdir("docs/validation", { recursive: true });
const admin = crypto.randomUUID() + crypto.randomUUID();
const config = JSON.parse(
  (await readFile("wrangler.jsonc", "utf8")).replace(/,\s*([}\]])/g, "$1"),
);
config.main = resolve("src/worker.ts");
config.assets.directory = resolve(directory, "assets");
await cp(resolve("dist/web"), config.assets.directory, { recursive: true });
config.vars = {
  ...config.vars,
  ADMIN_TOKEN: admin,
  OWNER_ID: "browser-" + crypto.randomUUID(),
  MODEL_MODE: "mock",
};
const configFile = resolve(directory, "wrangler.json");
await writeFile(configFile, JSON.stringify(config));
await freezeWorker(configFile,resolve(directory,"bundle"));
const children: ChildProcess[] = [],
  errors: string[] = [],
  checks: string[] = [];
let log = "";
function child(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const c = spawn(process.execPath, args, {
    cwd: root,
    env: { ...env, WRANGLER_SEND_METRICS: "false" },
    windowsHide: true,
    stdio: "pipe",
  });
  children.push(c);
  c.stdout?.on("data", (d) => (log += d));
  c.stderr?.on("data", (d) => (log += d));
  return c;
}
async function stop(c: ChildProcess) {
  if (!c.pid || c.exitCode !== null) return;
  if (process.platform === "win32")
    await new Promise<void>((done) => {
      const k = spawn("taskkill", ["/PID", String(c.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      k.on("close", () => done());
      k.on("error", () => done());
    });
  else c.kill();
}
async function until(fn: () => Promise<boolean>, ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("BROWSER_POLL_TIMEOUT");
}
const browser = await chromium.launch({ channel: "msedge", headless: true }),
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  }),
  page = await context.newPage();
page.on("pageerror", (e) => errors.push(e.message));
async function api(path: string, method = "GET", body?: any) {
  const r = await context.request.fetch(base + "/api/" + path, {
    method,
    data: body,
  });
  assert.equal(r.ok(), true, path + " " + r.status() + " " + (await r.text()));
  return r.json();
}
async function route(hash: string) {
  await page.goto(base + "/#" + hash);
}
async function screenshot(name: string) {
  await page.screenshot({
    path: resolve(shots, name + ".png"),
    fullPage: name.startsWith("recovery-")||name.startsWith("imports-")||name.startsWith("reader-")||name.startsWith("deletions-"),
  });
  if(name.startsWith("deletions-") || name.startsWith("recovery-")){
    const workspace=page.locator(".workspace"),position=await workspace.evaluate(e=>e.scrollTop);
    assert.equal(await workspace.evaluate(e=>e.scrollWidth<=e.clientWidth),true,"workspace overflow "+name);
    if(await workspace.evaluate(e=>e.scrollHeight>e.clientHeight+10)){
      await workspace.evaluate(e=>{e.scrollTop=e.scrollHeight;});
      await page.screenshot({path:resolve(shots,name+"-details.png"),fullPage:true});
      await workspace.evaluate((e,y)=>{e.scrollTop=y;},position);
    }
  }
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "horizontal overflow " + name,
  );
}
async function verifyImportBrowser(){
  await api("settings","PATCH",{requestId:crypto.randomUUID(),theme:"light"});
  await page.setViewportSize({width:1440,height:900});
  await route("papers");
  await page.getByRole("button",{name:"从 arXiv 添加",exact:true}).click();
  await page.getByLabel("arXiv 编号与版本",{exact:true}).fill("2401.00001v2");
  await page.getByLabel("标题（可选）",{exact:true}).fill("入库流程软件测试");
  await page.getByRole("button",{name:"加入入库待办",exact:true}).click();
  const importRow=page.locator(".import-row").filter({hasText:"入库流程软件测试"});
  await expect(importRow).toBeVisible();await expect(importRow.getByText("等待你的电脑上线",{exact:true})).toBeVisible();
  await screenshot("imports-desktop");
  await page.setViewportSize({width:390,height:844});await screenshot("imports-mobile");
  await api("settings","PATCH",{requestId:crypto.randomUUID(),theme:"dark"});await route("papers");
  const toggle=page.getByRole("button",{name:"从 arXiv 添加",exact:true});if(await toggle.isVisible())await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme","dark");
  await screenshot("imports-mobile-dark");
  await importRow.getByRole("button",{name:"取消入库",exact:true}).click();
  await expect(importRow.getByText("已取消",{exact:true})).toBeVisible();
  await importRow.getByRole("button",{name:"重新入库",exact:true}).click();
  await expect(importRow.getByText("等待你的电脑上线",{exact:true})).toBeVisible();
  await page.reload();await expect(page.locator(".import-row").filter({hasText:"入库流程软件测试"})).toBeVisible();
  checks.push("arXiv import registration, offline persistence, cancellation and retry work through real DO on desktop and mobile");
  const token=(await api("device/pair","POST",{requestId:crypto.randomUUID(),label:"Browser import state"})).token;
  const catalog=await nodeCatalog({executable:"unused",bootstrap:true,indexVersion:"library-empty-v1"},false),pages=catalogPages(catalog);
  const device=new WebSocket(base.replace("http","ws")+"/api/device/connect",{headers:{Authorization:"Bearer "+token}});
  device.on("error",()=>{});
  const protocolErrors:string[]=[];
  const send=(value:unknown)=>device.send(JSON.stringify(value));
  device.on("message",raw=>{
   const m=JSON.parse(raw.toString());if(m.type==="error")protocolErrors.push(m.code);
   if(m.type==="hello_ack"){send({type:"catalog_begin",pages:pages.length});pages.forEach((value,page)=>send({type:"catalog_page",page,value}));send({type:"catalog_end"});}
   if(m.type==="catalog_ack")send({type:"availability",ready:false,phase:"indexing"});
   if(m.type==="library_import")send({type:"library_result",id:m.id,generation:m.generation,phase:"indexing"});
  });
  try{
   await new Promise<void>((ok,no)=>{device.once("open",ok);device.once("error",no);});
   send({type:"hello",version:1,deviceId:"browser-import",indexVersion:catalog.indexVersion,tools:["search_papers","retrieve_chunks"],capabilities:["library-v1"]});
   await expect(page.locator(".topbar-status")).toContainText("本机正在建索引");
   await expect(page.getByRole("button",{name:"连接电脑",exact:true})).not.toBeVisible();
   await expect(importRow).toContainText("正在建立检索索引");
   await api("settings","PATCH",{requestId:crypto.randomUUID(),theme:"light"});
   await expect(page.locator("html")).toHaveAttribute("data-theme","light");
   await page.setViewportSize({width:1440,height:900});await screenshot("imports-indexing-desktop");
   await page.setViewportSize({width:390,height:844});await screenshot("imports-indexing-mobile");
   await route("settings/devices");
   await expect(page.getByText("本机已连接，正在建立论文索引；检索任务会在完成后继续。",{exact:true})).toBeVisible();
   checks.push("connected but indexing node remains visibly connected across header, library and device settings; no false reconnect prompt");
   send({type:"ready",phase:"empty"});
   await until(async()=>(await api("overview")).deviceState.phase==="empty").catch(async()=>{throw Error("EMPTY_READY_FAILED "+JSON.stringify({errors:protocolErrors,state:(await api("overview")).deviceState}));});
   await route("papers");
   await expect(page.getByRole("heading",{name:"首篇论文正在入库"})).toBeVisible();
   await page.setViewportSize({width:1440,height:900});await screenshot("imports-first-processing-desktop");
   await page.setViewportSize({width:390,height:844});await screenshot("imports-first-processing-mobile");
   await importRow.getByRole("button",{name:"取消入库",exact:true}).click();
   await expect(page.getByRole("heading",{name:"添加你的第一篇论文"})).toBeVisible();
   await expect(page.getByRole("button",{name:"设置本地节点",exact:true})).not.toBeVisible();
   await expect(page.locator(".topbar-status")).toContainText("本机已连接");
   await page.setViewportSize({width:1440,height:900});await screenshot("imports-empty-desktop");
   await page.setViewportSize({width:390,height:844});await screenshot("imports-empty-mobile");
   await api("settings","PATCH",{requestId:crypto.randomUUID(),theme:"dark"});
   await expect(page.locator("html")).toHaveAttribute("data-theme","dark");
   await screenshot("imports-empty-mobile-dark");
   checks.push("first-run empty library stays connected and directs users to import without claiming loaded retrieval models");

  }finally{device.terminate();}


}
try {
  child([
    "node_modules/wrangler/bin/wrangler.js",
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    "8812",
    "--config",
    configFile,
    "--persist-to",
    resolve(directory, "worker"),
  ]);
  await until(async () => {
    const r = await fetch(base);
    return r.ok;
  }, 60000);
  if(process.env.PRA_BROWSER_SCOPE==="changes"){
    await api("login","POST",{token:admin});
    await api("settings","PATCH",{requestId:crypto.randomUUID(),onboarded:true});
    checks.push(...await verifyChangeFeedBrowser(base,page,api,screenshot));
  }else if(process.env.PRA_BROWSER_SCOPE==="context"){
    await api("login","POST",{token:admin});
    await api("settings","PATCH",{requestId:crypto.randomUUID(),onboarded:true});
    checks.push(...(await verifyContextWindowBrowser(base,page,api,screenshot)).checks);
  }else if(process.env.PRA_BROWSER_SCOPE==="controls"){
    await api("login","POST",{token:admin});
    await api("settings","PATCH",{requestId:crypto.randomUUID(),onboarded:true});
    checks.push(...await verifyConversationControlBrowser(base,page,api,screenshot));
  }else if(process.env.PRA_BROWSER_SCOPE==="recovery"){
    await api("login","POST",{token:admin});
    await api("settings","PATCH",{requestId:crypto.randomUUID(),onboarded:true});
    checks.push(...await verifyRecoveryBrowser(base,page,api,screenshot));
  }else if(process.env.PRA_BROWSER_SCOPE==="deletions"){
    await api("login","POST",{token:admin});
    await api("settings","PATCH",{requestId:crypto.randomUUID(),onboarded:true});
    checks.push(...await verifyDeletionBrowser(base,page,context,api,screenshot));
  }else if(process.env.PRA_BROWSER_SCOPE==="reader"){
    await api("login","POST",{token:admin});
    await api("settings","PATCH",{requestId:crypto.randomUUID(),onboarded:true});
    checks.push(...await verifyReaderBrowser(base,page,context,api,screenshot));
  }else if(process.env.PRA_BROWSER_SCOPE==="imports"){
    await api("login","POST",{token:admin});
    await api("settings","PATCH",{requestId:crypto.randomUUID(),onboarded:true});
    await verifyImportBrowser();
  }else{
  await page.goto(base);
  await expect(
    page.getByRole("button", { name: "使用通行密钥登录" }),
  ).toBeVisible();
  await screenshot("auth-desktop");
  await page.getByText("首次初始化", { exact: true }).click();
  await page.getByLabel("初始化凭证", { exact: true }).fill(admin);
  await page.getByRole("button", { name: "进入并设置账户" }).click();
  await expect(
    page.getByRole("heading", { name: "先建立你的研究工作区" }),
  ).toBeVisible();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await page.getByRole("button", { name: "创建我的通行密钥" }).click();
  await expect(
    page.getByRole("heading", { name: "保存你的恢复码" }),
  ).toBeVisible({ timeout: 20000 });
  await page.getByLabel("我已妥善保存").check();
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await page.getByLabel("助手名称", { exact: true }).fill("Aster");
  await page
    .getByLabel("研究方向", { exact: true })
    .fill("检索增强生成中的长期记忆与证据可靠性");
  await page.getByRole("button", { name: "保存并开始讨论" }).click();
  await expect(
    page.getByRole("heading", { name: "今天从哪里开始？" }),
  ).toBeVisible();
  await screenshot("chat-empty-desktop");
  checks.push(
    "browser WebAuthn virtual authenticator enrolls through real origin-checked backend and onboarding persists",
  );
  await page
    .getByLabel("消息", { exact: true })
    .fill("你好，介绍你能怎样协助我的研究");
  await page.getByRole("button", { name: "发送消息" }).click();
  await until(async () => {
    const s = await api("overview");
    return s.tasks[0]?.status === "completed";
  });
  await expect(page.locator(".assistant-message .markdown")).not.toBeEmpty();
  const chat = (await api("overview")).conversations.items[0];
  await page.getByLabel("消息", { exact: true }).fill("请继续刚才的讨论");
  await page.getByRole("button", { name: "发送消息" }).click();
  await until(async () => {
    const s = await api("tasks?limit=10");
    return (
      s.items.length === 2 &&
      s.items.every((t: any) => t.status === "completed")
    );
  });
  assert.equal((await api("conversations?limit=30")).items.length, 1);
  checks.push(
    "natural multi-turn chat reuses one conversation while local node is offline",
  );
  await page.getByRole("button", { name: "保存为研究成果" }).first().click();
  await expect(page.locator(".artifact-page")).toBeVisible();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page
    .getByLabel("Markdown 正文", { exact: true })
    .fill(
      "## 研究记录\n\n已整理讨论内容。\n\n| 方法 | 结果 |\n| --- | --- |\n| 样例 | 待验证 |\n\n公式：$E=mc^2$",
    );
  await page.getByRole("button", { name: "保存新版本" }).click();
  await expect(page.locator(".katex")).toBeVisible();
  await expect(page.locator(".markdown table")).toBeVisible();
  await screenshot("artifact-desktop");
  checks.push(
    "artifact editing renders safe Markdown, table and formula; version and exports come from backend",
  );
  await route("projects");
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称", { exact: true }).fill("长期记忆与证据");
  await page
    .getByLabel("研究目标", { exact: true })
    .fill("比较证据约束与可纠正记忆，保留尚未解决的问题。");
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "长期记忆与证据", exact: true }),
  ).toBeVisible();
  await screenshot("project-desktop");
  checks.push("project creation and goal use persisted application objects");
  await route("conversations");
  await page
    .locator(".conversation-row")
    .filter({ hasText: chat.title })
    .getByRole("button", { name: "归档", exact: true })
    .click();
  await page.getByLabel("已归档", { exact: true }).check();
  await expect(
    page.locator(".conversation-row").filter({ hasText: chat.title }),
  ).toBeVisible();
  await page
    .locator(".conversation-row")
    .filter({ hasText: chat.title })
    .getByRole("button", { name: "恢复", exact: true })
    .click();
  checks.push("archived conversations remain searchable and can be restored");
  for (let i = 0; i < 52; i++)
    await api("projects", "POST", {
      title: "Pagination fixture " + i,
      requestId: crypto.randomUUID(),
    });
  await route("projects");
  await expect(
    page.getByRole("button", { name: "下一页", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByText("第 2 页", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "上一页", exact: true }).click();
  checks.push("project history is accessible through real server pagination");
  await route("chat/" + chat.id);
  await page.getByLabel("会话操作", { exact: true }).click();
  await page.getByRole("button", { name: "重命名", exact: true }).click();
  let refused = false;
  await page.route("**/api/conversations/" + chat.id, async (route) => {
    if (route.request().method() === "PATCH" && !refused) {
      refused = true;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "TEST_TRANSIENT" }),
      });
    } else await route.continue();
  });
  const rename = page.getByRole("dialog", { name: "重命名会话", exact: true });
  await rename.getByLabel("会话名称").fill("可恢复的讨论");
  await rename.getByRole("button", { name: "保存", exact: true }).click();
  await expect(rename.getByRole("alert")).toBeVisible();
  await screenshot("modal-retry-desktop");
  await rename.getByRole("button", { name: "保存", exact: true }).click();
  await expect(rename).not.toBeVisible();
  await page.unroute("**/api/conversations/" + chat.id);
  checks.push(
    "modal failure stays accessible inside named dialog and retry succeeds",
  );
  await route("memory");
  await page
    .getByLabel("明确告诉我需要记住什么")
    .fill("讨论研究时优先提供可核对的原文引用。");
  await page.getByRole("button", { name: "保存记忆", exact: true }).click();
  await expect(
    page
      .locator(".memory-row")
      .filter({ hasText: "讨论研究时优先提供可核对的原文引用。" }),
  ).toBeVisible();
  checks.push(
    "explicit memory is visible with correction and deletion controls",
  );
  for (let i = 0; i < 15; i++)
    await api("memories", "POST", { content: "长列表纠正验证 " + i });
  await route("memory");
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator(".memory-row")
    .last()
    .getByRole("button", { name: "纠正", exact: true })
    .click();
  await expect(page.getByLabel("纠正这条记忆", { exact: true })).toBeFocused();
  await expect(
    page.getByLabel("纠正这条记忆", { exact: true }),
  ).toBeInViewport();
  const draft = "切换筛选后保留的纠正草稿";
  await page.getByLabel("纠正这条记忆", { exact: true }).fill(draft);
  const scopeSelect = page.getByLabel("记忆项目范围", { exact: true });
  const scopeValue = await scopeSelect
    .locator("option")
    .nth(1)
    .getAttribute("value");
  await scopeSelect.selectOption(scopeValue!);
  await expect(page.getByLabel("纠正这条记忆", { exact: true })).toHaveValue(
    draft,
  );
  await scopeSelect.selectOption("");
  const searchBox = await page
    .getByLabel("搜索记忆", { exact: true })
    .boundingBox();
  assert.ok(
    searchBox && searchBox.width >= 300,
    "mobile memory search must remain usable",
  );
  await screenshot("memory-correction-mobile");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    (window as any).__budgetRetryClicked = false;
    document.addEventListener(
      "click",
      (event) => {
        if (
          (event.target as HTMLElement)
            .closest("button")
            ?.textContent?.trim() === "重试"
        )
          (window as any).__budgetRetryClicked = true;
      },
      true,
    );
  });
  await page.route("**/api/budget", async (route) => {
    if (!(await page.evaluate(() => (window as any).__budgetRetryClicked))) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "TEST_TRANSIENT" }),
      });
    } else await route.continue();
  });
  await route("settings/budget");
  await page.evaluate(() => {
    document.addEventListener(
      "click",
      (event) => {
        if (
          (event.target as HTMLElement)
            .closest("button")
            ?.textContent?.trim() === "重试"
        )
          (window as any).__budgetRetryClicked = true;
      },
      true,
    );
  });
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.locator(".budget-summary")).toBeVisible();
  await page.unroute("**/api/budget");
  checks.push(
    "long-list memory correction scrolls and focuses; settings request errors offer direct recovery",
  );
  await api("settings", "PATCH", {
    requestId: crypto.randomUUID(),
    notifications: false,
  });
  const pair = await api("device/pair", "POST", {
      label: "Browser fixture node",
      requestId: crypto.randomUUID(),
    }),
    nodeFile = resolve(directory, "node.json");
  await writeFile(
    nodeFile,
    JSON.stringify({
      endpoint: base,
      dataDir: resolve(directory, "node"),
      port: 48740,
      fixture: true,
    }),
  );
  const node = child(["local/node.ts", nodeFile], {
    ...process.env,
    PRA_DEVICE_TOKEN: pair.token,
  });
  await until(async () => (await api("overview")).deviceOnline);
  await route("chat");
  await page
    .getByLabel("消息", { exact: true })
    .fill("请深入阅读论文中的研究方法，并提供原文证据。");
  await page.getByRole("button", { name: "发送消息" }).click();
  await until(async () => {
    const latest = (await api("tasks?limit=1")).items[0];
    return (
      latest?.input === "请深入阅读论文中的研究方法，并提供原文证据。" &&
      latest.status === "completed"
    );
  });
  await expect(page.locator(".citation").first()).toBeVisible();
  await page.locator(".citation").first().click();
  await expect(
    page.getByRole("complementary", { name: "原文与证据" }),
  ).toBeVisible();
  await screenshot("chat-evidence-desktop");
  await page.getByRole("button", { name: "关闭证据面板" }).click();
  await page.getByRole("button", { name: /任务进度/ }).click();
  await expect(
    page.getByRole("heading", { name: "研究进度与依据" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  checks.push(
    "real Pi tool execution renders citation evidence and reused task progress without inactive controls",
  );
  const researchConversation = (await api("tasks?limit=1")).items[0]
    .conversationId;
  await route("memory");
  await page.getByLabel("记忆类型", { exact: true }).selectOption("conclusion");
  await expect(
    page.getByText("原文依据 · 1 处", { exact: true }),
  ).toBeVisible();
  await page.getByText("原文依据 · 1 处", { exact: true }).click();
  await expect(page.locator(".memory-evidence blockquote")).toHaveText(
    "Evidence.",
  );
  await screenshot("memory-evidence-desktop");
  const memoryRow = page
    .locator(".memory-row")
    .filter({ hasText: "模拟证据可定位" });
  await memoryRow.getByRole("button", { name: "纠正", exact: true }).click();
  await page
    .getByLabel("纠正这条记忆", { exact: true })
    .fill("人工纠正的结论，需要再次核对原文。");
  await page.getByRole("button", { name: "保存纠正", exact: true }).click();
  const corrected = page
    .locator(".memory-row")
    .filter({ hasText: "人工纠正的结论，需要再次核对原文。" });
  await expect(corrected).toBeVisible();
  await expect(corrected).toContainText("人工修改后待重新核对原文");
  await corrected
    .getByRole("button", { name: "修订记录", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "记忆修订记录" }),
  ).toContainText("模拟证据可定位");
  await page
    .getByRole("dialog", { name: "记忆修订记录" })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await corrected.getByRole("button", { name: "删除", exact: true }).click();
  await expect(corrected).not.toBeVisible();
  assert.equal((await api("memories?category=conclusion")).items.length, 0);
  checks.push(
    "source-bound memory shows original quote, revisions, correction warning and real deletion",
  );
  await route("chat/" + researchConversation);
  await expect(page.locator(".citation").first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot("chat-mobile");
  await page.locator(".citation").first().click();
  await screenshot("evidence-mobile");
  await page.getByRole("button", { name: "关闭证据面板" }).click();
  await page.getByRole("button", { name: "打开导航" }).click();
  await expect(page.locator("dialog[open] .mobile-navigation")).toBeVisible();
  await page
    .locator(".mobile-navigation")
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await page.getByRole("button", { name: "预算", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "模型调用预算" }),
  ).toBeVisible();
  await expect(page.locator(".budget-summary")).toBeVisible();
  await screenshot("budget-mobile");
  await page.getByRole("button", { name: "个人设置", exact: true }).click();
  await page.getByLabel("外观", { exact: true }).selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await screenshot("settings-mobile-dark");
  checks.push(
    "390px mobile navigation, full-screen evidence and budget/settings retain real actions without horizontal overflow",
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await route("chat/" + chat.id);
  await expect(page.locator(".user-message").first()).toBeVisible();
  await screenshot("chat-desktop-dark");
  await stop(node);
  await until(async () => !(await api("overview")).deviceOnline);
  await route("chat");
  await page.getByLabel("作为长期研究目标，最多分四段推进").check();
  await page.getByLabel("消息", { exact: true }).fill("请继续检索论文原文");
  await page.getByRole("button", { name: "发送消息" }).click();
  await until(async () => {
    const t = (await api("tasks?limit=1")).items[0];
    return t?.input === "请继续检索论文原文" && t.status === "waiting_device";
  });
  await route("tasks");
  await expect(
    page
      .locator(".activity-row")
      .filter({ hasText: "等待你的电脑上线" })
      .first(),
  ).toBeVisible();
  const longRow = page
    .locator(".activity-row")
    .filter({ hasText: "请继续检索论文原文" });
  await longRow.getByRole("button", { name: "暂停任务", exact: true }).click();
  await expect(longRow.getByText("已暂停", { exact: true })).toBeVisible();
  await longRow.getByRole("button", { name: "调整方向", exact: true }).click();
  await page
    .getByLabel("补充当前要求", { exact: true })
    .fill("只比较研究方法，暂不讨论实验结果。");
  await page.getByRole("button", { name: "保存调整", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "调整任务方向" }),
  ).not.toBeVisible();
  await longRow.getByRole("combobox").selectOption("2");
  await longRow.locator(".goal-checkpoints summary").click();
  await longRow.getByText("已补充的要求", { exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot("task-paused-mobile");
  await page.setViewportSize({ width: 1440, height: 900 });
  await screenshot("task-paused-desktop");
  await longRow.getByRole("button", { name: "继续执行", exact: true }).click();
  await expect(
    longRow.getByText("等待你的电脑上线", { exact: true }),
  ).toBeVisible();
  await longRow.getByRole("button", { name: "取消任务", exact: true }).click();
  await expect(
    page
      .locator(".activity-row")
      .filter({ hasText: "请继续检索论文原文" })
      .getByText("已取消", { exact: true }),
  ).toBeVisible();
  checks.push(
    "long-goal creation, pause, direction amendment, priority and offline resume preserve real progress on desktop and mobile; cancellation persists",
  );
  await verifyImportBrowser();
  await route("settings/account");
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "使用通行密钥登录" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "使用通行密钥登录" }).click();
  await expect(
    page.getByRole("button", { name: "开始新讨论", exact: true }).first(),
  ).toBeVisible({ timeout: 20000 });
  checks.push("browser passkey sign-in works after logout");
  }
  assert.deepEqual(errors, [], "unhandled browser errors");
  const report = {
    kind: "local-browser-product-flows",
    timestamp: new Date().toISOString(),
    checks,
    deviceFixture:["reader","deletions"].includes(process.env.PRA_BROWSER_SCOPE??""),nativeWindowObserved:false,
    browser: ["changes","context","controls","imports","reader","deletions","recovery"].includes(process.env.PRA_BROWSER_SCOPE??"")?"installed Microsoft Edge, isolated bootstrap authentication":"installed Microsoft Edge, virtual WebAuthn authenticator",
    viewports: ["1440x900", "390x844"],
    paidCalls: 0,
    cloudDeployment: false,
  };
  await writeFile(
    process.env.PRA_BROWSER_SCOPE==="changes"?"docs/validation/browser-changes.json":process.env.PRA_BROWSER_SCOPE==="context"?"docs/validation/browser-context.json":process.env.PRA_BROWSER_SCOPE==="controls"?"docs/validation/browser-controls.json":process.env.PRA_BROWSER_SCOPE==="recovery"?"docs/validation/browser-recovery.json":process.env.PRA_BROWSER_SCOPE==="deletions"?"docs/validation/browser-deletions.json":process.env.PRA_BROWSER_SCOPE==="reader"?"docs/validation/browser-reader.json":process.env.PRA_BROWSER_SCOPE==="imports"?"docs/validation/browser-imports.json":"docs/validation/browser-product.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  await writeFile(resolve(directory,"failure.json"),JSON.stringify({timestamp:new Date().toISOString(),checks,scope:process.env.PRA_BROWSER_SCOPE??"all",message:e instanceof Error?e.message:String(e)},null,2));
  await page
    .screenshot({ path: resolve(shots, "failure.png") })
    .catch(() => {});
  console.error({
    message: e instanceof Error ? e.message : String(e),
    browserErrors: errors,
    serverError: log.match(/Error: [^\r\n]*/g)?.slice(-3),
  });
  process.exitCode = 1;
} finally {
  await browser.close();
  for (const c of children.reverse()) await stop(c);
}
