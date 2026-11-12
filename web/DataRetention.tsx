import {useEffect,useRef,useState} from "react";
import type {RetentionCandidate,RetentionPreview,retentionCandidates} from "../src/data-retention.ts";
import {api,errorText} from "./api.ts";
import {Dialog,Field,Loading,Pager,date} from "./components.tsx";
import {navigate,usePaged} from "./hooks.ts";
type RetentionPage=ReturnType<typeof retentionCandidates>;
export function DataRetention({revision,refresh}:{revision:number;refresh:()=>void}){
 const [days,setDays]=useState(180),[busy,setBusy]=useState<string>(),[error,setError]=useState(""),[receipt,setReceipt]=useState(""),
 [selection,setSelection]=useState<{preview:RetentionPreview;requestId:string}>(),[confirmation,setConfirmation]=useState(false);
 const trigger=useRef<HTMLButtonElement|null>(null),status=useRef<HTMLParagraphElement>(null),refreshButton=useRef<HTMLButtonElement>(null);
 const page=usePaged<RetentionCandidate>("data/retention?limit=20&days="+days,revision),value=page.value as RetentionPage|undefined;
 const returnFocus=useRef<HTMLElement|null>(null);
 useEffect(()=>{if(selection||!returnFocus.current)return;const target=returnFocus.current;returnFocus.current=null;const frame=requestAnimationFrame(()=>{if(target.isConnected)target.focus();});return()=>cancelAnimationFrame(frame);},[selection]);
 const close=()=>{if(confirmation||!selection)return;returnFocus.current=trigger.current;setSelection(undefined);setError("");};
 const inspect=async(item:RetentionCandidate)=>{
  setBusy(item.id);setError("");setReceipt("");
  try{const preview=await api<RetentionPreview>("data/retention/preview","POST",{id:item.id,days});setSelection({preview,requestId:crypto.randomUUID()});}
  catch(e){setError(errorText(e));}finally{setBusy(undefined);}
 };
 const confirm=async()=>{
  if(!selection)return;setConfirmation(true);setError("");
  try{const p=selection.preview;await api("data/retention/confirm","POST",{id:p.id,days:p.days,fingerprint:p.fingerprint,requestId:selection.requestId});
   returnFocus.current=status.current;setSelection(undefined);setReceipt("删除请求已登记。请在下方删除记录中查看云端与本机的清理结果。");page.reload();refresh();
  }catch(e){setError(errorText(e));}finally{setConfirmation(false);}
 };
 return <section className="data-retention" aria-labelledby="retention-heading">
  <div className="deletion-heading"><h3 id="retention-heading">会话保留与清理</h3><button ref={refreshButton} onClick={page.reload}>刷新可清理会话</button></div>
  <p className="help">研究内容默认保留。这里只列出已归档、未置顶且没有未完成任务的会话，由你逐条确认清理。</p>
  {value&&<p className={value.usage.nearTaskLimit?"warning":"help"}>已保存 {value.usage.conversations.toLocaleString()} 个会话、{value.usage.tasks.toLocaleString()} / {value.usage.taskLimit.toLocaleString()} 项任务。{value.usage.nearTaskLimit?"接近任务容量，请导出并清理不再需要的归档会话。":""}</p>}
  <Field label="最后活动时间"><select value={days} onChange={e=>{setDays(Number(e.target.value));setError("");setReceipt("");}}>
   <option value={180}>180 天以前</option><option value={365}>365 天以前</option><option value={90}>90 天以前</option><option value={30}>30 天以前</option><option value={0}>全部已归档</option>
  </select></Field>
  {page.error&&<div className="error" role="alert"><p>可清理会话暂时无法读取，请重新加载。{value?"下方保留的是上一次读取的结果。":""}</p><button onClick={page.reload}>重新加载会话</button></div>}
  {error&&!selection&&<p role="alert" className="error">{error}</p>}
  <p ref={status} tabIndex={-1} role="status" aria-live="polite" className="retention-receipt">{receipt}</p>
  {!value&&!page.error&&<Loading/>}
  {value&&!value.items.length&&<div className="deletion-empty"><p>{page.hasPrevious?"这一页没有可清理会话。":"没有符合条件的归档会话。"}</p><button onClick={()=>navigate("chat")}>管理会话</button></div>}
  {value&&value.items.length>0&&<ul className="deletion-list">{value.items.map(item=><li className="deletion-row" key={item.id}>
   <div className="deletion-row-heading"><h4>{item.title}</h4><time dateTime={new Date(item.lastActivity).toISOString()}>{date(item.lastActivity)}</time></div>
   <p className="help">{item.tasks} 项已结束任务</p>
   <div className="retention-actions"><button onClick={()=>navigate("chat",item.id)}>查看会话</button><button disabled={!!busy} onClick={e=>{trigger.current=e.currentTarget;void inspect(item);}}>{busy===item.id?"正在检查影响…":"检查清理影响"}</button></div>
  </li>)}</ul>}
  <Pager page={page}/>
  <Dialog open={!!selection} title="确认清理这段会话" onClose={close} dismissible={!confirmation}>
   {selection&&<><p className="retention-title">{selection.preview.title}</p><p>将清理本会话、相关成果和 {selection.preview.tasks} 项任务中的关联研究内容、{selection.preview.memories} 条派生记忆。</p>
    {selection.preview.relatedConversations>0&&<p className="warning">还会清除另外 {selection.preview.relatedConversations} 个会话中由这些内容派生的回答和研究记录。这些会话的独立用户消息会保留。</p>}
    <p className="help">{selection.preview.localOperations>0?"已登记的本地结果缓存需等待原设备确认清理。":""}论文库原件和费用记录保留。平台备份按平台保留策略处理。</p>
    {error&&<div className="error" role="alert"><p>{error}</p><button disabled={confirmation} onClick={()=>{returnFocus.current=refreshButton.current;setSelection(undefined);setError("");page.reload();}}>返回并刷新</button></div>}
    <div className="dialog-actions"><button onClick={close} disabled={confirmation}>保留会话</button><button className="danger" disabled={confirmation||!!error} onClick={()=>void confirm()}>{confirmation?"正在登记删除…":"确认删除会话"}</button></div>
   </>}
  </Dialog>
 </section>;
}
