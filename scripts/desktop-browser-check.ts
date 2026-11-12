import {chromium,expect} from "@playwright/test";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import assert from "node:assert/strict";
const browser=await chromium.launch({channel:"msedge",headless:true}),page=await browser.newPage({viewport:{width:800,height:740}});
const folder=resolve(".impeccable/review");await mkdir(folder,{recursive:true});
const failures:string[]=[],checks:string[]=[];
page.on("pageerror",e=>failures.push(e.message));
await page.addInitScript(()=>{
 const state:any={ok:true,connected:true,ready:true,paused:false,phase:"empty",indexVersion:"synthetic-library-v2",libraryEnabled:true,imports:[],application:{build:"a".repeat(40)}};
 (window as any).__desktopState=state;
 const calls:any[]=[];(window as any).__desktopCalls=calls;
 const ok=(value:any)=>({ok:true,value});
 (window as any).pywebview={api:{
  status:async()=>JSON.parse(JSON.stringify(state)),
  start:async()=>ok({accepted:true}),
  control:async(action:string)=>{calls.push(["control",action]);state.paused=action==="pause";state.phase=state.paused?"paused":"ready";return ok({accepted:true});},
  import_pdf:async()=>{state.imports=[{id:"synthetic-pdf",title:"Synthetic study: source-grounded research",source:"sha256:synthetic",status:"indexing"}];return ok(state.imports);},
  import_arxiv:async(value:string)=>/^\d{4}\.\d{4,5}v[1-9]\d*$/.test(value)?ok({id:"arxiv-import"}):{ok:false,error:"VERSIONED_ARXIV_ID_REQUIRED"},
  job:async(action:string,id:string)=>{calls.push(["job",action,id]);state.imports[0].status=action==="cancel"?"cancelled":"queued";return ok(state.imports[0]);},
  library:async(query:string)=>ok({indexVersion:state.indexVersion,total:query?0:1,next:null,papers:query?[]:[{paperId:"synthetic-paper",title:"Synthetic study: source-grounded research"}]}),
  open_paper:async(...args:any[])=>{calls.push(["open",...args]);return ok({opened:true});},
  open_web:async()=>ok({opened:true}),diagnostics:async()=>ok({saved:true})
 }};
});
try{
 await page.goto("file:///"+resolve("local/desktop/panel.html").replaceAll("\\","/"));
 await expect(page.getByRole("heading",{name:"等待导入第一篇论文"})).toBeVisible();
 await page.screenshot({path:resolve(folder,"desktop-empty-light.png"),fullPage:true});
 await page.evaluate(()=>(window as any).__desktopState.phase="ready");
 await expect(page.getByRole("heading",{name:"本机已就绪"})).toBeVisible();
 checks.push("explicit empty-library phase offers first import without a false model-loaded claim");
 await page.getByRole("button",{name:"暂停处理",exact:true}).click();
 await expect(page.getByRole("heading",{name:"本机处理已暂停"})).toBeVisible();
 await page.getByRole("button",{name:"恢复处理",exact:true}).click();
 checks.push("pause and resume use the real bridge contract");
 await page.getByRole("button",{name:"选择本机 PDF"}).click();
 await expect(page.getByText("正在建立索引",{exact:true})).toBeVisible();
 await page.evaluate(()=>{const job=(window as any).__desktopState.imports[0];job.status="failed";job.error="PDF_TEXT_ENCODING_INVALID";});
 await expect(page.getByText("这份 PDF 的文字映射不完整，暂时无法可靠解析。请尝试论文的其他公开版本。",{exact:true})).toBeVisible({timeout:12000});
 await page.evaluate(()=>{const job=(window as any).__desktopState.imports[0];job.status="indexing";delete job.error;});
 await expect(page.getByText("正在建立索引",{exact:true})).toBeVisible({timeout:12000});
 checks.push("invalid PDF text mappings remain an explicit failure with an actionable explanation");
 await page.getByRole("button",{name:"取消",exact:true}).click();
 await expect(page.getByText("已取消",{exact:true})).toBeVisible();
 await page.getByRole("button",{name:"重试",exact:true}).click();
 await expect(page.getByText("等待处理",{exact:true})).toBeVisible();
 checks.push("import, cancel and retry expose actual stage responses");
 await page.locator("#arxiv-id").fill("2401.00001");
 await page.getByRole("button",{name:"从 arXiv 导入"}).click();
 await expect(page.getByRole("alert")).toContainText("完整 arXiv 编号和版本");
 await page.getByRole("button",{name:"关闭错误提示"}).click();
 await page.screenshot({path:resolve(folder,"desktop-node-light.png"),fullPage:true});
 await page.getByRole("button",{name:"本机论文",exact:true}).click();
 await expect(page.locator("#papers").getByText("Synthetic study: source-grounded research",{exact:true})).toBeVisible();
 await page.getByLabel("页码").fill("0");
 await page.getByRole("button",{name:"打开全文"}).click();
 await expect(page.getByLabel("页码")).toBeFocused();
 assert.equal(await page.getByLabel("页码").evaluate((el:HTMLInputElement)=>el.validationMessage),"请输入 1–1000 的整数页码。");
 assert.equal(await page.evaluate(()=>(window as any).__desktopCalls.filter((c:any[])=>c[0]==="open").length),0);
 await page.getByLabel("页码").fill("3");
 await page.getByRole("button",{name:"打开全文"}).click();
 const calls=await page.evaluate(()=>(window as any).__desktopCalls);
 assert.ok(calls.some((c:any[])=>c[0]==="open"&&c[1]==="synthetic-paper"&&c[2]==="synthetic-library-v2"&&c[3]===3));
 await page.screenshot({path:resolve(folder,"desktop-papers-light.png"),fullPage:true});
 await page.getByLabel("搜索本机论文").fill("unmatched");
 await page.getByRole("button",{name:"搜索",exact:true}).click();
 await expect(page.getByText("没有匹配的论文。")).toBeVisible();
 checks.push("private reader uses paper, snapshot and page identity; empty search is explicit");
 await page.emulateMedia({colorScheme:"dark"});await page.setViewportSize({width:580,height:540});
 await page.getByRole("button",{name:"连接与导入"}).click();
 await page.screenshot({path:resolve(folder,"desktop-node-dark-narrow.png"),fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.keyboard.press("Tab");assert.ok(await page.evaluate(()=>document.activeElement?.tagName!=="BODY"));
 await page.getByText("版本信息",{exact:true}).click();
 await expect(page.locator("#application-version")).toHaveText("正在运行版本 aaaaaaaa");
 await page.evaluate(async()=>{(window as any).__desktopState.ok=false;await (window as any).refresh();});
 await expect(page.locator("#application-version")).toHaveText("服务尚未就绪，运行版本未确认。");
 await page.evaluate(async()=>{(window as any).__desktopState.ok=true;(window as any).__desktopState.application={build:"development"};await (window as any).refresh();});
 await expect(page.locator("#application-version")).toHaveText("当前运行开发工作副本。");
 checks.push("actual application version, development source and unconfirmed offline state are distinguished");
 await page.evaluate(async()=>{Object.assign((window as any).__desktopState,{ok:false,starting:true,phase:"loading",application:{build:"b".repeat(40)}});await (window as any).refresh();});
 await expect(page.getByText("正在加载本机科研服务，完成后会自动连接云端。")).toBeVisible();
 await expect(page.getByRole("button",{name:"启动服务"})).toBeHidden();
 await expect(page.getByRole("button",{name:"暂停处理"})).toBeDisabled();
 await expect(page.locator("#application-version")).toHaveText("正在运行版本 bbbbbbbb");
 await page.evaluate(async()=>{Object.assign((window as any).__desktopState,{starting:false,ok:true,phase:"ready"});await (window as any).refresh();});
 checks.push("initialization reports the identified running version while controls stay unavailable");
 assert.equal(failures.length,0,failures.join("\n"));
 checks.push("light/dark, narrow window, keyboard focus and no script errors");
 await mkdir("docs/validation",{recursive:true});
 await writeFile("docs/validation/desktop-browser.json",JSON.stringify({date:new Date().toISOString(),checks,fixtureBridge:true,nativeAcceptance:false,success:true},null,2));
 console.log(JSON.stringify({passed:checks.length,fixtureBridge:true,nativeAcceptance:false}));
}finally{await browser.close();}
