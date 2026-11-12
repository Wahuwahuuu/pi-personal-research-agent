import {createHash} from "node:crypto";
import {createServer} from "node:net";

/** A loopback OS lock is released on process death; no stale filesystem lock to erase. */
export async function acquireDeploymentLock(accountId:string,name:string):Promise<()=>Promise<void>> {
 if(!/^[a-zA-Z0-9-]{1,80}$/.test(accountId)||!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name))throw Error("INVALID_DEPLOYMENT_IDENTITY");
 const port=51000+createHash("sha256").update(accountId+":"+name).digest().readUInt32BE(0)%12000;
 const server=createServer(socket=>socket.destroy());
 await new Promise<void>((ok,no)=>{
  server.once("error",()=>no(Error("DEPLOYMENT_LOCKED")));
  server.listen({host:"127.0.0.1",port,exclusive:true},ok);
 });
 let released=false;
 return async()=>{if(released)return;released=true;await new Promise<void>((ok,no)=>server.close(e=>e?no(Error("DEPLOYMENT_LOCK_RELEASE_FAILED")):ok()));};
}
