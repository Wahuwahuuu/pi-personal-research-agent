import assert from "node:assert/strict";
type API=(path:string,method?:string,body?:unknown,expected?:number)=>Promise<any>;
export async function verifyConversationControls(api:API) {
  const checks:string[]=[],prefix="control-"+crypto.randomUUID();
  const until=async(id:string,status:string)=>{
    const end=Date.now()+15000;
    while(Date.now()<end){const t=await api("tasks/"+id);if(t.status===status)return t;await new Promise(r=>setTimeout(r,100));}
    throw new Error("CONTROL_TASK_TIMEOUT:"+status);
  };
  const a=await api("tasks","POST",{requestId:prefix+"-a",input:"offline control fixture A",kind:"research"});
  await until(a.id,"waiting_device");
  const conversationId=a.conversationId;
  const command=(input:string,key:string=crypto.randomUUID())=>api("tasks","POST",{requestId:key,input,kind:"auto",conversationId});
  const before=(await api("state")).usage.requests;
  const paused=await command("暂停当前研究",prefix+"-pause");
  assert.equal(paused.control.outcome,"applied");assert.equal((await api("tasks/"+a.id)).status,"paused");
  assert.equal((await command("暂停当前研究"," "+prefix+"-pause ")).id,paused.id);
  for(const action of ["resume","continue","pause","priority","amend"])
    assert.equal((await api("tasks/"+paused.id+"/"+action,"POST",{requestId:crypto.randomUUID(),input:"direction",priority:2},409)).error,"CONTROL_REQUIRES_MESSAGE");
  const b=await api("tasks","POST",{requestId:prefix+"-b",input:"offline control fixture B",kind:"research",conversationId});
  assert.equal((await api("tasks/"+b.id)).status,"queued","same-conversation tasks serialize behind the paused predecessor");
  const clarification=await command("取消当前任务");
  assert.deepEqual(clarification.control.candidates,[b.id,a.id]);
  assert.equal(clarification.status,"waiting_user");
  const cancelled=await command("第二个");
  assert.equal(cancelled.control.targetId,a.id);assert.equal((await api("tasks/"+a.id)).status,"cancelled");
  await until(b.id,"waiting_device");
  assert.equal((await api("tasks/"+clarification.id)).control.outcome,"resolved");
  assert.equal((await command("暂停当前研究")).control.targetId,b.id);
  const beforeResume=await api("tasks/"+b.id);
  const resumed=await command("继续刚才的任务");
  const afterResume=await until(b.id,"waiting_device");
  assert.equal(resumed.control.targetId,b.id);
  assert.deepEqual([afterResume.calls,afterResume.tools,afterResume.activeMs],[beforeResume.calls,beforeResume.tools,beforeResume.activeMs]);
  const status=await command("现在做到哪了");
  assert.equal(status.control.targetId,b.id);assert.match(status.answer,/等待你的电脑/);
  await command("取消这个任务");
  const state=await api("state");
  assert.equal(state.usage.requests,before,"host controls and offline retries do not call the model");
  const receipts=state.tasks.filter((t:any)=>t.conversationId===conversationId&&t.control);
  assert.ok(receipts.every((t:any)=>t.calls===0&&t.tools===0&&t.activeMs===0));
  const history=state.conversations.find((c:any)=>c.id===conversationId).history;
  assert.equal(history.length,receipts.length);assert.equal(new Set(history.map((h:any)=>h.turn_id)).size,history.length);
  checks.push("natural-language pause/resume/cancel/status use the original task, retain budgets and persist host replies with zero model calls");
  checks.push("multi-task ordinal selection uses persisted IDs; control receipt cannot enter model execution through any task-control endpoint");
  await api("conversations/"+conversationId,"DELETE");
  return checks;
}
