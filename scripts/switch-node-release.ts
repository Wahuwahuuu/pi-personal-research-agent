import {selectApplication,rollbackApplication} from "../local/application-selection.ts";
try{
 const args=process.argv.slice(2),values:Record<string,string>={};
 while(args.length){const key=args.shift()!,value=args.shift();if(!["--config","--release","--rollback"].includes(key)||!value||value.startsWith("--")||values[key])throw Error("INVALID_APPLICATION_ARGUMENT");values[key]=value;}
 if(!values["--config"]||Number(!!values["--release"])+Number(!!values["--rollback"])!==1)throw Error("APPLICATION_TARGET_REQUIRED");
 console.log(JSON.stringify(values["--rollback"]?await rollbackApplication(values["--config"],values["--rollback"]):await selectApplication(values["--config"],values["--release"])));
}catch(e){const code=e instanceof Error?e.message:"";console.error(/^[A-Z_]+$/.test(code)?code:"LOCAL_APPLICATION_SWITCH_FAILED");process.exitCode=1;}
