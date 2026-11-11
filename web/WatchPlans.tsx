import { useState, useRef, useEffect } from "react";
import { api, mutate, errorText } from "./api.ts";
import { Field, Loading, Pager, Status, date } from "./components.tsx";
import { navigate, usePaged, useResource, type Run } from "./hooks.ts";
import type { Overview, Plan, Task } from "./types.ts";
import type { PlanDraft } from "../src/plan-draft.ts";
import type {
  ResearchBatch,
  ResearchCandidate,
} from "../src/research-batches.ts";
interface Props {
  data: Overview;
  revision: number;
  run: Run;
  refresh: () => void;
}
type Batch = ResearchBatch & {
  counts: Record<string, number>;
  selected?: ResearchCandidate[];
};
const phases: Record<string, string> = {
  discovering: "正在检查论文来源",
  metadata_only: "已保存文献线索",
  screening: "正在筛选候选论文",
  processing: "正在处理相关论文",
  summarizing: "正在整理阶段简报",
  waiting_user: "需要你处理",
  completed: "本轮检查已结束",
};
const batchLabel = (b: Batch) =>
  b.error && b.status === "discovering" ? "来源检查待重试" : phases[b.status];
const paperPhases: Record<string, string> = {
  discovered: "候选待筛选",
  selected: "已选入研究",
  skipped: "本轮不深入处理",
  importing: "等待本机完成入库",
  ready: "已入库，等待阅读",
  reading: "正在阅读原文",
  analyzed: "已整理研究结论",
  failed: "入库未完成",
  cancelled: "已取消",
};
function ResourceProblem({
  message,
  retry,
}: {
  message: string;
  retry: () => void;
}) {
  return (
    <p className="error" role="alert">
      {message} <button onClick={retry}>重新加载</button>
    </p>
  );
}
function Candidate({ paper }: { paper: ResearchCandidate }) {
  return (
    <li className="watch-candidate">
      <a href={paper.paper.url} target="_blank" rel="noopener noreferrer">
        {paper.paper.title}
      </a>
      <small>
        {paperPhases[paper.phase] ?? "待处理"} · {paper.source}
      </small>
      {paper.reason && <p>{paper.reason}</p>}
    </li>
  );
}
function BatchDetail({ id, revision }: { id: string; revision: number }) {
  const resource = useResource<Batch>(
      "research-batches/" + encodeURIComponent(id),
      revision,
    ),
    b = resource.value;
  const candidates = usePaged<ResearchCandidate>(
    "research-batches/" + encodeURIComponent(id) + "/candidates?limit=10",
    revision,
  );
  const task = useResource<Task>(
    b?.taskId ? "tasks/" + b.taskId : undefined,
    revision,
  );
  if (resource.error)
    return <ResourceProblem message={resource.error} retry={resource.reload} />;
  if (!b) return <Loading />;
  const stopped =
    task.value &&
    [
      "waiting_device",
      "waiting_user",
      "paused",
      "failed",
      "cancelled",
    ].includes(task.value.status);
  return (
    <div className="watch-batch-detail">
      <div className="row-between">
        <h4>本轮处理</h4>
        {stopped ? (
          <Status status={task.value!.status} />
        ) : (
          <span className="badge">{batchLabel(b)}</span>
        )}
      </div>
      <p className="help">
        发现范围：{date(b.from)} 至 {date(b.until)}。
        {b.status === "discovering"
          ? "来源检查尚未完成，成功检查位置没有推进。"
          : "发现记录已保存；这不代表所有论文已经深入阅读。"}
      </p>
      {task.error && (
        <ResourceProblem message={task.error} retry={task.reload} />
      )}
      {b.error && b.error !== "CANCELLED" && (
        <p className="error" role="alert">
          {errorText(b.error)}
        </p>
      )}
      {task.value?.error && task.value.error !== b.error && (
        <p className="warning">{errorText(task.value.error)}</p>
      )}
      <div className="button-row">
        {b.conversationId && (
          <button onClick={() => navigate("chat", b.conversationId)}>
            打开研究会话
          </button>
        )}
        {b.taskId && (
          <button onClick={() => navigate("tasks")}>管理研究任务</button>
        )}
        {b.artifactId && (
          <button
            className="primary"
            onClick={() => navigate("artifacts", b.artifactId)}
          >
            阅读阶段简报
          </button>
        )}
      </div>
      {!!b.selected?.length && (
        <>
          <h4>本轮选中的论文 · {b.selected.length} 篇</h4>
          <p className="help">
            包含此前保留的候选，每篇的入库和分析状态分别记录。
          </p>
          <ul className="watch-candidates">
            {b.selected.map((p) => (
              <Candidate key={p.id} paper={p} />
            ))}
          </ul>
        </>
      )}
      {!!b.coverageGaps?.length && (
        <div className="watch-gaps">
          <h4>尚未覆盖</h4>
          <ul>
            {b.coverageGaps.map((gap, i) => (
              <li key={i}>{gap}</li>
            ))}
          </ul>
        </div>
      )}
      <h4>本轮新发现 · {b.discovered} 条</h4>
      {candidates.error ? (
        <ResourceProblem message={candidates.error} retry={candidates.reload} />
      ) : !candidates.value ? (
        <Loading />
      ) : candidates.value.items.length ? (
        <>
          <ul className="watch-candidates">
            {candidates.value.items.map((p) => (
              <Candidate key={p.id} paper={p} />
            ))}
          </ul>
          <Pager page={candidates} />
        </>
      ) : (
        <p className="help">
          {b.status === "discovering"
            ? "暂未保存新的发现记录。"
            : "本轮没有新的文献记录。"}
        </p>
      )}
    </div>
  );
}
function PlanBatches({ plan, revision }: { plan: Plan; revision: number }) {
  const rows = usePaged<Batch>(
      "research-batches?plan=" + encodeURIComponent(plan.id) + "&limit=5",
      revision,
    ),
    [open, setOpen] = useState<string>();
  return (
    <section className="watch-history" aria-label={"处理记录：" + plan.query}>
      <h3>检查与研究记录</h3>
      {plan.sourceError && (
        <p className="error" role="alert">
          {errorText(plan.sourceError)} 将在 {date(plan.next)} 重试。
        </p>
      )}
      {rows.error ? (
        <ResourceProblem message={rows.error} retry={rows.reload} />
      ) : !rows.value ? (
        <Loading />
      ) : !rows.value.items.length ? (
        <p className="help">计划已保存，首轮检查尚未产生记录。</p>
      ) : (
        <>
          {rows.value.items.map((b) => (
            <section className="watch-batch" key={b.id}>
              <button
                className="watch-batch-toggle"
                aria-expanded={open === b.id}
                onClick={() => setOpen(open === b.id ? undefined : b.id)}
              >
                <span>
                  {date(b.created)}
                  <small>
                    {b.discovered} 条新发现 · {b.selectedIds?.length ?? 0}{" "}
                    篇选入研究
                  </small>
                </span>
                <span>
                  {open === b.id ? "收起处理详情" : batchLabel(b) + " · 查看"}
                </span>
              </button>
              {open === b.id && <BatchDetail id={b.id} revision={revision} />}
            </section>
          ))}
          <Pager page={rows} />
        </>
      )}
    </section>
  );
}
export function WatchPlans({ data, revision, run, refresh }: Props) {
  const [selected, setSelected] = useState<string>(),
    [editing, setEditing] = useState<string>(),
    [description, setDescription] = useState("");
  const [draft, setDraft] = useState<PlanDraft>({
      query: "",
      objective: "",
      maxPapers: 3,
      warnings: [],
    }),
    [projectId, setProjectId] = useState("default"),
    [autoProcess, setAutoProcess] = useState(false),
    [pending, setPending] = useState(false);
  const act = (fn: () => Promise<void>) =>
    void run(async () => {
      setPending(true);
      try {
        await fn();
      } finally {
        setPending(false);
      }
    });
  const editor = useRef<HTMLFormElement>(null),
    keyword = useRef<HTMLInputElement>(null),
    descriptionField = useRef<HTMLTextAreaElement>(null),
    trigger = useRef<HTMLElement | null>(null);
  const [editSerial, setEditSerial] = useState(0);
  useEffect(() => {
    if (!editing) return;
    editor.current?.scrollIntoView({ block: "start" });
    (editing === "new" ? descriptionField.current : keyword.current)?.focus({
      preventScroll: true,
    });
  }, [editing, editSerial]);
  const closeEditor = () => {
    setEditing(undefined);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  const edit = (p?: Plan, button?: HTMLElement) => {
    trigger.current = button ?? null;
    setEditSerial((value) => value + 1);
    setEditing(p?.id ?? "new");
    setDescription("");
    setDraft({
      query: p?.query ?? "",
      objective: p?.objective ?? p?.query ?? "",
      maxPapers: p?.maxPapers ?? 3,
      warnings: [],
    });
    setProjectId(p?.projectId ?? "default");
    setAutoProcess(p?.autoProcess ?? false);
  };
  return (
    <section className="watch-settings" aria-label="关注计划">
      <div className="row-between">
        <h2>关注主题</h2>
        <button
          disabled={pending}
          onClick={(event) => edit(undefined, event.currentTarget)}
        >
          新建关注计划
        </button>
      </div>
      <p className="help">
        每天 09:00（上海时间）检查
        arXiv。先保存文献线索；启用自动处理后，在预算内入库、阅读并汇报值得关注的变化。
      </p>
      {editing && (
        <form
          className="watch-editor"
          ref={editor}
          onSubmit={(e) => {
            e.preventDefault();
            act(async () => {
              const fields = {
                query: draft.query,
                objective: draft.objective,
                maxPapers: draft.maxPapers,
                autoProcess,
              };
              const saved = await mutate<Plan>(
                editing === "new" ? "plans" : "plans/" + editing,
                editing === "new" ? "POST" : "PATCH",
                {
                  ...fields,
                  ...(editing === "new" ? { projectId, enabled: true } : {}),
                },
              );
              setSelected(saved.id);
              closeEditor();
              refresh();
            });
          }}
        >
          <h3>{editing === "new" ? "创建关注计划" : "编辑关注计划"}</h3>
          {editing === "new" && (
            <div className="watch-draft">
              <Field
                label="想持续关注什么"
                hint="例如：每天关注 retrieval augmented generation，重点看证据可靠性，最多两篇。"
              >
                <textarea
                  ref={descriptionField}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={2000}
                  rows={2}
                />
              </Field>
              <button
                type="button"
                disabled={pending || !description.trim()}
                onClick={() =>
                  act(async () => {
                    setDraft(
                      await api<PlanDraft>("plans/draft", "POST", {
                        input: description,
                      }),
                    );
                  })
                }
              >
                生成可编辑草稿
              </button>
              <p className="help">
                草稿不会启用计划。请核对下面的关键词、目标与权限后保存。
              </p>
            </div>
          )}
          {!!draft.warnings.length && (
            <ul className="warning" role="status">
              {draft.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <div className="watch-fields">
            <Field
              label="arXiv 检索关键词"
              hint="用英文关键词组合；多个词会同时匹配。"
            >
              <input
                required
                maxLength={300}
                ref={keyword}
                value={draft.query}
                onChange={(e) => setDraft({ ...draft, query: e.target.value })}
              />
            </Field>
            <Field label="所属研究项目">
              <select
                disabled={editing !== "new"}
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                {data.projects.items.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field
            label="研究目标"
            hint="用于判断论文是否相关，以及它对已有研究有什么影响。"
          >
            <textarea
              required
              rows={3}
              maxLength={2000}
              value={draft.objective}
              onChange={(e) =>
                setDraft({ ...draft, objective: e.target.value })
              }
            />
          </Field>
          <label className="check-label">
            <input
              type="checkbox"
              checked={autoProcess}
              onChange={(e) => setAutoProcess(e.target.checked)}
            />
            允许自动下载、索引、阅读相关论文并整理研究记录
          </label>
          {autoProcess && (
            <Field label="每轮最多深入处理">
              <select
                value={draft.maxPapers}
                onChange={(e) =>
                  setDraft({ ...draft, maxPapers: Number(e.target.value) })
                }
              >
                {[1, 2, 3].map((n) => (
                  <option value={n} key={n}>
                    {n} 篇
                  </option>
                ))}
              </select>
            </Field>
          )}
          <p className="help">
            自动科研共用每月 20 元后台额度和全应用 50
            元上限。本机离线时保留待办，上线后继续；无重要变化不通知。
            {editing !== "new"
              ? "调整关键词或目标会暂停原研究任务；关闭权限会停止新步骤；启用权限或调整篇数在下个发现批次生效。"
              : ""}
          </p>
          <div className="button-row">
            <button className="primary" disabled={pending}>
              {pending
                ? "正在保存…"
                : editing === "new"
                  ? "保存并启用计划"
                  : "保存修改"}
            </button>
            <button type="button" disabled={pending} onClick={closeEditor}>
              取消编辑
            </button>
          </div>
        </form>
      )}
      <div className="watch-plans">
        {!data.plans.length && !editing && (
          <p className="help">
            还没有关注主题。添加一个研究方向，开始积累文献线索。
          </p>
        )}
        {data.plans.map((p) => (
          <div key={p.id}>
            <article className="watch-row">
              <div className="watch-plan-copy">
                <h3>{p.query}</h3>
                <p>{p.objective ?? p.query}</p>
                <small>
                  {p.autoProcess
                    ? "自动处理已授权 · 每轮最多 " + (p.maxPapers ?? 3) + " 篇"
                    : "仅保存文献线索"}{" "}
                  · {p.enabled ? "下次检查：" + date(p.next) : "已暂停"}
                </small>
                {p.sourceError && (
                  <small className="error">
                    论文来源暂不可用，检查位置已保留。
                  </small>
                )}
              </div>
              <div className="button-row">
                <button
                  disabled={pending}
                  aria-expanded={selected === p.id}
                  onClick={() =>
                    setSelected(selected === p.id ? undefined : p.id)
                  }
                >
                  {selected === p.id ? "收起记录" : "查看记录"}
                </button>
                <button
                  disabled={pending}
                  onClick={(event) => edit(p, event.currentTarget)}
                >
                  编辑
                </button>
                <button
                  disabled={pending}
                  onClick={() =>
                    act(async () => {
                      await mutate("plans/" + p.id, "PATCH", {
                        enabled: !p.enabled,
                      });
                      refresh();
                    })
                  }
                >
                  {p.enabled ? "暂停计划" : "恢复计划"}
                </button>
              </div>
            </article>
            {selected === p.id && <PlanBatches plan={p} revision={revision} />}
          </div>
        ))}
      </div>
    </section>
  );
}
