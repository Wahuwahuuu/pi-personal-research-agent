import assert from "node:assert/strict";
import { expect, type Page, type Route } from "@playwright/test";

type Api = (path: string, method?: string, body?: unknown) => Promise<any>;

export async function verifyArtifactEdits(base: string, page: Page, api: Api) {
  const request = () => ({ requestId: crypto.randomUUID() });
  const task = await api("tasks", "POST", { ...request(), kind: "chat", input: "你好" });
  try {
    await expect.poll(async () => (await api("tasks/" + task.id)).status).toBe("completed");
    const a = await api("artifacts", "POST", { ...request(), taskId: task.id, kind: "reading", title: "阅读卡" });
    const path = "artifacts/" + a.id;
    const url = base + "/api/" + path;
    const save = page.getByRole("button", { name: "保存新版本", exact: true });
    const body = page.getByLabel("Markdown 正文", { exact: true });
    for (const [width, delayedRefresh] of [[1440, false], [390, true]] as const) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(base + "/#artifacts/" + a.id);
      const before = await api(path);
      const draft = "本窗口修改 " + width;
      const external = "另一窗口修改 " + width;
      await page.getByRole("button", { name: "编辑", exact: true }).click();
      await body.fill(draft);
      let release!: () => void;
      const gate = new Promise<void>(done => { release = done; });
      const delayRead = async (route: Route) => {
        if (route.request().method() === "GET") await gate;
        await route.continue();
      };
      if (delayedRefresh) await page.route(url, delayRead);
      try {
        await api(path, "PATCH", { ...request(), version: before.version, title: external, content: external });
        if (delayedRefresh) {
          const [conflict] = await Promise.all([
            page.waitForResponse(r => r.url() === url && r.request().method() === "PATCH"),
            save.click(),
          ]);
          assert.equal(conflict.request().postDataJSON().version, before.version);
          assert.equal(conflict.status(), 409);
        }
      } finally {
        release();
        if (delayedRefresh) await page.unroute(url, delayRead);
      }
      const alert = page.locator(".artifact-page").getByRole("alert");
      await expect(alert).toContainText("草稿");
      await expect(save).toBeDisabled();
      await expect(page.getByLabel("成果版本", { exact: true })).toBeDisabled();
      await expect(body).toHaveValue(draft);
      await alert.locator("summary").click();
      await expect(alert.locator(".markdown")).toContainText(external);
      const otherVersion = before.version + 1;
      assert.equal((await api(path)).version, otherVersion);
      await alert.getByRole("button", { name: "基于第 " + otherVersion + " 版继续编辑" }).click();
      await expect(body).toHaveValue(draft);
      const merged = external + "\n" + draft;
      await body.fill(merged);
      const [saved] = await Promise.all([
        page.waitForResponse(r => r.url() === url && r.request().method() === "PATCH"),
        save.click(),
      ]);
      assert.equal(saved.request().postDataJSON().version, otherVersion);
      assert.ok(saved.ok());
      assert.equal((await api(path)).content, merged);
      assert.equal((await api(path + "?version=" + otherVersion)).content, external);
      await expect(body).toHaveCount(0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
  } finally {
    await api("conversations/" + task.conversationId, "DELETE", request());
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  return "Concurrent artifact edits preserve the draft through event refresh and HTTP conflict. Saving a merge requires a new base version.";
}
