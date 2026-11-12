import {Problem} from "./domain.ts";
import type {StateStorage} from "./state-store.ts";
import type {ModelUsage} from "./budget.ts";
export interface ValidationUsage extends ModelUsage {requests:number;reservedInput?:number;reservedOutput?:number}
export const VALIDATION_LIMITS={requests:500,input:6000000,output:1000000} as const;
function count(value:number){if(!Number.isSafeInteger(value)||value<0)throw new Problem("INVALID_VALIDATION_USAGE");}
interface Call {id:string;owner:string;task:string;input_bound:number;output_bound:number;input:number|null;output:number|null;status:string;created:number}
export class ValidationBudget {
 readonly db:StateStorage;
 constructor(db:StateStorage){this.db=db;
  db.sql.exec("CREATE TABLE IF NOT EXISTS pra_validation_imports(owner TEXT PRIMARY KEY,requests INTEGER NOT NULL,input INTEGER NOT NULL,output INTEGER NOT NULL)");
  db.sql.exec("CREATE TABLE IF NOT EXISTS pra_validation_calls(id TEXT PRIMARY KEY,owner TEXT NOT NULL,task TEXT NOT NULL,input_bound INTEGER NOT NULL,output_bound INTEGER NOT NULL,input INTEGER,output INTEGER,status TEXT NOT NULL,created INTEGER NOT NULL)");
  db.sql.exec("CREATE INDEX IF NOT EXISTS pra_validation_calls_status ON pra_validation_calls(status,created)");
 }
 imported(owner:string){return this.db.sql.exec("SELECT owner FROM pra_validation_imports WHERE owner=?",owner).toArray().length>0;}
 import(owner:string,usage:ValidationUsage){
  if(this.imported(owner))return;
  for(const v of [usage.requests,usage.input,usage.output,usage.reservedInput??0,usage.reservedOutput??0])count(v);
  const input=usage.input+(usage.reservedInput??0),output=usage.output+(usage.reservedOutput??0);count(input);count(output);
  this.db.sql.exec("INSERT INTO pra_validation_imports VALUES(?,?,?,?)",owner,usage.requests,input,output);
 }
 snapshot(){
  const prior=this.db.sql.exec<{requests:number;input:number;output:number}>("SELECT COALESCE(SUM(requests),0) AS requests,COALESCE(SUM(input),0) AS input,COALESCE(SUM(output),0) AS output FROM pra_validation_imports").toArray()[0];
  const calls=this.db.sql.exec<{requests:number;input:number;output:number;reservedInput:number;reservedOutput:number}>("SELECT COUNT(*) AS requests,COALESCE(SUM(input),0) AS input,COALESCE(SUM(output),0) AS output,COALESCE(SUM(CASE WHEN status='reserved' THEN input_bound ELSE 0 END),0) AS reservedInput,COALESCE(SUM(CASE WHEN status='reserved' THEN output_bound ELSE 0 END),0) AS reservedOutput FROM pra_validation_calls").toArray()[0];
  const used={requests:prior.requests+calls.requests,input:prior.input+calls.input,output:prior.output+calls.output,reservedInput:calls.reservedInput,reservedOutput:calls.reservedOutput};
  return {...used,limits:VALIDATION_LIMITS,scope:"application" as const,period:"lifetime" as const,legacyAccounting:"conservative-aggregate" as const,
   blocked:used.requests>=500||used.input+used.reservedInput>=6000000||used.output+used.reservedOutput>=1000000};
 }
 reserve(owner:string,request:{id:string;taskId:string;input:number;output:number},now=Date.now()){
  count(request.input);count(request.output);
  if(!this.imported(owner))throw new Problem("VALIDATION_MIGRATION_REQUIRED",503);
  return this.db.transactionSync(()=>{
   const previous=this.db.sql.exec<Call>("SELECT * FROM pra_validation_calls WHERE id=?",request.id).toArray()[0];
   if(previous){
    if(previous.owner!==owner||previous.task!==request.taskId||previous.input_bound!==request.input||previous.output_bound!==request.output)throw new Problem("RESERVATION_CONFLICT",409);
    if(previous.status!=="reserved")throw new Problem("RESERVATION_ALREADY_SETTLED",409);
    return;
   }
   const used=this.snapshot();
   if(used.blocked||used.input+used.reservedInput+request.input>6000000||used.output+used.reservedOutput+request.output>1000000)throw new Problem("VALIDATION_BUDGET",429);
   this.db.sql.exec("INSERT INTO pra_validation_calls VALUES(?,?,?,?,?,NULL,NULL,'reserved',?)",request.id,owner,request.taskId,request.input,request.output,now);
  });
 }
 settle(owner:string,id:string,usage?:ModelUsage){
  if(usage){count(usage.input);count(usage.output);}
  this.db.transactionSync(()=>{
   const row=this.db.sql.exec<Call>("SELECT * FROM pra_validation_calls WHERE id=?",id).toArray()[0];
   // Historical money calls are already covered by their owner's imported aggregate.
   if(!row)return;
   if(row.owner!==owner)throw new Problem("UNKNOWN_RESERVATION",404);
   if(row.status!=="reserved")return;
   this.db.sql.exec("UPDATE pra_validation_calls SET input=?,output=?,status=? WHERE id=?",usage?.input??row.input_bound,usage?.output??row.output_bound,usage?"settled":"unknown",id);
  });
 }
}
