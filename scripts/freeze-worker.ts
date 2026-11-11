import {execFileSync} from "node:child_process";
import {readFile,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
/** Pin a test server to one bundle so unrelated edits cannot silently restart its in-flight WebSockets. */
export async function freezeWorker(configPath:string,outputDir:string){
 const config=JSON.parse(await readFile(configPath,"utf8"));
 try{
  execFileSync(process.execPath,["node_modules/wrangler/bin/wrangler.js","deploy","--dry-run","--config",configPath,"--outdir",outputDir],{
   windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,WRANGLER_SEND_METRICS:"false"},timeout:120000
  });
 }catch{throw Error("ISOLATED_WORKER_BUILD_FAILED");}
 config.main=resolve(outputDir,"worker.js");
 await writeFile(configPath,JSON.stringify(config));
}
