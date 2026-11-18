import assert from "node:assert/strict";
import {expect,type Page,type Route} from "@playwright/test";

export async function verifyProjectScope(
 base:string,page:Page,api:(path:string,method?:string,body?:any)=>Promise<any>,
){
 const papers=["alpha","beta","gamma"].map(id=>({paper_id:id,title:"范围检查 "+id,abstract:""}));
 const catalogue=(r:Route)=>r.fulfill({json:papers});
 await page.route("**/api/papers",catalogue);
 const checks:string[]=[];
 try{
  for(const width of [1440,390]){
   const p=await api("projects","POST",{requestId:crypto.randomUUID(),title:"论文范围检查 "+width,paperIds:["alpha"]});
   const path="projects/"+p.id,summary=path+"?view=summary",pattern="**/api/"+path+"?view=summary";
   const patch=(updates:object)=>api(path,"PATCH",{requestId:crypto.randomUUID(),...updates});
   let fail=true,intercepted=0,release!:()=>void;
   const blocked=new Promise<void>(done=>{release=done;});
   const failRead=async(route:Route)=>{
    if(!fail)return route.continue();
    intercepted++;await blocked;await route.fulfill({status:503,json:{error:"SERVICE_UNAVAILABLE"}});
   };
   await page.route(pattern,failRead);
   const save=page.getByRole("button",{name:"保存论文范围"}),box=(id:string)=>page.getByRole("checkbox",{name:"选择 范围检查 "+id});
   try{
    await page.setViewportSize({width,height:width===390?844:900});
    await page.goto(base+"/#papers/"+p.id);
    await expect.poll(()=>intercepted).toBeGreaterThan(0);await expect(save).toBeDisabled();await expect(box("alpha")).toBeDisabled();
    release();await expect(page.getByRole("alert").filter({hasText:"读取项目论文范围失败"})).toBeVisible();
    await expect(save).toBeDisabled();assert.deepEqual((await api(summary)).paperIds,["alpha"]);
    fail=false;await page.getByRole("alert").getByRole("button",{name:"重试"}).click();
    await expect(box("alpha")).toBeChecked();await expect(save).toBeEnabled();await box("beta").check();
    await patch({title:"编辑期间修改的标题 "+width});
    await expect(page.getByText("为「编辑期间修改的标题 "+width+"」选择研究范围。",{exact:true})).toBeVisible({timeout:15000});
    await expect(box("beta")).toBeChecked();
    // Simulate a second signed client changing the scope after the first has read it.
    const beforePatch=async(route:Route)=>{
     if(route.request().method()==="PATCH"){
      await patch({paperIds:["gamma"]});
     }
     await route.continue();
    };
    await page.route("**/api/"+path,beforePatch);
    try{
     const response=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/"+path&&r.request().method()==="PATCH");
     await save.click();assert.equal((await response).status(),409);
    }finally{await page.unroute("**/api/"+path,beforePatch);}
    await expect(save).toBeDisabled();const latest=page.getByRole("button",{name:"载入最新范围"});await expect(latest).toBeEnabled();
    assert.deepEqual((await api(summary)).paperIds,["gamma"]);await latest.click();
    await expect(box("gamma")).toBeChecked();await expect(box("beta")).not.toBeChecked();
    await box("alpha").check();await save.focus();await page.keyboard.press("Enter");
    await expect(page).toHaveURL(base+"/#projects/"+p.id);
    assert.deepEqual((await api(summary)).paperIds,["gamma","alpha"]);
    checks.push("paper scope load, failure, retry, draft, competing update and keyboard save at "+width+"px");
   }finally{release();await page.unroute(pattern,failRead);await api(path,"DELETE",{requestId:crypto.randomUUID()});}
  }
 }finally{await page.unroute("**/api/papers",catalogue);}
 return checks;
}
