import {expect,type Page,type BrowserContext} from "@playwright/test";import assert from "node:assert/strict";
export async function verifyRetentionBrowser(base:string,page:Page,context:BrowserContext,api:(p:string,m?:string,b?:any)=>Promise<any>,shot:(n:string)=>Promise<void>){
 const checks:string[]=[],until=async(fn:()=>Promise<boolean>)=>{const end=Date.now()+40000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,150));}throw Error("RETENTION_BROWSER_TIMEOUT");};
 await api("settings","PATCH",{requestId:crypto.randomUUID(),theme:"light"});
 await page.goto(base+"/#settings/data");const section=page.locator(".data-retention");
 await expect(section.getByText("没有符合条件的归档会话。",{exact:true})).toBeVisible();
 await shot("retention-empty-desktop");
 const c=await api("conversations","POST",{requestId:crypto.randomUUID(),title:"已归档的研究记录：可核对的清理范围"});
 const t=await api("tasks","POST",{requestId:crypto.randomUUID(),conversationId:c.id,kind:"chat",input:"你好"});
 await until(async()=>(await api("tasks/"+t.id)).status==="completed");
 await api("conversations/"+c.id,"PATCH",{requestId:crypto.randomUUID(),archived:true});
 const waiting=await api("tasks","POST",{requestId:crypto.randomUUID(),input:"查找原文",kind:"research"});
 await api("conversations/"+waiting.conversationId,"PATCH",{requestId:crypto.randomUUID(),archived:true});
 const pinned=await api("conversations","POST",{requestId:crypto.randomUUID(),title:"保留的置顶会话"});
 await api("conversations/"+pinned.id,"PATCH",{requestId:crypto.randomUUID(),archived:true,pinned:true});
 for(let i=0;i<21;i++){const v=await api("conversations","POST",{requestId:crypto.randomUUID(),title:"分页归档 "+i});await api("conversations/"+v.id,"PATCH",{requestId:crypto.randomUUID(),archived:true});}
 const state=await api("state"),usage=state.usage;
 const first=await api("data/retention?days=0&limit=20");assert.equal(first.eligible,22);assert.ok(!first.items.some((v:any)=>[waiting.conversationId,pinned.id].includes(v.id)));
 await section.getByLabel("最后活动时间",{exact:true}).selectOption("0");await expect(section.locator(".deletion-row")).toHaveCount(20);
 await section.getByRole("button",{name:"下一页",exact:true}).click();await expect(section.locator(".deletion-row")).toHaveCount(2);
 await section.getByRole("button",{name:"上一页",exact:true}).click();await expect(section.locator(".deletion-row")).toHaveCount(20);
 await shot("retention-list-desktop");
 let row=section.locator(".deletion-row").filter({hasText:c.title});const inspect=row.getByRole("button",{name:"检查清理影响",exact:true});
 await inspect.focus();await page.keyboard.press("Enter");const dialog=page.getByRole("dialog",{name:"确认清理这段会话",exact:true});
 await expect(dialog).toBeVisible();await expect(dialog.getByText(/1 项任务中的关联研究内容/)).toBeVisible();
 await shot("retention-confirm-desktop");await page.setViewportSize({width:390,height:844});await shot("retention-confirm-mobile");
 await page.keyboard.press("Escape");await expect(dialog).not.toBeVisible();await expect(inspect).toBeFocused();
 await inspect.click();await expect(dialog).toBeVisible();await api("conversations/"+c.id,"PATCH",{requestId:crypto.randomUUID(),title:"更新后的归档会话"});
 await dialog.getByRole("button",{name:"确认删除会话",exact:true}).click();
 await expect(dialog.getByRole("alert")).toContainText("发生了变化");
 await expect(dialog.getByRole("button",{name:"确认删除会话",exact:true})).toBeDisabled();await shot("retention-stale-mobile");
 await dialog.getByRole("button",{name:"返回并刷新",exact:true}).click();await expect(dialog).not.toBeVisible();
 await expect(section.getByRole("button",{name:"刷新可清理会话",exact:true})).toBeFocused();
 // Updated ordering moves the edited conversation to the second page.
 await section.getByRole("button",{name:"下一页",exact:true}).click();row=section.locator(".deletion-row").filter({hasText:"更新后的归档会话"});
 await row.getByRole("button",{name:"检查清理影响",exact:true}).click();await expect(dialog).toBeVisible();
 let body:any;
 const request=page.waitForRequest(r=>r.url().endsWith("/api/data/retention/confirm")&&r.method()==="POST");
 await dialog.getByRole("button",{name:"确认删除会话",exact:true}).click();body=(await request).postDataJSON();
 await expect(dialog).not.toBeVisible();await expect(section.getByRole("status")).toContainText("删除请求已登记");
 await until(async()=>(await api("deletions/"+c.id)).status==="completed");
 for(let i=0;i<5;i++){const d=await api("data/retention/confirm","POST",body);assert.equal(d.id,c.id);}
 const records=await api("deletions?limit=50");assert.equal(records.items.filter((v:any)=>v.id===c.id).length,1);
 assert.deepEqual((await api("state")).usage,usage);
 assert.equal((await fetch(base+"/api/data/retention")).status,401);
 checks.push("Real workerd: archived eligibility excludes waiting and pinned conversations; 22 records paginate without loss; source change rejects confirmed preview; deletion clears the real Pi conversation and five repeats retain one record without model calls.");
 let mode="loading",release!:()=>void,gate=new Promise<void>(r=>release=r);
 const data={...first,usage:{tasks:4500,taskLimit:5000,conversations:900,nearTaskLimit:true},items:first.items.slice(0,1),nextCursor:null};
 await page.route("**/api/data/retention?*",async route=>{if(mode==="loading")await gate;if(mode==="error")await route.fulfill({status:503,json:{error:"REQUEST_FAILED"}});else await route.fulfill({json:data});});
 await page.reload();await expect(section.getByRole("status",{name:"正在加载"})).toBeVisible();await shot("retention-loading-mobile");
 mode="rows";release();await expect(section.getByText(/接近任务容量/)).toBeVisible();
 await api("settings","PATCH",{requestId:crypto.randomUUID(),theme:"dark"});await expect(page.locator("html")).toHaveAttribute("data-theme","dark");await shot("retention-capacity-mobile-dark");
 mode="error";await section.getByRole("button",{name:"刷新可清理会话",exact:true}).click();await expect(section.getByRole("alert")).toContainText("上一次读取");
 await shot("retention-error-mobile-dark");mode="rows";await section.getByRole("button",{name:"重新加载会话",exact:true}).click();await expect(section.getByRole("alert")).toHaveCount(0);
 await page.setViewportSize({width:1440,height:900});await shot("retention-capacity-desktop-dark");
 await page.unroute("**/api/data/retention?*");await page.reload();
 checks.push("Explicit UI fixtures: loading, stale-data error/reload and capacity warning; desktop/mobile light/dark, keyboard dialog focus, no overflow. Fixture capacity is not actual storage or platform quota.");
 return checks;
}
