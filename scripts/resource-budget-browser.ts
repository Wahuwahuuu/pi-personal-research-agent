import assert from "node:assert/strict";
import { expect, type Page } from "@playwright/test";
import { PLATFORM_LIMITS } from "../src/platform-resources.ts";

export async function verifyResourceBudget(
  base: string, page: Page, api: (path: string, method?: string, body?: any) => Promise<any>,
  screenshot: (name: string) => Promise<void>, scriptName: string,
) {
  await page.goto(base + "/#settings/budget");
  const panel = page.getByRole("region", { name: "Cloudflare 免费资源" });
  const reload = panel.getByRole("button", { name: "重新读取用量" });
  await expect(panel.getByText("尚未配置自动采集，也尚未收到平台用量。")).toBeVisible();
  await expect(panel.getByRole("table", {name:"免费额度与项目目标"})).toBeVisible();
  await expect(panel.getByText("待报告", {exact:true})).toHaveCount(12);
  await expect(page.getByRole("heading", { name: "模型调用预算" })).toBeVisible();
  const before = await api("budget");
  const counts = (value: number) => Object.fromEntries(Object.keys(PLATFORM_LIMITS).map(key => [key, { status: "observed", value }]));
  async function observe(high: boolean) {
    const observedAt = new Date().toISOString(), day = observedAt.slice(0, 10);
    const account = counts(8), project = counts(0);
    account.workerRequests.value = high ? 90000 : 715;
    account.sqliteStoredBytes.value = 32000000;
    project.workerRequests.value = high ? 9200 : 0;
    if (!high) project.sqliteStoredBytes.status = "no_data";
    return api("platform", "POST", { requestId: crypto.randomUUID(), report: {
      version: 1, source: "Cloudflare GraphQL Analytics API", scriptName,
      accountScope: "a".repeat(64), observedAt, window: { day, timezone: "UTC", start: day + "T00:00:00.000Z", end: observedAt }, account, project,
    } });
  }
  await observe(false);
  await reload.focus();
  await page.keyboard.press("Enter");
  const table = panel.getByRole("table");
  await expect(table.getByRole("row")).toHaveCount(7);
  const worker = table.getByRole("row", { name: /网页与 API 请求/ });
  const storage = table.getByRole("row", { name: /数据库存储/ });
  await expect(worker.getByRole("cell").first().locator("strong")).toHaveText("0");
  await expect(worker.getByRole("cell").last().locator("strong")).toHaveText("715");
  await expect(storage.getByRole("cell").first().locator("strong")).toHaveText("待报告");
  await expect(storage.getByRole("cell").last().locator("strong")).toHaveText("32 MB");
  await expect(panel.getByRole("status")).toContainText("暂时无法确认云端剩余额度");
  await expect(table.locator("caption")).toContainText("UTC");
  await expect(panel.getByText(/最近上报于上海时间/)).toBeVisible();
  await expect(panel.getByText(/当前用量来自手动上报/)).toBeVisible();
  await observe(true);
  await reload.click();
  await expect(panel.getByRole("status")).toContainText("资源已达到保护阈值");
  await expect(worker.getByRole("cell").first()).toContainText("9,200");
  await expect(worker.getByRole("cell").last()).toContainText("90,000");
  await expect(worker.getByText("目标 10,000", {exact:true})).toBeVisible();
  await expect(worker.getByText("免费额度 100,000", {exact:true})).toBeVisible();
  for (const viewport of [{width:1440,height:900}, {width:390,height:844}]) {
    await page.setViewportSize(viewport);
    await table.scrollIntoViewIfNeeded();
    const fits = await panel.evaluate(element => element.scrollWidth <= element.clientWidth);
    assert.equal(fits, true, "resource table overflows the settings panel");
    await expect(table.getByRole("columnheader", {name:"共享账户"})).toBeVisible();
    await screenshot("resource-budget-" + viewport.width);
  }
  const cached = await api("platform?view=budget");
  const path = (u: URL) => u.pathname === "/api/platform" && u.searchParams.get("view") === "budget";
  await page.route(path, route => route.fulfill({status:503,json:{error:"SERVICE_UNAVAILABLE"}}), {times:1});
  await reload.click(); await expect(panel.getByRole("alert")).toContainText("云端服务暂时无法响应");
  await reload.press("Enter"); await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(worker.getByRole("cell").last()).toContainText("90,000");
  const after = await api("budget");
  assert.deepEqual(cached, {...await api("platform?view=budget"), nextCheck:cached.nextCheck});
  assert.deepEqual(after.validation, before.validation);
  return ["Owner quota settings use real workerd storage and synthetic source observations; all six project/account metrics, measured zero, unavailable storage and threshold hold.",
    "Two Edge widths, keyboard refresh, a failed read and recovery; read-only views preserve the model budget and the stored platform snapshot."];
}
