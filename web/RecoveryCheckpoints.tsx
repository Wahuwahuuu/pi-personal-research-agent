import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorText, mutate } from "./api.ts";
import { Dialog, Field, Loading, date } from "./components.tsx";
import { useResource, type Run } from "./hooks.ts";

interface Checkpoint { id: string; label: string; created: number; build: string }
interface Job { id: string; checkpointId: string; status: "pending" | "completed"; created: number; completed?: number; error?: string }
interface View { checkpoints: Checkpoint[]; jobs: Job[] }
interface Attempt { requestId: string; checkpointId: string }
const lifetime = 29 * 86400000;

export function RecoveryCheckpoints({ accountId, build, revision, run, refresh }: {
  accountId: string; build?: string; revision: number; run: Run; refresh: () => void;
}) {
  const storageKey = "pra-recovery-request:" + accountId;
  const [attempt, setAttempt] = useState<Attempt | undefined>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
      if (typeof value?.requestId === "string" && value.requestId.length <= 128 &&
          typeof value.checkpointId === "string" && value.checkpointId.length <= 128) return value;
    } catch {}
  });
  const resource = useResource<View>("recovery", revision);
  const [label, setLabel] = useState(""), [selected, setSelected] = useState<Checkpoint>(),
    [acknowledged, setAcknowledged] = useState(false), [busy, setBusy] = useState(false),
    [accepted, setAccepted] = useState<Job>(), [expanded, setExpanded] = useState(false),
    [saved, setSaved] = useState(""), [now, setNow] = useState(Date.now());
  const lock = useRef(false), completed = useRef<string | undefined>(undefined), reload = useRef(resource.reload);
  reload.current = resource.reload;
  const pending = resource.value?.jobs.find(j => j.status === "pending");
  const knownAttempt = resource.value?.jobs.find(j => j.id === attempt?.requestId);
  const current = pending ?? knownAttempt ?? accepted ?? (!attempt ? resource.value?.jobs[0] : undefined);
  const uncertain = !!attempt && !knownAttempt && !accepted;
  const waiting = !!pending || !!attempt || accepted?.status === "pending";
  const unavailable = busy || waiting || !build || !resource.value || resource.loading || !!resource.error;
  useEffect(() => {
    if (!waiting) return;
    const poll = () => { if (!document.hidden) reload.current(); };
    const timer = setInterval(poll, 3000);
    document.addEventListener("visibilitychange", poll);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", poll); };
  }, [waiting]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const job = knownAttempt ?? (accepted && resource.value?.jobs.find(j => j.id === accepted.id)) ?? current;
    if (job?.status !== "completed") return;
    if (attempt?.requestId === job.id) {
      try { sessionStorage.removeItem(storageKey); } catch {}
      setAttempt(undefined);
    }
    setAccepted(undefined);
    if (completed.current !== job.id) { completed.current = job.id; refresh(); }
  }, [resource.value, knownAttempt, current, accepted, attempt, storageKey, refresh]);
  const update = () => { resource.reload(); refresh(); };
  const submit = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setSaved("");
    try { await run(action); } finally { lock.current = false; setBusy(false); }
  };
  const restore = async (request: Attempt) => {
    // Persist only operation identifiers before sending; a lost response must not create a second restore.
    try { sessionStorage.setItem(storageKey, JSON.stringify(request)); }
    catch { throw new ApiError("RECOVERY_REQUEST_STORAGE", 409); }
    setAttempt(request);
    try {
      const result = await api<{ id: string; status: Job["status"] }>("recovery/restore", "POST", request as unknown as Record<string, unknown>);
      setAccepted({ ...result, checkpointId: request.checkpointId, created: Date.now() });
      setSelected(undefined); setAcknowledged(false);
      resource.reload();
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) {
        try { sessionStorage.removeItem(storageKey); } catch {} setAttempt(undefined);
      } else { setSelected(undefined); setAcknowledged(false); }
      resource.reload();
      throw e;
    }
  };
  const reason = (c: Checkpoint) => now - c.created >= lifetime ? "检查点已过期"
    : build && c.build !== build ? "由旧版本保存，当前版本不能恢复" : "";
  return <section className="recovery-checkpoints" aria-labelledby="recovery-heading" aria-busy={resource.loading}>
    <div className="recovery-heading">
      <h3 id="recovery-heading">恢复检查点</h3>
      <button onClick={update}>刷新恢复状态</button>
    </div>
    <p className="help">保存云端研究记录的时间点，必要时回退。检查点最多保留 29 天，只能在相同应用版本恢复；不是永久备份。</p>
    {!build && <p className="warning">研究工作区暂时不可用。这里仍可查看恢复状态，工作区恢复连接后才能保存或选择新的检查点。</p>}
    {resource.error && <div className="error" role="alert">
      <p>恢复状态暂时无法读取。请检查网络后刷新；当前不允许发起新的恢复。{resource.value ? "下方是上次读取的记录。" : ""}</p>
      <details className="diagnostics"><summary>诊断信息</summary><p>{resource.error}</p></details>
    </div>}
    {!resource.value && !resource.error && <Loading />}
    {resource.value && resource.loading && <p className="help" role="status">正在刷新恢复状态，当前显示上次读取的记录。</p>}
    {current && <div className={"recovery-status " + (current.error ? "error" : "")} role="status">
      <strong>{current.status === "completed" ? "已完成恢复" : current.error ? "恢复尚未完成，需要检查" : "正在恢复研究工作区"}</strong>
      <p>{current.status === "completed"
        ? "较新的研究记录已回退；当前删除记录、设备权限、费用和修订后的记忆已保留。原有未完任务已取消，关注计划已暂停，请检查后再安排研究。"
        : current.error ? errorText(new Error(current.error))
        : "正在回退记录并核对删除、权限和用量。完成核对前，研究工作区暂停使用；此页会自动更新。"}</p>
      <details className="diagnostics"><summary>查看恢复详情</summary><dl className="key-values">
        <div><dt>开始时间</dt><dd>{date(current.created)}</dd></div>
        {current.completed && <div><dt>完成时间</dt><dd>{date(current.completed)}</dd></div>}
        <div><dt>恢复编号</dt><dd>{current.id}</dd></div>
        {current.error && <div><dt>诊断代码</dt><dd>{current.error}</dd></div>}
      </dl></details>
    </div>}
    {uncertain && <div className="warning" role="status">
      <strong>提交结果尚未确认</strong>
      <p>正在查询已提交的恢复请求。刷新或关闭提示不会重新发起回退；如果一直没有结果，可用同一请求重新提交。</p>
      <button disabled={busy || !!pending || resource.loading || !!resource.error || !resource.value}
        onClick={() => void submit(() => restore(attempt!))}>用同一请求重试</button>
    </div>}
    <form className="checkpoint-form" onSubmit={e => {
      e.preventDefault();
      if (unavailable || !label.trim()) return;
      void submit(async () => {
        await mutate("recovery/checkpoints", "POST", { label: label.trim() });
        setSaved("检查点已保存。"); setLabel(""); resource.reload();
      });
    }}>
      <Field label="检查点名称"><input maxLength={80} value={label} placeholder="例如：整理研究方向之前"
        disabled={unavailable} onChange={e => setLabel(e.target.value)} /></Field>
      <button disabled={unavailable || !label.trim()} type="submit">{busy && !selected && !attempt ? "正在保存…" : "保存检查点"}</button>
    </form>
    {saved && <p className="success-line" role="status">{saved}</p>}
    {resource.value && !resource.value.checkpoints.length && <p className="recovery-empty">还没有有效的检查点。可以在调整研究记录前先保存一个。</p>}
    {!!resource.value?.checkpoints.length && <ul className="checkpoint-list">
      {resource.value.checkpoints.slice(0, expanded ? undefined : 5).map(c => <li key={c.id} className="checkpoint-row">
        <div><h4>{c.label}</h4><p className="help">保存于 {date(c.created)} · 有效至 {date(c.created + lifetime)}</p>
          {reason(c) && <p className="help">{reason(c)}</p>}</div>
        <button disabled={unavailable || !!reason(c)} onClick={() => { setSelected(c); setAcknowledged(false); }}>恢复到这里</button>
      </li>)}
    </ul>}
    {(resource.value?.checkpoints.length ?? 0) > 5 && <button onClick={() => setExpanded(!expanded)}>
      {expanded ? "收起检查点" : "查看全部 " + resource.value!.checkpoints.length + " 个检查点"}
    </button>}
    <p className="help recovery-boundary">完整论文与本机索引不会随云端回退。请等待当前模型、工具和入库步骤结束后操作；恢复不会撤销已经执行的本地操作。</p>
    <Dialog title="恢复到这个检查点？" open={!!selected} onClose={() => { if (!busy) setSelected(undefined); }} dismissible={!busy}>
      {selected && <><p><strong>{selected.label}</strong><br />{date(selected.created)}</p>
        <ul className="recovery-consequences">
          <li>该时间点之后的对话、研究成果和修改会回退。</li>
          <li>已删除的内容不会恢复；保留当前设备权限、累计费用和修订后的记忆。</li>
          <li>未完成任务会取消，关注计划会暂停。完成后需要重新安排。</li>
          <li>本机论文和已经执行的本地操作不会回退。</li>
        </ul>
        <label className="recovery-ack"><input type="checkbox" checked={acknowledged}
          disabled={busy} onChange={e => setAcknowledged(e.target.checked)} />我了解这些变化，确认回退云端研究记录</label>
        <div className="recovery-actions">
          <button disabled={busy} onClick={() => setSelected(undefined)}>保留当前记录</button>
          <button className="danger" disabled={busy || waiting || !acknowledged || resource.loading || !!resource.error || !!reason(selected)}
            onClick={() => void submit(() => restore({ requestId: crypto.randomUUID(), checkpointId: selected.id }))}>
            {busy ? "正在提交…" : "确认恢复"}
          </button>
        </div>
      </>}
    </Dialog>
  </section>;
}
