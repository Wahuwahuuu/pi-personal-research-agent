import type { PlatformBudgetView } from "../src/platform-resources.ts";
import { date, Loading } from "./components.tsx";
import { errorText } from "./api.ts";
import { useResource } from "./hooks.ts";

const labels = {
  workerRequests: "网页与 API 请求",
  doRequestUpperEstimate: "Agent 请求上界",
  doDuration: "Agent 运行时长",
  sqliteRowsRead: "数据库读取行数",
  sqliteRowsWritten: "数据库写入行数",
  sqliteStoredBytes: "数据库存储",
};
type Metric = keyof typeof labels;
const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });

function display(key: Metric, value: number | null) {
  if (value === null) return "待报告";
  if (key === "sqliteStoredBytes") {
    const [unit, scale] = value >= 1e9 ? ["GB", 1e9] as const :
      value >= 1e6 ? ["MB", 1e6] as const : value >= 1e3 ? ["KB", 1e3] as const : ["B", 1] as const;
    return number.format(value / scale) + " " + unit;
  }
  if (key === "doDuration") return (value > 0 && value < 0.01 ? "<0.01" : number.format(value)) + " GB-s";
  return number.format(value);
}

export function CloudResources() {
  const report = useResource<PlatformBudgetView>("platform?view=budget");
  const view = report.value;
  const snapshot = view?.snapshot, limits = view?.limits;
  return (
    <section className="cloud-resources" aria-labelledby="cloud-resources-title">
      <div className="row-between">
        <h2 id="cloud-resources-title">Cloudflare 免费资源</h2>
        <button type="button" disabled={report.loading} onClick={report.reload}>重新读取用量</button>
      </div>
      {report.error ? <p className="error" role="alert">{report.error}</p> : !view ? <Loading /> : (
        <>
          {view.blocked && <p className="warning" role="status">{errorText(view.reason ?? "PLATFORM_METRICS_UNAVAILABLE")}</p>}
          {view.observedAt ? <p className="help">最近上报于上海时间 {date(view.observedAt)}。</p> :
            <p>{view.monitoring === "automatic" ? "正在等待首次平台统计。" :
              view.monitoring === "incomplete" ? "自动采集配置尚未完整，平台用量待确认。" :
              "尚未配置自动采集，也尚未收到平台用量。"}</p>}
          {view.observedAt && view.monitoring === "unconfigured" && <p className="help">当前用量来自手动上报，自动采集尚未配置。</p>}
          {view.observedAt && view.monitoring === "incomplete" && <p className="help">自动采集配置尚未完整，下面保留最近一次上报。</p>}
          {limits && (
            <>
              <table className="cloud-resource-table">
                <caption>{snapshot ? snapshot.day + " UTC 用量" : "免费额度与项目目标"}</caption>
                <thead><tr><th scope="col">资源</th><th scope="col">本项目</th><th scope="col">共享账户</th></tr></thead>
                <tbody>{(Object.keys(labels) as Metric[]).map(key => (
                  <tr key={key}>
                    <th scope="row">{labels[key]}</th>
                    <td><strong>{display(key, snapshot?.project[key] ?? null)}</strong><small>目标 {display(key, limits[key][1])}</small></td>
                    <td><strong>{display(key, snapshot?.account[key] ?? null)}</strong><small>免费额度 {display(key, limits[key][0])}</small></td>
                  </tr>
                ))}</tbody>
              </table>
              <p className="help">共享账户达到任一免费额度的 80%，或本项目达到表内任一目标时，暂停新的后台研究。</p>
              <p className="help">请求和读写按 UTC 日统计。Agent 请求采用保守上界，存储为各命名空间在观察期内的峰值之和。平台统计可能延迟。</p>
            </>
          )}
          {view.observedAt && !view.limits && !view.blocked && <p>最近一次统计处于后台工作的保护阈值以内。</p>}
        </>
      )}
    </section>
  );
}
