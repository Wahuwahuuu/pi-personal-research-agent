import { isAbsolute } from "node:path";
import {
  PythonWorkerClient,
  type SearchParams,
  type RetrieveParams,
} from "../packages/research/transport.ts";
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
/** Restricted facade over AsterCite's existing JSONL transport. Model loading is readiness, not tool execution. */
export class PythonBridge {
  config: PythonConfig;
  private client?: PythonWorkerClient;
  private pending = false;
  constructor(config: PythonConfig) {
    this.config = config;
    for (const p of [
      config.executable,
      config.worker,
      config.corpus,
      config.index,
      config.models,
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
        ? ["query", "limit"]
        : ["query", "paper_ids", "top_k", "offset"];
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
  stop() {
    const client = this.client;
    this.client = undefined;
    client?.close();
  }
}
