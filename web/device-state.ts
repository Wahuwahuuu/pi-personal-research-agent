import type { Overview } from "./types.ts";
export function deviceView(
  data?: Pick<Overview, "deviceOnline" | "deviceState">,
) {
  const connected = data?.deviceState?.connected ?? data?.deviceOnline ?? false;
  if (!connected)
    return {
      connected: false,
      label: "本机离线",
      detail: "本机尚未连接，检索任务会等待",
    };
  if (data?.deviceState?.ready ?? data?.deviceOnline)
    return {
      connected: true,
      label: "本机已连接",
      detail: "本机已连接，可执行科研工具",
    };
  const labels: Record<string, [string, string]> = {
    indexing: [
      "本机正在建索引",
      "本机已连接，正在建立论文索引；检索任务会在完成后继续。",
    ],
    paused: [
      "本机处理已暂停",
      "本机已连接，处理已暂停；可在 Windows 托盘继续。",
    ],
    reading: [
      "本机正在阅读",
      "本机已连接，正在阅读论文；其他检索任务排队等待。",
    ],
    busy: [
      "本机正在处理",
      "本机已连接，正在处理已有任务；其他检索任务排队等待。",
    ],
  };
  const [label, detail] = labels[data?.deviceState?.phase ?? ""] ?? [
    "本机正在准备",
    "本机已连接，正在准备检索能力；待办会保留。",
  ];
  return { connected: true, label, detail };
}
