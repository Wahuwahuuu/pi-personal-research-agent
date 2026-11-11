import { useState } from "react";
import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { api, errorText } from "./api.ts";
import { Icon, Field } from "./components.tsx";
import type { Account, AuthStatus } from "./types.ts";
export function Auth({
  status,
  onSigned,
}: {
  status: AuthStatus;
  onSigned: (a: Account, codes?: string[]) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [secret, setSecret] = useState(""),
    [invite, setInvite] = useState(""),
    [recovery, setRecovery] = useState("");
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      setSecret("");
      setRecovery("");
    }
  }
  async function login() {
    const challenge = await api("auth/login/options", "POST", {});
    const response = await startAuthentication({
      optionsJSON: challenge.options,
    });
    const result = await api("auth/login/verify", "POST", {
      id: challenge.id,
      response,
    });
    onSigned(result.account);
  }
  async function join() {
    const challenge = await api("auth/register/options", "POST", { invite });
    const response = await startRegistration({
      optionsJSON: challenge.options,
    });
    const result = await api("auth/register/verify", "POST", {
      id: challenge.id,
      response,
    });
    setInvite("");
    onSigned(result.account, result.recoveryCodes);
  }
  return (
    <main className="auth-screen">
      <div className="auth-brand">
        <Icon name="memory" size={28} />
        <strong>Aster</strong>
        <span>个人科研助手</span>
      </div>
      <section className="auth-panel">
        <h1>回到你的研究。</h1>
        <p>接着讨论，核对证据，查看正在推进的工作。</p>
        <button
          className="primary full"
          disabled={busy}
          onClick={() => void run(login)}
        >
          <Icon name="key" />
          {busy ? "正在验证…" : "使用通行密钥登录"}
        </button>
        <p className="help">使用设备的指纹、面容、PIN 或安全密钥。</p>
        <details>
          <summary>收到邀请？创建账户</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(join);
            }}
          >
            <Field label="邀请码">
              <input
                value={invite}
                onChange={(e) => setInvite(e.target.value)}
                autoComplete="off"
                required
              />
            </Field>
            <button disabled={busy || !invite}>创建通行密钥</button>
          </form>
        </details>
        <details>
          <summary>无法使用通行密钥</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const result = await api("auth/recover", "POST", {
                  code: recovery,
                });
                onSigned(result.account);
              });
            }}
          >
            <Field label="一次性恢复码" hint="成功恢复后，之前的登录会失效。">
              <input
                type="password"
                value={recovery}
                onChange={(e) => setRecovery(e.target.value)}
                autoComplete="off"
                required
              />
            </Field>
            <button disabled={busy || !recovery}>恢复登录</button>
          </form>
        </details>
        {status.bootstrapAvailable && (
          <details>
            <summary>首次初始化</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const result = await api("login", "POST", { token: secret });
                  onSigned(result.account);
                });
              }}
            >
              <Field
                label="初始化凭证"
                hint="首次创建通行密钥后，这个登录入口会关闭。"
              >
                <input
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  autoComplete="off"
                  required
                />
              </Field>
              <button disabled={busy || !secret}>进入并设置账户</button>
            </form>
          </details>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>
      <p className="auth-note">
        完整论文默认保留在你的电脑。必要的引用与研究记录保存在云端。
      </p>
    </main>
  );
}
