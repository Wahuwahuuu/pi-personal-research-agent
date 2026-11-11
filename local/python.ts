import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PythonWorkerClient,
  type SearchParams,
  type RetrieveParams,
  type ScientificParams,
} from "../packages/research/transport.ts";
import type { Tool } from "../src/domain.ts";
export interface PythonConfig {
  executable: string;
  worker?: string;
  corpus: string;
  index?: string;
  models?: string;
  profile?: string;
  device?: "cpu" | "cuda";
  indexVersion: string;
  scientificCacheDir?: string;
}
/** Restricted facade over AsterCite's existing JSONL transport. Model loading is readiness, not tool execution. */
export class PythonBridge {
  config: PythonConfig & {worker:string};
  private client?: PythonWorkerClient;
  private pending = false;
  constructor(config: PythonConfig) {
    this.config = {...config,worker:config.worker ?? fileURLToPath(new URL("../packages/retrieval/retriever/worker.py",import.meta.url))};
    for (const p of [
      config.executable,
      config.worker,
      config.corpus,
      config.index,
      config.models,
      config.scientificCacheDir,
    ].filter(Boolean))
      if (!isAbsolute(p!)) throw Error("ABSOLUTE_LOCAL_PATH_REQUIRED");
  }
  private getClient() {
    const c = this.config;
    return (this.client ??= new PythonWorkerClient({
      pythonPath: c.executable,
      workerPath: c.worker,
      corpusDir: c.corpus,
      indexDir: c.index,
      modelsDir: c.models,
      profile: c.index ? (c.profile ?? "rrf_rerank") : undefined,
      device: c.index ? (c.device ?? "cpu") : undefined,
      expectReady: !!c.index,
      readyTimeoutMs: 180000,
      timeoutMs: 180000,
      maxFrameBytes: 1500000,
      scientificCacheDir: c.scientificCacheDir,
    }));
  }
  async ready() {
    const client = this.getClient();
    try {
      const event = await client.ready();
      if (event && event.index_version !== this.config.indexVersion)
        throw Error("INDEX_CHANGED");
    } catch (e) {
      if (this.client === client) this.stop();
      throw e;
    }
  }
  async request(
    tool: Tool,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    if (this.pending) throw Error("RETRIEVER_BUSY");
    if (!["search_papers", "retrieve_chunks"].includes(tool))
      throw Error("TOOL_DENIED");
    if (
      typeof params.query !== "string" ||
      !params.query.trim() ||
      Array.from(params.query).length > 1000
    )
      throw Error("INVALID_QUERY");
    const allowed =
      tool === "search_papers"
        ? ["query", "limit", "allowed_paper_ids"]
        : [
            "query",
            "paper_ids",
            "top_k",
            "offset",
            "reading_mode",
            "allowed_paper_ids",
          ];
    if (Object.keys(params).some((k) => !allowed.includes(k)))
      throw Error("PARAMETER_DENIED");
    signal.throwIfAborted();
    this.pending = true;
    const abort = () => this.stop();
    signal.addEventListener("abort", abort, { once: true });
    try {
      await this.ready();
      signal.throwIfAborted();
      const request =
        tool === "retrieve_chunks"
          ? {
              ...params,
              reading_mode: "workbench-v1",
              offset: params.offset ?? 0,
            }
          : params;
      return await this.client!.request(
        tool,
        request as unknown as SearchParams | RetrieveParams,
        signal,
      );
    } finally {
      signal.removeEventListener("abort", abort);
      this.pending = false;
    }
  }
  async readScientificSources(params: ScientificParams, signal?: AbortSignal) {
    if (this.pending) throw Error("RETRIEVER_BUSY");
    this.pending = true;
    const abort = () => this.stop();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      await this.ready();
      signal?.throwIfAborted();
      return await this.client!.readScientificSources(params, signal);
    } finally {
      this.pending = false;
      signal?.removeEventListener("abort", abort);
    }
  }
  async close() {
    const client=this.client;
    this.stop();
    await client?.whenClosed();
  }
  stop() {
    const client = this.client;
    this.client = undefined;
    client?.close();
  }
}
