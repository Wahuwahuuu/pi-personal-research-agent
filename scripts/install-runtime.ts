import {prepareRuntime} from "../local/runtime-install.ts";
const args=process.argv.slice(2),options:Record<string,string>={};
try{
 while(args.length){
  const key=args.shift()!,value=args.shift();
  if(!["--models","--device","--python","--uv","--proxy"].includes(key)||!value||options[key]!==undefined)throw Error("INVALID_INSTALL_ARGUMENT");
  options[key]=value;
 }
 if(!options["--models"]||!["cuda","cpu"].includes(options["--device"]))throw Error("MODELS_AND_DEVICE_REQUIRED");
 const result=await prepareRuntime({models:options["--models"],device:options["--device"] as "cuda"|"cpu",
  python:options["--python"],uv:options["--uv"],proxy:options["--proxy"]},
  {progress:phase=>console.log(JSON.stringify({phase}))});
 console.log(JSON.stringify(result));
}catch(e){const code=e instanceof Error?e.message:"";
 console.error(/^[A-Z_]+$/.test(code)?code:"RUNTIME_INSTALL_FAILED");process.exitCode=1;
}
