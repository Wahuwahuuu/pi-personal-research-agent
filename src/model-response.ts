/** Decode only visible OpenAI-compatible fields; reasoning fields never cross this boundary. */
export async function modelResponse(response:Response,key:string,onText:(text:string)=>void){
 const reader=response.body?.getReader();if(!reader)throw Error("EMPTY_RESPONSE");
 const decoder=new TextDecoder(),sse=response.headers.get("content-type")?.includes("text/event-stream");
 let bytes=0,pending="",text="",sent=0,done=false,finish:string|undefined,usage:any;
 const calls=new Map<number,any>();
 const safe=(value:string)=>{if(value.includes(key)||/<\/?(?:think|thinking|analysis)>/i.test(value))throw Error("UNSAFE_RESPONSE");};
 const emit=(final=false)=>{safe(text);const end=final?text.length:Math.max(0,text.length-Math.max(key.length,32));if(end>sent){onText(text.slice(sent,end));sent=end;}};
 const frame=(value:string)=>{
  if(value==="[DONE]"){done=true;return;}
  const row=JSON.parse(value);if(row.error)throw Error("MODEL_HTTP_ERROR");if(row.usage)usage=row.usage;
  const choice=row.choices?.[0];if(!choice)return;
  if(choice.finish_reason)finish=choice.finish_reason;
  const delta=choice.delta??{};
  if(delta.content!==undefined&&delta.content!==null){if(typeof delta.content!=="string")throw Error("INVALID_CONTENT");text+=delta.content;emit();}
  for(const part of delta.tool_calls??[]){
   if(!Number.isSafeInteger(part.index)||part.index<0||part.index>=10)throw Error("INVALID_TOOLS");
   const prior=calls.get(part.index)??{id:"",type:"function",function:{name:"",arguments:""}};
   if(part.id)prior.id+=part.id;if(part.type)prior.type=part.type;
   if(part.function?.name)prior.function.name+=part.function.name;
   if(part.function?.arguments)prior.function.arguments+=part.function.arguments;
   calls.set(part.index,prior);
  }
 };
 try{
  while(true){
   const r=await reader.read();if(r.done)break;bytes+=r.value.length;if(bytes>1000000)throw Error("RESPONSE_TOO_LARGE");
   pending+=decoder.decode(r.value,{stream:true});
   if(sse){let at;while((at=pending.indexOf("\n"))>=0){const line=pending.slice(0,at).replace(/\r$/,"");pending=pending.slice(at+1);if(line.startsWith("data:"))frame(line.slice(5).trimStart());}}
  }
  pending+=decoder.decode();
  if(!sse){const data=JSON.parse(pending);safe(JSON.stringify(data.choices?.[0]?.message?.content??""));return data;}
  if(pending.startsWith("data:"))frame(pending.slice(5).trim());
  if(!done||!finish)throw Error("INCOMPLETE_STREAM");
  safe(JSON.stringify([...calls.values()]));emit(true);
  return {choices:[{message:{content:text,tool_calls:[...calls.entries()].sort((a,b)=>a[0]-b[0]).map(([,v])=>v)},finish_reason:finish}],usage};
 }finally{await reader.cancel().catch(()=>{});}
}

/** Extract only the answer field from a partial JSON envelope; never show execution metadata. */
export function answerPreview(text:string):string{
 const value=text.trimStart();if(!value.startsWith("{"))return value.startsWith("```")?"":value;
 let depth=0;
 for(let i=0;i<value.length;i++){
  if(value[i]==="{"){depth++;continue;}if(value[i]==="}"){depth--;continue;}if(value[i]!==String.fromCharCode(34))continue;
  const start=i++;let escape=false;
  for(;i<value.length;i++){if(escape)escape=false;else if(value[i]==="\\")escape=true;else if(value[i]===String.fromCharCode(34))break;}
  if(i>=value.length)return "";
  const field=JSON.parse(value.slice(start,i+1));let cursor=i+1;while(/\s/.test(value[cursor]??"!") )cursor++;
  if(depth!==1||field!=="answer"||value[cursor]!==":")continue;
  cursor++;while(/\s/.test(value[cursor]??"!"))cursor++;if(value[cursor]!==String.fromCharCode(34))return "";
  const from=cursor++;escape=false;
  for(;cursor<value.length;cursor++){if(escape)escape=false;else if(value[cursor]==="\\")escape=true;else if(value[cursor]===String.fromCharCode(34))return JSON.parse(value.slice(from,cursor+1));}
  let tail=value.slice(from+1);tail=tail.replace(/\\(?:u[0-9a-fA-F]{0,3})?$/,"");
  try{return JSON.parse(String.fromCharCode(34)+tail+String.fromCharCode(34));}catch{return "";}
 }
 return "";
}
