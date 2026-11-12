import {launchApplication} from "../local/application-launch.ts";
try{
 const args=process.argv.slice(2);let config="",desktop=false,show=false;
 while(args.length){const arg=args.shift();if(arg==="--config"&&!config){config=args.shift()??"";}else if(arg==="--desktop"&&!desktop)desktop=true;else if(arg==="--show"&&!show)show=true;else throw Error("INVALID_APPLICATION_ARGUMENT");}
 if(!config||config.startsWith("--")||(show&&!desktop))throw Error("INVALID_APPLICATION_ARGUMENT");
 const child=await launchApplication(config,desktop,show);
 if(child){
  const code=child.exitCode??await new Promise<number>(resolve=>{child.once("exit",code=>resolve(code??1));child.once("error",()=>resolve(1));});
  process.exitCode=code;
 }
}catch(e){const code=e instanceof Error?e.message:"";console.error(/^[A-Z_]+$/.test(code)?code:"LOCAL_APPLICATION_START_FAILED");process.exitCode=1;}
