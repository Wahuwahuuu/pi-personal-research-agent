import {prepareApplicationRelease} from "../local/application-release.ts";
try {
 if(process.argv.length!==2)throw Error("INVALID_RELEASE_ARGUMENT");
 const result=await prepareApplicationRelease();
 console.log(JSON.stringify({prepared:true,release:result.directory,build:result.manifest.build,digest:result.digest,files:result.manifest.files.length,started:false}));
}catch(error){
 const code=error instanceof Error?error.message:"";
 console.error(/^[A-Z_]+$/.test(code)?code:"LOCAL_APPLICATION_PREPARATION_FAILED");process.exitCode=1;
}
