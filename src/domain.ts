export type Status =
  | "queued"
  | "running"
  | "waiting_device"
  | "waiting_user"
  | "completed"
  | "failed"
  | "cancelled";
export type Tool = "search_papers" | "retrieve_chunks";
export interface Task {
  id: string;
  requestId: string;
  input: string;
  kind: "chat" | "research";
  status: Status;
  created: number;
  updated: number;
  calls: number;
  tools: number;
  activeMs: number;
  answer?: string;
  error?: string;
  evidence?: unknown;
  operationId?: string;
  sessionId?: string;
  modelOperation?: string;
  modelStarted?: number;
  modelPrompt?: string;
  modelAdmitted?: boolean;
}
export interface Operation {
  id: string;
  taskId: string;
  tool: Tool;
  params: Record<string, unknown>;
  indexVersion: string;
  state: "pending" | "sent" | "done" | "cancelled";
  deadline: number;
  result?: unknown;
}
export interface Memory {
  id: string;
  content: string;
  source: string;
  updated: number;
}
export interface Notice {
  id: string;
  text: string;
  read: boolean;
  created: number;
}
export interface Plan {
  id: string;
  query: string;
  enabled: boolean;
  cursor: number;
  next: number;
  batch?: { from: number; until: number; offset: number; count: number };
}
export interface State {
  tasks: Task[];
  operations: Operation[];
  memories: Memory[];
  notices: Notice[];
  plans: Plan[];
  papers: Record<string, Paper>;
  usage: {
    requests: number;
    input: number;
    output: number;
    reservedInput: number;
    reservedOutput: number;
  };
}
export interface Paper {
  id: string;
  version: string;
  title: string;
  summary: string;
  published: string;
  updated: string;
  url: string;
}
export const initialState = (): State => ({
  tasks: [],
  operations: [],
  memories: [],
  notices: [],
  plans: [],
  papers: {},
  usage: {
    requests: 0,
    input: 0,
    output: 0,
    reservedInput: 0,
    reservedOutput: 0,
  },
});
export class Problem extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export const text = (v: unknown, max = 12000) => {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw new Problem("INVALID_TEXT");
  return v.trim();
};
export function submit(
  s: State,
  input: unknown,
  requestId: unknown,
  kind: unknown,
  now = Date.now(),
): Task {
  const key = text(requestId, 128),
    prompt = text(input);
  if (kind !== "chat" && kind !== "research") throw new Problem("INVALID_KIND");
  const old = s.tasks.find((t) => t.requestId === key);
  if (old) {
    if (old.input !== prompt || old.kind !== kind)
      throw new Problem("REQUEST_CONFLICT", 409);
    return old;
  }
  if (s.tasks.length >= 5000) throw new Problem("CAPACITY", 429);
  const t: Task = {
    id: crypto.randomUUID(),
    requestId: key,
    input: prompt,
    kind,
    status: "queued",
    created: now,
    updated: now,
    calls: 0,
    tools: 0,
    activeMs: 0,
  };
  s.tasks.push(t);
  return t;
}
export function cancel(s: State, id: string, now = Date.now()) {
  const t = getTask(s, id);
  if (["completed", "failed", "cancelled"].includes(t.status)) return;
  t.status = "cancelled";
  t.updated = now;
  for (const op of s.operations.filter(
    (o) => o.taskId === id && o.state !== "done",
  ))
    op.state = "cancelled";
}
export function getTask(s: State, id: string) {
  const t = s.tasks.find((t) => t.id === id);
  if (!t) throw new Problem("NOT_FOUND", 404);
  return t;
}
export function operation(
  s: State,
  t: Task,
  indexVersion: string,
  tool: Tool,
  params: Record<string, unknown>,
): Operation {
  const prior = s.operations.find(
    (o) => o.id === t.operationId && o.state !== "cancelled",
  );
  if (prior) return prior;
  if (t.tools >= 10) throw new Problem("TOOL_BUDGET", 429);
  const op: Operation = {
    id: crypto.randomUUID(),
    taskId: t.id,
    tool,
    params,
    indexVersion,
    state: "pending",
    deadline: 0,
  };
  t.tools++;
  t.operationId = op.id;
  s.operations.push(op);
  return op;
}
export function acceptResult(
  s: State,
  id: string,
  indexVersion: string,
  result: unknown,
  now = Date.now(),
  executionMs = 0,
): "accepted" | "duplicate" | "discarded" {
  const op = s.operations.find((o) => o.id === id);
  if (!op) throw new Problem("UNKNOWN_OPERATION", 404);
  const t = getTask(s, op.taskId);
  if (
    op.state === "cancelled" ||
    t.status === "cancelled" ||
    t.status === "failed"
  )
    return "discarded";
  if (op.state === "done") return "duplicate";
  if (indexVersion !== op.indexVersion) throw new Problem("INDEX_CHANGED", 409);
  validateEvidence(op.tool, result, indexVersion);
  if (!Number.isFinite(executionMs) || executionMs < 0 || executionMs > 180000)
    throw new Problem("INVALID_EXECUTION_TIME");
  t.activeMs += executionMs;
  op.result = result;
  op.state = "done";
  t.evidence = result;
  t.status = "queued";
  t.updated = now;
  return "accepted";
}
export function validateEvidence(tool: Tool, value: unknown, version: string) {
  if (!value || typeof value !== "object") throw new Problem("INVALID_RESULT");
  const r = value as Record<string, unknown>;
  if (r.index_version !== version) throw new Problem("INDEX_CHANGED", 409);
  if (tool === "search_papers") {
    if (!Array.isArray(r.papers) || r.papers.length > 10)
      throw new Problem("INVALID_PAPERS");
    for (const p of r.papers) {
      text(p.paper_id, 256);
      text(p.title, 2000);
    }
    return;
  }
  if (!Array.isArray(r.chunks) || r.chunks.length > 20)
    throw new Problem("INVALID_CHUNKS");
  for (const c of r.chunks) {
    text(c.paper_id, 256);
    text(c.chunk_id, 512);
    text(c.text, 20000);
    if (
      !Number.isInteger(c.start) ||
      !Number.isInteger(c.end) ||
      c.start < 0 ||
      c.end - c.start !== Array.from(c.text).length
    )
      throw new Problem("INVALID_CITATION_RANGE");
  }
}
export function expire(s: State, now = Date.now()) {
  for (const op of s.operations) {
    if (op.state === "sent" && op.deadline <= now) {
      op.state = "pending";
      const t = getTask(s, op.taskId);
      if (!["cancelled", "failed", "completed"].includes(t.status))
        t.status = "waiting_device";
    }
  }
}
export function reserve(s: State, t: Task, input: number, output: number) {
  if (
    t.calls >= 6 ||
    t.activeMs >= 180000 ||
    s.usage.requests >= 500 ||
    s.usage.input + s.usage.reservedInput + input > 6000000 ||
    s.usage.output + s.usage.reservedOutput + output > 1000000
  )
    throw new Problem("MODEL_BUDGET", 429);
  t.calls++;
  s.usage.requests++;
  s.usage.reservedInput += input;
  s.usage.reservedOutput += output;
}
export function settle(
  s: State,
  reservedInput: number,
  reservedOutput: number,
  usage?: { input: number; output: number },
) {
  s.usage.reservedInput -= reservedInput;
  s.usage.reservedOutput -= reservedOutput;
  // Missing usage is conservatively charged at the full reservation.
  s.usage.input += usage?.input ?? reservedInput;
  s.usage.output += usage?.output ?? reservedOutput;
}
export function memory(
  s: State,
  id: string | undefined,
  content: unknown,
  source: unknown,
) {
  const value = text(content, 1200),
    provenance = text(source, 256);
  const found = id ? s.memories.find((m) => m.id === id) : undefined;
  if (id && !found) throw new Problem("NOT_FOUND", 404);
  if (found) {
    found.content = value;
    found.source = provenance;
    found.updated = Date.now();
    return found;
  }
  const m = {
    id: crypto.randomUUID(),
    content: value,
    source: provenance,
    updated: Date.now(),
  };
  s.memories.push(m);
  return m;
}
export function notice(s: State, id: string, value: string) {
  const old = s.notices.find((n) => n.id === id);
  if (old) {
    old.text = value;
    return old;
  }
  const n = { id, text: value, read: false, created: Date.now() };
  s.notices.push(n);
  return n;
}
export function startBatch(p: Plan, now = Date.now()) {
  return (p.batch ??= {
    from: Math.max(0, p.cursor - 7 * 86400000),
    until: now,
    offset: 0,
    count: 0,
  });
}
export function commitPage(
  s: State,
  p: Plan,
  rows: Paper[],
  complete: boolean,
  now = Date.now(),
) {
  const b = p.batch;
  if (!b) throw new Problem("NO_BATCH");
  for (const row of rows) {
    const key = row.id + "@" + row.version;
    if (!s.papers[key]) {
      s.papers[key] = row;
      b.count++;
    }
  }
  b.offset += rows.length;
  if (complete) {
    if (b.count)
      notice(
        s,
        "discovery:" + p.id + ":" + b.until,
        `主题「${p.query}」发现 ${b.count} 条新版本记录。全文下载、索引及语义筛选尚待本地处理。`,
      );
    p.cursor = b.until;
    p.next = nextShanghaiMorning(now);
    delete p.batch;
  }
}
export function nextShanghaiMorning(now: number) {
  const d = new Date(now + 8 * 3600000);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 1);
  return next > now ? next : next + 86400000;
}
