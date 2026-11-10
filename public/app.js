import {renderMarkdown} from "./markdown.js";
import {TaskProgressPanel} from "./task-progress.js";
let currentState,papers=[];
async function openSource(t,source){
 const target=$("source-content");target.replaceChildren();
 const heading=document.createElement("h2");heading.textContent=papers.find(p=>p.paper_id===source.paper_id)?.title??source.paper_id;
 const meta=document.createElement("p");meta.textContent=source.section+" · "+source.chunk_id+" · "+source.start+"–"+source.end;
 const body=document.createElement("div");renderMarkdown(body,source.text);
 target.append(heading,meta,body);
 const paper=papers.find(p=>p.paper_id===source.paper_id);
 for(const [label,url] of [["打开本地 PDF",paper?.localUrl],["打开公开原文",paper?.originalUrl]]){
  if(!url)continue;const link=document.createElement("a");link.textContent=label;link.href=url;link.target="_blank";link.rel="noopener noreferrer";target.append(link,document.createTextNode(" "));
 }
 target.append(button("翻译这段原文",async()=>{await api("tasks/"+t.id+"/translate","POST",{sourceIds:[source.chunk_id],requestId:crypto.randomUUID()});await refresh();$("source-dialog").close();}));
 if(!$("source-dialog").open)$("source-dialog").showModal();
}
function renderConversations(s){
 const selected=$("conversation").value,select=$("conversation");select.replaceChildren(new Option("新会话",""));
 for(const c of s.conversations??[])select.add(new Option(c.title,c.id));
 if([...select.options].some(o=>o.value===selected))select.value=selected;
}
async function loadPapers(){
 const version=currentState?.tasks.findLast(t=>t.researchIndex)?.researchIndex;
 if(!version)return;
 papers=await api("papers?indexVersion="+encodeURIComponent(version));
 $("scope").replaceChildren();
 const scope=currentState.conversations?.find(c=>c.id===$("conversation").value)?.scope??[];
 for(const p of papers){const option=new Option(p.title,p.paper_id);option.selected=scope.includes(p.paper_id);$("scope").add(option);}
}
const $ = (id) => document.getElementById(id);
let socket,
  reconnectTimer,
  reconnectDelay = 1000;
