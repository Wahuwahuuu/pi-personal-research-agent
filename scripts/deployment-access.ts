export interface DeploymentAccess {kind:"device"|"session";path:string;headers:Record<string,string>}
export interface DeploymentCredentials {deviceToken?:string;sessionCookie?:string;bootstrapToken?:string}
type Fetcher=typeof globalThis.fetch;
function origin(raw:string){
 const u=new URL(raw);
 if(u.username||u.password||u.search||u.hash||u.pathname!=="/"||!(u.protocol==="https:"||(u.protocol==="http:"&&["127.0.0.1","localhost"].includes(u.hostname))))throw Error("INVALID_DEPLOYMENT_ORIGIN");
 return u.origin;
}
async function request(url:string,path:string,options:RequestInit,fetcher:Fetcher){
 try{return await fetcher(origin(url)+path,{...options,redirect:"error",signal:AbortSignal.timeout(10000)});}
 catch{throw Error("DEPLOYMENT_PROBE_UNAVAILABLE");}
}
async function value(response:Response){
 if(!response.ok)return undefined;
 try{const v=await response.json() as any;return v&&typeof v==="object"?v:undefined;}catch{return undefined;}
}
export async function deploymentBuild(url:string,access:DeploymentAccess,fetcher:Fetcher=fetch){
 const r=await request(url,access.path,{headers:access.headers},fetcher);
 if([401,403].includes(r.status))throw Error("DEPLOYMENT_AUTH_REJECTED");
 const v=await value(r);
 if(!v||typeof v.build!=="string"||v.build.length>128||!v.build||(access.kind==="device"&&(v.protocol!==1||!/^[a-f0-9]{64}$/.test(v.accountScope))))throw Error("DEPLOYMENT_PROBE_UNAVAILABLE");
 return v.build as string;
}
export async function deploymentAccess(url:string,credentials:DeploymentCredentials,fetcher:Fetcher=fetch):Promise<DeploymentAccess>{
 origin(url);
 const candidates:DeploymentAccess[]=[];
 if(credentials.deviceToken){
  if(!/^[A-Za-z0-9._-]{32,256}$/.test(credentials.deviceToken))throw Error("INVALID_DEPLOYMENT_CREDENTIAL");
  candidates.push({kind:"device",path:"/api/device/verify",headers:{Authorization:"Bearer "+credentials.deviceToken}});
 }
 if(credentials.sessionCookie){
  if(!/^[a-zA-Z0-9_-]+=[A-Za-z0-9._%-]{16,512}$/.test(credentials.sessionCookie))throw Error("INVALID_DEPLOYMENT_CREDENTIAL");
  candidates.push({kind:"session",path:"/api/state",headers:{Cookie:credentials.sessionCookie}});
 }
 for(const access of candidates){try{await deploymentBuild(url,access,fetcher);return access;}catch{/* Try another explicitly supplied credential; never weaken server authentication. */}}
 const status=await request(url,"/api/auth/status",{},fetcher);
 const authentication=await value(status);
 if(!(authentication?.bootstrapAvailable===true||status.status===404)||!credentials.bootstrapToken)throw Error("DEPLOYMENT_AUTH_REQUIRED");
 const login=await request(url,"/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:credentials.bootstrapToken})},fetcher);
 const cookie=login.headers.get("set-cookie")?.split(";")[0];
 if(!login.ok||!cookie||/[\r\n]/.test(cookie))throw Error("DEPLOYMENT_AUTH_REJECTED");
 const access:DeploymentAccess={kind:"session",path:"/api/state",headers:{Cookie:cookie}};
 await deploymentBuild(url,access,fetcher);return access;
}
export async function waitForDeployment(url:string,access:DeploymentAccess,build:string,options:{timeoutMs?:number;intervalMs?:number;fetcher?:Fetcher}={}){
 const until=Date.now()+(options.timeoutMs??120000),fetcher=options.fetcher??fetch;
 do{
  try{if(await deploymentBuild(url,access,fetcher)===build)return;}
  catch(error){if(error instanceof Error&&error.message==="DEPLOYMENT_AUTH_REJECTED")throw error;}
  await new Promise(r=>setTimeout(r,options.intervalMs??1500));
 }while(Date.now()<until);
 throw Error("DEPLOYED_BUILD_NOT_SERVING");
}
