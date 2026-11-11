import {
  useEffect,
  useRef,
  useId,
  useState,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import type { Chunk, Task } from "./types.ts";
const paths: Record<string, ReactNode> = {
  chat: (
    <>
      <path d="M4 5h16v12H9l-5 4V5Z" />
      <path d="M8 9h8M8 13h5" />
    </>
  ),
  projects: (
    <>
      <path d="M3 6h7l2 2h9v12H3V6Z" />
      <path d="M3 6V4h7l2 2" />
    </>
  ),
  papers: (
    <>
      <path d="M5 3h10l4 4v14H5V3Z" />
      <path d="M14 3v5h5M8 12h8M8 16h6" />
    </>
  ),
  tasks: (
    <>
      <path d="m4 7 2 2 4-4M13 7h7M4 16l2 2 4-4M13 16h7" />
    </>
  ),
  artifacts: (
    <>
      <path d="M5 3h14v18H5zM8 7h8M8 11h8M8 15h5" />
    </>
  ),
  inbox: (
    <>
      <path d="m5 4-3 12v4h20v-4L19 4H5Z" />
      <path d="M2 16h6l2 3h4l2-3h6" />
    </>
  ),
  memory: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="m9 3 6 0 1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3Z" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="m15 15 5 5" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  send: (
    <>
      <path d="m4 11 16-7-7 16-2-7-7-2Z" />
      <path d="m11 13 9-9" />
    </>
  ),
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  check: <path d="m4 12 5 5L20 6" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
  desktop: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 21h8m-4-5v5" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="10" r="5" />
      <path d="m12 13 8 8m-3-3 3-3m-6 0 3-3" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  star: (
    <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9L12 3Z" />
  ),
};
export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.papers}
    </svg>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading" role="status" aria-label="正在加载">
      <div />
      <div />
      <div />
    </div>
  );
}
export function Dialog({
  open,
  onClose,
  title,
  children,
  wide = false,
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    titleId = useId();
  const [failure, setFailure] = useState("");
  useEffect(() => {
    const start = () => setFailure("");
    const failed = (event: Event) => {
      if (ref.current?.open) setFailure(String((event as CustomEvent).detail));
    };
    addEventListener("operation-start", start);
    addEventListener("operation-error", failed);
    return () => {
      removeEventListener("operation-start", start);
      removeEventListener("operation-error", failed);
    };
  }, []);
  useEffect(() => setFailure(""), [open]);
  useEffect(() => {
    const el = ref.current!;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={wide ? "dialog wide" : "dialog"}
      onCancel={(e) => {
        if (dismissible) onClose();
        else e.preventDefault();
      }}
      onClose={onClose}
    >
      <header>
        <h2 id={titleId}>{title}</h2>
        <button
          className="icon-button"
          onClick={onClose}
          disabled={!dismissible}
          aria-label="关闭"
        >
          <Icon name="close" />
        </button>
      </header>
      {failure && (
        <p className="error" role="alert">
          {failure}
        </p>
      )}
      {children}
    </dialog>
  );
}
let renderer: Promise<any> | undefined;
const noSources: Chunk[] = [];
export function Markdown({
  text,
  sources = noSources,
  onCitation,
}: {
  text: string;
  sources?: Chunk[];
  onCitation?: (s: Chunk) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    const url = "/markdown.js";
    renderer ??= import(/* @vite-ignore */ url);
    void renderer
      .then((module) => {
        if (!disposed && ref.current)
          module.renderMarkdown(ref.current, text, {
            sources,
            onCitation: (index: number) => {
              if (sources[index]) onCitation?.(sources[index]);
            },
          });
      })
      .catch(() => {
        if (!disposed && ref.current) ref.current.textContent = text;
      });
    return () => {
      disposed = true;
    };
  }, [text, sources, onCitation]);
  return <div className="markdown" ref={ref} />;
}
export const statusText: Record<string, string> = {
  queued: "排队中",
  running: "正在研究",
  waiting_device: "等待你的电脑上线",
  waiting_user: "等待你处理",
  completed: "已完成",
  failed: "未能完成",
  cancelled: "已取消",
  paused: "已暂停",
};
export function Status({ status }: { status: string }) {
  return (
    <span className={"status status-" + status}>
      <i />
      {statusText[status] ?? status}
    </span>
  );
}
let progressModule: Promise<any> | undefined;
export function TaskProgress({ task }: { task: Task }) {
  const button = useRef<HTMLButtonElement>(null),
    dialog = useRef<HTMLDialogElement>(null),
    content = useRef<HTMLDivElement>(null),
    panel = useRef<any>(null),
    latest = useRef(task);
  const titleId = useId();
  latest.current = task;
  const ready = Boolean(task.workflow?.progress?.items?.length);
  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    const url = "/task-progress.js";
    progressModule ??= import(/* @vite-ignore */ url);
    void progressModule.then((m) => {
      if (disposed || !button.current || !dialog.current || !content.current)
        return;
      panel.current = new m.TaskProgressPanel({
        button: button.current,
        dialog: dialog.current,
        content: content.current,
        papers: () => [],
        onPaper: null,
      });
      panel.current.update(latest.current.workflow?.progress);
    });
    return () => {
      disposed = true;
      panel.current?.destroy();
      panel.current = null;
    };
  }, [ready]);
  useEffect(() => {
    panel.current?.update(task.workflow?.progress);
  }, [task.workflow?.progress]);
  if (!ready) return null;
  return (
    <div className="task-progress">
      <button ref={button}>查看逐项进度</button>
      <dialog className="dialog wide" ref={dialog} aria-labelledby={titleId}>
        <header>
          <h2 id={titleId}>研究进度与依据</h2>
          <button
            className="icon-button"
            aria-label="关闭任务进度"
            onClick={() => dialog.current?.close()}
          >
            <Icon name="close" />
          </button>
        </header>
        <div ref={content} />
      </dialog>
    </div>
  );
}
export function date(value: number | string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {isValidElement(children)
        ? cloneElement(children as ReactElement<any>, {
            id,
            "aria-describedby": hint ? id + "-hint" : undefined,
          })
        : children}
      {hint && <small id={id + "-hint"}>{hint}</small>}
    </div>
  );
}

export function Pager({
  page,
}: {
  page: {
    value?: { nextCursor: string | number | null };
    hasPrevious: boolean;
    pageNumber: number;
    previous: () => void;
    next: () => void;
  };
}) {
  return page.hasPrevious || page.value?.nextCursor != null ? (
    <nav className="pager" aria-label="列表分页">
      <button disabled={!page.hasPrevious} onClick={page.previous}>
        上一页
      </button>
      <span>第 {page.pageNumber} 页</span>
      <button disabled={page.value?.nextCursor == null} onClick={page.next}>
        下一页
      </button>
    </nav>
  ) : null;
}
