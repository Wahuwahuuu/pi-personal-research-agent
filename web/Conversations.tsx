import { useState } from "react";
import { mutate } from "./api.ts";
import { Field, Icon, Empty, Loading, date, Pager } from "./components.tsx";
import { usePaged, navigate, type Run } from "./hooks.ts";
import type { Conversation } from "./types.ts";
export function Conversations({
  revision,
  run,
  refresh,
}: {
  revision: number;
  run: Run;
  refresh: () => void;
}) {
  const [q, setQ] = useState(""),
    [archived, setArchived] = useState(false);
  const page = usePaged<Conversation>(
    "conversations?limit=30&archived=" +
      archived +
      "&q=" +
      encodeURIComponent(q),
    revision,
  );
  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <h1>所有讨论</h1>
          <p>按内容查找研究，或恢复归档的会话。</p>
        </div>
        <button className="primary" onClick={() => navigate("chat")}>
          <Icon name="plus" />
          新的讨论
        </button>
      </div>
      <div className="filters">
        <label className="search-field">
          <Icon name="search" />
          <input
            aria-label="搜索全部讨论"
            placeholder="搜索标题与消息"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <label className="check-label">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />
          已归档
        </label>
      </div>
      {page.error ? (
        <p className="error" role="alert">
          {page.error}
          <button onClick={page.reload}>重试</button>
        </p>
      ) : !page.value ? (
        <Loading />
      ) : !page.value.items.length ? (
        <Empty title="没有匹配的讨论">调整搜索词，或开始一个新的问题。</Empty>
      ) : (
        page.value.items.map((c) => (
          <div className="conversation-row" key={c.id}>
            <button
              className="list-row grow"
              onClick={() => navigate("chat", c.id)}
            >
              <Icon name="chat" />
              <span className="grow">
                <strong>{c.title}</strong>
                <small>{date(c.updated ?? c.created)}</small>
              </span>
            </button>
            <button
              className="text-button"
              onClick={() =>
                void run(async () => {
                  await mutate("conversations/" + c.id, "PATCH", {
                    archived: !c.archived,
                  });
                  refresh();
                })
              }
            >
              {archived ? "恢复" : "归档"}
            </button>
          </div>
        ))
      )}
      <Pager page={page} />
    </section>
  );
}
