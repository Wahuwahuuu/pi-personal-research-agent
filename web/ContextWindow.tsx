import type { Task } from "./types.ts";
export function ContextWindow({task}:{task:Task}){
  const window=task.workflow?.contextWindow;
  if(!window)return null;
  const stage:Record<string,string>={prepare:"理解要求",agent:"整理回答",completion:"检查完成情况",comparison:"逐篇比较"};
  return <details className="context-window help">
    <summary>对话上下文范围</summary>
    <p>最近准备的步骤：{stage[window.stage]??"研究"}。准备时已保存 {window.stored_turns} 轮讨论，本次选入 {window.visible_recent_turns.length} 轮；其中 {window.truncated_recent_turns.length} 轮只取了部分文字。</p>
    <p>同时选入 {window.constraints} 条约束、{window.memories} 条个人记忆、{window.unresolved_questions} 个未解决问题。</p>
    {!!window.invalidated_turns_excluded&&<p>{window.invalidated_turns_excluded} 轮来源已失效，未纳入本次上下文。</p>}
    {!window.answers_included&&<p>近期轮次只带入提问，已保存的完整回答仍可在历史中查看。</p>}
    <p>历史仍保存在会话中，不代表每次都会发给模型。这里显示本步开始前准备的内容；执行中新读取的原文见证据面板。</p>
  </details>;
}
