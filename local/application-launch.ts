import {spawn,type ChildProcess} from "node:child_process";
import {get} from "node:http";
import {readFile} from "node:fs/promises";
import {resolve,join,dirname} from "node:path";
import {withRuntimeConfiguration,type RuntimeSwitchControls} from "./runtime-switch.ts";
import {selectedApplication} from "./application-selection.ts";
import {runtimeEnvironment} from "./runtime-install.ts";
import {controlKey} from "./lifecycle.ts";
import {stopNode} from "./stop-node.ts";

export interface ApplicationLaunchControls extends RuntimeSwitchControls {
 health?:(port:number)=>Promise<any>;spawn?:(executable:string,args:string[],cwd:string,env:NodeJS.ProcessEnv)=>ChildProcess;
 delay?:(ms:number)=>Promise<void>;timeoutMs?:number;
}
export function applicationHealth(port:number):Promise<any>{
 return new Promise((ok,no)=>{
  const req=get({hostname:"127.0.0.1",port,path:"/health",timeout:1000},res=>{
   let bytes="";res.setEncoding("utf8");res.on("data",v=>{bytes+=v;if(bytes.length>4096)req.destroy();});
   res.on("end",()=>{try{if(res.statusCode!==200)throw Error();ok(JSON.parse(bytes));}catch{no(Error("LOCAL_APPLICATION_HEALTH_INVALID"));}});
   res.on("error",()=>no(Error("LOCAL_APPLICATION_HEALTH_FAILED")));
  });
  req.on("timeout",()=>req.destroy());
  req.on("error",e=>(e as NodeJS.ErrnoException).code==="ECONNREFUSED"?ok(undefined):no(Error("LOCAL_APPLICATION_HEALTH_FAILED")));
 });
}
/** Reserve the same config lock as upgrades until the selected process reports its actual build. */
export async function launchApplication(configPath:string,desktop:boolean,show=false,controls:ApplicationLaunchControls={}):Promise<ChildProcess|undefined>{
 configPath=resolve(configPath);
 return withRuntimeConfiguration(configPath,controls,async(root,current,config)=>{
  const selection=await selectedApplication(configPath,root);
  if(!selection.managed)throw Error("MANAGED_APPLICATION_REQUIRED");
  const health=controls.health??applicationHealth;
  const matches=(value:any)=>value?.instanceId===controlKey(configPath)&&value.application?.build===selection.build&&value.application?.digest===selection.digest;
  const existing=await health(config.port);
  if(existing&&!matches(existing))throw Error("LOCAL_APPLICATION_RESTART_REQUIRED");
  if(existing&&!desktop)return undefined;
  if((await readFile(configPath)).compare(current)!==0)throw Error("NODE_CONFIGURATION_CHANGED");
  const executable=desktop?join(dirname(config.libraryPython),"pythonw.exe"):process.execPath;
  const args=desktop?["-B",join(selection.directory,"local/desktop/main.py"),"--config",configPath,...(show?["--show"]:[])]:[join(selection.directory,"local/node.ts"),configPath];
  const child=(controls.spawn??((exe,args,cwd,env)=>spawn(exe,args,{cwd,env,windowsHide:true,stdio:"ignore"})))(executable,args,selection.directory,runtimeEnvironment());
  let error=false;child.once("error",()=>{error=true;});
  try{
   const deadline=Date.now()+(controls.timeoutMs??60000);
   do{
    const value=await health(config.port);if(matches(value))return child;
    if(value)throw Error("LOCAL_APPLICATION_RESTART_REQUIRED");
    if(error||child.exitCode!==null)throw Error("LOCAL_APPLICATION_START_FAILED");
    await (controls.delay??(ms=>new Promise(r=>setTimeout(r,ms))))(200);
   }while(Date.now()<deadline);
   throw Error("LOCAL_APPLICATION_START_TIMEOUT");
  }catch(e){
   // Stop only this authenticated configuration. Never terminate processes by their executable names.
   await (controls.stop??stopNode)(configPath).catch(()=>{});
   if(child.exitCode===null){
    // Wait for the owned launcher to exit before the final authenticated cleanup;
    // it must not create another child after the stop marker was observed.
    const exited=new Promise<void>((ok,no)=>{
     const timer=setTimeout(()=>no(Error("LOCAL_APPLICATION_CLEANUP_FAILED")),5000);
     child.once("exit",()=>{clearTimeout(timer);ok();});
    });
    child.kill();await exited;
   }
   await (controls.stop??stopNode)(configPath);
   throw e;
  }
 });
}
