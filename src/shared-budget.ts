import {BudgetLedger,BUDGET_STOPS,type ModelUsage} from "./budget.ts";
import {Problem} from "./domain.ts";
import type {StateStorage} from "./state-store.ts";
export class SharedBudget {
 readonly ledger:BudgetLedger;readonly db:StateStorage;
 constructor(db:StateStorage){
  this.db=db;this.ledger=new BudgetLedger(db);
  db.sql.exec("CREATE TABLE IF NOT EXISTS pra_budget_imports(owner TEXT PRIMARY KEY)");
  db.sql.exec("CREATE TABLE IF NOT EXISTS pra_budget_owners(id TEXT PRIMARY KEY,owner TEXT NOT NULL)");
 }
 import(owner:string,rows:any[]){
  if(this.db.sql.exec("SELECT owner FROM pra_budget_imports WHERE owner=?",owner).toArray().length)return;
  this.db.transactionSync(()=>{
   for(const row of rows){
    const id="import:"+owner+":"+row.id,charged=row.charged??row.reserved;
    if(!Number.isSafeInteger(charged)||charged<0)throw Error("INVALID_BUDGET_IMPORT");
    this.db.sql.exec("INSERT INTO pra_model_calls VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",id,row.task_id,row.month,row.day,row.background,row.created,row.input_bound,row.output_bound,row.reserved,charged,row.input,row.output,row.charged===null?"unknown":row.status,row.price);
    this.db.sql.exec("INSERT INTO pra_budget_owners VALUES(?,?)",id,owner);
    this.db.sql.exec("INSERT INTO pra_budget_months(month,spent,background) VALUES(?,?,?) ON CONFLICT(month) DO UPDATE SET spent=spent+excluded.spent,background=background+excluded.background",row.month,charged,row.background?charged:0);
    if(row.background)this.db.sql.exec("INSERT INTO pra_budget_days(day,spent) VALUES(?,?) ON CONFLICT(day) DO UPDATE SET spent=spent+excluded.spent",row.day,charged);
   }
   this.db.sql.exec("INSERT INTO pra_budget_imports VALUES(?)",owner);
  });
 }
 reserve(owner:string,request:Parameters<BudgetLedger["reserve"]>[0],now=Date.now()){
  // A model HTTP attempt has a 90-second timeout. Stale reservations stay charged,
  // rather than becoming free when the coordinating object is restarted.
  for(const row of this.db.sql.exec<{id:string}>("SELECT id FROM pra_model_calls WHERE status='reserved' AND created<?",now-180000).toArray())this.ledger.settle(row.id);
  try{return this.db.transactionSync(()=>{
   const existing=this.db.sql.exec<{owner:string}>("SELECT owner FROM pra_budget_owners WHERE id=?",request.id).toArray()[0];
   if(existing&&existing.owner!==owner)throw new Problem("RESERVATION_CONFLICT",409);
   const id=this.ledger.reserve(request,now);this.db.sql.exec("INSERT OR IGNORE INTO pra_budget_owners VALUES(?,?)",id,owner);
   return{ok:true as const,id,budget:this.ledger.snapshot(now)};
  });}catch(e){if(e instanceof Problem&&BUDGET_STOPS.has(e.code))return{ok:false as const,error:e.code};throw e;}
 }
 settle(owner:string,id:string,usage?:ModelUsage){
  if(this.db.sql.exec<{owner:string}>("SELECT owner FROM pra_budget_owners WHERE id=?",id).toArray()[0]?.owner!==owner)throw new Problem("UNKNOWN_RESERVATION",404);
  const result=this.ledger.settle(id,usage);return{...result,budget:this.ledger.snapshot()};
 }
 calls(owner:string,after="",limit=50){
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Problem("INVALID_PAGE");
  const items=this.db.sql.exec<any>("SELECT c.* FROM pra_model_calls c JOIN pra_budget_owners o ON o.id=c.id WHERE o.owner=? AND c.id>? ORDER BY c.id LIMIT ?",owner,after,limit+1).toArray();
  return{items:items.slice(0,limit).map(({price,...r})=>({...r,priceId:JSON.parse(price).id})),nextCursor:items.length>limit?items[limit-1].id:null};
 }
}
