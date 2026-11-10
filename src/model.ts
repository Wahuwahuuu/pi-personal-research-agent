import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import {
  createAssistantMessageEventStream,
  getCurrentTools,
  type AssistantMessage,
  type ToolCall,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
export const MODEL = { provider: "pra", id: "deterministic-v1" };
export function mockModels(
  before: () => void,
  after: (input: number, output: number) => void,
) {
  const stream: ProviderStreams["stream"] = (model, context) => {
    const events = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    queueMicrotask(() => {
      try {
        before();
        const source = JSON.stringify(context.messages);
        const input = Math.ceil(new TextEncoder().encode(source).length / 3);
        const names = getCurrentTools(context.messages).map((t) => t.name);
        const research = names.includes("search_papers");
        const users=context.messages.filter((m:any)=>m.role==="user");
        const latest=users.at(-1) as any;
        const raw=typeof latest?.content==="string"?latest.content:latest?.content?.filter((c:any)=>c.type==="text").map((c:any)=>c.text).join("\n");
        let frame:any;try{frame=JSON.parse(raw??"");}catch{}
        const current = frame?.stage ? JSON.stringify(frame.observations??{}) : source;
        const hasSearch =
          current.includes('"papers"') || current.includes('\\\"papers\\\"');
        const hasChunks =
          current.includes('"chunks"') || current.includes('\\\"chunks\\\"');
        if (research && !hasChunks) {
          const name = hasSearch ? "retrieve_chunks" : "search_papers";
          const call: ToolCall = {
            type: "toolCall",
            id: "deterministic-" + (hasSearch ? "retrieve" : "search"),
            name,
            arguments: hasSearch
              ? { query: "evidence", paper_ids: ["fixture-paper"], top_k: 1 }
              : { query: "research", limit: 3 },
          };
          message.content = [call];
          message.stopReason = "toolUse";
          message.usage.input = input;
          message.usage.output = 40;
          message.usage.totalTokens = input + 40;
          events.push({ type: "start", partial: message });
          events.push({
            type: "toolcall_start",
            contentIndex: 0,
            partial: message,
          });
          events.push({
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: call,
            partial: message,
          });
          after(input, 40);
          events.push({ type: "done", reason: "toolUse", message });
          events.end(message);
          return;
        }
        let content =
          "[模拟模型验证输出，不是科研结论]\n" +
          (source.includes("chunks")
            ? "已收到本地证据 [cite:fixture-chunk]；请查看任务的 evidence 字段核对片段与出处。"
            : "云端 PiHarness 已完成持久化模型轮次。");
        if (research || frame?.stage==="agent")
          content = JSON.stringify({
            execution: {
              state: "complete",
              remaining_needs: [],
              needs_sources: true,
            },
            answer: content,
          });
        if(frame?.stage==="translation")content=JSON.stringify({translations:frame.excerpts.map((s:any)=>({chunk_id:s.chunk_id,text:"[模拟翻译] "+s.text}))});
        if(frame?.stage==="prepare")content=JSON.stringify({intent:"answer",targets:[],rewrite:frame.request,queries:[],constraints:[]});
        if(frame?.stage==="completion")content=JSON.stringify({state:"complete",remaining_needs:[],needs_sources:true});
        if(frame?.stage==="comparison")content=JSON.stringify({cells:frame.workspace.cells.map((c:any)=>({...c,status:"missing",summary:"Mock has not semantically verified the evidence",citations:[]}))});
        message.usage.input = input;
        message.usage.output = 40;
        message.usage.totalTokens = input + 40;
        events.push({ type: "start", partial: message });
        message.content = [{ type: "text", text: "" }];
        events.push({ type: "text_start", contentIndex: 0, partial: message });
        message.content[0] = { type: "text", text: content };
        events.push({
          type: "text_delta",
          contentIndex: 0,
          delta: content,
          partial: message,
        });
        events.push({
          type: "text_end",
          contentIndex: 0,
          content,
          partial: message,
        });
        after(input, 40);
        events.push({ type: "done", reason: "stop", message });
        events.end(message);
      } catch {
        message.stopReason = "error";
        message.errorMessage = "MODEL_ADMISSION_DENIED";
        events.push({ type: "error", reason: "error", error: message });
        events.end(message);
      }
    });
    return events;
  };
  const models = createModels();
  models.setProvider(
    createProvider({
      id: MODEL.provider,
      auth: {
        apiKey: {
          name: "Deterministic provider (no credentials)",
          resolve: async () => ({ auth: {} }),
        },
      },
      models: [
        {
          ...MODEL,
          name: "Deterministic validation provider",
          api: "openai-completions",
          baseUrl: "https://invalid.example",
          input: ["text"],
          reasoning: false,
          contextWindow: 32768,
          maxTokens: 2048,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      api: { stream, streamSimple: stream },
    }),
  );
  return models;
}
