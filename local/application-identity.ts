import {readFile} from "node:fs/promises";
import {resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {APPLICATION_CONTRACT,assertApplicationCompatible} from "./application-contract.ts";
/** The launcher verifies full file integrity before execution; this identifies the actual entry point. */
export async function applicationIdentity(root=resolve(dirname(fileURLToPath(import.meta.url)),"..")){
 let value:any;
 try{value=JSON.parse(await readFile(resolve(root,"release.json"),"utf8"));}
 catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return{build:"development",managed:false,contract:APPLICATION_CONTRACT};throw Error("LOCAL_RELEASE_INVALID");}
 assertApplicationCompatible(value.contract);
 if(value.format!==1||value.status!=="ready"||!/^[a-f0-9]{40}$/.test(value.build??"")||!/^[a-f0-9]{64}$/.test(value.digest??""))throw Error("LOCAL_RELEASE_INVALID");
 return{build:value.build,digest:value.digest,managed:true,contract:APPLICATION_CONTRACT};
}
