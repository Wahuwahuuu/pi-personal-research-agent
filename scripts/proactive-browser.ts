import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
export async function verifyProactiveBrowser(
  base: string,
  cookie: string,
  api: (path: string, method?: string, body?: any) => Promise<any>,
  directory: string,
  planId: string,
  failedId: string,
) {
  const browser = await chromium.launch({ channel: "msedge", headless: true }),
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
  const at = cookie.indexOf("=");
  await context.addCookies([
    {
      name: cookie.slice(0, at),
      value: cookie.slice(at + 1),
      url: base,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  const page = await context.newPage(),
    errors: string[] = [],
    checks: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const requests: {
    at: number;
    method: string;
    path: string;
    status?: number;
    failure?: string;
  }[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/plans"))
      requests.push({
        at: Date.now(),
        method: r.method(),
        path: new URL(r.url()).pathname,
      });
  });
  page.on("response", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/plans"))
      requests.push({
        at: Date.now(),
        method: r.request().method(),
        path: new URL(r.url()).pathname,
        status: r.status(),
      });
  });
  const shots = resolve(".impeccable/review");
  await mkdir(shots, { recursive: true });
  const shot = async (name: string) => {
    await page.screenshot({
      path: resolve(shots, name + ".png"),
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      "horizontal overflow " + name,
    );
  };
  const inbox = async () => {
    await page.goto(base + "/#inbox");
    await page
      .getByRole("button", { name: "管理关注主题", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "关注主题", exact: true }),
    ).toBeVisible();
  };
  try {
    await inbox();
    const planPermissions=async()=> (await api("overview")).plans.map((p:any)=>({id:p.id,enabled:p.enabled,autoProcess:p.autoProcess})).sort((a:any,b:any)=>a.id.localeCompare(b.id));
    const beforeDraft=await planPermissions();
    await page
      .getByRole("button", { name: "新建关注计划", exact: true })
      .click();
    await page
      .getByLabel("想持续关注什么", { exact: true })
      .fill("每天关注科研智能体");
    await page
      .getByRole("button", { name: "生成可编辑草稿", exact: true })
      .click();
    await expect(
      page.getByText(
        "请补充 arXiv 英文检索词。研究目标可以保留中文，系统不会猜测翻译。",
        { exact: true },
      ),
    ).toBeVisible();
    assert.deepEqual(await planPermissions(),beforeDraft,"draft cannot create or enable a plan");
    assert.ok(!requests.some(r=>r.method==="POST"&&r.path==="/api/plans"),"draft must not submit a plan mutation");
    await page
      .getByLabel("想持续关注什么", { exact: true })
      .fill(
        "每天关注 retrieval augmented generation，重点看证据可靠性，最多两篇",
      );
    await page
      .getByRole("button", { name: "生成可编辑草稿", exact: true })
      .click();
    await expect(
      page.getByLabel("arXiv 检索关键词", { exact: true }),
    ).toHaveValue("retrieval augmented generation");
    await page
      .getByLabel("允许自动下载、索引、阅读相关论文并整理研究记录", {
        exact: true,
      })
      .check();
    await expect(
      page.getByLabel("每轮最多深入处理", { exact: true }),
    ).toHaveValue("2");
    await shot("proactive-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await shot("proactive-mobile");
    await api("settings", "PATCH", {
      requestId: crypto.randomUUID(),
      theme: "dark",
    });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await shot("proactive-mobile-dark");
    await page
      .getByRole("button", { name: "保存并启用计划", exact: true })
      .scrollIntoViewIfNeeded();
    await shot("proactive-permission-mobile");
    await page
      .getByLabel("允许自动下载、索引、阅读相关论文并整理研究记录", {
        exact: true,
      })
      .uncheck();
    await page
      .getByRole("button", { name: "保存并启用计划", exact: true })
      .click();
    const newRow = page.locator(".watch-row").filter({
      has: page.getByRole("heading", {
        name: "retrieval augmented generation",
        exact: true,
      }),
    });
    await expect(newRow).toBeVisible();
    await expect(newRow).toContainText("仅保存文献线索");
    const created = (await api("overview")).plans.find(
      (p: any) => p.query === "retrieval augmented generation",
    );
    assert.equal(created.autoProcess, false);
    assert.equal(created.maxPapers, 2);
    await newRow.getByRole("button", { name: "暂停计划", exact: true }).click();
    await expect(newRow).toContainText("已暂停");
    await newRow.getByRole("button", { name: "编辑", exact: true }).click();
    await expect(
      page.getByLabel("arXiv 检索关键词", { exact: true }),
    ).toBeFocused();
    const editorBox = await page.locator(".watch-editor").boundingBox();
    assert.ok(
      editorBox && editorBox.y >= 50 && editorBox.y < 200,
      "edit should position the form below the fixed header",
    );
    await page.getByRole("button", { name: "取消编辑", exact: true }).click();
    await expect(
      newRow.getByRole("button", { name: "编辑", exact: true }),
    ).toBeFocused();
    await newRow.getByRole("button", { name: "编辑", exact: true }).click();
    await expect(
      page.getByLabel("arXiv 检索关键词", { exact: true }),
    ).toBeFocused();
    await page
      .getByLabel("允许自动下载、索引、阅读相关论文并整理研究记录", {
        exact: true,
      })
      .check();
    let rejected = false;
    await page.route("**/api/plans/" + created.id, async (route) => {
      if (route.request().method() === "PATCH" && !rejected) {
        rejected = true;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"error":"SERVICE_UNAVAILABLE"}',
        });
      } else await route.continue();
    });
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/plans/" + created.id) && r.status() === 503,
      ),
      page.getByRole("button", { name: "保存修改", exact: true }).click(),
    ]);
    await expect(page.getByLabel("研究目标", { exact: true })).toHaveValue(
      created.objective,
    );
    await expect(
      page.getByRole("button", { name: "保存修改", exact: true }),
    ).toBeEnabled();
    const [savedResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/plans/" + created.id) &&
          r.request().method() === "PATCH",
        { timeout: 20000 },
      ),
      page.getByRole("button", { name: "保存修改", exact: true }).click(),
    ]);
    assert.equal(savedResponse.status(), 200);
    await expect(newRow).toContainText("自动处理已授权");
    assert.equal(
      (await api("overview")).plans.find((p: any) => p.id === created.id)
        .enabled,
      false,
    );
    checks.push(
      "editing a lower mobile row scrolls to and focuses the keyword field before any filling action; cancel restores the invoking button",
    );
    checks.push(
      "natural-language drafts require review and explicit permission; real plan writes, pause and failed-write retry preserve inputs",
    );
    await api("settings", "PATCH", {
      requestId: crypto.randomUUID(),
      theme: "light",
    });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.setViewportSize({ width: 1440, height: 1000 });
    const row = page.locator(".watch-row").filter({
      has: page.getByRole("heading", { name: "agents", exact: true }),
    });
    await row.getByRole("button", { name: "查看记录", exact: true }).click();
    await page.locator(".watch-batch-toggle").first().click();
    await expect(
      page.getByRole("heading", { name: "本轮选中的论文 · 1 篇", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".watch-batch-detail")).toContainText(
      "已整理研究结论",
    );
    await page.locator(".watch-batch-detail").scrollIntoViewIfNeeded();
    await shot("proactive-batch-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".watch-batch-detail").scrollIntoViewIfNeeded();
    await shot("proactive-batch-mobile");
    await page
      .locator(".watch-batch-detail")
      .getByRole("button", { name: "阅读阶段简报", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "主题简报 · agents", exact: true }),
    ).toBeVisible();
    checks.push(
      "real batch records distinguish new discoveries from selected backlog and open the saved cited brief on desktop and mobile",
    );
    await inbox();
    const notice = page
      .locator(".notice-row")
      .filter({ hasText: "主题「agents」" });
    await notice
      .getByRole("button", { name: "阅读阶段简报", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "主题简报 · agents", exact: true }),
    ).toBeVisible();
    await inbox();
    const failed = page.locator(".watch-row").filter({
      has: page.getByRole("heading", { name: "sourcefail", exact: true }),
    });
    await failed.getByRole("button", { name: "查看记录", exact: true }).click();
    await page.locator(".watch-batch-toggle").first().click();
    await expect(page.locator(".watch-batch-detail")).toContainText(
      "来源检查尚未完成",
    );
    await page.locator(".watch-history").scrollIntoViewIfNeeded();
    await shot("proactive-error-mobile");
    assert.equal(
      (await api("research-batches?plan=" + failedId)).items[0].discovered,
      0,
    );
    assert.ok(
      (await api("research-batches?plan=" + planId)).items[0].artifactId,
    );
    checks.push(
      "inbox brief opens the actual artifact; source outage displays retained checkpoint and no fabricated discovery or reading progress",
    );
    assert.deepEqual(errors, []);
    return checks;
  } catch (e) {
    await page.screenshot({
      path: resolve(directory, "browser-failure.png"),
      fullPage: true,
    });
    await writeFile(
      resolve(directory, "browser-errors.json"),
      JSON.stringify({ errors, requests }),
    );
    throw e;
  } finally {
    await browser.close();
  }
}
