const pending = new Map<string, string>();
export class ApiError extends Error {
  status: number;
  constructor(code: string, status: number) {
    super(code);
    this.status = status;
  }
}
export async function api<T = any>(
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
): Promise<T> {
  const r = await fetch("/api/" + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await r.json();
  if (!r.ok) {
    if (r.status === 401 && !path.startsWith("auth/") && path !== "login")
      window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(value.error ?? "REQUEST_FAILED", r.status);
  }
  return value;
}
export async function mutate<T = any>(
  path: string,
  method: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const key = method + " " + path + " " + JSON.stringify(body),
    requestId = pending.get(key) ?? crypto.randomUUID();
  pending.set(key, requestId);
  try {
    const value = await api<T>(path, method, { ...body, requestId });
    pending.delete(key);
    return value;
  } catch (e) {
    if (e instanceof ApiError && e.status < 500) pending.delete(key);
    throw e;
  }
}
const messages: Record<string, string> = {
  DELETION_PENDING:"这个会话的来源仍在清理，请先完成数据删除；其他独立会话可以继续使用。",
  CONTEXT_SOURCE_DELETED:"这次回答使用的来源已删除，相关结果已清除。你可以在当前会话重新提问。",
  PAIRING_REVOKED:"这次配对已撤销，请重新生成配对凭证。",
  PAIRING_EXPIRED:"这次配对已过期，请重新生成配对凭证。",
  PAIRING_KEY_CHANGED:"配对配置已更新，请重新生成配对凭证；已安装的有效设备仍可连接。",
  PAIRING_NOT_CONFIGURED:"云端配对配置尚未就绪，请检查部署设置。",
  READER_UNAVAILABLE:"本机阅读器尚未就绪，请打开 Windows 托盘、确认连接后重试。",
  READER_EXPIRED:"阅读请求已过期。确认本机在线后，可以再次打开。",
  READER_INTERRUPTED:"阅读器启动过程被中断。请检查本机窗口后再决定是否重试。",
  READER_CANCELLED:"阅读请求已取消，关联会话或设备权限已有变化。",
  PDF_UNAVAILABLE:"本机未能打开这份全文，请在 Windows 托盘检查资料是否完整，再重试。",
  INDEX_UNAVAILABLE:"这条引用使用的资料版本已不在本机，无法准确打开。请重新检索或查看已保存证据。",

  SOURCE_UNAVAILABLE:"论文来源暂时无法查询，成功检查位置保持不变。",
  PLAN_CHECK_IN_PROGRESS:"本轮来源检查尚未结束，请在来源恢复并完成检查后再修改关键词或目标。",
  PROACTIVE_IMPORT_FAILED:"所选论文尚未成功入库，请在论文库检查失败原因，重试入库后继续研究任务。",
  PROACTIVE_RESULT_INVALID:"本轮筛选或简报的结构未通过校验，已保留记录，请在研究会话中检查并决定是否继续。",
  RESEARCH_DELETED:"关联研究会话已经删除，旧研究结果不会恢复。",
  BACKGROUND_DAILY_BUDGET:"今天的自动科研额度已用尽，待办保留，可以在后续额度可用时继续。",

  VERSIONED_ARXIV_ID_REQUIRED:"请填写包含版本号的 arXiv 编号，例如 2401.00001v2。",
  IMPORT_QUEUE_FULL:"入库待办已达到 100 项，请完成或取消部分待办后再添加。",
  LOCAL_CANCEL_PENDING:"取消已保存，等待本机确认后才能重新入库。",
  IMPORT_ALREADY_PUBLISHED:"这篇论文已经入库。取消待办不会删除已入库的论文。",
  IMPORT_DEVICE_REVOKED:"执行入库的设备已被撤销。连接有效设备后可以重新入库。",
  IMPORT_NOT_RETRYABLE:"这项入库仍在处理中，请刷新查看最新状态。",
  IMPORT_REGISTRATION_TIMEOUT:"本机未确认收到请求，请检查连接后重新入库。",
  IMPORT_DELIVERY_LIMIT:"多次连接未能登记成功，请检查本机状态后重新入库。",
  DOWNLOAD_UNAVAILABLE:"未能获取论文，请核对编号和版本，检查本机网络后重试。",
  TEXT_LAYER_REQUIRED:"这份 PDF 没有可读取的文本层，当前版本不支持扫描件。",
  IMPORT_PROCESS_INTERRUPTED:"本机处理被中断，请检查节点状态后重新入库。",
  IMPORT_TIMEOUT:"本机处理超时，请查看托盘诊断后重新入库。",
  UNAUTHORIZED: "登录已过期，请重新登录。",
  INVITATION_REQUIRED: "需要有效的邀请码，才能创建账户。",
  INVITE_EXPIRED: "邀请已使用或过期，请获取新的邀请。",
  PASSKEY_REQUIRED: "此账户已启用通行密钥，请使用通行密钥登录。",
  AUTHENTICATION_FAILED: "通行密钥验证未完成，请重试。",
  RECOVERY_INVALID: "恢复码无效或已经使用。",
  TRY_LATER: "尝试次数较多，请一分钟后重试。",
  VALIDATION_BUDGET: "本应用的模型验证总配额已达到上限，已有研究结果已保留。切换账户或跨月不会重置额度。",
  VALIDATION_MIGRATION_REQUIRED: "正在核对已有账户的累计用量，完成后才能继续付费调用。",
  MONTHLY_BUDGET: "本月模型预算已用尽，研究结果已保留。",
  BACKGROUND_BUDGET: "自动科研预算已暂停，待办会保留。",
  PRICE_REVIEW_REQUIRED: "模型费率需要核对，付费调用已暂停。",
  BILLING_UNAVAILABLE: "暂时无法核对预算，请稍后重试。",
  GOAL_BUDGET: "这项目标已达到累计上限，部分成果和未完成事项已保留。",
  PAUSE_PENDING: "当前步骤尚未结束，请在进度保存后继续。",
  PAUSE_REQUIRED: "请先暂停任务，待当前步骤结束后再调整方向。",
  TASK_NOT_PAUSED: "任务尚未暂停，请刷新查看最新状态。",
  MODEL_BUDGET: "本次任务已达到调用上限，可查看已有结果和未完成部分。",
  NOT_FOUND: "这条记录不存在或已删除。",
  RESOURCE_DELETED: "这条记录已删除，不能重新提交原操作。",
  VERSION_CONFLICT: "内容已有更新，请重新打开最新版本后修改。",
  CONVERSATION_BUSY: "此会话仍有任务执行，完成或取消后才能修改研究范围。",
  NEW_TASK_REQUIRED: "这项任务不能直接重跑，请在原会话中补充要求。",
  RESULT_NOT_READY: "回答尚未准备好，完成后可保存成果。",
  DEFAULT_PROJECT_REQUIRED: "默认研究项目需要保留。可以删除其中的会话。",
  LAST_PASSKEY: "请先添加另一枚通行密钥，再删除这一枚。",
  ACCOUNT_DATA_DIRECTORY_MISMATCH:
    "本机资料目录属于另一个账户，请选择独立目录。",
  CONTEXT_CHANGED:
    "研究依赖的记忆已修改。已暂停旧上下文，请补充当前要求后继续。",
  CONTEXT_LIMIT: "本次上下文过长，请缩小研究范围后继续。",
};
export function errorText(e: unknown) {
  const code = e instanceof Error ? e.message : String(e);
  return (
    messages[code] ??
    (code.includes("NotAllowed")
      ? "通行密钥操作已取消，可以重试。"
      : e instanceof TypeError
        ? "无法连接服务。请检查网络后重试。"
        : "操作未完成。请重试；仍失败时可在诊断中查看：" + code)
  );
}
export function download(
  name: string,
  content: string,
  type = "application/json",
) {
  const url = URL.createObjectURL(new Blob([content], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
