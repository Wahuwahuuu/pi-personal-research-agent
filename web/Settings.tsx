import {RecoveryCheckpoints} from "./RecoveryCheckpoints.tsx";
import {DeletionRecords} from "./DeletionRecords.tsx";
import {deviceView} from "./device-state.ts";
import { useEffect, useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { api, mutate, download } from "./api.ts";
import { Icon, Field, Loading, Dialog, date } from "./components.tsx";
import { navigate, useResource, type Run } from "./hooks.ts";
import type { Account, Overview, Budget } from "./types.ts";
interface Props {
  account: Account;
  data: Overview;
  section?: string;
  revision: number;
  run: Run;
  refresh: () => void;
  showCodes: (codes: string[]) => void;
  logout: () => Promise<void>;
}
interface Device {
  id: string;
  label: string;
  created: number;
  expires: number;
  revoked: number;
}
interface Me {
  account: Account;
  credentials: { id: string; name: string; created: number }[];
}
export async function registerPasskey() {
  const c = await api("auth/register/options", "POST", {});
  const response = await startRegistration({ optionsJSON: c.options });
  return api("auth/register/verify", "POST", { id: c.id, response });
}
export function Onboarding({
  data,
  run,
  refresh,
  showCodes,
}: {
  data: Overview;
  run: Run;
  refresh: () => void;
  showCodes: (c: string[]) => void;
}) {
  const me = useResource<Me>("auth/me", data.cursor),
    [name, setName] = useState(data.settings.agentName),
    [direction, setDirection] = useState(data.settings.researchDirection),
    [registered, setRegistered] = useState(false);
  const ready = registered || Boolean(me.value?.credentials.length);
  return (
    <section className="onboarding page">
      <div className="page-heading">
        <div>
          <h1>先建立你的研究工作区</h1>
          <p>确定研究方向和登录方式，本机可以稍后连接。</p>
        </div>
      </div>
      <div className="setup-step">
        <span>1</span>
        <div>
          <h2>保护你的账户</h2>
          <p>通行密钥用于日常登录；恢复码请离线妥善保存。</p>
          {ready ? (
            <p className="success-line">
              <Icon name="check" />
              通行密钥已就绪
            </p>
          ) : (
            <button
              className="primary"
              onClick={() =>
                void run(async () => {
                  const r = await registerPasskey();
                  setRegistered(true);
                  if (r.recoveryCodes) showCodes(r.recoveryCodes);
                  refresh();
                })
              }
            >
              创建我的通行密钥
            </button>
          )}
        </div>
      </div>
      <div className="setup-step">
        <span>2</span>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await mutate("settings", "PATCH", {
                agentName: name,
                researchDirection: direction,
                onboarded: true,
              });
              refresh();
              navigate("chat");
            });
          }}
        >
          <h2>告诉我你在研究什么</h2>
          <Field label="助手名称">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={40}
            />
          </Field>
          <Field label="研究方向">
            <textarea
              value={direction}
              rows={3}
              onChange={(e) => setDirection(e.target.value)}
              maxLength={2000}
              placeholder="例如：检索增强生成中的长期记忆、证据验证与评测。"
            />
          </Field>
          <p className="help">
            模型预算：全应用每月最多 50 元，自动科研最多 20 元。可随时暂停任务。
          </p>
          <button className="primary" disabled={!ready}>
            保存并开始讨论 <Icon name="arrow" size={16} />
          </button>
        </form>
      </div>
      <div className="setup-step">
        <span>3</span>
        <div>
          <h2>连接本机论文</h2>
          <p>
            完成设置后，在“设置 → 本地设备”连接 Windows
            节点。离线时依赖原文的任务会保留。
          </p>
          <p className="help">云端对话可先使用；完整论文默认留在电脑上。</p>
        </div>
      </div>
    </section>
  );
}
export function SettingsView({
  account,
  data,
  section = "profile",
  revision,
  run,
  refresh,
  showCodes,
  logout,
}: Props) {
  const me = useResource<Me>("auth/me", revision),
    devices = useResource<Device[]>("devices", revision),
    budget = useResource<Budget>("budget", revision);
  const [name, setName] = useState(data.settings.agentName),
    [direction, setDirection] = useState(data.settings.researchDirection),
    [deviceName, setDeviceName] = useState("我的 Windows 电脑"),
    [paired, setPaired] = useState(""),
    [inviteName, setInviteName] = useState(""),
    [invite, setInvite] = useState(""),
    [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!paired) return;
    const timer = setTimeout(() => setPaired(""), 120000);
    return () => clearTimeout(timer);
  }, [paired]);
  const tabs = [
    ["profile", "个人设置"],
    ["devices", "本地设备"],
    ["account", "账户"],
    ["budget", "预算"],
    ["data", "数据与诊断"],
  ];
  return (
    <section className="page settings-page">
      <div className="page-heading">
        <div>
          <h1>设置</h1>
          <p>管理研究偏好、设备、费用与数据。</p>
        </div>
      </div>
      <nav className="tabs" aria-label="设置分类">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            aria-current={section === key ? "page" : undefined}
            onClick={() => navigate("settings", key)}
          >
            {label}
          </button>
        ))}
      </nav>
      {section === "profile" && (
        <form
          className="settings-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await mutate("settings", "PATCH", {
                agentName: name,
                researchDirection: direction,
              });
              refresh();
            });
          }}
        >
          <h2>个人研究偏好</h2>
          <Field label="助手名称">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={40}
            />
          </Field>
          <Field label="研究方向">
            <textarea
              value={direction}
              onChange={(e) => setDirection(e.target.value)}
              rows={4}
              maxLength={2000}
            />
          </Field>
          <button className="primary">保存设置</button>
          <hr />
          <Field label="外观">
            <select
              value={data.settings.theme}
              onChange={(e) =>
                void run(async () => {
                  await mutate("settings", "PATCH", { theme: e.target.value });
                  refresh();
                })
              }
            >
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </Field>
          <label className="check-label">
            <input
              type="checkbox"
              checked={data.settings.notifications}
              onChange={(e) =>
                void run(async () => {
                  await mutate("settings", "PATCH", {
                    notifications: e.target.checked,
                  });
                  refresh();
                })
              }
            />
            允许本机桌面提醒
          </label>
          <p className="help">
            站内收件箱始终保留结果。日程按 Asia/Shanghai 计算。
          </p>
        </form>
      )}
      {section === "devices" && (
        <div className="settings-form">
          <h2>本地节点</h2>
          <p className={deviceView(data).connected ? "success-line" : "muted"}>
            <Icon name="desktop" />
            {deviceView(data).detail}
          </p>
          <p>节点在 Windows 登录后运行。网页关闭后，节点仍可继续工作。</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const r = await mutate("device/pair", "POST", {
                  label: deviceName,
                });
                setPaired(r.token);
                setCopied(false);
                refresh();
              });
            }}
          >
            <Field label="设备名称">
              <input
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                maxLength={80}
                required
              />
            </Field>
            <button className="primary">生成配对凭证</button>
          </form>
          <p className="help">
            配对凭证只显示一次，请交给本机节点的配对窗口或安装脚本。
          </p>
          <a
            href="https://github.com/Wahuwahuuu/pi-personal-research-agent#readme"
            target="_blank"
            rel="noreferrer"
          >
            查看本地安装说明
          </a>
          <h3 className="section-heading">已配对设备</h3>
          {devices.error ? (
            <p className="error" role="alert">
              {devices.error}
              <button onClick={devices.reload}>重试</button>
            </p>
          ) : !devices.value ? (
            <Loading />
          ) : !devices.value.length ? (
            <p className="muted">还没有配对设备。</p>
          ) : (
            devices.value.map((d) => (
              <div className="device-row" key={d.id}>
                <Icon name="desktop" />
                <span className="grow">
                  <strong>{d.label}</strong>
                  <small>
                    {d.revoked
                      ? "已撤销"
                      : d.expires < Date.now()
                        ? "已过期"
                        : "凭证有效至 " + date(d.expires)}
                  </small>
                </span>
                {!d.revoked && (
                  <button
                    className="danger-text"
                    onClick={() =>
                      void run(async () => {
                        await mutate("device/revoke", "POST", { id: d.id });
                        refresh();
                      })
                    }
                  >
                    撤销
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      )}
      {section === "account" && (
        <div className="settings-form">
          <h2>通行密钥</h2>
          <p>当前账户：{account.name}</p>
          {me.value?.credentials.map((c) => (
            <div className="device-row" key={c.id}>
              <Icon name="key" />
              <span className="grow">
                <strong>{c.name}</strong>
                <small>添加于 {date(c.created)}</small>
              </span>
              {me.value!.credentials.length > 1 && (
                <button
                  onClick={() =>
                    void run(async () => {
                      await mutate("auth/credentials/" + c.id, "DELETE");
                      refresh();
                    })
                  }
                >
                  移除
                </button>
              )}
            </div>
          ))}
          <button
            className="primary"
            onClick={() =>
              void run(async () => {
                const r = await registerPasskey();
                if (r.recoveryCodes) showCodes(r.recoveryCodes);
                refresh();
              })
            }
          >
            添加通行密钥
          </button>
          <h3 className="section-heading">恢复方式</h3>
          <p>每个恢复码只能使用一次。更新后，旧恢复码会失效。</p>
          <button
            onClick={() =>
              void run(async () => {
                const r = await mutate("auth/recovery", "POST");
                showCodes(r.recoveryCodes);
              })
            }
          >
            生成新的恢复码
          </button>
          {account.role === "owner" && (
            <>
              <h3 className="section-heading">邀请使用者</h3>
              <form
                className="inline-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    const r = await mutate("auth/invites", "POST", {
                      name: inviteName,
                    });
                    setInvite(r.code);
                    setInviteName("");
                  });
                }}
              >
                <input
                  aria-label="受邀者名称"
                  value={inviteName}
                  maxLength={80}
                  onChange={(e) => setInviteName(e.target.value)}
                  required
                  placeholder="受邀者名称"
                />
                <button>生成邀请</button>
              </form>
              {invite && (
                <Field label="邀请码，有效期七天">
                  <input
                    readOnly
                    value={invite}
                    onFocus={(e) => e.target.select()}
                  />
                </Field>
              )}
            </>
          )}
          <div className="section-actions">
            <button onClick={() => void run(logout)}>退出登录</button>
          </div>
        </div>
      )}
      {section === "budget" && (
        <div className="settings-form">
          <h2>模型调用预算</h2>
          {budget.error ? (
            <p className="error" role="alert">
              {budget.error}
              <button onClick={budget.reload}>重试</button>
            </p>
          ) : !budget.value ? (
            <Loading />
          ) : (
            <>
              <div className="budget-summary">
                <span>本月可用</span>
                <strong>¥{budget.value.remaining.toFixed(2)}</strong>
                <p>
                  全应用月上限 ¥{budget.value.limit} · {budget.value.month}
                </p>
              </div>
              <dl className="key-values">
                <div>
                  <dt>已记费用估算</dt>
                  <dd>¥{budget.value.estimatedSpent.toFixed(4)}</dd>
                </div>
                <div>
                  <dt>执行中预留</dt>
                  <dd>¥{budget.value.reserved.toFixed(4)}</dd>
                </div>
                <div>
                  <dt>后台科研已记费用</dt>
                  <dd>
                    ¥{budget.value.backgroundSpent.toFixed(4)} / ¥
                    {budget.value.backgroundLimit}
                  </dd>
                </div>
                <div>
                  <dt>当前模型</dt>
                  <dd>{data.model.id}</dd>
                </div>
                <div>
                  <dt>深度思考</dt>
                  <dd>关闭</dd>
                </div>
              </dl>
              {budget.value.blocked ? (
                <p className="error">月度额度已用尽，新的付费调用已暂停。</p>
              ) : budget.value.backgroundPaused ? (
                <p className="warning">后台新调用已暂停，待办仍保留。</p>
              ) : null}
              <p className="help">
                40 元提醒，45 元暂停后台，50
                元停止新调用。缺失用量按预留上限计入。供应商账单需单独核对。
              </p>
              <a
                href={budget.value.priceSource}
                target="_blank"
                rel="noreferrer"
              >
                查看费率来源
              </a>
            </>
          )}
        </div>
      )}
      {section === "data" && (
        <div className="settings-form">
          <h2>你的研究数据</h2>
          <p>完整论文默认留在本机。云端保存必要的引用、证据片段和研究记录。</p>
          <button
            onClick={() =>
              void run(async () =>
                download(
                  "research-data.json",
                  JSON.stringify(await api("export"), null, 2),
                ),
              )
            }
          >
            导出在线数据
          </button>
          <RecoveryCheckpoints accountId={account.id} build={data.build} revision={revision} run={run} refresh={refresh} />
          <DeletionRecords revision={revision} run={run} />
          <details className="diagnostics">
            <summary>诊断详情</summary>
            <dl className="key-values">
              <div>
                <dt>构建版本</dt>
                <dd>{data.build}</dd>
              </div>
              <div>
                <dt>模型模式</dt>
                <dd>{data.model.mode}</dd>
              </div>
              <div>
                <dt>已保存事件游标</dt>
                <dd>{data.cursor}</dd>
              </div>
            </dl>
            <p>此处为应用状态，不代表 Cloudflare 账户的实际剩余额度。</p>
            <a href="/legacy.html">打开兼容验证界面</a>
          </details>
        </div>
      )}
      <Dialog
        open={!!paired}
        onClose={() => setPaired("")}
        title="保存设备配对凭证"
      >
        <p>
          两分钟后或关闭此窗口后隐藏。凭证只用于节点连接，不包含模型 API Key。
        </p>
        <Field label="配对凭证">
          <input
            type="password"
            value={paired}
            readOnly
            onFocus={(e) => e.target.select()}
          />
        </Field>
        <button
          className="primary"
          onClick={() =>
            void run(async () => {
              await navigator.clipboard.writeText(paired);
              setCopied(true);
            })
          }
        >
          {copied ? "已复制" : "复制配对凭证"}
        </button>
      </Dialog>
    </section>
  );
}
