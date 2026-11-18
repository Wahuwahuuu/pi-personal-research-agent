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
    await verifyArtifactEditCapacity(base, page, api, a.id);
  } finally {
    await api("conversations/" + task.conversationId, "DELETE", request());
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  return "Concurrent artifact edits require an explicit merge. Long Markdown survives a desktop edit, mobile rename, replay, history and export.";
}

/** The same saved Markdown must survive a long edit, a title-only edit, history, and export. */
export async function verifyArtifactEditCapacity(base: string, page: Page, api: Api, id: string) {
  const path = "artifacts/" + id;
  const url = base + "/api/" + path;
  const heading = "    研究笔记 🧪\n";
  const tail = "\n末行保留两个空格  \n\n";
  const line = '\t证据 "A" 与路径 A\\B。\n';
  const space = 50_000 - heading.length - tail.length;
  const content = heading + line.repeat(Math.ceil(space / line.length)).slice(0, space) + tail;
  const initial = await api(path);
  let version = initial.version;
  const editor = page.getByLabel("Markdown 正文", { exact: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(base + "/#artifacts/" + id);
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await expect(editor).toHaveAttribute("maxlength", "50000");
    if (width === 1440) await editor.fill(content);
    assert.ok(await editor.inputValue() === content);
    const title = "长篇修订 " + width;
    await page.getByLabel("成果名称", { exact: true }).fill(title);
    const [saved] = await Promise.all([
      page.waitForResponse(r => r.url() === url && r.request().method() === "PATCH"),
      page.getByRole("button", { name: "保存新版本", exact: true }).click(),
    ]);
    assert.equal(saved.status(), 200);
    const request = saved.request().postDataJSON();
    const replay = await api(path, "PATCH", request);
    assert.equal(replay.version, ++version);
    const stored = await api(path + "?version=" + version);
    assert.equal(stored.title, title);
    assert.ok(stored.content === content);
    assert.deepEqual(stored.sources, initial.sources);
    const download = await page.request.get(url + "/export?format=md&version=" + version);
    assert.ok(download.ok());
    assert.ok((await download.text()).includes(content));
    await expect(editor).toHaveCount(0);
  }
  assert.ok((await api(path + "?version=" + (version - 1))).content === content);
  assert.equal((await api(path + "?version=" + initial.version)).content, initial.content);
  const tooLong = await page.request.patch(url, { data: {
    requestId: crypto.randomUUID(), version, content: content + "x",
  } });
  assert.equal(tooLong.status(), 400);
  assert.equal((await tooLong.json()).error, "INVALID_TEXT");
  const ordinaryEndpoint = await page.request.post(base + "/api/projects", { data: {
    requestId: crypto.randomUUID(), title: "Oversized draft", goal: content,
  } });
  assert.equal(ordinaryEndpoint.status(), 413);
  assert.equal((await api(path)).version, version);
  return { characters: content.length, originalVersion: initial.version, finalVersion: version, widths: [1440,390] };
}
