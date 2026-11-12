import {useEffect,useRef,useState} from "react";
import {api,ApiError,errorText} from "./api.ts";
interface Request {id:string;status:"queued"|"opened"|"failed"|"expired"|"cancelled";expires:number;deviceLabel?:string;page?:number;error?:string}
interface Pending {id:string;expires:number;job?:Request}
const pending=new Map<string,Pending>();
function restore(key:string):Pending|undefined{
 let value=pending.get(key);
 if(!value)try{value=JSON.parse(sessionStorage.getItem(key)??"null")??undefined;}catch{}
 if(value&&typeof value.id==="string"&&typeof value.expires==="number"&&value.expires>Date.now()){pending.set(key,value);return value;}
 pending.delete(key);try{sessionStorage.removeItem(key);}catch{}
}
function retain(key:string,value:Pending){pending.set(key,value);try{sessionStorage.setItem(key,JSON.stringify(value));}catch{}}
export function ReaderAction({accountId,paperId,indexVersion,chunkId,taskId,artifactId}:{accountId:string;paperId:string;indexVersion:string;chunkId?:string;taskId?:string;artifactId?:string}){
 const key="pra-reader:"+JSON.stringify([accountId,paperId,indexVersion,chunkId,taskId,artifactId]);
 const initial=useRef(restore(key));
 const [device,setDevice]=useState<{available:boolean;deviceLabel?:string}>(),[job,setJob]=useState<Request|undefined>(initial.current?.job),[error,setError]=useState(""),[sending,setSending]=useState(false),[checking,setChecking]=useState(true),[deviceError,setDeviceError]=useState("");
 const mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 async function checkDevice(manual=false){
  if(manual)setChecking(true);
  try{const v=await api("reader/status?indexVersion="+encodeURIComponent(indexVersion));if(mounted.current){setDevice(v);setDeviceError("");}}
  catch(e){if(mounted.current)setDeviceError(errorText(e));}
  finally{if(mounted.current)setChecking(false);}
 }
 useEffect(()=>{void checkDevice();const t=setInterval(()=>void checkDevice(),5000);return()=>clearInterval(t);},[indexVersion]);
 function saved(value:Request){retain(key,{id:value.id,expires:value.expires,job:value});if(mounted.current)setJob(value);}
 useEffect(()=>{
  if(!job||job.status!=="queued")return;
  let active=true;
  const check=async()=>{
   try{const value=await api<Request>("reader/"+job.id);retain(key,{id:value.id,expires:value.expires,job:value});if(active){setJob(value);setError("");}}
   catch(e){if(active){
    setError(e instanceof ApiError&&e.status===404?"上次打开请求尚未确认。可以重试，系统会避免重复打开。":errorText(e));
    if(e instanceof ApiError&&e.status===404){retain(key,{id:job.id,expires:job.expires});setJob(undefined);}
    else if(Date.now()>=job.expires)saved({...job,status:"expired",error:"READER_EXPIRED"});
   }}
  };
  void check();const t=setInterval(check,1500);return()=>{active=false;clearInterval(t);};
 },[job?.id,job?.status,key]);
 const waiting=sending||job?.status==="queued",failed=job&&["failed","expired","cancelled"].includes(job.status);
 async function open(){
  const prior=restore(key),id=prior&&!prior.job?prior.id:crypto.randomUUID();
  const provisional:Request={id,status:"queued",expires:Date.now()+90000,deviceLabel:device?.deviceLabel};
  retain(key,{id,expires:provisional.expires,job:provisional});setSending(true);setError("");
  try{const value=await api<Request>("reader/open","POST",{requestId:id,paperId,indexVersion,chunkId,taskId,artifactId});saved(value);}
  catch(e){
   try{saved(await api<Request>("reader/"+id));if(mounted.current)setError("");}
   catch{retain(key,{id,expires:provisional.expires});if(mounted.current){setJob(undefined);setError(errorText(e));}}
  }finally{if(mounted.current)setSending(false);}
 }
 return <div className="reader-action">
  <button className="source-link" disabled={checking||!!deviceError||!device?.available||waiting} onClick={()=>void open()}>
   {waiting?"正在交给本机阅读器…":checking?"正在检查本机阅读器…":failed?"重试在电脑打开":job?.status==="opened"?"再次在电脑打开":"在已连接电脑打开"}
  </button>
  {checking?<p className="help" role="status">正在检查本机阅读器，请稍候。</p>:deviceError?<div role="alert"><p className="error">未能确认阅读器状态。{deviceError}</p><button onClick={()=>void checkDevice(true)}>重新检查连接</button></div>:<p className="help">{device?.available?"将在「"+device.deviceLabel+"」打开全文，文件不会传到当前网页。":"请打开 Windows 托盘并连接本机，才能打开本地全文。"}</p>}
  <div role="status" aria-live="polite">
   {job?.status==="queued"&&<p className="help">请求已保存，正在等待阅读窗口打开。</p>}
   {job?.status==="opened"&&<p className="help">「{job.deviceLabel}」已打开阅读窗口。{job.page?"定位到第 "+job.page+" 页。":"没有可核对的页码映射，已打开全文首页。"}</p>}
   {failed&&<p className="error">{errorText(new Error(job.error??"PDF_UNAVAILABLE"))}</p>}
  </div>
  {error&&<p role="alert" className="error">{error}</p>}
 </div>;
}
