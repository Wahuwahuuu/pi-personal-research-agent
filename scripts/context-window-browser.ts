import {expect,type Page} from "@playwright/test";
import assert from "node:assert/strict";
export async function verifyContextWindowBrowser(base:string,page:Page,api:(path:string,method?:string,body?:any)=>Promise<any>,shot:(name:string)=>Promise<void>){
 const created:string[]=[],checks:string[]=[];
 const wait=async(id:string)=>{
  const end=Date.now()+45000;
  while(Date.now()<end){const t=await api("tasks/"+id);if(t.status==="completed")return t;if(["failed","cancelled"].includes(t.status))throw Error(t.error??t.status);await new Promise(r=>setTimeout(r,200));}
  throw Error("CONTEXT_TASK_TIMEOUT");
 };
 const input="你好，请说明可做的工作。"+"请用中文并保留原文证据。".repeat(180);
 let conversationId="";
 try{
  let last:any;
  for(let i=0;i<3;i++){
   const t=await api("tasks","POST",{requestId:crypto.randomUUID(),input:input+i,kind:"chat",...(conversationId?{conversationId}:{})});
   conversationId=t.conversationId;if(!created.includes(conversationId))created.push(conversationId);
   last=await wait(t.id);
  }
  const window=last.workflow.contextWindow;
  assert.equal(window.stored_turns,2);assert.equal(window.visible_recent_turns.length,1);assert.equal(window.truncated_recent_turns.length,1);
  const original=(await api("state")).conversations.find((c:any)=>c.id===conversationId);
  assert.equal(original.history.length,3);assert.equal(original.history[0].user_text,input+"0");
  await page.goto(base+"/#chat/"+conversationId);
  const panel=page.locator("article.turn").last().locator("details.context-window");
  const toggle=panel.locator("summary");await toggle.focus();await page.keyboard.press("Enter");
  await expect(panel).toHaveAttribute("open","");
  await expect(panel).toContainText("已保存 2 轮讨论，本次选入 1 轮");
  await expect(panel).toContainText("1 轮只取了部分文字");
  await panel.scrollIntoViewIfNeeded();await shot("context-window-desktop");
  await page.setViewportSize({width:390,height:844});await panel.scrollIntoViewIfNeeded();await shot("context-window-mobile");
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.reload();const restored=page.locator("article.turn").last().locator("details.context-window");await restored.locator("summary").click();
  await expect(restored).toContainText("本次选入 1 轮");
  checks.push("three real continuous Pi turns retain full Chinese history while the last projection selects and labels one bounded recent turn");
  checks.push("desktop and mobile context details use actual persisted metadata, are keyboard operable and survive reload");
  return {checks,conversationId,window,taskCalls:last.calls};
 }finally{
  for(const id of created)await api("conversations/"+id,"DELETE");
 }
}
