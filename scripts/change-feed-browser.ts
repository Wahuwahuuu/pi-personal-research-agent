import {expect,type Page,type WebSocketRoute} from "@playwright/test";
import assert from "node:assert/strict";

/** Transport fault injection; resources and reset responses come from the actual Worker. */
export async function verifyChangeFeedBrowser(base:string,page:Page,api:(path:string,method?:string,body?:any)=>Promise<any>,shot:(name:string)=>Promise<void>){
 const before=(await api("state")).usage.requests;
 const project=await api("projects","POST",{requestId:crypto.randomUUID(),title:"Before reconnect",goal:"Cursor recovery"});
 const transportErrors:string[]=[];
 let blocked=false,forceReset=true,resets=0,pair:{client:WebSocketRoute;server:WebSocketRoute}|undefined;
 await page.routeWebSocket("**/api/events?*",async client=>{
  if(blocked){await client.close();return;}
  pair={client,server:client.connectToServer()};
 });
 const changes="**/api/changes?*";
 await page.route(changes,async route=>{
  if(!forceReset){await route.continue();return;}
  // Ask the real API for a deliberately invalidated cursor; no fabricated success payload.
  try{
   const body=await api("changes?after="+Number.MAX_SAFE_INTEGER+"&limit=100");
   assert.equal(body.resetRequired,true);assert.deepEqual(body.events,[]);
   resets++;await route.fulfill({json:body});
  }catch{
   // Playwright request errors may include cookie headers; never log those errors.
   transportErrors.push("CHANGE_PROBE_FAILED");await route.abort().catch(()=>{});
  }
 });
 try{
  await page.goto(base+"/#projects/"+project.id);
  await expect(page.getByRole("heading",{name:"Before reconnect",exact:true})).toBeVisible();
  await expect.poll(()=>resets).toBeGreaterThan(0);
  // Allow the existing one-second resource refresh to finish before injecting a disconnect.
  await page.waitForTimeout(1500);
  let previousTitle="Before reconnect";
  for(const width of [1440,390]){
   await page.setViewportSize({width,height:width===390?844:900});
   for(const reset of [false,true]){
    forceReset=reset;
    blocked=true;await pair?.client.close();await pair?.server.close();
    const title="After "+width+" "+(reset?"reset":"replay");
    const previous=(await api("overview")).cursor;
    const edit={requestId:crypto.randomUUID(),title,goal:"Changed while disconnected"};
    await api("projects/"+project.id,"PATCH",edit);
    await api("projects/"+project.id,"PATCH",edit);
    const expected={entity:"projects",id:project.id};
    const committed=await api("changes?after="+previous);
    assert.equal(committed.resetRequired,false);
    assert.deepEqual(committed.events.flatMap((e:{changes:{id:string}[]})=>e.changes).filter((c:{id:string})=>c.id===project.id),[expected]);
    await expect(page.getByRole("heading",{name:previousTitle,exact:true})).toBeVisible();
    const response=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/changes"&&r.ok());
    blocked=false;await page.evaluate(()=>window.dispatchEvent(new Event("online")));
    const replay=await (await response).json();
    assert.equal(replay.resetRequired,reset);
    if(reset)assert.deepEqual(replay.events,[]);
    else assert.ok(replay.events.some((e:{seq:number;changes:{entity:string;id:string}[]})=>
     e.seq>previous&&e.changes.some(c=>c.entity==="projects"&&c.id===project.id)));
    await expect(page.getByRole("heading",{name:title,exact:true})).toBeVisible({timeout:15000});
    await expect(page.getByRole("heading",{name:previousTitle,exact:true})).toHaveCount(0);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if(reset)await shot(width===390?"change-feed-mobile":"change-feed-desktop");
    previousTitle=title;
   }
  }
  assert.deepEqual(transportErrors,[]);
  assert.equal((await api("state")).usage.requests,before);
  return ["desktop and mobile recover project edits through both ordinary event replay and an expired cursor; repeated writes produce one project event"];
 }finally{
  blocked=true;await pair?.client.close().catch(()=>{});await pair?.server.close().catch(()=>{});
  await page.unrouteAll({behavior:"wait"});
  await api("projects/"+project.id,"DELETE",{requestId:crypto.randomUUID()});
 }
}
