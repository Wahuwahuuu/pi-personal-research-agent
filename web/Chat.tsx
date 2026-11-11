import { TaskControls } from "./TaskControls.tsx";
import { useEffect, useRef, useState } from "react";
import { api, mutate, errorText } from "./api.ts";
import {
  Markdown,
  Icon,
  Status,
  TaskProgress,
  Empty,
  Loading,
  Dialog,
  Field,
} from "./components.tsx";
import { navigate, useResource, type Run } from "./hooks.ts";
import type { Overview, Task, Chunk, Conversation, Page } from "./types.ts";
interface Messages extends Page<Task> {
  conversation: Conversation;
}
export function Chat({
  id,
  data,
  revision,
  run,
  refresh,
  onSource,
}: {
  id?: string;
  data: Overview;
  revision: number;
  run: Run;
  refresh: () => void;
  onSource: (source: Chunk, task?: Task) => void;
}) {
  const messages = useResource<Messages>(
    id ? "conversations/" + id + "/messages?limit=30" : undefined,
    revision,
  );
  const [draft, setDraft] = useState(""),
    [longGoal, setLongGoal] = useState(false),
    [busy, setBusy] = useState(false),
    [older, setOlder] = useState<Task[]>([]),
    [olderCursor, setOlderCursor] = useState<string | null>(),
    [editing, setEditing] = useState(false),
    [title, setTitle] = useState(""),
    [deleting, setDeleting] = useState(false),
    [localError, setLocalError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null),
    bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setOlder([]);
    setOlderCursor(undefined);
    setLocalError("");
  }, [id]);
  useEffect(() => {
    if (!draft)
      bottom.current?.scrollIntoView({ block: "end", behavior: "instant" });
  }, [id, messages.value?.items.length]);
  const rows = [...older, ...(messages.value?.items ?? [])],
    conversation = messages.value?.conversation,
    active = rows.filter(
      (t) => !["completed", "failed", "cancelled"].includes(t.status),
    );
  async function send() {
    if (!draft.trim() || busy) return;
    setBusy(true);
    setLocalError("");
    try {
      const task = await mutate<Task>("tasks", "POST", {
        input: draft,
        kind: "auto",
        mode: longGoal ? "long" : "normal",
        ...(id ? { conversationId: id } : {}),
      });
      setDraft("");
      refresh();
      navigate("chat", task.conversationId);
      input.current?.focus();
    } catch (e) {
      setLocalError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function loadOlder() {
    const cursor =
      olderCursor === undefined ? messages.value?.nextCursor : olderCursor;
    if (!cursor || !id) return;
    const page = await api<Messages>(
      "conversations/" +
        id +
        "/messages?limit=30&before=" +
        encodeURIComponent(String(cursor)),
    );
    setOlder((v) =>
      [...page.items, ...v].filter(
        (t, i, all) => all.findIndex((a) => a.id === t.id) === i,
      ),
    );
    setOlderCursor(page.nextCursor ? String(page.nextCursor) : null);
  }
  return (
    <div className="chat-layout">
      <div className="conversation-toolbar">
        <div>
          <h1>{conversation?.title ?? "新的研究"}</h1>
          {conversation && (
            <p>
              {data.projects.items.find((p) => p.id === conversation.projectId)
                ?.title ?? "研究项目"}
            </p>
          )}
        </div>
        {id && (
          <details className="action-menu">
            <summary aria-label="会话操作">
              <Icon name="more" />
            </summary>
            <div>
              <button
                onClick={() => {
                  setTitle(conversation?.title ?? "");
                  setEditing(true);
                }}
              >
                重命名
              </button>
              <button
                onClick={() =>
                  void run(async () => {
                    const c = data.conversations.items.find((c) => c.id === id);
                    await mutate("conversations/" + id, "PATCH", {
                      pinned: !c?.pinned,
                    });
                    refresh();
                  })
                }
              >
                切换置顶
              </button>
              <button
                onClick={() =>
                  void run(async () => {
                    await mutate("conversations/" + id, "PATCH", {
                      archived: true,
                    });
                    navigate("chat");
                    refresh();
                  })
                }
              >
                归档会话
              </button>
              <button className="danger-text" onClick={() => setDeleting(true)}>
                删除会话
              </button>
            </div>
          </details>
        )}
      </div>
      <div className="message-scroll">
        {messages.error ? (
          <div className="error" role="alert">
            {messages.error}
            <button onClick={messages.reload}>重试</button>
          </div>
        ) : id && !messages.value ? (
          <Loading />
        ) : !rows.length ? (
          <div className="chat-welcome">
            <span className="welcome-mark">
              <Icon name="memory" size={30} />
            </span>
            <h2>今天从哪里开始？</h2>
            <p>讨论一个问题，深入阅读论文，或接着推进你的研究。</p>
            <div className="suggestions">
              {[
                "帮我梳理当前的研究问题",
                "比较几篇论文的方法和实验",
                "记住我的研究偏好",
              ].map((v) => (
                <button
                  key={v}
                  onClick={() => {
                    setDraft(v);
                    input.current?.focus();
                  }}
                >
                  {v}
                  <Icon name="arrow" size={16} />
                </button>
              ))}
            </div>
            {!data.deviceOnline && (
              <p className="connection-note">
                <Icon name="desktop" size={16} /> 电脑未连接，云端对话仍然可用。
              </p>
            )}
          </div>
        ) : (
          <>
            {(olderCursor === undefined
              ? messages.value?.nextCursor
              : olderCursor) && (
              <button
                className="text-button older"
                onClick={() => void run(loadOlder)}
              >
                加载更早的消息
              </button>
            )}
            {rows.map((t) => (
              <article className="turn" key={t.id}>
                <div className="user-message">{t.input}</div>
                <div className="assistant-message">
                  <div className="message-byline">
                    <Icon name="memory" size={18} />
                    <strong>{data.settings.agentName}</strong>
                    <Status status={t.status} />
                  </div>
                  {t.answer ? (
                    <Markdown
                      text={t.answer}
                      sources={t.researchEvidence ?? []}
                      onCitation={(s) => onSource(s, t)}
                    />
                  ) : t.preview ? (
                    <div className="stream-preview">{t.preview}</div>
                  ) : (
                    <p className="muted">
                      {t.status === "waiting_device"
                        ? "已保存这项研究。电脑上线后会继续读取论文。"
                        : t.status === "cancelled"
                          ? "这项工作已停止。"
                          : t.status === "failed"
                            ? "这次未能完成，可以补充要求后继续讨论。"
                            : "正在处理你的要求…"}
                    </p>
                  )}
                  {t.error && (
                    <p className="task-error">
                      {errorText(new Error(t.error))}
                    </p>
                  )}
                  <div role="status" aria-live="polite" aria-atomic="true">
                    {t.workflow?.memory && (
                      <p className="help">
                        {t.workflow.memory.state === "saved"
                          ? "本次研究记忆已整理。"
                          : t.workflow.memory.state === "pending"
                            ? "正在整理有原文依据的研究记忆…"
                            : t.workflow.memory.state === "budget_exhausted"
                              ? "本轮预算已用尽，阅读结果已保留，记忆尚未整理。"
                              : "阅读结果已保留，本轮记忆整理未完成。"}{" "}
                        <button
                          className="text-button"
                          onClick={() => navigate("memory")}
                        >
                          查看记忆
                        </button>
                      </p>
                    )}
                  </div>
                  <TaskProgress task={t} />
                  <TaskControls task={t} run={run} refresh={refresh} />
                  <div className="message-actions">
                    {t.researchEvidence?.length ? (
                      <button
                        className="text-button"
                        onClick={() => onSource(t.researchEvidence![0], t)}
                      >
                        查看 {t.researchEvidence.length} 处原文
                      </button>
                    ) : null}
                    {t.answer && (
                      <button
                        className="text-button"
                        onClick={() =>
                          void run(async () => {
                            const a = await mutate("artifacts", "POST", {
                              taskId: t.id,
                              kind: t.workflow?.comparison
                                ? "comparison"
                                : "reading",
                              title: t.input.slice(0, 100),
                            });
                            refresh();
                            navigate("artifacts", a.id);
                          })
                        }
                      >
                        保存为研究成果
                      </button>
                    )}
                    {!["completed", "failed", "cancelled"].includes(
                      t.status,
                    ) && (
                      <button
                        className="text-button"
                        onClick={() =>
                          void run(async () => {
                            await mutate("tasks/" + t.id + "/cancel", "POST");
                            refresh();
                          })
                        }
                      >
                        停止这项工作
                      </button>
                    )}
                    {t.status === "waiting_user" && (
                      <button
                        className="text-button"
                        onClick={() => input.current?.focus()}
                      >
                        补充要求
                      </button>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </>
        )}
        <div ref={bottom} />
      </div>
      <div className="composer-area">
        {active.length > 0 && (
          <div className="active-strip">
            <Status status={active[0].status} />
            <span>
              {active.length > 1
                ? "另有 " + (active.length - 1) + " 项工作排队"
                : active[0].input}
            </span>
          </div>
        )}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            ref={input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={12000}
            rows={2}
            placeholder="交代研究任务，或继续刚才的讨论…"
            aria-label="消息"
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div>
            <span>Enter 发送 · Shift + Enter 换行</span>
            <button
              className="primary send-button"
              type="submit"
              disabled={busy || !draft.trim()}
              aria-label="发送消息"
            >
              <Icon name="send" />
              <span>{busy ? "发送中" : "发送"}</span>
            </button>
          </div>
        </form>
        {localError && (
          <p className="error" role="alert">
            {localError}
          </p>
        )}
        <label className="check-label long-goal-option">
          <input
            type="checkbox"
            checked={longGoal}
            onChange={(e) => setLongGoal(e.target.checked)}
          />
          作为长期研究目标，最多分四段推进
        </label>
        <p className="composer-note">
          研究结论请结合引用原文核对。
          {data.model.mode === "mock" ? " 当前为模拟验证环境。" : ""}
        </p>
      </div>
      <Dialog
        open={editing}
        onClose={() => setEditing(false)}
        title="重命名会话"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await mutate("conversations/" + id, "PATCH", { title });
              setEditing(false);
              refresh();
            });
          }}
        >
          <Field label="会话名称">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={100}
              required
              autoFocus
            />
          </Field>
          <button className="primary">保存</button>
        </form>
      </Dialog>
      <Dialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title="删除这个会话？"
      >
        <p>
          将清理在线会话、关联研究记录与成果。本机离线时，清理待办会在重连后继续。
        </p>
        <div className="button-row">
          <button onClick={() => setDeleting(false)}>保留</button>
          <button
            className="danger"
            onClick={() =>
              void run(async () => {
                await mutate("conversations/" + id, "DELETE");
                setDeleting(false);
                navigate("chat");
                refresh();
              })
            }
          >
            删除会话
          </button>
        </div>
      </Dialog>
    </div>
  );
}
