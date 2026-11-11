import { Problem } from "./domain.ts";
import type { StateStorage } from "./state-store.ts";

export const BUDGET_STOPS = new Set(["BILLING_UNAVAILABLE","MONTHLY_BUDGET","BACKGROUND_BUDGET","BACKGROUND_DAILY_BUDGET","PRICE_NOT_CONFIGURED","PRICE_REVIEW_REQUIRED"]);
const MICRO = 1_000_000;
export interface ModelUsage { input: number; output: number }
export interface PriceCard {
  id: string; model: string; baseUrl: string; source: string; effective: string;
  bands: { maxInput: number; inputPerMillion: number; outputPerMillion: number }[];
}
// Integer micro-CNY per million tokens. No cache/promotion discount is assumed.
export const QWEN_PRICE: PriceCard = {
  id:"dashscope-cn-qwen3.7-flash-2026-11-11", model:"qwen3.7-flash",
  baseUrl:"https://dashscope.aliyuncs.com/compatible-mode/v1",
  source:"https://help.aliyun.com/zh/model-studio/qwen3-7-flash", effective:"2026-11-11",
  bands:[
    {maxInput:32000,inputPerMillion:200000,outputPerMillion:800000},
    {maxInput:256000,inputPerMillion:600000,outputPerMillion:2400000},
    {maxInput:1000000,inputPerMillion:1200000,outputPerMillion:4800000},
  ]
};
function tokens(v: number) { if(!Number.isSafeInteger(v)||v<0||v>1000000)throw new Problem("INVALID_MODEL_USAGE"); }
export function costMicro(price: PriceCard, usage: ModelUsage) {
  tokens(usage.input);tokens(usage.output);
  const band=price.bands.find(b=>usage.input<=b.maxInput);
  if(!band)throw new Problem("UNPRICED_CONTEXT",503);
  return Math.ceil((usage.input*band.inputPerMillion+usage.output*band.outputPerMillion)/MICRO);
}
export function billingTime(now: number) {
  const d=new Date(now+8*3600000),month=d.toISOString().slice(0,7),day=d.toISOString().slice(0,10);
  const daysRemaining=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate()-d.getUTCDate()+1;
  return {month,day,daysRemaining};
}
interface Totals { spent: number; reserved: number; background: number; background_reserved: number }
interface Receipt {
  id:string; task_id:string; month:string; day:string; background:number; created:number;
  input_bound:number; output_bound:number; reserved:number; charged:number|null;
  input:number|null; output:number|null; status:string; price:string;
}
export class BudgetLedger {
  storage:StateStorage;
  constructor(storage:StateStorage) {
    this.storage=storage;
    storage.transactionSync(()=>{
      storage.sql.exec("CREATE TABLE IF NOT EXISTS pra_budget_months(month TEXT PRIMARY KEY,spent INTEGER NOT NULL DEFAULT 0,reserved INTEGER NOT NULL DEFAULT 0,background INTEGER NOT NULL DEFAULT 0,background_reserved INTEGER NOT NULL DEFAULT 0)");
      storage.sql.exec("CREATE TABLE IF NOT EXISTS pra_budget_days(day TEXT PRIMARY KEY,spent INTEGER NOT NULL DEFAULT 0,reserved INTEGER NOT NULL DEFAULT 0)");
      storage.sql.exec("CREATE TABLE IF NOT EXISTS pra_model_calls(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,month TEXT NOT NULL,day TEXT NOT NULL,background INTEGER NOT NULL,created INTEGER NOT NULL,input_bound INTEGER NOT NULL,output_bound INTEGER NOT NULL,reserved INTEGER NOT NULL,charged INTEGER,input INTEGER,output INTEGER,status TEXT NOT NULL,price TEXT NOT NULL)");
      storage.sql.exec("CREATE INDEX IF NOT EXISTS pra_model_calls_month ON pra_model_calls(month,id)");
      storage.sql.exec("CREATE INDEX IF NOT EXISTS pra_model_calls_status ON pra_model_calls(status,id)");
    });
  }
  private totals(month:string):Totals {
    return this.storage.sql.exec<Totals>("SELECT spent,reserved,background,background_reserved FROM pra_budget_months WHERE month=?",month).toArray()[0]??{spent:0,reserved:0,background:0,background_reserved:0};
  }
  reserve(request:{id:string;taskId:string;input:number;output:number;background?:boolean;model:string;baseUrl:string}, now=Date.now()) {
    const price=QWEN_PRICE;
    if(request.model!==price.model||request.baseUrl.replace(/\/$/,"")!==price.baseUrl)throw new Problem("PRICE_NOT_CONFIGURED",503);
    if(now>Date.parse(price.effective+"T00:00:00+08:00")+30*86400000)throw new Problem("PRICE_REVIEW_REQUIRED",503);
    const amount=costMicro(price,request),{month,day,daysRemaining}=billingTime(now),bg=request.background?1:0;
    if(!request.id||!request.taskId)throw new Problem("INVALID_RESERVATION");
    return this.storage.transactionSync(()=>{
      const old=this.storage.sql.exec<Receipt>("SELECT * FROM pra_model_calls WHERE id=?",request.id).toArray()[0];
      if(old) {
        if(old.task_id!==request.taskId||old.input_bound!==request.input||old.output_bound!==request.output||old.background!==bg)throw new Problem("RESERVATION_CONFLICT",409);
        // A settled attempt must never be reused to issue another HTTP call.
        if(old.status!=="reserved")throw new Problem("RESERVATION_ALREADY_SETTLED",409);
        return old.id;
      }
      const total=this.totals(month),committed=total.spent+total.reserved;
      if(committed+amount>50*MICRO)throw new Problem("MONTHLY_BUDGET",429);
      if(bg) {
        if(committed+amount>45*MICRO||total.background+total.background_reserved+amount>20*MICRO)throw new Problem("BACKGROUND_BUDGET",429);
        const today=this.storage.sql.exec<{spent:number;reserved:number}>("SELECT spent,reserved FROM pra_budget_days WHERE day=?",day).toArray()[0]??{spent:0,reserved:0};
        const available=20*MICRO-total.background-total.background_reserved;
        const daily=Math.ceil((available+today.spent+today.reserved)/daysRemaining);
        if(today.spent+today.reserved+amount>daily)throw new Problem("BACKGROUND_DAILY_BUDGET",429);
      }
      this.storage.sql.exec("INSERT INTO pra_budget_months(month) VALUES(?) ON CONFLICT(month) DO NOTHING",month);
      this.storage.sql.exec("UPDATE pra_budget_months SET reserved=reserved+?,background_reserved=background_reserved+? WHERE month=?",amount,bg?amount:0,month);
      if(bg) {
        this.storage.sql.exec("INSERT INTO pra_budget_days(day) VALUES(?) ON CONFLICT(day) DO NOTHING",day);
        this.storage.sql.exec("UPDATE pra_budget_days SET reserved=reserved+? WHERE day=?",amount,day);
      }
      this.storage.sql.exec("INSERT INTO pra_model_calls VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,'reserved',?)",request.id,request.taskId,month,day,bg,now,request.input,request.output,amount,JSON.stringify(price));
      return request.id;
    });
  }
  settle(id:string, usage?:ModelUsage) {
    return this.storage.transactionSync(()=>{
      const row=this.storage.sql.exec<Receipt>("SELECT * FROM pra_model_calls WHERE id=?",id).toArray()[0];
      if(!row)throw new Problem("UNKNOWN_RESERVATION",404);
      if(row.status!=="reserved")return {charged:row.charged!,status:row.status};
      // Unknown provider usage and interrupted attempts remain conservatively charged.
      let charged=row.reserved,status="unknown";
      if(usage) {charged=costMicro(JSON.parse(row.price),usage);status=charged>row.reserved?"overrun":"settled";}
      this.storage.sql.exec("UPDATE pra_model_calls SET charged=?,input=?,output=?,status=? WHERE id=?",charged,usage?.input??null,usage?.output??null,status,id);
      this.storage.sql.exec("UPDATE pra_budget_months SET spent=spent+?,reserved=reserved-?,background=background+?,background_reserved=background_reserved-? WHERE month=?",
        charged,row.reserved,row.background?charged:0,row.background?row.reserved:0,row.month);
      if(row.background)this.storage.sql.exec("UPDATE pra_budget_days SET spent=spent+?,reserved=reserved-? WHERE day=?",charged,row.reserved,row.day);
      return {charged,status};
    });
  }
  importLegacy(usage:ModelUsage,now=Date.now()) {
    // Earlier versions had aggregate tokens only. Attribute a conservative upper-tier estimate once.
    if(this.storage.sql.exec("SELECT id FROM pra_model_calls LIMIT 1").toArray().length)return;
    const {month,day}=billingTime(now),band=QWEN_PRICE.bands.at(-1)!;
    const charged=Math.ceil((usage.input*band.inputPerMillion+usage.output*band.outputPerMillion)/MICRO);
    this.storage.transactionSync(()=>{
      this.storage.sql.exec("INSERT INTO pra_model_calls VALUES('legacy-aggregate','legacy',?,?,0,?,?,?,0,?,?,?,'legacy-estimate',?)",month,day,now,usage.input,usage.output,charged,usage.input,usage.output,JSON.stringify(QWEN_PRICE));
      this.storage.sql.exec("INSERT INTO pra_budget_months(month,spent) VALUES(?,?) ON CONFLICT(month) DO UPDATE SET spent=spent+excluded.spent",month,charged);
    });
  }
  recoverInterrupted() {
    const pending=this.storage.sql.exec<{id:string}>("SELECT id FROM pra_model_calls WHERE status='reserved'").toArray();
    for(const row of pending)this.settle(row.id);
    return pending.length;
  }
  snapshot(now=Date.now()) {
    const {month}=billingTime(now),t=this.totals(month),committed=t.spent+t.reserved;
    return {month,currency:"CNY",limit:50,backgroundLimit:20,estimatedSpent:t.spent/MICRO,reserved:t.reserved/MICRO,
      backgroundSpent:t.background/MICRO,backgroundReserved:t.background_reserved/MICRO,
      remaining:Math.max(0,50-committed/MICRO),warning:committed>=40*MICRO,
      backgroundPaused:committed>=45*MICRO||t.background+t.background_reserved>=20*MICRO,blocked:committed>=50*MICRO,
      accounting:"conservative-estimate",priceId:QWEN_PRICE.id,priceSource:QWEN_PRICE.source};
  }
  calls(after="",limit=50,now=Date.now()) {
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new Problem("INVALID_PAGE");
    const rows=this.storage.sql.exec<Receipt>("SELECT * FROM pra_model_calls WHERE month=? AND id>? ORDER BY id LIMIT ?",billingTime(now).month,after,limit+1).toArray();
    return {items:rows.slice(0,limit).map(({price,...r})=>({...r,priceId:JSON.parse(price).id})),nextCursor:rows.length>limit?rows[limit-1].id:null};
  }
}
