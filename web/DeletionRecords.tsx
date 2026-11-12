import { useState } from "react";
import type { DeletionRecord } from "../src/deletion.ts";
import { api } from "./api.ts";
import { Loading, Pager, date } from "./components.tsx";
import { navigate, usePaged, type Run } from "./hooks.ts";

function description(record: DeletionRecord) {
  if (record.status === "failed") return {
    title: "云端清理未完成",
    detail: record.error === "PI_DELETE_SCHEMA_MISMATCH"
      ? "会话仍暂停使用。需要先检查存储版本兼容性，修复后再重试。"
      : "会话仍暂停使用。可以重试删除；如果再次失败，请保留诊断编号以便排查。",
    tone: "failed",
  };
  if (record.status === "pending") return {
    title: "正在清理云端记录",
    detail: "正在停止相关任务并清理会话及派生内容，请稍候。",
    tone: "pending",
  };
  if (record.unverifiedOperations) return {
    title: "本地副本待核验",
    detail: "云端已清理。旧版本没有完整记录哪些电脑保存过结果，暂时无法确认所有本地副本已清理。",
    tone: "waiting",
  };
  if (record.status === "cloud_complete") return {
    title: "云端已清理，等待本机",
    detail: record.pendingDevices
      ? "请让原来的 " + record.pendingDevices + " 台电脑连接节点。收到本地缓存清理回执后，这条记录会自动更新。"
      : "云端内容已清理，本地清理结果仍待确认。请连接原来的电脑。",
    tone: "waiting",
  };
  return {
    title: "清理已完成",
    detail: "云端会话及派生内容已清理，已登记的本地缓存均已确认清理。",
    tone: "complete",
  };
}

export function DeletionRecords({ revision, run }: { revision: number; run: Run }) {
  const page = usePaged<DeletionRecord>("deletions?limit=20", revision);
  const [retrying, setRetrying] = useState<string>();
  const retry = async (record: DeletionRecord) => {
    setRetrying(record.id);
    try {
      await run(async () => {
        await api("conversations/" + encodeURIComponent(record.id), "DELETE");
        page.reload();
      });
    } finally { setRetrying(undefined); }
  };
  return (
    <section className="deletion-records" aria-labelledby="deletion-heading">
      <div className="deletion-heading">
        <h3 id="deletion-heading">删除记录</h3>
        <button onClick={page.reload}>刷新记录</button>
      </div>
      <p className="help">记录云端内容与本地缓存的清理情况。论文库中的原始论文会保留。</p>
      {page.error && <div role="alert" className="error">
        <p>删除记录暂时无法读取，请检查网络后重新加载。{page.value ? "下方保留的是上一次读取的记录。" : ""}</p>
        <details className="diagnostics"><summary>诊断信息</summary><p>{page.error}</p></details>
        <button onClick={page.reload}>重新加载</button>
      </div>}
      {!page.value && !page.error && <Loading />}
      {page.value && !page.value.items.length && <div className="deletion-empty">
        <p>{page.hasPrevious ? "这一页暂时没有删除记录。" : "还没有删除记录。"}</p>
        <p className="help">需要清理某段研究对话时，可在会话菜单中选择“删除会话”。</p>
        <button onClick={() => navigate("chat")}>管理会话</button>
      </div>}
      {page.value && page.value.items.length > 0 && <ul className="deletion-list">
        {page.value.items.map(record => {
          const view = description(record);
          return <li key={record.id} className="deletion-row">
            <div className="deletion-row-heading">
              <h4 className={"deletion-state deletion-" + view.tone} aria-live="polite">{view.title}</h4>
              <time dateTime={new Date(record.created).toISOString()}>{date(record.created)}</time>
            </div>
            <p>{view.detail}</p>
            <details className="diagnostics">
              <summary>查看清理详情</summary>
              <dl className="key-values">
                <div><dt>删除编号</dt><dd>{record.id}</dd></div>
                <div><dt>已知待确认电脑</dt><dd>{record.pendingDevices} 台</dd></div>
                <div><dt>待确认结果副本</dt><dd>{record.pendingResults} 份</dd></div>
                <div><dt>待确认阅读器缓存</dt><dd>{record.pendingReaders} 份</dd></div>
                {record.unverifiedOperations > 0 && <div><dt>设备记录不完整</dt><dd>{record.unverifiedOperations} 项操作</dd></div>}
                {record.error && <div><dt>诊断代码</dt><dd>{record.error}</dd></div>}
              </dl>
            </details>
            {record.status === "failed" && <button disabled={retrying !== undefined} onClick={() => void retry(record)}>
              {retrying === record.id ? "正在重新提交…" : "重试删除"}
            </button>}
          </li>;
        })}
      </ul>}
      <Pager page={page} />
      <p className="help deletion-boundary">此处核验应用在线数据和已登记的本地缓存。平台备份按平台保留策略处理，不计入这里的清理完成状态。</p>
    </section>
  );
}
