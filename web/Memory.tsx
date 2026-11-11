import { useEffect, useRef, useState } from "react";
import { api, mutate } from "./api.ts";
import { Empty, Loading, Field, date, Dialog, Pager } from "./components.tsx";
import { navigate, usePaged, useResource, type Run } from "./hooks.ts";
import type { Overview, Memory } from "./types.ts";
const categories: Record<string, string> = {
  preference: "个人偏好",
  constraint: "研究约束",
  conclusion: "研究结论",
  question: "未解决问题",
  reading: "阅读记录",
};
export function MemoryView({
  data,
  revision,
  run,
  refresh,
  projectId,
}: {
  data: Overview;
  revision: number;
  run: Run;
  refresh: () => void;
  projectId?: string;
}) {
  const editor = useRef<HTMLFormElement>(null),
    [text, setText] = useState(""),
    [editing, setEditing] = useState<Memory>(),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [category, setCategory] = useState(""),
    [scope, setScope] = useState(projectId ?? ""),
    [kind, setKind] = useState("constraint"),
    [historyId, setHistoryId] = useState<string>();
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query), 300);
    return () => clearTimeout(timer);
  }, [query]);
  const memories = usePaged<Memory>(
    "memories?limit=30&q=" +
      encodeURIComponent(search) +
      "&category=" +
      category +
      (scope ? "&project=" + scope : ""),
    revision,
  );
  const history = useResource<
    { revision: number; changed: number; entry: Memory }[]
  >(historyId ? "memories/" + historyId + "/revisions" : undefined, revision);
  const rows = memories.value?.items ?? [];
  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <h1>记忆</h1>
          <p>保存偏好、研究约束、有原文依据的结论和未解决问题。</p>
        </div>
      </div>
      <form
        ref={editor}
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await mutate("memories", "POST", {
              content: text,
              ...(editing
                ? { id: editing.id }
                : {
                    category: kind,
                    ...(kind !== "preference" && scope
                      ? { projectId: scope }
                      : {}),
                  }),
            });
            setText("");
            setEditing(undefined);
            refresh();
          });
        }}
      >
        <Field label={editing ? "纠正这条记忆" : "明确告诉我需要记住什么"}>
          <textarea
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            required
            maxLength={1200}
            placeholder="例如：我关注长期记忆的可靠性，讨论时优先给出原文证据。"
          />
        </Field>
        {!editing && (
          <div className="inline-row">
            <Field label="保存类型">
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                {["constraint", "preference", "question"].map((c) => (
                  <option key={c} value={c}>
                    {categories[c]}
                  </option>
                ))}
              </select>
            </Field>
            <p className="help">
              {kind === "preference"
                ? "个人偏好在各研究项目中共享。"
                : scope
                  ? "保存到所选研究项目。"
                  : "未限定项目，作为个人研究记录使用。"}
            </p>
          </div>
        )}
        {editing?.sources?.length ? (
          <p className="help">
            修改后的表述会标为“待重新核对”，原有引用不会自动证明新内容。
          </p>
        ) : null}
        <div className="button-row">
          <button className="primary" disabled={!text.trim()}>
            {editing ? "保存纠正" : "保存记忆"}
          </button>
          {editing && (
            <button
              type="button"
              onClick={() => {
                setEditing(undefined);
                setText("");
              }}
            >
              取消
            </button>
          )}
        </div>
      </form>
      <div className="filters memory-filters">
        <input
          aria-label="搜索记忆"
          placeholder="搜索中文记忆内容"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label="记忆类型"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">全部类型</option>
          {Object.entries(categories).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <select
          aria-label="记忆项目范围"
          value={scope}
          onChange={(e) => {
            setScope(e.target.value);
          }}
        >
          <option value="">所有项目</option>
          {data.projects.items.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
      </div>
      {memories.error ? (
        <p className="error" role="alert">
          {memories.error}
          <button onClick={memories.reload}>重试</button>
        </p>
      ) : !memories.value ? (
        <Loading />
      ) : !rows.length ? (
        <Empty title="还没有匹配的记忆">
          可以调整范围，或明确保存一条研究偏好。完成原文阅读后，结论整理会留下依据。
        </Empty>
      ) : (
        <div className="memory-list">
          {rows.map((m) => (
            <article className="memory-row" key={m.id}>
              <div className="row-between">
                <span className="tag">
                  {categories[m.category ?? "reading"]}
                  {m.edited ? " · 已人工修订" : ""}
                </span>
                <small>{date(m.updated_at)}</small>
              </div>
              <p>{m.content}</p>
              <p className="help">
                {m.projectId
                  ? (data.projects.items.find((p) => p.id === m.projectId)
                      ?.title ?? "研究项目")
                  : "个人范围"}
                {m.sourceStatus === "verified"
                  ? " · 引文已核对，结论含义待审阅"
                  : m.sourceStatus === "needs_review"
                    ? " · 人工修改后待重新核对原文"
                    : m.sourceStatus === "stale"
                      ? " · 原文版本已变化，需重新核对"
                      : ""}
              </p>
              {!!m.sources?.length && (
                <details className="memory-evidence">
                  <summary>原文依据 · {m.sources.length} 处</summary>
                  {m.sources.map((s, i) => (
                    <figure key={s.chunk_id + ":" + i}>
                      <blockquote>{s.quote}</blockquote>
                      <figcaption>
                        {s.paper_id} · {s.section}
                        <details className="diagnostics">
                          <summary>定位详情</summary>
                          <p>
                            {s.chunk_id} · 字符 {s.quote_start}–{s.quote_end} ·
                            版本 {s.index_version}
                          </p>
                        </details>
                      </figcaption>
                    </figure>
                  ))}
                </details>
              )}
              <div className="button-row">
                {m.source_session && (
                  <button
                    className="text-button"
                    onClick={() => navigate("chat", m.source_session)}
                  >
                    查看来源讨论
                  </button>
                )}
                <button
                  className="text-button"
                  onClick={() => {
                    setEditing(m);
                    setText(m.content);
                    requestAnimationFrame(() => {
                      editor.current?.scrollIntoView({ block: "start" });
                      editor.current?.querySelector("textarea")?.focus();
                    });
                  }}
                >
                  纠正
                </button>
                <button
                  className="text-button"
                  onClick={() => setHistoryId(m.id)}
                >
                  修订记录
                </button>
                <button
                  className="text-button danger-text"
                  onClick={() =>
                    void run(async () => {
                      await mutate("memories/" + m.id, "DELETE");
                      refresh();
                    })
                  }
                >
                  删除
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      <Pager page={memories} />
      <Dialog
        open={!!historyId}
        onClose={() => setHistoryId(undefined)}
        title="记忆修订记录"
      >
        <p>旧版本仅供查看，不参与新讨论的记忆检索。</p>
        {history.error ? (
          <p className="error" role="alert">
            {history.error}
            <button onClick={history.reload}>重试</button>
          </p>
        ) : !history.value ? (
          <Loading />
        ) : (
          history.value.map((v) => (
            <article className="memory-row" key={v.revision}>
              <strong>第 {v.revision} 版</strong>
              <small> · {date(v.changed)}</small>
              <p>{v.entry.content}</p>
            </article>
          ))
        )}
      </Dialog>
    </section>
  );
}
