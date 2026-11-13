import {taskByRequest} from "./task-queries.ts";
import { cancel, Problem, submit, text, type State, type Task } from "./domain.ts";
import { pauseTask, resumeTask, settledForControl } from "./task-control.ts";
export type ControlAction = "pause" | "resume" | "cancel" | "status";
export interface ControlReceipt {
  action: ControlAction;
  outcome: "applied" | "clarification" | "blocked" | "resolved";
  targetId?: string; candidates?: string[]; resolvedBy?: string;
}
export interface ControlIntent { action?: ControlAction; ordinal?: number; weak?: boolean }
export interface ControlSelection {
  action: ControlAction; targetId?: string; candidates?: string[]; clarificationId?: string; message?: string;
}
const noun = "(?:研究(?:任务)?|任务|工作)";
const reference = "(?:(?:当前(?:的)?|这个|这项|刚才的|刚刚的)?" + noun + ")";
const ordinal = "第([1-9][0-9]?|[一二三四五六七八九十])(?:个|项)";
const numberOf = (v: string) => /^[0-9]+$/.test(v) ? Number(v) : "零一二三四五六七八九十".indexOf(v);
const trimCommand = (v: string) => v.trim().normalize("NFKC").replace(/[。.!！?？]+$/u, "").replace(/(?:好吗|可以吗|吧)$/u, "").replace(/^(?:(?:请(?:你)?|麻烦(?:你)?|帮我|先)){1,3}/u, "").trim();
/** Deliberately narrow: a quotation, negation or research question is never a host command. */
export function parseControlIntent(input: string): ControlIntent | undefined {
  if (input.length > 80) return;
  const s = trimCommand(input).replace(/\s+/gu, "");
  if (/^(?:现在)?(?:做到哪(?:里)?了|进展如何|进度如何|进度怎么样了?)$/.test(s) ||
      new RegExp("^(?:" + reference + ")?(?:的)?(?:进度|进展|做到哪(?:里)?了|怎么样了|进展如何|进度如何|进度怎么样了?)$").test(s) ||
      new RegExp("^(?:查看|查询|看一下|看看|看下|查一下)(?:" + reference + ")?(?:的)?(?:进度|进展)$").test(s))
    return { action: "status" };
  if (s === "停一下") return { action: "pause" };
  const selection = new RegExp("^" + ordinal + "(?:" + noun + ")?$").exec(s);
  if (selection) return { ordinal: numberOf(selection[1]) };
  for (const [action, verbs] of [["pause", "(?:暂停|暂时停止)"], ["resume", "(?:继续|恢复)"], ["cancel", "(?:取消|停止)"]] as const) {
    const selected = new RegExp("^" + verbs + ordinal + "(?:" + noun + ")?$").exec(s);
    if (selected) return { action, ordinal: numberOf(selected[1]) };
    if (new RegExp("^" + verbs + "(?:一下)?(?:" + reference + ")?(?:一下)?$").test(s))
      return { action, ...(action === "resume" && /^(继续|恢复)(一下)?$/.test(s) ? { weak: true } : {}) };
  }
}
const active = (t: Task) => !["completed", "failed", "cancelled"].includes(t.status);
const eligible = (t: Task, action: ControlAction) => !t.control && (action === "status" ||
  (action === "resume" ? ["paused", "waiting_user"].includes(t.status) : active(t)));
