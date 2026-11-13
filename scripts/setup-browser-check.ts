import {chromium,expect} from "@playwright/test";
import {mkdir,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import assert from "node:assert/strict";
const browser=await chromium.launch({channel:"msedge",headless:true}),page=await browser.newPage({viewport:{width:800,height:820}});
const folder=resolve(".impeccable/review");await mkdir(folder,{recursive:true});const failures:string[]=[],checks:string[]=[];
page.on("pageerror",e=>failures.push(e.message));
await page.addInitScript(()=>{
 const state:any={configured:location.hash==="#paired",ready:false,config:"C:\\Synthetic\\node.json",runtimes:[{manifest:"C:\\Synthetic\\status.json",id:"synthetic-runtime",device:"cpu"}],directory:"C:\\Synthetic\\data",models:"C:\\Synthetic\\models",failure:"",busy:false,phase:""};
 const calls:any[]=[];(window as any).__setup={state,calls};
 const ok=(value:any)=>({ok:true,value});
 (window as any).pywebview={api:{
  status:async()=>ok(state),progress:async()=>{const captured={busy:state.busy,phase:state.phase};if(state.holdProgress)await new Promise<void>(r=>(window as any).__releaseProgress=r);return captured;},
  choose_directory:async()=>ok(state.choice===null?null:state.choice||state.directory),
  check:async(value:any)=>{calls.push(["check",value]);return state.failure?{ok:false,error:state.failure}:ok({library:state.directory+"\\papers",data:state.directory+"\\node",device:"cpu"});},
  install:async(value:any,credential:string)=>{calls.push(["install",value,credential.length]);if(state.failure)return {ok:false,error:state.failure};state.configured=true;return ok({configured:true,config:state.config,started:false});},
  activate:async()=>{state.busy=true;state.phase="preparing";if(state.hold)await new Promise<void>(r=>(window as any).__release=r);state.busy=false;if(state.failure)return {ok:false,error:state.failure};state.ready=true;return ok({ready:true,build:"a".repeat(40),started:false});},
  start:async()=>ok({started:true}),startup:async(remove:boolean)=>ok({registered:!remove})
 }};
});
try{
 await page.goto("file:///"+resolve("local/desktop/setup.html").replaceAll("\\","/"));
 await expect(page.getByRole("heading",{name:"连接这台电脑"})).toBeVisible();
 await page.screenshot({path:resolve(folder,"setup-empty-light.png"),fullPage:true});
 await page.getByLabel("研究工作区地址").fill("https://research.example");
 await page.locator("#choose-directory").click();
 await page.evaluate(()=>(window as any).__setup.state.choice=null);
 await page.locator("#choose-directory").click();await expect(page.locator("#directory")).toHaveValue("C:\\Synthetic\\data");
 await page.evaluate(()=>(window as any).__setup.state.choice=(window as any).__setup.state.models);
 await page.locator("#choose-models").click();
 await page.getByRole("button",{name:"检查并继续"}).click();
 await expect(page.getByLabel("设备配对凭证")).toBeFocused();
 assert.equal(await page.getByLabel("设备配对凭证").getAttribute("type"),"password");
 await page.screenshot({path:resolve(folder,"setup-pair-light.png"),fullPage:true});
 await page.evaluate(()=>(window as any).__setup.state.failure="DEVICE_CREDENTIAL_REJECTED");
 await page.getByLabel("设备配对凭证").fill("s".repeat(40));await page.getByRole("button",{name:"验证并配对"}).click();
 await expect(page.getByRole("alert")).toContainText("配对凭证已失效");await expect(page.getByRole("alert")).toBeFocused();
 await expect(page.getByLabel("设备配对凭证")).toHaveValue("");await expect(page.locator("#finish")).toBeHidden();
 await page.getByRole("button",{name:"返回修改"}).click();await expect(page.getByLabel("研究工作区地址")).toBeFocused();
 await page.evaluate(()=>(window as any).__setup.state.failure="");
 await page.getByRole("button",{name:"检查并继续"}).click();await page.getByLabel("设备配对凭证").fill("s".repeat(40));
 await page.getByRole("button",{name:"验证并配对"}).click();
 await expect(page.getByRole("heading",{name:"设备已配对"})).toBeFocused();
 await expect(page.getByRole("button",{name:"启动托盘与服务"})).toBeHidden();
 checks.push("native folder cancellation preserves selection; checks, credential rejection, correction and paired-only state are distinct");
 await page.evaluate(()=>{Object.assign((window as any).__setup.state,{hold:true,failure:"LOCAL_APPLICATION_PREPARATION_FAILED"});});
 await page.getByRole("button",{name:"准备本机程序"}).click();
 await expect(page.getByRole("button",{name:"准备本机程序"})).toBeDisabled();
 await expect(page.locator("#progress")).toContainText("正在准备并校验");
 await page.screenshot({path:resolve(folder,"setup-preparing-light.png"),fullPage:true});
 await page.evaluate(()=>(window as any).__release());
 await expect(page.getByRole("alert")).toContainText("配对结果已保留");
 await page.emulateMedia({colorScheme:"dark"});await page.setViewportSize({width:580,height:540});
 await page.screenshot({path:resolve(folder,"setup-error-dark-narrow.png"),fullPage:true});
 await page.evaluate(()=>Object.assign((window as any).__setup.state,{hold:true,holdProgress:true,failure:""}));
 await page.getByRole("button",{name:"准备本机程序"}).click();
 await expect.poll(()=>page.evaluate(()=>typeof (window as any).__releaseProgress)).toBe("function");
 await page.evaluate(()=>(window as any).__release());
 await expect(page.getByRole("heading",{name:"本机程序已就绪"})).toBeVisible();
 await page.evaluate(async()=>{(window as any).__setup.state.holdProgress=false;(window as any).__releaseProgress();await new Promise(requestAnimationFrame);});
 await expect(page.locator("#progress")).toBeEmpty();
 checks.push("late progress cannot revive a finished operation; failure warning receives visible keyboard focus");
 await page.getByRole("button",{name:"启用登录启动"}).click();await expect(page.locator("#startup-status")).toContainText("已为此配置启用");
 await page.getByRole("button",{name:"移除登录启动"}).click();await expect(page.locator("#startup-status")).toContainText("已移除");
 await page.getByRole("button",{name:"启动托盘与服务"}).click();
 await expect(page.getByRole("heading",{name:"本机服务已启动"})).toBeVisible();
 await page.screenshot({path:resolve(folder,"setup-started-dark-narrow.png"),fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 checks.push("preparation failure remains retryable; actual success controls readiness, startup registration and running state");
 await page.goto("about:blank");await page.goto("file:///"+resolve("local/desktop/setup.html").replaceAll("\\","/")+"#paired");
 await expect(page.getByRole("heading",{name:"设备已配对"})).toBeVisible();await expect(page.getByLabel("设备配对凭证")).toBeHidden();
 checks.push("reopening an already paired configuration resumes preparation without asking for its credential");
 assert.deepEqual(failures,[]);
 await mkdir("docs/validation",{recursive:true});await writeFile("docs/validation/browser-setup.json",JSON.stringify({at:new Date().toISOString(),passed:true,mode:"explicit native bridge fixture in Edge; not an actual OS picker or Windows login",checks},null,2));
 console.log(JSON.stringify({passed:true,checks:checks.length,paidModelRequests:0}));
}finally{await browser.close();}
