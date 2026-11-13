import {spawn} from "node:child_process";
import {resolve,dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {availableRuntimes} from "../local/first-run.ts";
import {verifyRuntimeCandidate} from "../local/runtime-switch.ts";
import {runtimeEnvironment} from "../local/runtime-install.ts";
const root=resolve(dirname(fileURLToPath(import.meta.url)),".."),args=process.argv.slice(2);
const arg=(name:string)=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
try{
 if(process.platform!=="win32")throw Error("WINDOWS_REQUIRED");
 const chosen=arg("--runtime"),runtime=chosen?await verifyRuntimeCandidate(root,chosen):(await availableRuntimes(root))[0];
 if(!runtime)throw Error("DESKTOP_RUNTIME_REQUIRED");
 const launch=["-B",join(root,"local/desktop/setup.py"),"--node",process.execPath,"--config",resolve(arg("--config")??join(root,".local/node.json"))];
 if(arg("--release"))launch.push("--release",resolve(arg("--release")!));
 const child=spawn(join(dirname(runtime.python),"pythonw.exe"),launch,{cwd:root,env:runtimeEnvironment(),windowsHide:true,stdio:"ignore",detached:true});
 await new Promise<void>((ok,no)=>{child.once("spawn",()=>ok());child.once("error",()=>no(Error("DESKTOP_START_FAILED")));});
 child.unref();process.stdout.write("已打开本机首次设置窗口。\n");
}catch(e){const code=e instanceof Error&&/^[A-Z_]+$/.test(e.message)?e.message:"DESKTOP_START_FAILED";
 process.stderr.write(code==="DESKTOP_RUNTIME_REQUIRED"?"请先按 README 的 Windows 运行环境安装步骤准备 Python 与检索模型，再打开设置窗口。\n":code+"\n");process.exitCode=1;}