const statusName = (t: Task) => ({
  queued: "排队中", running: "执行中", waiting_device: "等待你的电脑", waiting_user: "等待你补充信息",
  paused: "已请求暂停", completed: "已完成", failed: "失败", cancelled: "已取消",
}[t.status]);
const title = (t: Task) => Array.from(t.input.replace(/\s+/gu, " ")).slice(0, 70).join("").replace(/[\\`*_{}[\]()#+.!>|~$-]/g, "\\$&");
const actionName: Record<ControlAction, string> = { pause: "暂停", resume: "继续", cancel: "取消", status: "查看进度" };
export function resolveConversationControl(s: State, conversationId: string, input: string, now = Date.now()): ControlSelection | undefined {
  const intent = parseControlIntent(input);
  if (!intent) return;
  const turns = s.tasks.filter(t => t.conversationId === conversationId);
  const previous = turns.at(-1);
  if (intent.ordinal !== undefined) {
    const receipt = previous?.control;
    if (!intent.action && !receipt) return;
    const action = intent.action ?? receipt!.action;
    if (!receipt || receipt.outcome !== "clarification" || previous.status !== "waiting_user" ||
        now - previous.created > 300000 || now < previous.created || action !== receipt.action)
      return { action, message: "这项选择已失效。请重新发送暂停、继续、取消或进度指令，获取当前任务列表。" };
    const id = receipt.candidates?.[intent.ordinal - 1];
    const target = turns.find(t => t.id === id);
    if (!target || !eligible(target, action))
      return { action, message: "所选任务已结束、已变化或序号不在列表中。请重新发送指令获取当前列表。", clarificationId: previous.id };
    return { action, targetId: target.id, clarificationId: previous.id };
  }
  const action = intent.action!;
  let targets = turns.filter(t => eligible(t, action)).reverse();
  if (action === "status") {
    const live = targets.filter(active);
    targets = live.length ? live : targets.slice(0, 1);
  }
  if (intent.weak && !targets.length) return;
  if (!targets.length) return { action, message: "当前会话没有可以" + actionName[action] + "的任务。请在目标任务所在的会话中操作。"};
  if (targets.length === 1) return { action, targetId: targets[0].id };
  const candidates = targets.slice(0, 5);
  return {
    action, candidates: candidates.map(t => t.id),
    message: "这个会话有多项任务。请选择要" + actionName[action] + "的一项：\n\n" +
      candidates.map((t, i) => (i + 1) + ". " + title(t) + "（" + statusName(t) + "）").join("\n") +
      "\n\n回复“第一个”等序号，选择在 5 分钟内有效。" +
      (targets.length > 5 ? "这里只列出最近 5 项；其余任务请在活动页面操作。" : ""),
  };
}
const blockedMessage = (code: string) => {
  if (code === "PAUSE_PENDING") return "当前步骤还没有结束，暂时不能继续。请等进度保存后再试。";
  if (["GOAL_BUDGET", "MODEL_BUDGET", "TOOL_BUDGET", "VALIDATION_BUDGET"].includes(code))
    return "原任务已达到执行预算上限，未开始新的调用。已有进度和用量保留。";
  if (code === "NEW_TASK_REQUIRED") return "原任务使用的上下文已失效，无法直接恢复。请重新说明当前研究要求。";
  if (code.startsWith("PLATFORM_")) return "云端资源保护尚未解除，后台研究继续等待；已有进度已保留。";
  return "任务状态已经变化，未开始新的执行步骤。请查看任务卡后再操作。";
};
export function controlStatus(t: Task, s: State) {
  const status = t.status === "paused" && settledForControl(s, t) ? "已暂停" : statusName(t);
  const lines = ["任务：“" + title(t) + "”", "当前状态：" + status + "。",
    "累计模型请求 " + t.calls + " 次，工具调用 " + t.tools + " 次，活跃执行 " + Math.ceil(t.activeMs / 1000) + " 秒。"];
  if (t.workflow?.progress?.items.length) {
    const names = { pending: "待处理", running: "进行中", retrieved: "已取得原文", supported: "已有证据", answered: "已回答", gap: "证据缺口", stopped: "已停止", unconfirmed: "待确认" };
    lines.push(...t.workflow.progress.items.slice(0, 8).map(i => "- " + i.label.replace(/\s+/g, " ").slice(0, 200) + "：" + names[i.state]));
  }
  return lines.join("\n\n");
}
/** The caller commits this mutation and its host side effects in one storage transaction. */
export function recordConversationControl(s: State, conversationId: string, input: unknown, requestId: unknown, selected: ControlSelection,
  hooks: { cancel?: (task: Task) => void; resumeBlocked?: string } = {}, now = Date.now()) {
  const c = s.conversations?.find(c => c.id === conversationId);
  if (!c) throw new Problem("UNKNOWN_CONVERSATION", 404);
  const key=text(requestId,128);
  const prior = taskByRequest(s,key);
  const receipt = submit(s, input, key, "auto", now);
  if (prior) {
    if (prior.conversationId !== conversationId || !prior.control) throw new Problem("REQUEST_CONFLICT", 409);
    return prior;
  }
  receipt.conversationId = conversationId;
  receipt.control = { action: selected.action, outcome: selected.candidates ? "clarification" : "blocked",
    ...(selected.candidates ? { candidates: selected.candidates } : {}) };
  receipt.status = "waiting_user";
  receipt.answer = selected.message;
  if (selected.targetId) {
    const target = s.tasks.find(t => t.id === selected.targetId && t.conversationId === conversationId && eligible(t, selected.action));
    if (!target) throw new Problem("CONTROL_TARGET_CHANGED", 409);
    receipt.control.targetId = target.id;
    try {
      if (selected.action === "pause") {
        pauseTask(target);
        if (target.proactive) target.proactive.planPaused = false;
        receipt.answer = settledForControl(s, target) ? "任务已暂停，已有进度和累计用量已保留。" : "已请求暂停，当前步骤结束后停止推进并保存进度。";
      } else if (selected.action === "resume") {
        if (target.origin === "schedule" && hooks.resumeBlocked) throw new Problem(hooks.resumeBlocked, 429);
        resumeTask(s, target);
        receipt.answer = target.status === "waiting_device" ? "原任务已恢复，正在等待你的电脑提供科研工具。累计用量保留。" : "原任务已重新排队，将从已有进度继续。累计用量保留。";
      } else if (selected.action === "cancel") {
        cancel(s, target.id, now);
        receipt.answer = "任务已取消，不再启动新的步骤；已发出的操作将收到停止请求，迟到结果不会覆盖取消状态。";
      } else receipt.answer = controlStatus(target, s);
      receipt.control.outcome = "applied";
      receipt.status = "completed";
    } catch (e) {
      if (!(e instanceof Problem) || !["PAUSE_PENDING","TASK_NOT_PAUSED","TASK_CLOSED","NEW_TASK_REQUIRED","GOAL_BUDGET","MODEL_BUDGET","TOOL_BUDGET","VALIDATION_BUDGET"].includes(e.code) && !e.code.startsWith("PLATFORM_")) throw e;
      receipt.answer = blockedMessage(e.code);
    }
  }
  if(receipt.control.outcome==="applied" && selected.action==="cancel") hooks.cancel?.(s.tasks.find(t=>t.id===selected.targetId)!);
  const previous = selected.clarificationId ? s.tasks.find(t => t.id === selected.clarificationId && t.conversationId === conversationId) : undefined;
  if (previous?.control?.outcome === "clarification") {
    previous.control.outcome = "resolved"; previous.control.resolvedBy = receipt.id;
    previous.status = "completed"; previous.updated = now;
  }
  c.history.push({ turn_id: receipt.id, user_text: receipt.input, final_answer: receipt.answer! });
  c.updated = now;
  return receipt;
}
