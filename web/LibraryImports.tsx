import { useEffect, useState } from "react";
import { mutate, errorText } from "./api.ts";
import { Field, Loading, Pager, date } from "./components.tsx";
import { usePaged, type Run } from "./hooks.ts";
import type { Overview } from "./types.ts";
import type { LibraryJob } from "../src/library-jobs.ts";
const phases: Record<string, string> = {
  queued: "等待处理",
  acquiring: "正在获取原文",
  parsing: "正在解析论文",
  indexing: "正在建立检索索引",
  validating: "正在校验论文",
  published: "已入库",
  failed: "入库失败",
  cancelled: "已取消",
};
export function LibraryImports({
  projectId,
  data,
  revision,
  run,
  refresh,
  onPendingChange,
}: {
  projectId?: string;
  data: Overview;
  revision: number;
  run: Run;
  refresh: () => void;
  onPendingChange?: (count:number|undefined) => void;
}) {
  const jobs = usePaged<Omit<LibraryJob, "deviceHash">>(
    "imports?limit=5" +
      (projectId ? "&project=" + encodeURIComponent(projectId) : ""),
    revision,
  );
  const [open, setOpen] = useState(false),
    [arxiv, setArxiv] = useState(""),
    [title, setTitle] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  useEffect(()=>{onPendingChange?.(jobs.value?.pendingCount);},[onPendingChange,jobs.value?.pendingCount,projectId]);
  const connected = data.deviceState?.connected ?? data.deviceOnline;
  const state = (job: LibraryJob | Omit<LibraryJob, "deviceHash">) => {
    if (job.cancelPending) return "已取消，等待本机确认";
    if (["published", "failed", "cancelled"].includes(job.status))
      return phases[job.phase];
    if (!connected) return "等待你的电脑上线";
    if (!data.deviceState?.canImport) return "等待本机启用论文导入";
    if (data.deviceState.phase === "paused") return "本机已暂停，待办已保留";
    return phases[job.phase] ?? "等待处理";
  };
  return (
    <section className="library-imports" aria-labelledby="imports-heading">
      <div className="import-heading">
        <h2 id="imports-heading">添加论文</h2>
        <button aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "收起表单" : "从 arXiv 添加"}
        </button>
      </div>
      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            setBusy(true);
            setMessage("");
            void run(async () => {
              await mutate("imports", "POST", {
                projectId: projectId ?? "default",
                arxivId: arxiv.trim(),
                ...(title.trim() ? { title: title.trim() } : {}),
              });
              setArxiv("");
              setTitle("");
              setMessage("已加入待办。可在下方查看入库状态。");
              refresh();
              jobs.reload();
            }).finally(() => setBusy(false));
          }}
        >
          <div className="import-fields">
            <Field
              label="arXiv 编号与版本"
              hint="例如 2401.00001v2。使用论文页显示的版本号。"
            >
              <input
                required
                maxLength={32}
                pattern="[0-9]{4}[.][0-9]{4,5}v[1-9][0-9]{0,3}"
                value={arxiv}
                onChange={(e) => setArxiv(e.target.value)}
                placeholder="2401.00001v2"
                autoComplete="off"
              />
            </Field>
            <Field label="标题（可选）">
              <input
                maxLength={500}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="便于辨认这项待办"
              />
            </Field>
          </div>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "正在登记…" : "加入入库待办"}
          </button>
          <p className="muted import-hint">
            电脑离线时保留待办，上线后获取与索引。导入本机 PDF，请在 Windows
            托盘中选择文件。
          </p>
        </form>
      )}
      {message && (
        <p role="status" className="import-hint">
          {message}
        </p>
      )}
      {jobs.error ? (
        <div role="alert" className="error">
          {jobs.error}
          <button onClick={jobs.reload}>重新加载入库记录</button>
        </div>
      ) : !jobs.value ? (
        <Loading />
      ) : (
        jobs.value.items.length > 0 && (
          <div className="import-list">
            {jobs.value.items.map((job) => (
              <article className="import-row" key={job.id}>
                <div className="grow">
                  <h3>{job.title}</h3>
                  <div className="paper-meta">
                    <span>{job.arxivId}</span>
                    <time>{date(job.created)}</time>
                  </div>
                  <p
                    className={
                      job.status === "failed" ? "import-error" : "import-state"
                    }
                  >
                    {state(job)}
                  </p>
                  {job.error && job.status === "failed" && (
                    <p className="muted">{errorText(new Error(job.error))}</p>
                  )}
                </div>
                <div className="import-actions">
                  {["failed", "cancelled"].includes(job.status) ? (
                    <button
                      disabled={job.cancelPending}
                      onClick={() =>
                        void run(async () => {
                          await mutate("imports/" + job.id + "/retry", "POST");
                          refresh();
                          jobs.reload();
                        })
                      }
                    >
                      重新入库
                    </button>
                  ) : (
                    job.status !== "published" && (
                      <button
                        onClick={() =>
                          void run(async () => {
                            await mutate(
                              "imports/" + job.id + "/cancel",
                              "POST",
                            );
                            refresh();
                            jobs.reload();
                          })
                        }
                      >
                        取消入库
                      </button>
                    )
                  )}
                </div>
              </article>
            ))}
            <Pager page={jobs} />
          </div>
        )
      )}
    </section>
  );
}
