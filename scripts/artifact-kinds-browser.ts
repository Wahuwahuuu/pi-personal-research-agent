import assert from "node:assert/strict";
import { expect, type Page } from "@playwright/test";

type Api = (path: string, method?: string, body?: unknown) => Promise<any>;

export async function verifyAnswerArtifactKinds(base: string, page: Page, api: Api, taskId: string) {
  const task = await api("tasks/" + taskId);
  const conversation = base + "/#chat/" + task.conversationId;
  const turn = page.locator("article.turn").filter({ has: page.locator(".user-message", { hasText: task.input }) }).last();
  const selector = turn.getByRole("combobox", { name: "成果类型" });
  const save = turn.getByRole("button", { name: "保存为研究成果", exact: true });
  const ids = new Map<string, string>();
  const modelBefore = (await api("state")).usage.requests;
  const kinds = ["reading", "comparison", "review", "brief"];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const kind of kinds) {
      await page.goto(conversation);
      await expect(selector).toHaveValue(task.workflow?.comparison ? "comparison" : "reading");
      assert.deepEqual(await selector.locator("option").evaluateAll(options => options.map(o => (o as HTMLOptionElement).value)), kinds);
      await selector.selectOption(kind);
      const [response] = await Promise.all([
        page.waitForResponse(r => new URL(r.url()).pathname === "/api/artifacts" && r.request().method() === "POST"),
        save.click(),
      ]);
      assert.equal(response.status(), 201);
      const a = await response.json();
      assert.equal(a.taskId, task.id);
      assert.equal(a.conversationId, task.conversationId);
      assert.equal(a.kind, kind);
      assert.deepEqual(a.sources, task.researchEvidence ?? []);
      await expect(page).toHaveURL(base + "/#artifacts/" + a.id);
      if (ids.has(kind)) assert.equal(a.id, ids.get(kind));
      else ids.set(kind, a.id);
      if (kind === "review") {
        if (width === 1440) await api("artifacts/" + a.id, "PATCH", { requestId: crypto.randomUUID(), version: a.version, content: "保留我的综述修订" });
        else assert.equal(a.content, "保留我的综述修订");
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
  }
  await page.goto(conversation);
  await selector.selectOption("brief");
  const endpoint = base + "/api/artifacts";
  let committed = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(endpoint, async route => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    committed = response.status() === 201;
    await gate;
    await route.fulfill({ response });
  });
  try {
    await save.click();
    await expect.poll(() => committed).toBe(true);
    await expect(selector).toBeDisabled();
    await page.evaluate(() => { location.hash = "inbox"; });
    await expect(page.getByRole("heading", { name: "收件箱", exact: true })).toBeVisible();
    const receipt = page.waitForResponse(r => r.url() === endpoint && r.request().method() === "POST");
    release();
    assert.equal((await receipt).status(), 201);
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    await expect(page).toHaveURL(base + "/#inbox");
  } finally {
    release();
    await page.unroute(endpoint);
  }
  assert.equal(new Set(ids.values()).size, 4);
  assert.equal((await api("state")).usage.requests, modelBefore);
  return { types: ids.size, views: 2, sourceCount: (task.researchEvidence ?? []).length };
}
