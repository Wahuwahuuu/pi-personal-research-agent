import {useState} from "react";
import {date, Field, Icon, Loading, Pager, Status} from "./components.tsx";
import {navigate, usePaged} from "./hooks.ts";
import {MemoryEvidence, memorySourceLabel} from "./MemoryEvidence.tsx";
import type {Artifact, Memory, Task} from "./types.ts";

const labels = {tasks:"任务", artifacts:"研究成果", conclusion:"研究结论", question:"未解决问题"} as const;
type Kind = keyof typeof labels;

function ProjectRecordList({projectId, revision}: {projectId:string; revision:number}) {
  const [kind, setKind] = useState<Kind>("tasks");
  const scope = "project=" + encodeURIComponent(projectId) + "&limit=10";
  const tasks = usePaged<Task>(kind === "tasks" ? "tasks?" + scope : undefined, revision, "before");
  const artifacts = usePaged<Artifact>(kind === "artifacts" ? "artifacts?" + scope : undefined, revision);
  const memories = usePaged<Memory>(
    kind === "conclusion" || kind === "question" ? "memories?scope=project&category=" + kind + "&" + scope : undefined,
    revision,
  );
  const page = kind === "tasks" ? tasks : kind === "artifacts" ? artifacts : memories;
  return (
    <>
      <Field label="查看项目记录">
        <select value={kind} onChange={e => setKind(e.target.value as Kind)}>
          {Object.entries(labels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </Field>
      {page.error ? (
        <div role="alert" className="error">{page.error} <button onClick={page.reload}>重试</button></div>
      ) : !page.value ? <Loading /> : !page.value.items.length ? (
        <p className="help">本项目暂无{labels[kind]}。</p>
      ) : (
        <div className="list">
          {kind === "tasks" && tasks.value?.items.map(t => (
            <button key={t.id} className="list-row" onClick={() => navigate("chat", t.conversationId, t.id)}>
              <span className="grow"><strong>{t.input}</strong><small>{date(t.created)}</small></span>
              <Status status={t.status}/><Icon name="chevron" />
            </button>
          ))}
          {kind === "artifacts" && artifacts.value?.items.map(a => (
            <button key={a.id} className="list-row" onClick={() => navigate("artifacts", a.id)}>
              <Icon name="artifacts" /><span className="grow"><strong>{a.title}</strong>
                <small>第 {a.version} 版 · {date(a.updated)}{a.partial ? " · 部分完成" : ""}</small>
              </span><Icon name="chevron" />
            </button>
          ))}
          {(kind === "conclusion" || kind === "question") && memories.value?.items.map(m => (
            <article className="project-memory" key={m.id}>
              <p>{m.content}</p>
              <small>{[date(m.updated_at), m.edited ? "已人工修订" : "", memorySourceLabel(m)].filter(Boolean).join(" · ")}</small>
              <MemoryEvidence memory={m} />
              {m.source_session && <button className="text-button" onClick={() => navigate("chat", m.source_session, m.source_turn)}>查看来源讨论</button>}
            </article>
          ))}
        </div>
      )}
      <Pager page={page}/>
      {(kind === "conclusion" || kind === "question") && <button className="text-button" onClick={() => navigate("memory",projectId)}>管理项目记忆</button>}
    </>
  );
}

export function ProjectResearchRecords({projectId, revision}: {projectId:string; revision:number}) {
  const [open, setOpen] = useState(false);
  return (
    <details className="project-records" onToggle={e => setOpen(e.currentTarget.open)}>
      <summary>任务、成果与研究记录</summary>
      {open && <ProjectRecordList projectId={projectId} revision={revision} />}
    </details>
  );
}
