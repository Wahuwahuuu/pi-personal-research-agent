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
  $("device").textContent = s.deviceOnline
    ? "本地节点已连接"
    : "本地节点离线 · 检索任务将等待";
  $("usage").textContent = JSON.stringify(s.usage, null, 2);
  for (const name of ["tasks", "memories", "notices", "plans"])
    $(name).replaceChildren();
  for (const t of [...s.tasks].reverse()) {
    const d = item(`${labels[t.status]} · ${t.input}`, t.answer || t.error);
    if (!["completed", "cancelled", "failed"].includes(t.status))
      d.append(button("取消", () => api(`tasks/${t.id}/cancel`, "POST", {})));
    if (t.status === "failed")
      d.append(button("重试", () => api(`tasks/${t.id}/continue`, "POST", {})));
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
  connect();
}
$("login-form").onsubmit = guard(async () => {
  await api("login", "POST", { token: $("token").value });
  $("token").value = "";
  await enter();
});
$("task-form").onsubmit = guard(async () => {
  await api("tasks", "POST", {
    input: $("prompt").value,
    kind: $("kind").value,
    requestId: crypto.randomUUID(),
  });
  $("prompt").value = "";
  await refresh();
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
enter().catch(() => {});
