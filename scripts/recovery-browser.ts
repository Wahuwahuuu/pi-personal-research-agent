import assert from "node:assert/strict";
import { expect, type Page } from "@playwright/test";

export async function verifyRecoveryBrowser(
  base: string, page: Page,
  api: (path: string, method?: string, body?: any) => Promise<any>,
  shot: (name: string) => Promise<void>,
) {
  const checks: string[] = [];
  await api("settings", "PATCH", { requestId: crypto.randomUUID(), theme: "light" });
  await page.goto(base + "/#settings/data");
  const panel = page.locator(".recovery-checkpoints");
  await expect(panel.getByText("还没有有效的检查点。可以在调整研究记录前先保存一个。", { exact: true })).toBeVisible();
  await shot("recovery-empty-desktop");
  const label = "整理长目标、比较矩阵与待解问题之前的研究检查点";
  await panel.getByLabel("检查点名称", { exact: true }).fill(label);
  await panel.getByRole("button", { name: "保存检查点", exact: true }).click();
  await expect(panel.getByText("检查点已保存。", { exact: true })).toBeVisible();
  await expect(panel.locator(".checkpoint-row")).toHaveCount(1);
  const real = await api("recovery"), overview = await api("overview");
  assert.equal(real.checkpoints.length, 1);
  assert.equal(real.checkpoints[0].label, label);
  await page.reload();
  await expect(panel.locator(".checkpoint-row").getByRole("heading", { name: label, exact: true })).toBeVisible();
  checks.push("Real workerd checkpoint creation, list and reload; bookmark metadata only, not local native PITR.");

  // The remaining restore states are explicit HTTP response fixtures; actual PITR has a separate cloud acceptance.
  let readFailure = false, overviewBlocked = false, release: (() => void) | undefined;
  let gate: Promise<void> | undefined, restoreCount = 0;
  const submissions: { requestId: string; checkpointId: string }[] = [];
  const state = { checkpoints: [
    real.checkpoints[0],
    { id: "older-build", label: "另一应用版本保存的检查点", created: Date.now(), build: "older-build" },
    { id: "expired", label: "已过保留期的检查点", created: Date.now() - 30 * 86400000, build: overview.build },
  ], jobs: [] as any[] };
  await page.route("**/api/recovery", async route => {
    if (gate) await gate;
    if (readFailure) return route.fulfill({ status: 503, json: { error: "SERVICE_UNAVAILABLE" } });
    await route.fulfill({ json: state });
  });
  await page.route("**/api/overview", async route => {
    if (overviewBlocked) return route.fulfill({ status: 503, json: { error: "RECOVERY_IN_PROGRESS" } });
    await route.continue();
  });
  await page.route("**/api/recovery/restore", async route => {
    restoreCount++; submissions.push(route.request().postDataJSON());
    if (restoreCount === 1) return route.abort("failed"); // unknown result, no automatic resubmission
    assert.deepEqual(submissions[1], submissions[0], "reload/retry must retain operation identifier");
    state.jobs = [{ id: submissions[0].requestId, checkpointId: submissions[0].checkpointId, status: "pending", created: Date.now() }];
    await route.fulfill({ status: 202, json: { id: state.jobs[0].id, status: "pending" } });
  });
  await panel.getByRole("button", { name: "刷新恢复状态", exact: true }).click();
  await expect(panel.locator(".checkpoint-row")).toHaveCount(3);
  await expect(panel.locator(".checkpoint-row").nth(1).getByRole("button")).toBeDisabled();
  await expect(panel.locator(".checkpoint-row").nth(2).getByRole("button")).toBeDisabled();
  const choose = panel.locator(".checkpoint-row").first().getByRole("button");
  await choose.focus(); await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "恢复到这个检查点？", exact: true });
  await expect(dialog.getByRole("button", { name: "确认恢复", exact: true })).toBeDisabled();
  await shot("recovery-confirm-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("recovery-confirm-mobile");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible(); assert.equal(restoreCount, 0);
  await choose.click();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "保留当前记录", exact: true }).click();
  assert.equal(restoreCount, 0);
  await choose.click(); await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "确认恢复", exact: true }).click();
  await expect(panel.getByText("提交结果尚未确认", { exact: true })).toBeVisible();
  await page.reload();
  await expect(panel.getByText("提交结果尚未确认", { exact: true })).toBeVisible();
  assert.equal(restoreCount, 1, "unknown response never auto-starts another restore");
  await panel.getByRole("button", { name: "用同一请求重试", exact: true }).click();
  await expect(panel.getByText("正在恢复研究工作区", { exact: true })).toBeVisible();
  assert.equal(restoreCount, 2);
  await expect(panel.getByRole("button", { name: "保存检查点", exact: true })).toBeDisabled();
  checks.push("Response fixtures: incompatible/expired checkpoints disabled, keyboard confirmation and cancel, lost response retained across reload and explicit retry uses exactly the same request.");

  overviewBlocked = true;
  await api("settings", "PATCH", { requestId: crypto.randomUUID(), theme: "dark" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  await expect(page.getByRole("heading", { name: "数据与恢复", exact: true })).toBeVisible();
  await expect(panel.getByText("正在恢复研究工作区", { exact: true })).toBeVisible();
  await shot("recovery-pending-mobile-dark");
  state.jobs[0].error = "RECOVERY_PROTECTION_CORRUPT";
  await panel.getByRole("button", { name: "刷新恢复状态", exact: true }).click();
  await expect(panel.getByText("恢复尚未完成，需要检查", { exact: true })).toBeVisible();
  await panel.getByText("查看恢复详情", { exact: true }).click();
  await shot("recovery-blocked-mobile-dark");
  checks.push("Response fixtures: independent status remains reachable after page reload while overview returns 503; guard failure is visible and does not permit another restore.");

  state.jobs[0].status = "completed"; state.jobs[0].completed = Date.now(); delete state.jobs[0].error;
  overviewBlocked = false;
  await expect(panel.getByText("已完成恢复", { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(panel.getByLabel("检查点名称", { exact: true })).toBeEnabled({ timeout: 10000 });
  await expect(page.getByRole("heading", { name: "你的研究数据", exact: true })).toBeVisible();
  assert.deepEqual(await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith("pra-recovery-request:"))), []);
  await page.setViewportSize({ width: 1440, height: 900 });
  await api("settings", "PATCH", { requestId: crypto.randomUUID(), theme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await shot("recovery-completed-desktop");
  await panel.getByLabel("检查点名称", { exact: true }).fill("刷新期间不应保存");
  readFailure = true; await panel.getByRole("button", { name: "刷新恢复状态", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("恢复状态暂时无法读取");
  await expect(panel.locator(".checkpoint-row").first().getByRole("button")).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 }); await shot("recovery-read-error-mobile");
  readFailure = false; gate = new Promise<void>(r => release = r);
  await panel.getByRole("button", { name: "刷新恢复状态", exact: true }).click();
  await expect(panel.getByText("正在刷新恢复状态，当前显示上次读取的记录。", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "保存检查点", exact: true })).toBeDisabled();
  await expect(panel.locator(".checkpoint-row").first().getByRole("button")).toBeDisabled();
  await shot("recovery-refresh-mobile");
  release!(); gate = undefined;
  await expect(panel.getByRole("button", { name: "保存检查点", exact: true })).toBeEnabled();
  gate = new Promise<void>(r => release = r);
  await page.reload(); await expect(panel.getByRole("status", { name: "正在加载", exact: true })).toBeVisible();
  release!(); gate = undefined;
  await expect(panel.getByText("已完成恢复", { exact: true })).toBeVisible();
  assert.equal(restoreCount, 2);
  checks.push("Response fixtures: completion refreshes workspace, clears pending identifier, explains cancelled tasks/paused plans; stale-read and delayed-refresh controls stay locked until a successful response; loading/error recover without automatic restore.");
  return checks;
}
