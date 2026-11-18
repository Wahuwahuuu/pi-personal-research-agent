import assert from "node:assert/strict";
import {expect, type Page} from "@playwright/test";

export async function verifyProjectRecords(
  base: string, page: Page, api: (path:string,method?:string,body?:any)=>Promise<any>,
  screenshot:(name:string)=>Promise<void>,
) {
  const create = (path:string, fields:object) => api(path,"POST",{...fields,requestId:crypto.randomUUID()});
  const makeProject = (title:string) => create("projects",{title,paperIds:["fixture-paper"]});
  const a=await makeProject("试验项目甲"), b=await makeProject("试验项目乙");
  const research = async (id:string, title:string, question:string) => {
    const c = await create("conversations",{projectId:id,title});
    const t = await create("tasks",{conversationId:c.id,input:question,kind:"research"});
    await expect.poll(async ()=>(await api("tasks/"+t.id)).status,{timeout:60000}).toBe("completed");
    const done=await api("tasks/"+t.id);
    assert.equal(done.workflow.memory.written.conclusions,1);
    return {c,done,artifact:await create("artifacts",{taskId:t.id,kind:"reading",title:title+"阅读卡"})};
  };
  const first = await research(a.id,"甲的讨论","阅读甲项目所选论文并核对原文");
  const other = await research(b.id,"乙的讨论","阅读乙项目所选论文并核对原文");
  const questions = Array.from({length:12},(_,i)=>"项目甲的问题 "+String(i+1).padStart(2,"0"));
  for(const content of questions) await create("memories",{category:"question",projectId:a.id,content});
  await create("memories",{category:"question",projectId:b.id,content:"项目乙的问题"});
  await create("memories",{category:"question",content:"个人范围的问题"});
  const calls = (await api("state")).usage.requests;
  const observations:URL[]=[];
  page.on("request",r=>{const u=new URL(r.url());if(u.searchParams.has("project") && ["/api/tasks","/api/artifacts","/api/memories"].includes(u.pathname)) observations.push(u);});
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:width===390?844:900});
    observations.length=0;
    await page.goto(base+"/#projects/"+a.id);
    await expect(page.getByRole("heading",{name:a.title,exact:true})).toBeVisible();
    assert.equal(observations.length,0);
    const panel=page.locator(".project-records");
    await panel.locator(":scope > summary").click();
    await expect(panel.getByRole("button",{name:new RegExp(first.done.input)})).toBeVisible();
    await expect(panel.getByText(other.done.input,{exact:true})).toHaveCount(0);
    const kind=panel.getByLabel("查看项目记录",{exact:true});
    await kind.selectOption("question");
    const pager=panel.getByRole("navigation",{name:"列表分页"});
    await pager.getByRole("button",{name:"下一页"}).click();
    await expect(panel.locator(".project-memory")).toHaveCount(2);
    await expect(panel.getByText("项目乙的问题",{exact:true})).toHaveCount(0);
    await expect(panel.getByText("个人范围的问题",{exact:true})).toHaveCount(0);
    await kind.selectOption("conclusion");
    await panel.getByText("原文依据 · 1 处",{exact:true}).click();
    await expect(panel.locator("blockquote")).toHaveText("Evidence.");
    await panel.getByText("定位详情",{exact:true}).click();
    await expect(panel.locator(".diagnostics")).toContainText("0–9");
    await expect(panel.locator(".diagnostics")).toContainText("fixture-v1");
    await screenshot("project-records-"+(width===390?"mobile":"desktop"));
    await kind.selectOption("artifacts");
    await expect(panel.getByText(other.artifact.title,{exact:true})).toHaveCount(0);
    await panel.getByRole("button",{name:new RegExp(first.artifact.title)}).click();
    await expect(page).toHaveURL(base+"/#artifacts/"+first.artifact.id);
    await expect(page.getByRole("heading",{name:first.artifact.title,exact:true})).toBeVisible();
    assert.ok(observations.some(u=>u.pathname==="/api/tasks")&&observations.some(u=>u.pathname==="/api/artifacts"));
    assert.ok(observations.filter(u=>u.pathname==="/api/memories").every(u=>u.searchParams.get("scope")==="project"));
  }
  await page.goto(base+"/#projects/"+b.id);
  const panel=page.locator(".project-records");await panel.locator(":scope > summary").click();
  await expect(panel.getByText(first.done.input,{exact:true})).toHaveCount(0);
  await panel.getByRole("button",{name:new RegExp(other.done.input)}).click();
  await expect(page).toHaveURL(base+"/#chat/"+other.c.id+"/"+other.done.id);
  await expect(page.getByRole("article",{name:"来源消息",exact:true})).toContainText(other.done.input);
  assert.equal((await api("state")).usage.requests,calls);
  // Move the source beyond the latest page using ordinary, deterministic control receipts.
  for(let i=0;i<32;i++){
    const receipt=await create("tasks",{conversationId:first.c.id,kind:"auto",input:"查看当前任务进度"});
    assert.equal(receipt.control.action,"status");assert.equal(receipt.calls,0);
  }
  const recent=await api("conversations/"+first.c.id+"/messages?limit=30");
  assert.equal(recent.items.length,30);assert.ok(recent.items.every((t:{id:string})=>t.id!==first.done.id));
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:width===390?844:900});
    await page.goto(base+"/#artifacts/"+first.artifact.id);
    await page.getByRole("button",{name:"回到来源讨论",exact:true}).click();
    const source=page.locator("article.turn").filter({has:page.getByText(first.done.input,{exact:true})});
    await expect(source).toBeVisible();await expect(source).toBeFocused();
    await expect(source.locator(".markdown").first()).not.toBeEmpty();
    await expect(page).toHaveURL(base+"/#chat/"+first.c.id+"/"+first.done.id);
    const draft="从原消息继续核对";
    await page.getByLabel("消息",{exact:true}).fill(draft);
    await page.getByRole("button",{name:"回到最新消息",exact:true}).click();
    await expect(page.getByLabel("消息",{exact:true})).toHaveValue(draft);
    await expect(page.locator("article.turn")).toHaveCount(30);
    await expect(source).toHaveCount(0);

    await page.goto(base+"/#projects/"+a.id);
    const records=page.locator(".project-records");
    await records.locator(":scope > summary").click();
    await records.getByLabel("查看项目记录",{exact:true}).selectOption("conclusion");
    await records.getByRole("button",{name:"查看来源讨论",exact:true}).first().click();
    await expect(source).toBeFocused();
    await expect(page).toHaveURL(base+"/#chat/"+first.c.id+"/"+first.done.id);

    await page.goto(base+"/#memory/"+a.id);
    await page.getByRole("button",{name:"查看来源讨论",exact:true}).first().click();
    await expect(source).toBeFocused();
  }
  const noticeIndex=(await api("overview")).notices.findIndex((n:{id:string})=>n.id==="task:"+first.done.id);
  assert.ok(noticeIndex>=0);
  const notice=page.locator(".notice-row").nth(noticeIndex).getByRole("button",{name:"查看结果",exact:true});
  await page.goto(base+"/#inbox");await notice.click();
  await expect(page.getByRole("article",{name:"来源消息",exact:true})).toContainText(first.done.input);
  await page.goto(base+"/#inbox");
  let held=false,release!:()=>void;
  const pending=new Promise<void>(done=>release=done);
  const taskPath="**/api/tasks/"+first.done.id;
  await page.route(taskPath,async r=>{const result=await r.fetch();held=true;await pending;await r.fulfill({response:result});},{times:1});
  await notice.click();await expect.poll(()=>held,{timeout:10000}).toBe(true);
  await page.goto(base+"/#projects");await expect(page.getByRole("heading",{name:"研究项目",exact:true})).toBeVisible();
  const delivered=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/tasks/"+first.done.id);
  release();await delivered;
  await expect(page).toHaveURL(base+"/#projects");
  const invalid=await page.request.get(base+"/api/conversations/"+first.c.id+"/messages?focus="+other.done.id);
  assert.equal(invalid.status(),404);assert.equal((await invalid.json()).error,"SOURCE_MESSAGE_UNAVAILABLE");
  await page.goto(base+"/#chat/"+first.c.id+"/"+other.done.id);
  await expect(page.getByRole("alert")).toContainText("在这段讨论中找不到这条来源消息");
  await expect(page.getByText(other.done.input,{exact:true})).toHaveCount(0);
  await page.getByRole("button",{name:"回到最新消息",exact:true}).click();
  await expect(page.locator("article.turn")).toHaveCount(30);
  await page.goto(base+"/#chat/"+first.c.id+"/"+first.done.id);
  await expect(page.getByRole("article",{name:"来源消息",exact:true})).toBeFocused();
  await page.getByLabel("消息",{exact:true}).fill("现在做到哪了");
  await page.getByRole("button",{name:"发送消息",exact:true}).click();
  await expect(page).toHaveURL(base+"/#chat/"+first.c.id);
  await expect(page.locator(".user-message").last()).toHaveText("现在做到哪了");
  assert.equal((await api("state")).usage.requests,calls);
  return ["artifacts and project or personal memory open the exact older turn at both widths, preserve the draft and resume latest",
    "a missing source in this discussion returns an explicit error without displaying another discussion and source navigation adds no model requests",
    "two projects expose only their own tasks and artifacts on desktop and mobile",
    "project-only questions paginate without personal records; research conclusions expose the original quote and range",
    "opening a discussion or artifact resolves to the stored object and browsing starts no model requests"];
}
