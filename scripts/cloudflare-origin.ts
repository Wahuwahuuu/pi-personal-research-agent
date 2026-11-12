/** Verify ownership before publishing; never send a platform token to a URL from a receipt. */
export async function verifyCloudflareOrigin(accountId:string,name:string,origin:string,token:string,fetcher:typeof fetch=fetch){
 if(!/^[a-zA-Z0-9-]{1,80}$/.test(accountId)||!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name))throw Error("INVALID_DEPLOYMENT_IDENTITY");
 let response:Response,value:any;
 try{
  response=await fetcher("https://api.cloudflare.com/client/v4/accounts/"+accountId+"/workers/subdomain",{
   headers:{Authorization:"Bearer "+token},redirect:"error",signal:AbortSignal.timeout(15000),
  });
  value=await response.json();
 }catch{throw Error("CLOUDFLARE_ORIGIN_UNAVAILABLE");}
 const expected="https://"+name+"."+value?.result?.subdomain+".workers.dev";
 if(!response.ok||value?.success!==true||typeof value?.result?.subdomain!=="string"||origin!==expected)
  throw Error("CLOUDFLARE_ORIGIN_MISMATCH");
}