async function api(path, method = "GET", body) {
  const r = await fetch("/api/" + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await r.json();
  if (!r.ok) throw Error(value.error || "REQUEST_FAILED");
  return value;
}
function guard(fn) {
  return async (e) => {
    e?.preventDefault();
    $("error").textContent = "";
    try {
      await fn(e);
    } catch (err) {
      $("error").textContent = err.message;
    }
  };
}
function button(label, fn) {
  const b = document.createElement("button");
  b.textContent = label;
  b.className = "secondary";
  b.onclick = guard(fn);
  return b;
}
function item(title, body) {
  const d = document.createElement("div");
  d.className = "item";
  const h = document.createElement("strong");
  h.textContent = title;
  d.append(h);
  if (body) {
    const p = document.createElement("p");
    p.textContent = body;
    d.append(p);
  }
  return d;
}
const labels = {
  queued: "排队",
  running: "执行中",
  waiting_device: "等待本机",
  waiting_user: "等待你处理",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};
function render(s) {
  currentState=s;renderConversations(s);
  $("model-status").textContent =
    s.mode === "mock"
      ? "当前为模拟模型验证环境，输出不代表科研结论。"
      : `当前模型：${s.model?.id ?? "已配置模型"} · 深度思考关闭。回答请结合原文证据核对。`;
  $("device").textContent = s.deviceOnline
    ? "本地节点已连接"
    : "本地节点离线 · 检索任务将等待";
  $("usage").textContent = JSON.stringify(s.usage, null, 2);
  for (const name of ["tasks", "memories", "notices", "plans"])
    $(name).replaceChildren();
  for (const t of [...s.tasks].reverse()) {
    if($("conversation").value&&t.conversationId!==$("conversation").value)continue;
    const d = item(labels[t.status]+" · "+t.input, t.error);
    if(t.answer){const answer=document.createElement("div");renderMarkdown(answer,t.answer,{sources:t.researchEvidence??[],onCitation:index=>openSource(t,t.researchEvidence[index])});d.append(answer);}
    if(t.workflow?.progress){
      const b=button("查看逐项进度",()=>{});
      const panel=new TaskProgressPanel({dialog:$("progress-dialog"),content:$("progress-content"),button:b,papers:()=>papers,onPaper:id=>{const source=t.researchEvidence?.find(e=>e.paper_id===id);if(source)openSource(t,source);}});
      panel.update(t.workflow.progress);d.append(b);
    }
    if(t.workflow?.translation?.items){const hint=document.createElement("p");hint.textContent="译文仅供辅助阅读，以原文为准。";d.append(hint);}
    if(t.conversationId)d.append(button("继续这个会话",async()=>{$("conversation").value=t.conversationId;render(currentState);await loadPapers();$("prompt").focus();}));
    if (!["completed", "cancelled", "failed"].includes(t.status))
      d.append(button("取消", () => api(`tasks/${t.id}/cancel`, "POST", {})));
    if (["failed","waiting_user"].includes(t.status))
      d.append(button("补充并继续",async()=>{$("conversation").value=t.conversationId??"";$("prompt").focus();await loadPapers();}));
    if (t.evidence) {
      const details = document.createElement("details"),
        summary = document.createElement("summary"),
        pre = document.createElement("pre");
      summary.textContent = "查看原始证据";
      pre.textContent = JSON.stringify(t.evidence, null, 2);
      details.append(summary, pre);
      d.append(details);
    }
    $("tasks").append(d);
  }
  for (const m of s.memories) {
    const d = item(m.content);
    d.append(
      button("纠正", async () => {
        const content = prompt("修改记忆", m.content);
        if (content) await api("memories", "POST", { id: m.id, content });
      }),
      button("删除", () => api("memories/" + m.id, "DELETE")),
    );
    $("memories").append(d);
  }
  for (const n of [...s.notices].reverse()) {
    const d = item(n.read ? "已读" : "更新", n.text);
    if (!n.read)
      d.append(
        button("标记已读", async () => {
          await api("notices/" + encodeURIComponent(n.id), "POST", {});
          await refresh();
        }),
      );
    $("notices").append(d);
  }
  for (const p of s.plans) {
    const d = item(p.query, p.enabled ? "每天检查 · Asia/Shanghai" : "已暂停");
    d.append(
      button(p.enabled ? "暂停" : "恢复", async () => {
        await api("plans/" + p.id, "PATCH", { enabled: !p.enabled });
        await refresh();
      }),
    );
    $("plans").append(d);
  }
}
async function refresh() {
  render(await api("state"));
}
function connect() {
  clearTimeout(reconnectTimer);
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
  socket = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/events`,
  );
  socket.onopen = () => {
    reconnectDelay = 1000;
    $("connection").textContent = "已连接";
  };
  socket.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "state") render(m.state);
  };
  socket.onclose = (e) => {
    if (e.code === 1008) {
      $("connection").textContent = "登录已过期，请刷新后登录";
      return;
    }
    $("connection").textContent = "连接断开 · 正在自动重连";
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(30000, reconnectDelay * 2);
  };
}
async function enter() {
  await refresh();
  $("login").hidden = true;
  $("workspace").hidden = false;
  connect();await loadPapers();
}
$("login-form").onsubmit = guard(async () => {
  await api("login", "POST", { token: $("token").value });
  $("token").value = "";
  await enter();
});
$("task-form").onsubmit = guard(async () => {
  const submitted=await api("tasks", "POST", {
    ...( $("conversation").value?{conversationId:$("conversation").value}:{} ),
    projectId:$("project").value,
    input: $("prompt").value,
    kind: $("kind").value,
    requestId: crypto.randomUUID(),
  });
  $("prompt").value = "";
  await refresh();
  $("conversation").value=submitted.conversationId;render(currentState);await loadPapers();
});
$("memory-form").onsubmit = guard(async () => {
  await api("memories", "POST", { content: $("memory").value });
  $("memory").value = "";
  await refresh();
});
$("plan-form").onsubmit = guard(async () => {
  await api("plans", "POST", { query: $("query").value });
  $("query").value = "";
  await refresh();
});
$("pair").onclick = guard(async () => {
  const r = await api("device/pair", "POST", {});
  $("device-token").value = r.token;
  $("device-token").hidden = false;
  $("copy").hidden = false;
});
$("copy").onclick = guard(() =>
  navigator.clipboard.writeText($("device-token").value),
);
$("revoke").onclick = guard(async () => {
  await api("device/revoke", "POST", {});
  $("device-token").value = "";
  await refresh();
});
$("conversation").onchange=guard(async()=>{const c=currentState.conversations?.find(c=>c.id===$("conversation").value);$("project").value=c?.projectId??"default";render(currentState);await loadPapers();});
$("rename").onclick=guard(async()=>{const id=$("conversation").value;if(!id)return;const title=prompt("会话名称");if(title){await api("conversations/"+id,"PATCH",{title});await refresh();}});
$("save-scope").onclick=guard(async()=>{const id=$("conversation").value;if(!id)throw Error("请先创建研究会话");await api("conversations/"+id,"PATCH",{scope:[...$("scope").selectedOptions].map(o=>o.value),projectId:$("project").value});await refresh();});
$("close-source").onclick=()=>$("source-dialog").close();
$("close-progress").onclick=()=>$("progress-dialog").close();
enter().catch(() => {});
