import {readFile,access} from "node:fs/promises";
import {resolve} from "node:path";
import {configureNode,installationConfig,preflight} from "../local/setup.ts";
try{
 let template=resolve(".local/node-install.json"),file=resolve(".local/node.json"),check=false;
 const args=process.argv.slice(2);
 while(args.length){const key=args.shift();if(key==="--check"){check=true;continue;}
  if(!["--template","--config"].includes(key??"")||!args.length)throw Error("INVALID_SETUP_ARGUMENT");
  const value=args.shift()!;if(key==="--template")template=resolve(value);else file=resolve(value);
 }
 await access(file).then(()=>{throw Error("NODE_ALREADY_CONFIGURED");},error=>{if(error.code!=="ENOENT")throw error;});
 if(check){
  const config=installationConfig(JSON.parse(await readFile(template,"utf8")));
  console.log(JSON.stringify(await preflight(config)));
 }else{
  if(process.stdin.isTTY)throw Error("USE_SECURE_POWERSHELL_SETUP");
  let token="";for await(const part of process.stdin){token+=part;if(token.length>512)throw Error("INVALID_DEVICE_CREDENTIAL");}
  const result=await configureNode(template,file,token.trim());token="";
  console.log(JSON.stringify(result));
 }
}catch(error){
 const message=error instanceof Error?error.message:"";
 console.error(/^[A-Z_]+(?::[a-z0-9-]+)?(?:,[A-Z_]+(?::[a-z0-9-]+)?)*$/.test(message)?message:"NODE_SETUP_FAILED");
 process.exitCode=1;
}
