import {readFile} from "node:fs/promises";
import {resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {availableRuntimes,checkFirstRun,installFirstRun,activateFirstRun} from "../local/first-run.ts";
import {selectedApplication} from "../local/application-selection.ts";
import {launchApplication} from "../local/application-launch.ts";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const args=process.argv.slice(2),arg=(name:string)=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const path=resolve(arg("--config")??resolve(root,".local/node.json"));
const send=(value:unknown)=>process.stdout.write(JSON.stringify(value)+"\n");
try{
 let input="";for await(const chunk of process.stdin){input+=chunk;if(input.length>16384)throw Error("SETUP_INPUT_LIMIT");}
 const body=JSON.parse(input);input="";
 if(!body||typeof body!=="object"||Object.keys(body).some(k=>!["action","input","credential"].includes(k)))throw Error("INVALID_SETUP_INPUT");
 if(body.action==="status"){
  let configured=false;try{await readFile(path);configured=true;}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  const selected=configured?await selectedApplication(path,root):undefined;
  send({ok:true,value:{configured,ready:selected?.managed??false,build:selected?.build,config:path,runtimes:configured?[]:await availableRuntimes(root)}});
 }else if(body.action==="check"){
  const result=await checkFirstRun(root,path,body.input);
  send({ok:true,value:{checked:true,library:result.config.libraryRoot,data:result.config.dataDir,device:result.config.python.device}});
 }else if(body.action==="install"){
  const token=body.credential;delete body.credential;
  const result=await installFirstRun(root,path,body.input,token,{},phase=>send({phase}));
  send({ok:true,value:result});
 }else if(body.action==="activate"){
  send({phase:"preparing"});send({ok:true,value:await activateFirstRun(root,path,arg("--release"))});
 }else if(body.action==="start"){
  const child=await launchApplication(path,true,true);child?.unref();send({ok:true,value:{started:true}});
 }else throw Error("INVALID_SETUP_ACTION");
}catch(e){
 const message=e instanceof Error?e.message:"";
 send({ok:false,error:/^[A-Z_]{3,100}$/.test(message)?message:"SETUP_ACTION_FAILED"});process.exitCode=1;
}
