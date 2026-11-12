import { useState } from "react";
import type { Task } from "./types.ts";
import type { Run } from "./hooks.ts";
import { mutate } from "./api.ts";
import { Dialog, Field, date } from "./components.tsx";
export function TaskControls({
  task: t,
  run,
  refresh,
}: {
  task: Task;
  run: Run;
  refresh: () => void;
}) {
  const [editing, setEditing] = useState(false),
    [direction, setDirection] = useState("");
  if(t.control)return null;
  const terminal = ["completed", "failed", "cancelled"].includes(t.status),
    paused = t.status === "paused";
  const control = (action: string, body: Record<string, unknown> = {}) =>
    run(async () => {
      await mutate("tasks/" + t.id + "/" + action, "POST", body);
      refresh();
    });
  return (
    <div className="task-controls">
      {!terminal && (
        <div className="button-row">
          {paused ? (
            <button
              className="text-button"
              disabled={t.runOpen || t.error === "GOAL_BUDGET"}
              onClick={() => void control("resume")}
            >
              继续执行
            </button>
          ) : (
            <button
              className="text-button"
              onClick={() => void control("pause")}
            >
              暂停任务
            </button>
          )}
          {paused && (
            <button
              className="text-button"
              disabled={t.runOpen}
              onClick={() => setEditing(true)}
            >
              调整方向
            </button>
          )}
          <label className="task-priority">
            优先级{" "}
            <select
              aria-label={"任务优先级：" + t.input.slice(0, 40)}
              value={t.priority ?? 1}
              onChange={(e) =>
                void control("priority", { priority: Number(e.target.value) })
              }
            >
              <option value={2}>优先处理</option>
              <option value={1}>普通</option>
              <option value={0}>稍后处理</option>
            </select>
          </label>
        </div>
      )}
      {paused && (
        <p className="help" role="status">
          {t.runOpen
            ? "已收到暂停请求，当前步骤结束后保存进度。"
            : "进度已保存，继续时保留已用额度。正在执行的本机操作会先返回结果。"}
        </p>
      )}
      {t.goal && (
        <details className="goal-checkpoints">
          <summary>长期研究 · 第 {t.goal.segments.length} / 4 段</summary>
          <p className="help">
            累计模型请求 {t.calls} / 24 · 工具调用 {t.tools} / 40 · 活跃执行{" "}
            {Math.ceil(t.activeMs / 1000)} / 720 秒。等待电脑不计入活跃时间。
          </p>
          <ol>
            {t.goal.segments.map((s) => (
              <li key={s.index}>
                <strong>第 {s.index} 段</strong>
                {s.checkpoint ? (
                  <>
                    <span> · {date(s.checkpoint.saved)}</span>
                    <p>
                      {s.checkpoint.reason === "completed"
                        ? "本段要求已完成"
                        : s.checkpoint.remaining.length
                          ? s.checkpoint.remaining.join("；")
                          : "已保存当前进度，完成情况仍待检查。"}
                    </p>
                  </>
                ) : (
                  <p>按当前要求推进，下一步结束时保存检查点。</p>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}
      {t.amendments?.length ? (
        <details>
          <summary>已补充的要求</summary>
          {t.amendments.map((a, i) => (
            <p key={i}>{a.text}</p>
          ))}
        </details>
      ) : null}
      {editing && (
        <Dialog
          open={editing}
          onClose={() => setEditing(false)}
          title="调整任务方向"
        >
          <p>
            补充要求会保留已有证据和累计用量。保存后保持暂停，由你决定何时继续。
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await mutate("tasks/" + t.id + "/amend", "POST", {
                  input: direction,
                });
                setEditing(false);
                setDirection("");
                refresh();
              });
            }}
          >
            <Field label="补充当前要求">
              <textarea
                rows={4}
                value={direction}
                onChange={(e) => setDirection(e.target.value)}
                maxLength={2000}
                required
                autoFocus
              />
            </Field>
            <button className="primary" disabled={!direction.trim()}>
              保存调整
            </button>
          </form>
        </Dialog>
      )}
    </div>
  );
}
