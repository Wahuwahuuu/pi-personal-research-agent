import {expect,type Page,type BrowserContext} from "@playwright/test";
import WebSocket from "ws";
import assert from "node:assert/strict";
import {nodeCatalog,catalogPages} from "../local/catalog.ts";
import type {DeletionRecord} from "../src/deletion.ts";

export async function verifyDeletionBrowser(base:string,page:Page,context:BrowserContext,api:(p:string,m?:string,b?:any)=>Promise<any>,shot:(n:string)=>Promise<void>){
 const checks:string[]=[];
 const until=async(f:()=>Promise<boolean>,ms=30000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await f())return;await new Promise(r=>setTimeout(r,150));}throw Error("DELETION_BROWSER_TIMEOUT");};
 await api("settings","PATCH",{requestId:crypto.randomUUID(),theme:"light"});
 await page.goto(base+"/#settings/data");
 await expect(page.getByText("还没有删除记录。",{exact:true})).toBeVisible();
 await shot("deletions-empty-desktop");
 await page.setViewportSize({width:390,height:844});await shot("deletions-empty-mobile");
 const pair=await api("device/pair","POST",{requestId:crypto.randomUUID(),label:"删除回执测试电脑"});
 const catalog=await nodeCatalog(undefined,true),pages=catalogPages(catalog);
 const ws=new WebSocket(base.replace("http","ws")+"/api/device/connect",{headers:{Authorization:"Bearer "+pair.token}});
 const frames:any[]=[];
 ws.on("error",()=>{});
 const send=(m:unknown)=>ws.send(JSON.stringify(m));
 ws.on("message",raw=>{
  const m=JSON.parse(raw.toString());frames.push(m);
  if(m.type==="hello_ack"){send({type:"catalog_begin",pages:pages.length});pages.forEach((value,page)=>send({type:"catalog_page",page,value}));send({type:"catalog_end"});}
  if(m.type==="catalog_ack")send({type:"ready"});
 });
 try{
  await new Promise<void>((ok,no)=>{ws.once("open",ok);ws.once("error",no);});
  send({type:"hello",version:1,deviceId:"deletion-browser",indexVersion:catalog.indexVersion,tools:["search_papers","retrieve_chunks"],capabilities:[]});
  await until(async()=>(await api("state")).deviceOnline);
  const task=await api("tasks","POST",{requestId:crypto.randomUUID(),input:"搜索论文原文",kind:"research"});
  await until(async()=>frames.some(m=>m.type==="operation"));
  await api("conversations/"+task.conversationId,"DELETE");
  await until(async()=>(await api("deletions/"+task.conversationId)).status==="cloud_complete");
  await expect(page.getByRole("heading",{name:"云端已清理，等待本机",exact:true})).toBeVisible({timeout:15000});
  const row=page.locator(".deletion-row").first();
  await row.locator("summary").focus();await page.keyboard.press("Enter");
  await expect(row.getByText(task.conversationId,{exact:true})).toBeVisible();
  await expect(row.getByText("1 台",{exact:true})).toBeVisible();
  await shot("deletions-waiting-mobile");
  await page.setViewportSize({width:1440,height:900});await shot("deletions-waiting-desktop");
  const purge=frames.find(m=>m.type==="purge_operations"&&m.deletionId===task.conversationId);
  assert.ok(purge);send({type:"purged",deletionId:purge.deletionId,operationIds:purge.operationIds});
  await expect(page.getByRole("heading",{name:"清理已完成",exact:true})).toBeVisible({timeout:15000});
  await page.reload();await expect(page.getByRole("heading",{name:"清理已完成",exact:true})).toBeVisible();
  await shot("deletions-completed-desktop");
  checks.push("Real workerd deletion list: empty state, known-device pending count, keyboard diagnostics, device receipt updates in place and completion survives reload; device is a controlled protocol fixture.");
  for(let i=0;i<21;i++){
   const c=await api("conversations","POST",{requestId:crypto.randomUUID(),title:"Deletion pagination fixture"});
   await api("conversations/"+c.id,"DELETE");
  }
  await page.getByRole("button",{name:"刷新记录",exact:true}).click();
  const latest=(await api("deletions?limit=20")).items[0].id;
  await expect(page.locator(".deletion-row")).toHaveCount(20);
  await expect(page.locator(".deletion-row").first().getByText(latest,{exact:true})).toHaveCount(1);
  await page.getByRole("button",{name:"下一页",exact:true}).click();
  await expect(page.locator(".deletion-row")).toHaveCount(2);
  await expect(page.getByText("第 2 页",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"上一页",exact:true}).click();await expect(page.locator(".deletion-row")).toHaveCount(20);
  checks.push("Real paginated DO list exposes 22 unique deletions over two pages without retaining deleted titles.");
  // Rare failure/legacy cases below are response fixtures, not cloud or native deletion evidence.
  let mode="states",release!:()=>void,gate:Promise<void>|undefined,retries=0;
  const fixtureId=crypto.randomUUID(),created=Date.now(),common={created,error:null,pendingDevices:0,pendingResults:0,pendingReaders:0,unverifiedOperations:0};
  const records:DeletionRecord[]=[
   {...common,id:fixtureId,status:"failed",error:"PI_DELETE_SCHEMA_MISMATCH"},
   {...common,id:crypto.randomUUID(),status:"cloud_complete",error:"LEGACY_DEVICE_OWNERSHIP_UNKNOWN",unverifiedOperations:3},
   {...common,id:crypto.randomUUID(),status:"pending"},
  ];
  await page.route("**/api/deletions?*",async route=>{
   if(gate)await gate;
   if(mode==="error")await route.fulfill({status:503,json:{error:"REQUEST_FAILED"}});
   else await route.fulfill({json:{items:records,nextCursor:null}});
  });
  await page.route("**/api/conversations/"+fixtureId,async route=>{
   assert.equal(route.request().method(),"DELETE");retries++;records[0].status="pending";records[0].error=null;
   await route.fulfill({status:202,json:records[0]});
  });
  await page.reload();
  await expect(page.getByRole("heading",{name:"本地副本待核验",exact:true})).toBeVisible();
  await expect(page.getByRole("heading",{name:"云端清理未完成",exact:true})).toBeVisible();
  await page.locator(".deletion-row").nth(1).locator("summary").click();
  await shot("deletions-states-desktop");
  await page.setViewportSize({width:390,height:844});await shot("deletions-states-mobile");
  await api("settings","PATCH",{requestId:crypto.randomUUID(),theme:"dark"});
  await expect(page.locator("html")).toHaveAttribute("data-theme","dark");await shot("deletions-states-mobile-dark");
  const retry=page.getByRole("button",{name:"重试删除",exact:true});await retry.focus();await page.keyboard.press("Enter");
  await expect(retry).not.toBeVisible();assert.equal(retries,1);
  await expect(page.getByRole("heading",{name:"正在清理云端记录",exact:true})).toHaveCount(2);
  mode="error";await page.getByRole("button",{name:"刷新记录",exact:true}).click();
  await expect(page.getByRole("alert").filter({hasText:"删除记录暂时无法读取"})).toBeVisible();await shot("deletions-error-mobile-dark");
  mode="states";await page.getByRole("button",{name:"重新加载",exact:true}).click();
  await expect(page.getByRole("alert").filter({hasText:"删除记录暂时无法读取"})).not.toBeVisible();
  gate=new Promise<void>(r=>release=r);await page.reload();
  await expect(page.locator(".deletion-records").getByRole("status",{name:"正在加载"})).toBeVisible();
  await shot("deletions-loading-mobile-dark");release();gate=undefined;
  await expect(page.getByRole("heading",{name:"本地副本待核验",exact:true})).toBeVisible();
  checks.push("Explicit response fixtures cover unknown legacy custody, incompatible schema, keyboard retry, read failure/reload and delayed loading in light/dark mobile; no percentage or false full deletion.");
  assert.deepEqual(frames.filter(m=>m.type==="error"),[]);
  return checks;
 }finally{ws.terminate();}
}
