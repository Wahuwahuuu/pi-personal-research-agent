import {deviceView} from "./device-state.ts";
import { MemoryView } from "./Memory.tsx";
import {
  StrictMode,
  useCallback,
  useEffect,
  useRef,
  useState,
  Component,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { Auth } from "./Auth.tsx";
import { Conversations } from "./Conversations.tsx";
import { Chat } from "./Chat.tsx";
import {
  Projects,
  Library,
  Activity,
  Inbox,
  ArtifactView,
} from "./WorkspaceViews.tsx";
import { SettingsView, Onboarding } from "./Settings.tsx";
import { api, download, errorText } from "./api.ts";
import { Icon, Loading, Dialog, Markdown } from "./components.tsx";
import { navigate, useResource, useRoute, type Run } from "./hooks.ts";
import type {
  Account,
  AuthStatus,
  Overview,
  Chunk,
  Task,
  Paper,
} from "./types.ts";
import "./styles.css";
const navigation = [
  ["chat", "对话"],
  ["projects", "研究项目"],
  ["papers", "论文库"],
  ["tasks", "活动与任务"],
  ["artifacts", "研究成果"],
  ["inbox", "收件箱"],
  ["memory", "记忆"],
];
type Evidence = { source?: Chunk; task?: Task; paper?: Paper };
function SourcePanel({
  evidence,
  close,
  select,
}: {
  evidence: Evidence;
  close: () => void;
  select: (s: Chunk) => void;
}) {
  const source = evidence.source,
    paper = evidence.paper,
    paperId = source?.paper_id ?? paper?.paper_id;
  const panel = useRef<HTMLElement>(null),
    closeRef = useRef(close);
  closeRef.current = close;
  const [mobile, setMobile] = useState(
    () => matchMedia("(max-width:800px)").matches,
  );
  useEffect(() => {
    const media = matchMedia("(max-width:800px)"),
      change = () => setMobile(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = panel.current!;
    const main = document.querySelector<HTMLElement>(".main-column");
    if (mobile && main) main.inert = true;
    (el.querySelector("button") as HTMLButtonElement)?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      }
      if (mobile && e.key === "Tab") {
        const nodes = [
          ...el.querySelectorAll<HTMLElement>(
            'button:not([disabled]),a[href],summary,[tabindex="0"]',
          ),
        ];
        const first = nodes[0],
          last = nodes.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    el.addEventListener("keydown", key);
    return () => {
      el.removeEventListener("keydown", key);
      if (main) main.inert = false;
      previous?.focus();
    };
  }, [mobile]);
  const catalog = useResource<Paper[]>("papers");
  const info = paper ?? catalog.value?.find((p) => p.paper_id === paperId);
  return (
    <aside
      ref={panel}
      className="evidence-panel"
      role={mobile ? "dialog" : "complementary"}
      aria-modal={mobile || undefined}
      aria-label="原文与证据"
    >
      <header>
        <div>
          <h2>{source ? "原文片段" : "论文详情"}</h2>
        </div>
        <button
          className="icon-button"
          onClick={close}
          aria-label="关闭证据面板"
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="evidence-scroll">
        <h3>{info?.title ?? paperId}</h3>
        {source ? (
          <>
            <p className="source-location">
              {source.section ?? "原文"} · {source.chunk_id}
            </p>
            <blockquote>
              <Markdown text={source.text} />
            </blockquote>
            <details className="diagnostics">
              <summary>来源定位</summary>
              <dl className="key-values">
                <div>
                  <dt>论文</dt>
                  <dd>{source.paper_id}</dd>
                </div>
                <div>
                  <dt>片段</dt>
                  <dd>{source.chunk_id}</dd>
                </div>
                <div>
                  <dt>字符位置</dt>
                  <dd>
                    {source.start}–{source.end}
                  </dd>
                </div>
                <div>
                  <dt>索引版本</dt>
                  <dd>{source.index_version ?? "由关联任务固定"}</dd>
                </div>
              </dl>
            </details>
          </>
        ) : (
          <p className="abstract">{info?.abstract || "尚无摘要记录。"}</p>
        )}
        {info?.originalUrl && (
          <a
            className="button-link source-link"
            target="_blank"
            rel="noreferrer"
            href={info.originalUrl}
          >
            查看公开原文 <Icon name="arrow" size={15} />
          </a>
        )}
        <p className="help">
          私人全文请在本机阅读器中打开；这里展示已保存的研究依据。
        </p>
        {!!evidence.task?.researchEvidence?.length && (
          <>
            <h3 className="section-heading">本次引用</h3>
            <div className="source-list">
              {evidence.task.researchEvidence.map((s, i) => (
                <button
                  key={s.chunk_id}
                  className={source?.chunk_id === s.chunk_id ? "selected" : ""}
                  onClick={() => select(s)}
                >
                  <span>{i + 1}</span>
                  <div>
                    <strong>
                      {catalog.value?.find((p) => p.paper_id === s.paper_id)
                        ?.title ?? s.paper_id}
                    </strong>
                    <small>{s.text.slice(0, 100)}</small>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
function Workspace({
  account,
  logout,
  showCodes,
}: {
  account: Account;
  logout: () => Promise<void>;
  showCodes: (c: string[]) => void;
}) {
  const route = useRoute(),
    [revision, setRevision] = useState(0),
    [error, setError] = useState(""),
    [menu, setMenu] = useState(false),
    [evidence, setEvidence] = useState<Evidence>(),
    [connection, setConnection] = useState("connecting"),
    [search, setSearch] = useState("");
  const overview = useResource<Overview>("overview", revision),
    cursor = useRef(0),
    refresh = useCallback(() => setRevision((n) => n + 1), []);
  const data = overview.value;
  const conversations = useResource<{
    items: Overview["conversations"]["items"];
  }>(
    search.trim()
      ? "conversations?limit=50&q=" + encodeURIComponent(search)
      : undefined,
    revision,
  );
  const run: Run = async (action) => {
    setError("");
    window.dispatchEvent(new Event("operation-start"));
    try {
      await action();
    } catch (e) {
      const message = errorText(e);
      setError(message);
      window.dispatchEvent(
        new CustomEvent("operation-error", { detail: message }),
      );
    }
  };
  useEffect(() => {
    cursor.current = data?.cursor ?? 0;
  }, [data?.cursor]);
  useEffect(() => {
    setMenu(false);
    setEvidence(undefined);
  }, [route.page, route.id]);
  useEffect(() => {
    const theme = data?.settings.theme ?? "system";
    document.documentElement.dataset.theme = theme;
  }, [data?.settings.theme]);
  useEffect(() => {
    let done = false,
      ws: WebSocket | undefined,
      reconnect: ReturnType<typeof setTimeout>,
      update: ReturnType<typeof setTimeout> | undefined,
      delay = 1000;
    const changed = () => {
      if (!update)
        update = setTimeout(() => {
          update = undefined;
          refresh();
        }, 1000);
    };
    const connect = () => {
      if (done) return;
      setConnection("connecting");
      ws = new WebSocket(
        location.origin.replace(/^http/, "ws") + "/api/events?version=2",
      );
      ws.onopen = () => {
        if (done) return;
        delay = 1000;
        setConnection("online");
        void api("changes?after=" + cursor.current + "&limit=100")
          .then(changed)
          .catch(changed);
      };
      ws.onmessage = () => changed();
      ws.onerror = () => ws?.close();
      ws.onclose = () => {
        if (done) return;
        setConnection("offline");
        reconnect = setTimeout(connect, delay);
        delay = Math.min(30000, delay * 2);
      };
    };
    connect();
    const online = () => {
      clearTimeout(reconnect);
      if (ws?.readyState !== WebSocket.OPEN) connect();
    };
    addEventListener("online", online);
    return () => {
      done = true;
      clearTimeout(reconnect);
      clearTimeout(update);
      removeEventListener("online", online);
      ws?.close();
    };
  }, [refresh]);
  const items = search.trim()
    ? (conversations.value?.items ?? [])
    : (data?.conversations.items ?? []);
  const nav = (
    <>
      <div className="brand">
        <span className="brand-mark">
          <Icon name="memory" size={24} />
        </span>
        <div>
          <strong>{data?.settings.agentName ?? "Aster"}</strong>
          <span>个人科研助手</span>
        </div>
      </div>
      <button
        className="new-chat"
        onClick={() => {
          navigate("chat");
          setMenu(false);
        }}
      >
        <Icon name="plus" size={18} />
        开始新讨论
      </button>
      <nav aria-label="主导航">
        {navigation.map(([key, label]) => (
          <button
            key={key}
            aria-current={route.page === key ? "page" : undefined}
            onClick={() => navigate(key)}
          >
            <Icon name={key} size={19} />
            <span>{label}</span>
            {key === "inbox" && data?.notices.some((n) => !n.read) && (
              <i className="unread-dot" aria-label="有未读事项" />
            )}
          </button>
        ))}
      </nav>
      <div className="sidebar-history">
        <div className="sidebar-label">
          最近讨论
          <button
            className="text-button"
            onClick={() => navigate("conversations")}
          >
            全部
          </button>
        </div>
        <label className="sidebar-search">
          <Icon name="search" size={15} />
          <input
            aria-label="搜索会话"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索讨论"
          />
        </label>
        <div className="recent-list">
          {items.map((c) => (
            <button
              key={c.id}
              aria-current={
                route.page === "chat" && route.id === c.id ? "page" : undefined
              }
              onClick={() => navigate("chat", c.id)}
            >
              {c.pinned && <Icon name="star" size={13} />}
              <span>{c.title}</span>
            </button>
          ))}
          {!items.length && (
            <p className="sidebar-hint">
              {search ? "没有匹配的讨论" : "新的讨论会保存在这里"}
            </p>
          )}
        </div>
      </div>
      <div className="sidebar-bottom">
        <button
          aria-current={route.page === "settings" ? "page" : undefined}
          onClick={() => navigate("settings")}
        >
          <Icon name="settings" size={19} />
          <span>设置</span>
        </button>
        <div className="account-label">
          <span>{account.name.slice(0, 1)}</span>
          <div>
            <strong>{account.name}</strong>
            <small>
              {account.role === "owner" ? "个人工作区" : "受邀工作区"}
            </small>
          </div>
        </div>
      </div>
    </>
  );
  const props = data ? { data, revision, run, refresh } : undefined;
  const content = !data ? (
    overview.error ? (
      <div className="page">
        <p className="error" role="alert">
          {overview.error}
        </p>
        <button onClick={overview.reload}>重新连接</button>
      </div>
    ) : (
      <Loading />
    )
  ) : !data.settings.onboarded ? (
    <Onboarding data={data} run={run} refresh={refresh} showCodes={showCodes} />
  ) : route.page === "chat" ? (
    <Chat
      key={route.id ?? "new"}
      id={route.id}
      {...props!}
      onSource={(source, task) => setEvidence({ source, task })}
    />
  ) : route.page === "conversations" ? (
    <Conversations revision={revision} run={run} refresh={refresh} />
  ) : route.page === "projects" ? (
    <Projects key={route.id ?? "list"} id={route.id} {...props!} />
  ) : route.page === "papers" ? (
    <Library
      projectId={route.id}
      {...props!}
      onPaper={(paper) => setEvidence({ paper })}
    />
  ) : route.page === "tasks" ? (
    <Activity {...props!} />
  ) : route.page === "artifacts" ? (
    <ArtifactView
      key={route.id ?? "list"}
      id={route.id}
      {...props!}
      onSource={(source) => setEvidence({ source })}
    />
  ) : route.page === "inbox" ? (
    <Inbox {...props!} />
  ) : route.page === "memory" ? (
    <MemoryView key={route.id ?? "all"} projectId={route.id} {...props!} />
  ) : route.page === "settings" ? (
    <SettingsView
      {...props!}
      account={account}
      section={route.id}
      showCodes={showCodes}
      logout={logout}
    />
  ) : (
    <div className="page">
      <h1>页面不存在</h1>
      <button onClick={() => navigate("chat")}>回到讨论</button>
    </div>
  );
  return (
    <div className={"app-shell" + (evidence ? " has-evidence" : "")}>
      <a
        href="#workspace"
        className="skip-link"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("workspace")?.focus();
        }}
      >
        跳到主要内容
      </a>
      <aside className="sidebar">{nav}</aside>
      <div className="main-column">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            aria-label="打开导航"
            onClick={() => setMenu(true)}
          >
            <Icon name="menu" />
          </button>
          <span className="workspace-caption">研究工作区</span>
          <div className="topbar-status">
            <span
              className={
                "connection " + (deviceView(data).connected ? "connected" : "")
              }
            >
              <i />
              {deviceView(data).label}
            </span>
            {connection !== "online" && (
              <span className="sync-state" role="status">
                {connection === "connecting"
                  ? "连接中"
                  : "连接已断开，正在重连"}
              </span>
            )}
            {data?.model.mode === "mock" && (
              <span className="environment-label">模拟环境</span>
            )}
          </div>
        </header>
        {error && (
          <div className="error global-error" role="alert">
            <span>{error}</span>
            <button
              className="icon-button"
              onClick={() => setError("")}
              aria-label="关闭错误提示"
            >
              <Icon name="close" size={17} />
            </button>
          </div>
        )}
        <main
          id="workspace"
          tabIndex={-1}
          className={
            route.page === "chat" && data?.settings.onboarded
              ? "workspace chat-workspace"
              : "workspace"
          }
        >
          {content}
        </main>
      </div>
      {evidence && (
        <SourcePanel
          evidence={evidence}
          close={() => setEvidence(undefined)}
          select={(source) => setEvidence((v) => ({ ...v, source }))}
        />
      )}
      <Dialog title="研究工作区" open={menu} onClose={() => setMenu(false)}>
        <div className="mobile-navigation">{nav}</div>
      </Dialog>
    </div>
  );
}
function App() {
  const [auth, setAuth] = useState<AuthStatus>(),
    [error, setError] = useState(""),
    [codes, setCodes] = useState<string[]>([]),
    [acknowledged, setAcknowledged] = useState(false);
  const reload = useCallback(() => {
    setError("");
    void api<AuthStatus>("auth/status")
      .then(setAuth)
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    reload();
    const expired = () => {
      setAuth(undefined);
      setCodes([]);
      reload();
    };
    addEventListener("session-expired", expired);
    return () => removeEventListener("session-expired", expired);
  }, [reload]);
  const showCodes = (v: string[]) => {
    setAcknowledged(false);
    setCodes(v);
  };
  async function logout() {
    await api("auth/logout", "POST", {});
    setCodes([]);
    location.hash = "chat";
    reload();
  }
  return (
    <>
      {!auth ? (
        error ? (
          <main className="auth-screen">
            <p className="error">{error}</p>
            <button onClick={reload}>重新连接</button>
          </main>
        ) : (
          <Loading />
        )
      ) : !auth.account ? (
        <Auth
          status={auth}
          onSigned={(account, recovery) => {
            setAuth({ ...auth, account });
            if (recovery) showCodes(recovery);
          }}
        />
      ) : (
        <Workspace
          key={auth.account.id}
          account={auth.account}
          logout={logout}
          showCodes={showCodes}
        />
      )}
      <Dialog
        dismissible={acknowledged}
        open={codes.length > 0}
        onClose={() => {
          if (acknowledged) setCodes([]);
        }}
        title="保存你的恢复码"
      >
        <p>每个码只能使用一次。请保存在离线安全位置，关闭后不再显示。</p>
        <div className="recovery-codes">
          {codes.map((c) => (
            <code key={c}>{c}</code>
          ))}
        </div>
        <button
          onClick={() =>
            download("aster-recovery-codes.txt", codes.join("\n"), "text/plain")
          }
        >
          下载恢复码
        </button>
        <label className="check-label recovery-ack">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          我已妥善保存
        </label>
        <button
          className="primary"
          disabled={!acknowledged}
          onClick={() => setCodes([])}
        >
          继续
        </button>
      </Dialog>
    </>
  );
}
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main className="auth-screen">
        <h1>页面暂时无法显示</h1>
        <p>已保存的研究仍在服务端，可以重新加载页面。</p>
        <button onClick={() => location.reload()}>重新加载</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Boundary>
      <App />
    </Boundary>
  </StrictMode>,
);
