import assert from "node:assert/strict";
import {expect, type Page, type Request, type Route} from "@playwright/test";

export async function verifyProjectDiscussions(
  base: string, page: Page, api: (path: string, method?: string, body?: any) => Promise<any>,
  screenshot: (name: string) => Promise<void>,
) {
  const create = (path: string, data: object) => api(path, "POST", {...data, requestId: crypto.randomUUID()});
  const project = await create("projects", {title: "项目讨论分页"});
  const other = await create("projects", {title: "另一个项目"});
  const createDiscussion = (projectId: string, title: string) => create("conversations", {projectId, title});
  for (let i = 1; i <= 32; i++) await createDiscussion(project.id, "项目讨论 " + String(i).padStart(2, "0"));
  const archived = await createDiscussion(project.id, "已归档的项目讨论");
  await api("conversations/" + archived.id, "PATCH", {archived: true, requestId: crypto.randomUUID()});
  const unrelated = await createDiscussion(other.id, "另一项目的独立讨论");
  const discussions = "conversations?limit=30&project=" + project.id;
  const first = await api(discussions);
  const second = await api(discussions + "&after=" + first.nextCursor);
  assert.deepEqual([first.items.length, second.items.length, second.nextCursor], [30, 2, null]);
  const task = await create("tasks", {conversationId:first.items[0].id,kind:"research",input:"测试项目范围"});
  const full = await api("projects/" + project.id);
  assert.ok(full.tasks.some((t: {id: string}) => t.id === task.id));
  assert.equal(full.conversations.nextCursor, first.nextCursor);
  const calls = (await api("state")).usage.requests;
  const requests: URL[] = [];
  const observe = (request: Request) => { if (request.method() === "GET") requests.push(new URL(request.url())); };
  page.on("request", observe);
  const workspace = page.locator("section.page");
  const row = (title: string) => workspace.getByRole("button", {name: new RegExp("^" + title)});
  const pager = workspace.getByRole("navigation", {name: "列表分页"});
  const checks: string[] = [];
  for (const width of [1440, 390]) {
    await page.setViewportSize({width, height:width === 390 ? 844 : 900});
    await page.goto(base + "/#projects/" + project.id);
    await expect(workspace.getByRole("heading", {name:project.title,exact:true})).toBeVisible();
    await expect(row(first.items[0].title)).toBeVisible();
    await expect(pager.getByRole("button",{name:"下一页"})).toBeVisible({timeout:4500});
    await expect(row(second.items[0].title)).toHaveCount(0);
    await expect(row(archived.title)).toHaveCount(0);
    await expect(row(unrelated.title)).toHaveCount(0);
    await pager.getByRole("button",{name:"下一页"}).click();
    await expect(row(second.items[0].title)).toBeVisible();
    await expect(pager.getByRole("button",{name:"下一页"})).toBeDisabled();
    await screenshot("project-discussions-" + (width === 390 ? "mobile" : "desktop"));
    await pager.getByRole("button",{name:"上一页"}).focus();
    await page.keyboard.press("Enter");
    await expect(row(first.items[0].title)).toBeVisible();
    await pager.getByRole("button",{name:"下一页"}).click();
    await row(second.items[1].title).click();
    await expect(page).toHaveURL(base + "/#chat/" + second.items[1].id);
    await page.goto(base + "/#projects/" + other.id);
    await expect(row(unrelated.title)).toBeVisible();
    await expect(row(second.items[0].title)).toHaveCount(0);
    await expect(pager).toHaveCount(0);
    checks.push("project discussion pages, keyboard navigation and opening the older conversation at " + width + "px");
  }
  let broken = true;
  const fault = async (route: Route) => {
    const p = new URL(route.request().url()).searchParams;
    if (broken && p.get("project") === project.id && p.get("after") === String(first.nextCursor))
      await route.fulfill({status:503,json:{error:"UNAVAILABLE"}});
    else await route.continue();
  };
  await page.route("**/api/conversations?*",fault);
  try {
    await page.goto(base + "/#projects/" + project.id);
    await pager.getByRole("button",{name:"下一页"}).click();
    await expect(workspace.getByRole("alert")).toBeVisible();
    broken = false;
    await workspace.getByRole("alert").getByRole("button",{name:"重试"}).click();
    await expect(row(second.items[1].title)).toBeVisible();
  } finally {await page.unroute("**/api/conversations?*",fault);}
  checks.push("a failed next page can be retried without losing its cursor");
  const details = requests.filter(u => u.pathname === "/api/projects/" + project.id);
  assert.ok(details.length && details.every(u => u.searchParams.get("view") === "summary"));
  requests.length = 0;
  await workspace.getByRole("button",{name:"选择项目论文"}).click();
  await expect(workspace.getByRole("heading",{name:"选择项目论文"})).toBeVisible();
  await expect.poll(() => requests.filter(u => u.pathname === "/api/projects/" + project.id).length).toBeGreaterThan(0);
  const projectReads = requests.filter(u => u.pathname === "/api/projects/" + project.id);
  assert.ok(projectReads.every(u => u.searchParams.get("view") === "summary"));
  const summary = await api("projects/" + project.id + "?view=summary");
  assert.equal(summary.id,project.id);
  assert.deepEqual(summary.paperIds,full.paperIds);
  assert.ok(!("conversations" in summary) && !("tasks" in summary));
  assert.equal((await api("state")).usage.requests,calls);
  page.off("request",observe);
  checks.push("paper selection uses project metadata and the original detail endpoint retains its tasks and conversations");
  return checks;
}
