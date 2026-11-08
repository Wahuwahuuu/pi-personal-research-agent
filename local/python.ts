import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import type { Tool } from "../src/domain.ts";
export interface PythonConfig {
  executable: string;
  worker: string;
  corpus: string;
  index?: string;
  models?: string;
  profile?: string;
  device?: "cpu" | "cuda";
  indexVersion: string;
}
export class PythonBridge {
  private process?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private pending?: {
    id: string;
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
  };
  config: PythonConfig;
  constructor(config: PythonConfig) {
    this.config = config;
    for (const p of [
      config.executable,
      config.worker,
      config.corpus,
      config.index,
      config.models,
    ].filter(Boolean))
      if (!isAbsolute(p!)) throw new Error("ABSOLUTE_LOCAL_PATH_REQUIRED");
  }
  private launch() {
    const c = this.config;
    const args = [
      c.worker,
      "--corpus-dir",
      c.corpus,
      ...(c.index
        ? [
            "--index-dir",
            c.index,
            "--models-dir",
            c.models!,
            "--profile",
            c.profile ?? "rrf_rerank",
            "--device",
            c.device ?? "cpu",
          ]
        : []),
    ];
    const env: NodeJS.ProcessEnv = {
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONDONTWRITEBYTECODE: "1",
      OMP_NUM_THREADS: "4",
      MKL_NUM_THREADS: "4",
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
    };
    for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP"])
      if (process.env[key]) env[key] = process.env[key];
    const child = spawn(c.executable, args, {
      shell: false,
      windowsHide: true,
      env,
      stdio: "pipe",
    });
    this.process = child;
    this.buffer = "";
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (part: string) => {
      if (this.process !== child) return;
      this.buffer += part;
      if (this.buffer.length > 1500000) {
        this.stop();
        return;
      }
      let at;
      while ((at = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        try {
          const r = JSON.parse(line);
          if (r.type === "ready") {
            if (r.index_version !== c.indexVersion) this.stop();
            continue;
          }
          if (r.request_id === this.pending?.id) {
            const p = this.pending!;
            this.pending = undefined;
            r.error
              ? p.reject(new Error("RETRIEVER_ERROR"))
              : p.resolve(r.result);
          }
        } catch {
          this.stop();
        }
      }
    });
    child.on("error", () => this.stop());
    child.on("exit", () => {
      if (this.process === child) this.stop();
    });
    child.stdin.on("error", () => this.stop());
  }
  request(tool: Tool, params: Record<string, unknown>, signal: AbortSignal) {
    if (this.pending) throw new Error("RETRIEVER_BUSY");
    if (!["search_papers", "retrieve_chunks"].includes(tool))
      throw new Error("TOOL_DENIED");
    if (typeof params.query !== "string" || params.query.length > 1000)
      throw new Error("INVALID_QUERY");
    const allowed =
      tool === "search_papers"
        ? ["query", "limit"]
        : ["query", "paper_ids", "top_k"];
    if (Object.keys(params).some((k) => !allowed.includes(k)))
      throw new Error("PARAMETER_DENIED");
    if (!this.process) this.launch();
    return new Promise<unknown>((resolve, reject) => {
      const id = crypto.randomUUID();
      const abort = () => this.stop();
      const finish = (fn: (v: any) => void, v: unknown) => {
        signal.removeEventListener("abort", abort);
        fn(v);
      };
      this.pending = {
        id,
        resolve: (v) => finish(resolve, v),
        reject: (e) => finish(reject, e),
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      this.process!.stdin.write(
        JSON.stringify({ version: 1, request_id: id, method: tool, params }) +
          "\n",
      );
    });
  }
  stop() {
    const p = this.pending;
    this.pending = undefined;
    const child = this.process;
    this.process = undefined;
    child?.kill();
    p?.reject(new Error("RETRIEVER_STOPPED"));
  }
}
