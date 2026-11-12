import { expect, type Page, type BrowserContext } from "@playwright/test";
import WebSocket from "ws";
import { DatabaseSync } from "node:sqlite";
import { nodeCatalog, catalogPages } from "../local/catalog.ts";
import { ReaderQueue } from "../local/reader-queue.ts";
import assert from "node:assert/strict";
export async function verifyReaderBrowser(
  base: string,
  page: Page,
  context: BrowserContext,
  api: (p: string, m?: string, b?: any) => Promise<any>,
  shot: (n: string) => Promise<void>,
) {
  const checks: string[] = [],
    paired = await api("device/pair", "POST", {
      requestId: crypto.randomUUID(),
      label: "验收电脑",
    });
  const catalog = await nodeCatalog(undefined, true),
    pages = catalogPages(catalog),
    db = new DatabaseSync(":memory:"),
    queue = new ReaderQueue(db);
  const ws = new WebSocket(base.replace("http", "ws") + "/api/device/connect", {
      headers: { Authorization: "Bearer " + paired.token },
    }),
    received: any[] = [],
    errors: string[] = [];
  const send = (v: any) => ws.send(JSON.stringify(v));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "error") errors.push(m.code);
    if (m.type === "hello_ack") {
      send({ type: "catalog_begin", pages: pages.length });
      pages.forEach((value, page) =>
        send({ type: "catalog_page", page, value }),
      );
      send({ type: "catalog_end" });
    }
    if (m.type === "catalog_ack") send({ type: "ready" });
    if (m.type === "reader_open") {
      queue.receive(m);
      received.push(m);
    }
    if (m.type === "reader_ack") queue.ack(m.id);
    if (m.type === "reader_cancel") queue.cancel(m.id);
  });
  const until = async (f: () => Promise<boolean>, ms = 15000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await f()) return;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw Error("READER_CHECK_TIMEOUT");
  };
  const fail = async (body: any, status: number) => {
    const r = await context.request.post(base + "/api/reader/open", {
      data: body,
    });
    assert.equal(r.status(), status, await r.text());
  };
  try {
    await new Promise<void>((ok, no) => {
      ws.once("open", ok);
      ws.once("error", no);
    });
    send({
      type: "hello",
      version: 1,
      deviceId: "reader-check",
      indexVersion: catalog.indexVersion,
      tools: ["search_papers", "retrieve_chunks"],
      capabilities: ["reader-v1"],
    });
    await until(async () => (await api("papers")).length === 1);
    let releaseCheck!:()=>void;
    const slowCheck=new Promise<void>(r=>{releaseCheck=r;});
    await page.route("**/api/reader/status?*",async route=>{await slowCheck;await route.continue().catch(()=>{});});
    await page.goto(base + "/#papers");
    await page
      .getByRole("button", { name: catalog.papers[0].title, exact: true })
      .click();
    const open = page.getByRole("button", {
      name: "在已连接电脑打开",
      exact: true,
    });
    await expect(page.getByText("正在检查本机阅读器，请稍候。",{exact:true})).toBeVisible();
    await shot("reader-checking-desktop");
    const released=page.waitForResponse(r=>r.url().includes("/api/reader/status?")&&r.status()===200);releaseCheck();await released;await page.unroute("**/api/reader/status?*");
    await expect(open).toBeDisabled();
    await expect(
      page.getByText("请打开 Windows 托盘并连接本机，才能打开本地全文。", {
        exact: true,
      }),
    ).toBeVisible();
    await shot("reader-unavailable-desktop");
    const body = {
      requestId: crypto.randomUUID(),
      paperId: "fixture-paper",
      indexVersion: "fixture-v1",
    };
    await fail(body, 409);
    send({ type: "reader_status", ready: true });
    await expect(open).toBeEnabled({ timeout: 15000 });
    await fail(
      { ...body, requestId: crypto.randomUUID(), paperId: "private-other" },
      404,
    );
    await fail(
      { ...body, requestId: crypto.randomUUID(), chunkId: "forged" },
      409,
    );
    assert.equal(
      (await api("reader/status?indexVersion=not-retained")).available,
      false,
    );
    checks.push(
      "real DO verifies identity, evidence and retained index; a connected node without an active tray cannot open a paper",
    );
    await page.route("**/api/reader/status?*",route=>route.abort());
    await expect(page.getByRole("button",{name:"重新检查连接",exact:true})).toBeVisible({timeout:15000});
    await expect(open).toBeDisabled();
    await shot("reader-status-failed-desktop");
    await page.unroute("**/api/reader/status?*");
    await page.getByRole("button",{name:"重新检查连接",exact:true}).click();
    await expect(open).toBeEnabled();
    checks.push("initial checking and a failed status query have separate truthful feedback and recover in place");
    await shot("reader-ready-desktop");
    await open.focus();
    await page.keyboard.press("Enter");
    await until(async () => received.length > 0);
    const first = received[0],
      claim = queue.claim();
    assert.equal(claim?.id, first.id);
    await expect(
      page.getByText("请求已保存，正在等待阅读窗口打开。", { exact: true }),
    ).toBeVisible();
    assert.equal((await api("reader/" + first.id)).status, "queued");
    for (let i = 0; i < 5; i++)
      await api("reader/open", "POST", { ...body, requestId: first.id });
    assert.equal(queue.claim(), null);
    assert.ok(received.every((r) => r.id === first.id));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button",{name:"关闭证据面板",exact:true}).click();
    await page.getByRole("button",{name:catalog.papers[0].title,exact:true}).click();
    await expect(page.getByRole("button",{name:"正在交给本机阅读器…",exact:true})).toBeDisabled();
    await expect(page.getByText("请求已保存，正在等待阅读窗口打开。",{exact:true})).toBeVisible();
    await page.reload();
    await page.getByRole("button",{name:catalog.papers[0].title,exact:true}).click();
    await expect(page.getByRole("button",{name:"正在交给本机阅读器…",exact:true})).toBeDisabled();
    assert.equal(new Set(received.map(r=>r.id)).size,1);
    await expect(page.getByText("将在「验收电脑」打开全文，文件不会传到当前网页。",{exact:true})).toBeVisible();
    await shot("reader-pending-mobile");
    queue.finish(first.id, true);
    send(queue.results()[0]);
    await expect(
      page.getByText(
        "「验收电脑」已打开阅读窗口。没有可核对的页码映射，已打开全文首页。",
        { exact: true },
      ),
    ).toBeVisible();
    checks.push(
      "keyboard request and five repeated deliveries preserve one claimed action; UI waits for the native receipt and states unmapped page honestly",
    );
    await page
      .getByRole("button", { name: "再次在电脑打开", exact: true })
      .click();
    await until(async () => new Set(received.map((r) => r.id)).size === 2);
    const second = queue.claim()!;
    queue.finish(second.id, false);
    send(queue.results()[0]);
    await expect(
      page.getByText(
        "本机未能打开这份全文，请在 Windows 托盘检查资料是否完整，再重试。",
        { exact: true },
      ),
    ).toBeVisible();
    await api("settings", "PATCH", {
      requestId: crypto.randomUUID(),
      theme: "dark",
    });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await shot("reader-failed-mobile-dark");
    await page.getByRole("button",{name:"重试在电脑打开",exact:true}).click();
    await until(async () => new Set(received.map((r) => r.id)).size === 3);
    const last = received.at(-1);
    await api("device/revoke", "POST", { id: paired.id });
    await expect(
      page.getByText("阅读请求已取消，关联会话或设备权限已有变化。", {
        exact: true,
      }),
    ).toBeVisible();
    assert.equal((await api("reader/" + last.id)).status, "cancelled");
    await expect(page.getByRole("button",{name:"重试在电脑打开",exact:true})).toBeDisabled({ timeout: 15000 });
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("dialog", { name: "原文与证据" }),
    ).not.toBeVisible();
    checks.push(
      "failure, explicit retry, device revocation and mobile focus escape use actual persisted states without duplicate native actions",
    );
    assert.deepEqual(errors, []);
    return checks;
  } finally {
    ws.terminate();
    db.close();
  }
}
