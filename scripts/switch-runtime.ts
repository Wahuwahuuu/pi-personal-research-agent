import {switchRuntime,rollbackRuntime} from "../local/runtime-switch.ts";
try{
 const args=process.argv.slice(2),values:Record<string,string>={};
 while(args.length){const key=args.shift()!,value=args.shift();if(!["--config","--manifest","--rollback"].includes(key)||!value||values[key]!==undefined)throw Error("INVALID_SWITCH_ARGUMENT");values[key]=value;}
 if(!values["--config"]||!!values["--manifest"]===!!values["--rollback"])throw Error("CONFIG_AND_ONE_RUNTIME_ACTION_REQUIRED");
 const result=values["--manifest"]?await switchRuntime(values["--config"],values["--manifest"]):await rollbackRuntime(values["--config"],values["--rollback"]);
 console.log(JSON.stringify(result));
}catch(e){const code=e instanceof Error?e.message:"";console.error(/^[A-Z_]+$/.test(code)?code:"RUNTIME_SWITCH_FAILED");process.exitCode=1;}
