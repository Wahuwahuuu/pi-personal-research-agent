import {test} from "node:test";
import assert from "node:assert/strict";
import {validateOperatorTarget,privateOperatorPath} from "../scripts/platform-operator.ts";
const target={name:"research",url:"https://research.example.workers.dev",build:"a".repeat(40),servingBuildVerified:true};
test("operator only accepts a verified, explicit HTTPS workers.dev deployment",()=>{
 assert.equal(validateOperatorTarget(target).name,"research");
 for(const patch of [{url:"http://research.example.workers.dev"},{url:"https://research.example.workers.dev/path"},{url:"https://research.example.workers.dev.evil.example"},{url:"https://user:password@research.example.workers.dev"},{name:"different"},{build:"development"},{servingBuildVerified:false}])assert.throws(()=>validateOperatorTarget({...target,...patch}));
});
test("operator paths are contained in ignored local configuration before reading credentials",()=>{
 assert.ok(privateOperatorPath(".local/validation/session.secret"));
 for(const path of ["../session.secret","README.md",".local/../../secret",".local-bypass/session.secret"])assert.throws(()=>privateOperatorPath(path),/LOCAL_OPERATOR_FILE_REQUIRED/);
});
