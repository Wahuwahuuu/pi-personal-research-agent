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
    assert.ok(observations.some(u=>u.pathname==="/api/tasks")&&observations.some(u=>u.pathname==="/api/artifacts"));
    assert.ok(observations.filter(u=>u.pathname==="/api/memories").every(u=>u.searchParams.get("scope")==="project"));
  }
  await page.goto(base+"/#projects/"+b.id);
  const panel=page.locator(".project-records");await panel.locator(":scope > summary").click();
  await expect(panel.getByText(first.done.input,{exact:true})).toHaveCount(0);
  await panel.getByRole("button",{name:new RegExp(other.done.input)}).click();
  await expect(page).toHaveURL(base+"/#chat/"+other.c.id);
  assert.equal((await api("state")).usage.requests,calls);
  return ["two projects expose only their own tasks and artifacts on desktop and mobile",
    "project-only questions paginate without personal records; research conclusions expose the original quote and range",
    "opening a discussion or artifact resolves to the stored object and browsing starts no model requests"];
}
