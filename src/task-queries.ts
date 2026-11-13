import {Problem,type State,type Task} from "./domain.ts";
export interface TaskPageOptions {conversationId?:string;status?:string;before?:string;limit?:number}
export interface TaskPageQuery {conversationId?:string;status?:string;timestamp:number;id:string;limit:number}
interface TaskQueries {page:(query:TaskPageQuery)=>Task[];active:(includeOpen:boolean)=>Task[];byRequest:(requestId:string)=>Task|undefined}
const readers=new WeakMap<State,TaskQueries>();
export function bindTaskQueries(state:State,reader:TaskQueries){readers.set(state,reader);}
export function taskByRequest(state:State,requestId:string):Task|undefined{const reader=readers.get(state);return reader?reader.byRequest(requestId):state.tasks.find(t=>t.requestId===requestId);}
export const closedTask=(task:Task)=>["completed","failed","cancelled"].includes(task.status);
export const taskPageOrder=(a:Pick<Task,"created"|"id">,b:Pick<Task,"created"|"id">)=>b.created-a.created||(a.id===b.id?0:a.id<b.id?1:-1);
export function matchesTaskPage(task:Task,query:TaskPageQuery){return (!query.conversationId||task.conversationId===query.conversationId)&&(!query.status||task.status===query.status)&&(task.created<query.timestamp||task.created===query.timestamp&&task.id<query.id);}
export function activeTasks(state:State,includeOpen=false):Task[]{
 return readers.get(state)?.active(includeOpen)??state.tasks.filter(t=>!closedTask(t)||(includeOpen&&t.runOpen));
}
export function queryTaskPage(state:State,options:TaskPageOptions={}){
 const limit=options.limit??30;if(!Number.isInteger(limit)||limit<1||limit>100)throw new Problem("INVALID_PAGE");
 let timestamp=Number.MAX_SAFE_INTEGER,id="~";
 if(options.before){const split=options.before.indexOf(":");timestamp=Number(options.before.slice(0,split));id=options.before.slice(split+1);if(split<1||!Number.isSafeInteger(timestamp)||timestamp<0||!id||id.length>128)throw new Problem("INVALID_PAGE");}
 const query:TaskPageQuery={conversationId:options.conversationId,status:options.status,timestamp,id,limit};
 const rows=readers.get(state)?.page(query)??state.tasks.filter(t=>matchesTaskPage(t,query)).sort(taskPageOrder).slice(0,limit+1);
 return {items:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].created+":"+rows[limit-1].id:null};
}
