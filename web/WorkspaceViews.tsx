import {WatchPlans} from "./WatchPlans.tsx";
import {deviceView} from "./device-state.ts";
import {LibraryImports} from "./LibraryImports.tsx";
import { TaskControls } from "./TaskControls.tsx";
import { useEffect, useState, useRef } from "react";
import { api, mutate, errorText } from "./api.ts";
import {
  Icon,
  Empty,
  Loading,
  Field,
  Status,
  date,
  Markdown,
  Dialog,
  TaskProgress,
  Pager,
} from "./components.tsx";
import { navigate, useResource, usePaged, type Run } from "./hooks.ts";
import type {
  Overview,
  Project,
  Page,
  Paper,
  Task,
  Memory,
  SavedArtifact,
  Artifact,
  Chunk,
  Conversation,
} from "./types.ts";
interface Props {
  data: Overview;
  revision: number;
  run: Run;
  refresh: () => void;
}
function ResourceError({ text, retry }: { text: string; retry: () => void }) {
  return (
    <div className="error" role="alert">
      {text}
      <button onClick={retry}>重试</button>
    </div>
  );
}
export function Projects({
  id,
  data,
  revision,
  run,
  refresh,
}: Props & { id?: string }) {
  const [search, setSearch] = useState(""),
    [archived, setArchived] = useState(false),
    [create, setCreate] = useState(false),
    [title, setTitle] = useState(""),
    [goal, setGoal] = useState(""),
    [deleting, setDeleting] = useState(false);
  const list = usePaged<Project>(
    "projects?q=" + encodeURIComponent(search) + "&archived=" + archived,
    revision,
  );
  const detail = useResource<
    Project & { conversations: Page<Conversation>; tasks: Task[] }
  >(id ? "projects/" + id : undefined, revision);
  useEffect(() => {
    if (detail.value) {
      setTitle(detail.value.title);
      setGoal(detail.value.goal);
    }
  }, [detail.value?.id, detail.value?.updated]);
  const p = detail.value;
  if (id)
    return (
      <section className="page">
        <button
          className="text-button breadcrumb"
          onClick={() => navigate("projects")}
        >
          研究项目 /
        </button>
        {detail.error ? (
          <ResourceError text={detail.error} retry={detail.reload} />
        ) : !p ? (
          <Loading />
        ) : (
          <>
            <div className="page-heading">
              <div>
                <h1>{p.title}</h1>
                <p>把目标、讨论和成果放在同一个研究范围内。</p>
              </div>
              <button
                className="primary"
                onClick={() =>
                  void run(async () => {
                    const c = await mutate("conversations", "POST", {
                      projectId: p.id,
                      title: "围绕 " + p.title + " 的讨论",
                    });
                    refresh();
                    navigate("chat", c.id);
                  })
                }
              >
                <Icon name="plus" />
                开始讨论
              </button>
            </div>
            <form
              className="project-goal"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await mutate("projects/" + p.id, "PATCH", { title, goal });
                  refresh();
                });
              }}
            >
              <Field label="项目名称">
                <input
                  value={title}
                  maxLength={100}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                />
              </Field>
              <Field label="研究目标">
                <textarea
                  value={goal}
                  maxLength={4000}
                  rows={3}
                  placeholder="正在回答什么问题，希望得到什么结果？"
                  onChange={(e) => setGoal(e.target.value)}
                />
              </Field>
              <button>保存目标</button>
            </form>
            <h2 className="section-heading">相关讨论</h2>
            <div className="list">
              {p.conversations.items.length ? (
                p.conversations.items.map((c) => (
                  <button
                    className="list-row"
                    key={c.id}
                    onClick={() => navigate("chat", c.id)}
                  >
                    <Icon name="chat" />
                    <span className="grow">
                      <strong>{c.title}</strong>
                      <small>{date(c.updated ?? c.created)}</small>
                    </span>
                    <Icon name="chevron" />
                  </button>
                ))
              ) : (
                <Empty
                  title="还没有讨论"
                  action={
                    <button
                      onClick={() =>
                        void run(async () => {
                          const c = await mutate("conversations", "POST", {
                            projectId: p.id,
                            title: "项目讨论",
                          });
                          refresh();
                          navigate("chat", c.id);
                        })
                      }
                    >
                      开始第一次讨论
                    </button>
                  }
                >
                  从一个具体的研究问题开始。
                </Empty>
              )}
            </div>
            <h2 className="section-heading">项目中的论文</h2>
            <p>
              {p.paperIds.length
                ? p.paperIds.join("、")
                : "尚未限定论文范围。讨论默认可使用整个论文库。"}
            </p>
            <button onClick={() => navigate("papers", p.id)}>
              选择项目论文
            </button>
            <div className="section-actions">
              <button
                onClick={() =>
                  void run(async () => {
                    await mutate("projects/" + p.id, "PATCH", {
                      pinned: !p.pinned,
                    });
                    refresh();
                  })
                }
              >
                {p.pinned ? "取消置顶" : "置顶项目"}
              </button>
              <button
                onClick={() =>
                  void run(async () => {
                    await mutate("projects/" + p.id, "PATCH", {
                      archived: !p.archived,
                    });
                    refresh();
                    navigate("projects");
                  })
                }
              >
                {p.archived ? "恢复项目" : "归档项目"}
              </button>
              {p.id !== "default" && (
                <button
                  className="danger-text"
                  onClick={() => setDeleting(true)}
                >
                  删除项目
                </button>
              )}
            </div>
            <Dialog
              title="删除研究项目？"
              open={deleting}
              onClose={() => setDeleting(false)}
            >
              <p>
                项目中的会话和关联成果会进入删除流程。论文原文件不会因此从本机删除。
              </p>
              <button
                className="danger"
                onClick={() =>
                  void run(async () => {
                    await mutate("projects/" + p.id, "DELETE");
                    setDeleting(false);
                    refresh();
                    navigate("projects");
                  })
                }
              >
                确认删除
              </button>
            </Dialog>
          </>
        )}
      </section>
    );
  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <h1>研究项目</h1>
          <p>每个项目保留自己的目标、讨论和论文范围。</p>
        </div>
        <button
          className="primary"
          onClick={() => {
            setCreate((v) => !v);
            setTitle("");
            setGoal("");
          }}
        >
          <Icon name="plus" />
          新建项目
        </button>
      </div>
      {create && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const p = await mutate("projects", "POST", {
                title,
                ...(goal.trim() ? { goal } : {}),
              });
              setCreate(false);
              refresh();
              navigate("projects", p.id);
            });
          }}
        >
          <Field label="项目名称">
            <input
              required
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={100}
              placeholder="例如：长期记忆与检索增强"
            />
          </Field>
          <Field label="研究目标">
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={2}
            />
          </Field>
          <div className="button-row">
            <button className="primary">创建项目</button>
            <button type="button" onClick={() => setCreate(false)}>
              取消
            </button>
          </div>
        </form>
      )}
      <div className="filters">
        <label className="search-field">
          <Icon name="search" />
          <input
            aria-label="搜索项目"
            placeholder="搜索项目与目标"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
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
      {list.error ? (
        <ResourceError text={list.error} retry={list.reload} />
      ) : !list.value ? (
        <Loading />
      ) : !list.value.items.length ? (
        <Empty title="没有匹配的项目">
          可以调整搜索条件，或创建一个新的研究方向。
        </Empty>
      ) : (
        <div className="project-list">
          {list.value.items.map((p) => (
            <button
              key={p.id}
              className="project-row"
              onClick={() => navigate("projects", p.id)}
            >
              <div className="project-emblem">
                <Icon name="projects" size={24} />
              </div>
              <div className="grow">
                <strong>
                  {p.title}
                  {p.pinned && <Icon name="star" size={14} />}
                </strong>
                <p>{p.goal || "添加研究目标，让每次讨论有据可循。"}</p>
                <small>
                  {p.paperIds.length
                    ? p.paperIds.length + " 篇范围内论文"
                    : "整个论文库"}{" "}
                  · {p.updated ? date(p.updated) : "默认项目"}
                </small>
              </div>
              <Icon name="chevron" />
            </button>
          ))}
        </div>
      )}
      <Pager page={list} />
    </section>
  );
}
export function Library({
  projectId,
  data,
  revision,
  run,
  refresh,
  onPaper,
}: Props & { projectId?: string; onPaper: (p: Paper) => void }) {
  const papers = useResource<Paper[]>("papers", revision),
    project = useResource<Project>(
      projectId ? "projects/" + projectId : undefined,
      revision,
    );
  const [pendingImports,setPendingImports]=useState<number>(),
    [query, setQuery] = useState(""),
    [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    setSelected(project.value?.paperIds ?? []);
  }, [project.value?.id, project.value?.updated]);
  const list = (papers.value ?? []).filter((p) =>
    (p.title + " " + p.abstract + " " + p.paper_id)
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <h1>{projectId ? "选择项目论文" : "论文库"}</h1>
          <p>
            {project.value
              ? "为「" + project.value.title + "」选择研究范围。"
              : "本机索引的论文目录；原文片段可随讨论进入云端。"}
          </p>
        </div>
        {!deviceView(data).connected && (
          <button onClick={() => navigate("settings", "devices")}>
            <Icon name="desktop" />
            连接电脑
          </button>
        )}
      </div>
      <LibraryImports projectId={projectId} data={data} revision={revision} run={run} refresh={refresh} onPendingChange={setPendingImports}/>
      {projectId && (
        <div className="selection-bar">
          <span>已选 {selected.length} 篇</span>
          <button
            className="primary"
            onClick={() =>
              void run(async () => {
                await mutate("projects/" + projectId, "PATCH", {
                  paperIds: selected,
                });
                refresh();
                navigate("projects", projectId);
              })
            }
          >
            保存论文范围
          </button>
        </div>
      )}
      <div className="filters">
        <label className="search-field">
          <Icon name="search" />
          <input
            aria-label="搜索论文"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题、摘要或论文编号"
          />
        </label>
        <span className="muted">{list.length} 篇论文</span>
      </div>
      {papers.error ? (
        <ResourceError text={papers.error} retry={papers.reload} />
      ) : !papers.value ? (
        <Loading />
      ) : !list.length ? (
        <Empty
          title={query ? "未找到匹配的论文" : pendingImports?"首篇论文正在入库":deviceView(data).connected?(pendingImports===0?"添加你的第一篇论文":"论文库暂无可阅读的论文"):"论文目录还未连接"}
          action={
            !query&&!deviceView(data).connected ? (
              <button onClick={() => navigate("settings", "devices")}>
                设置本地节点
              </button>
            ) : undefined
          }
        >
          {query
            ? "试试标题中的其他关键词。"
            : pendingImports?"入库待办已经保存。可在上方查看处理进度，完成后论文会出现在这里。":deviceView(data).connected?"从上方添加 arXiv，或在本机托盘选择文本 PDF。建立索引后，就可以开始阅读。":"连接本地节点后，已有索引会出现在这里。完整论文保留在本机。"}
        </Empty>
      ) : (
        <div className="paper-list">
          {list.map((p) => (
            <article className="paper-row" key={p.paper_id}>
              {projectId && (
                <input
                  type="checkbox"
                  aria-label={"选择 " + p.title}
                  checked={selected.includes(p.paper_id)}
                  onChange={(e) =>
                    setSelected((v) =>
                      e.target.checked
                        ? [...v, p.paper_id]
                        : v.filter((id) => id !== p.paper_id),
                    )
                  }
                />
              )}
              <div className="grow">
                <button className="paper-title" onClick={() => onPaper(p)}>
                  {p.title}
                </button>
                <p className="clamp-3">{p.abstract}</p>
                <div className="paper-meta">
                  <span>{p.paper_id}</span>
                  <button
                    className="text-button"
                    onClick={() =>
                      void run(async () => {
                        const t = await mutate<Task>("tasks", "POST", {
                          kind: "auto",
                          input:
                            "请深入阅读论文 " +
                            p.paper_id +
                            "，解释研究问题、方法、实验结果与局限，并给出原文依据。",
                          ...(projectId ? { projectId } : {}),
                        });
                        refresh();
                        navigate("chat", t.conversationId);
                      })
                    }
                  >
                    开始阅读 <Icon name="arrow" size={14} />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
export function Activity({ data, revision, run, refresh }: Props) {
  const [status, setStatus] = useState(""),
    [more, setMore] = useState<Task[]>([]),
    [cursor, setCursor] = useState<string | null>();
  const tasks = useResource<Page<Task>>(
    "tasks?limit=30" + (status ? "&status=" + status : ""),
    revision,
  );
  useEffect(() => {
    setMore([]);
    setCursor(undefined);
  }, [status]);
  const rows = [...(tasks.value?.items ?? []), ...more].filter(
    (t, i, a) => a.findIndex((x) => x.id === t.id) === i,
  );
  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <h1>活动与任务</h1>
          <p>查看已经发生的工作，以及下一步在等待什么。</p>
        </div>
      </div>
      <div className="filters">
        <Field label="任务状态">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">全部任务</option>
            {Object.entries({
              running: "正在执行",
              queued: "排队中",
              waiting_device: "等待本机",
              waiting_user: "等待处理",
              paused: "已暂停",
              completed: "已完成",
              failed: "失败",
              cancelled: "已取消",
            }).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {tasks.error ? (
        <ResourceError text={tasks.error} retry={tasks.reload} />
      ) : !tasks.value ? (
        <Loading />
      ) : !rows.length ? (
        <Empty
          title="这里会显示你的研究进度"
          action={
            <button onClick={() => navigate("chat")}>交代一个任务</button>
          }
        >
          每项工作都有自己的状态，离线和未完成的部分会保留。
        </Empty>
      ) : (
        <div className="activity-list">
          {rows.map((t) => (
            <article className="activity-row" key={t.id}>
              <div className="grow">
                <div className="row-between">
                  <Status status={t.status} />
                  <small>{date(t.created)}</small>
                </div>
                <button
                  className="row-title"
                  onClick={() => navigate("chat", t.conversationId)}
                >
                  {t.input}
                </button>
                {t.error && (
                  <p className="task-error">{errorText(new Error(t.error))}</p>
                )}
                <TaskControls task={t} run={run} refresh={refresh} />
                <div className="button-row">
                  <button
                    className="text-button"
                    onClick={() => navigate("chat", t.conversationId)}
                  >
                    查看讨论
                  </button>
                  {!["completed", "failed", "cancelled"].includes(t.status) && (
                    <button
                      className="text-button"
                      onClick={() =>
                        void run(async () => {
                          await mutate("tasks/" + t.id + "/cancel", "POST");
                          refresh();
                        })
                      }
                    >
                      取消任务
                    </button>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      {(cursor === undefined ? tasks.value?.nextCursor : cursor) && (
        <button
          onClick={() =>
            void run(async () => {
              const next =
                cursor === undefined ? tasks.value?.nextCursor : cursor;
              const page = await api<Page<Task>>(
                "tasks?limit=30&before=" +
                  encodeURIComponent(String(next)) +
                  (status ? "&status=" + status : ""),
              );
              setMore((v) => [...v, ...page.items]);
              setCursor(page.nextCursor ? String(page.nextCursor) : null);
            })
          }
        >
          加载更多任务
        </button>
      )}
    </section>
  );
}
export function Inbox({ data, revision, run, refresh }: Props) {
  const [onlyUnread, setOnlyUnread] = useState(false),
    [showPlan, setShowPlan] = useState(false);
  const rows = data.notices.filter((n) => !onlyUnread || !n.read);
  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <h1>收件箱</h1>
          <p>研究结果、值得关注的变化，以及需要你决定的事项。</p>
        </div>
        <button onClick={() => setShowPlan((v) => !v)}>管理关注主题</button>
      </div>
      {showPlan && <WatchPlans data={data} revision={revision} run={run} refresh={refresh}/>}
      <label className="check-label">
        <input
          type="checkbox"
          checked={onlyUnread}
          onChange={(e) => setOnlyUnread(e.target.checked)}
        />
        只看未读
      </label>
      {!rows.length ? (
        <Empty title={onlyUnread ? "未读事项已处理" : "目前没有新的更新"}>
          有任务结果或关注主题变化时，会保存在这里。
        </Empty>
      ) : (
        <div className="inbox-list">
          {rows.map((n) => (
            <article
              className={"notice-row " + (n.read ? "read" : "unread")}
              key={n.id}
            >
              <div className="row-between">
                <strong>
                  {n.id.startsWith("discovery:")
                    ? "文献发现"
                    : n.id.startsWith("budget:")
                      ? "需要处理"
                      : "研究更新"}
                </strong>
                <small>{date(n.created)}</small>
              </div>
              <p>{n.text}</p>
              <div className="button-row">
                {n.artifactId&&<button className="text-button" onClick={()=>navigate("artifacts",n.artifactId)}>阅读阶段简报</button>}
                {n.id.startsWith("task:") && (
                  <button
                    className="text-button"
                    onClick={() =>
                      void run(async () => {
                        const t = await api<Task>("tasks/" + n.id.slice(5));
                        navigate("chat", t.conversationId);
                      })
                    }
                  >
                    查看结果
                  </button>
                )}
                {!n.read && (
                  <button
                    className="text-button"
                    onClick={() =>
                      void run(async () => {
                        await mutate(
                          "notices/" + encodeURIComponent(n.id),
                          "POST",
                        );
                        refresh();
                      })
                    }
                  >
                    标记已读
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
export function ArtifactView({
  id,
  data,
  revision,
  run,
  refresh,
  onSource,
}: Props & { id?: string; onSource: (s: Chunk,artifactId:string) => void }) {
  const list = usePaged<Artifact>("artifacts?limit=30", revision),
    detail = useResource<SavedArtifact>(
      id ? "artifacts/" + id : undefined,
      revision,
    ),
    versions = useResource<
      { version: number; editor: string; created: number }[]
    >(id ? "artifacts/" + id + "/versions" : undefined, revision);
  const [historical, setHistorical] = useState<SavedArtifact>(),
    [editing, setEditing] = useState(false),
    [content, setContent] = useState(""),
    [title, setTitle] = useState(""),
    [deleting, setDeleting] = useState(false);
  useEffect(() => {
    setHistorical(undefined);
    setEditing(false);
  }, [id]);
  const a = historical ?? detail.value,
    labels: Record<string, string> = {
      reading: "阅读卡",
      comparison: "比较研究",
      review: "主题综述",
      brief: "阶段简报",
    };
  if (id)
    return (
      <section className="page artifact-page">
        <button
          className="text-button breadcrumb"
          onClick={() => navigate("artifacts")}
        >
          研究成果 /
        </button>
        {detail.error ? (
          <ResourceError text={detail.error} retry={detail.reload} />
        ) : !a ? (
          <Loading />
        ) : (
          <>
            <div className="page-heading">
              <div>
                <h1>{a.title}</h1>
                <p>
                  {labels[a.kind]} · 第 {a.version} 版 ·{" "}
                  {a.editor === "user"
                    ? "人工编辑，修改内容未自动复核"
                    : "来自研究回答"}
                  {a.partial ? " · 部分完成" : ""}
                </p>
              </div>
              <button
                onClick={() => {
                  setContent(a.content);
                  setTitle(a.title);
                  setEditing((v) => !v);
                }}
                disabled={!!historical}
              >
                编辑
              </button>
            </div>
            <div className="artifact-toolbar">
              <label>
                版本{" "}
                <select
                  aria-label="成果版本"
                  value={a.version}
                  onChange={(e) =>
                    void run(async () => {
                      const v = Number(e.target.value);
                      setHistorical(
                        v === detail.value!.version
                          ? undefined
                          : await api("artifacts/" + id + "?version=" + v),
                      );
                    })
                  }
                >
                  {versions.value?.map((v) => (
                    <option key={v.version} value={v.version}>
                      第 {v.version} 版 · {date(v.created)}
                    </option>
                  ))}
                </select>
              </label>
              <span className="grow" />
              {["md", "html", "bibtex"].map((format) => (
                <a
                  className="button-link"
                  key={format}
                  href={
                    "/api/artifacts/" +
                    a.id +
                    "/export?format=" +
                    format +
                    "&version=" +
                    a.version
                  }
                >
                  {format === "md"
                    ? "Markdown"
                    : format === "html"
                      ? "HTML"
                      : "BibTeX"}
                </a>
              ))}
            </div>
            {editing ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    await mutate("artifacts/" + a.id, "PATCH", {
                      version: a.version,
                      content,
                      title,
                    });
                    setEditing(false);
                    refresh();
                  });
                }}
              >
                <Field label="成果名称">
                  <input
                    value={title}
                    maxLength={150}
                    onChange={(e) => setTitle(e.target.value)}
                    required
                  />
                </Field>
                <Field
                  label="Markdown 正文"
                  hint="引用标识需要与原有证据一致。人工修改不会自动成为已经核验的研究结论。"
                >
                  <textarea
                    className="artifact-editor"
                    rows={20}
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    maxLength={12000}
                    required
                  />
                </Field>
                <div className="button-row">
                  <button className="primary">保存新版本</button>
                  <button type="button" onClick={() => setEditing(false)}>
                    放弃修改
                  </button>
                </div>
              </form>
            ) : (
              <Markdown
                text={a.content}
                sources={a.sources}
                onCitation={(source)=>onSource(source,a.id)}
              />
            )}
            <div className="section-actions">
              <button onClick={() => navigate("chat", a.conversationId)}>
                回到来源讨论
              </button>
              <button className="danger-text" onClick={() => setDeleting(true)}>
                删除成果
              </button>
            </div>
            <Dialog
              title="删除全部成果版本？"
              open={deleting}
              onClose={() => setDeleting(false)}
            >
              <p>来源会话会保留，成果的所有版本将从在线存储删除。</p>
              <button
                className="danger"
                onClick={() =>
                  void run(async () => {
                    await mutate("artifacts/" + a.id, "DELETE");
                    setDeleting(false);
                    refresh();
                    navigate("artifacts");
                  })
                }
              >
                删除成果
              </button>
            </Dialog>
          </>
        )}
      </section>
    );
  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <h1>研究成果</h1>
          <p>保存阅读卡、比较、综述与简报，保留版本和原文出处。</p>
        </div>
      </div>
      {list.error ? (
        <ResourceError text={list.error} retry={list.reload} />
      ) : !list.value ? (
        <Loading />
      ) : !list.value.items.length ? (
        <Empty
          title="把有用的研究保存下来"
          action={<button onClick={() => navigate("chat")}>开始研究</button>}
        >
          回答下方的“保存为研究成果”会把正文和引用一起保存。
        </Empty>
      ) : (
        <div className="artifact-list">
          {list.value.items.map((a) => (
            <button
              className="artifact-row"
              key={a.id}
              onClick={() => navigate("artifacts", a.id)}
            >
              <Icon name="artifacts" size={24} />
              <span className="grow">
                <small>
                  {labels[a.kind]} · 第 {a.version} 版
                  {a.partial ? " · 部分完成" : ""}
                </small>
                <strong>{a.title}</strong>
                <small>{date(a.updated)}</small>
              </span>
              <Icon name="chevron" />
            </button>
          ))}
        </div>
      )}
      <Pager page={list} />
    </section>
  );
}
