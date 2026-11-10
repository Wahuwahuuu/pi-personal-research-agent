import {modelResponse} from "./model-response.ts";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import {
  createAssistantMessageEventStream,
  getCurrentTools,
  getCurrentSystemPrompt,
  type ToolCall,
  type AssistantMessage,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
export interface LiveConfig {
  authorized: string;
  apiKey: string;
  baseUrl: string;
  modelId: string;
  maxOutput?:()=>number;
  onVisible?:(text:string)=>void;
  onFailure?:(code:string)=>void;
}
/** Only visible text crosses this adapter into Pi persistence. Provider-native reasoning is never forwarded. */
export function liveModels(
  config: LiveConfig,
  before: () => void,
  after: (usage?: { input: number; output: number }) => void,
  fetcher: typeof fetch = fetch,
) {
  if (
    config.authorized !== "explicitly-authorized" ||
    !config.apiKey ||
    !config.modelId
  )
    throw new Error("PAID_CALLS_DISABLED");
  const endpoint = new URL(
    config.baseUrl.replace(/\/$/, "") + "/chat/completions",
  );
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password)
    throw new Error("HTTPS_MODEL_ENDPOINT_REQUIRED");
  const stream: ProviderStreams["stream"] = (model, context, options) => {
    const events = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "pra",
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
    void (async () => {
      let admitted = false,
        settled = false;
      try {
        const tools = getCurrentTools(context.messages);
        const system=getCurrentSystemPrompt(context.messages);
        const messages = context.messages.filter(m=>m.role!=="system").map((m) => {
          const content = typeof m.content === "string" ? m.content :
            m.content.filter(c => c.type === "text").map(c => c.text).join("\n");
          if (m.role === "toolResult") return {role:"tool",tool_call_id:m.toolCallId,content};
          if (m.role === "assistant") {
            const calls=m.content.filter(c=>c.type==="toolCall").map(c=>({
              id:c.id,type:"function",function:{name:c.name,arguments:JSON.stringify(c.arguments)}
            }));
            return {role:"assistant",content:content||null,...(calls.length?{tool_calls:calls}:{})};
          }
          return {role:m.role,content};
        });
        if(system)messages.unshift({role:"system",content:system});
        const declarations=tools.map(t=>({type:"function",function:{name:t.name,description:t.description,parameters:t.parameters}}));
        if (new TextEncoder().encode(JSON.stringify({messages,tools:declarations})).length > 48000)
          throw new Error("CONTEXT_LIMIT");
        before();
        admitted = true;
        const response = await fetcher(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + config.apiKey,
          },
          body: JSON.stringify({
            model: config.modelId,
            messages,
            ...(declarations.length ? {tools:declarations,tool_choice:"auto"} : {}),
            max_tokens: config.maxOutput?.() ?? 2048,
            stream: true,
            stream_options: {include_usage:true},
            ...(config.modelId.startsWith("qwen")
              ? { enable_thinking: false, preserve_thinking: false }
              : {}),
          }),
          signal: options?.signal
            ? AbortSignal.any([options.signal, AbortSignal.timeout(90000)])
            : AbortSignal.timeout(90000),
        });
        if (!response.ok) throw new Error("MODEL_HTTP_ERROR");
        let started=false,visible="";
        const pushText=(delta:string)=>{
          if(!started){events.push({type:"start",partial:message});message.content=[{type:"text",text:""}];events.push({type:"text_start",contentIndex:0,partial:message});started=true;}
          visible+=delta;message.content=[{type:"text",text:visible}];
          events.push({type:"text_delta",contentIndex:0,delta,partial:message});config.onVisible?.(visible);
        };
        const data=await modelResponse(response,config.apiKey,pushText);
        const rawMessage = data.choices?.[0]?.message;
        const content = rawMessage?.content ?? "";
        const rawCalls = rawMessage?.tool_calls ?? [];
        if (!Array.isArray(rawCalls) || rawCalls.length > 10) throw new Error("INVALID_TOOLS");
        const callIds=new Set<string>();
        const calls:ToolCall[]=rawCalls.map((call: any) => {
          if (call.type!=="function" || typeof call.id!=="string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(call.id) ||
              callIds.has(call.id) || !tools.some(t=>t.name===call.function?.name) || typeof call.function?.arguments!=="string")
            throw new Error("INVALID_TOOL_CALL");
          callIds.add(call.id);
          const args=JSON.parse(call.function.arguments);
          if (!args || Array.isArray(args) || typeof args!=="object") throw new Error("INVALID_ARGUMENTS");
          return {type:"toolCall",id:call.id,name:call.function.name,arguments:args};
        });
        const input = data.usage?.prompt_tokens,
          output = data.usage?.completion_tokens;
        const usage =
          Number.isSafeInteger(input) &&
          input >= 0 &&
          Number.isSafeInteger(output) &&
          output >= 0
            ? { input, output }
            : undefined;
        after(usage);
        settled = true;
        if (
          typeof content !== "string" ||
          (!content.trim() && !calls.length) ||
          /<\/?(?:think|thinking|analysis)>/i.test(content) ||
          JSON.stringify({content,calls}).includes(config.apiKey) ||
          /<\/?(?:think|thinking|analysis)>/i.test(JSON.stringify(calls))
        )
          throw new Error("UNSAFE_OR_UNSUPPORTED_RESPONSE");
        message.usage.input = usage?.input ?? 52000;
        message.usage.output = usage?.output ?? config.maxOutput?.() ?? 2048;
        message.usage.totalTokens = message.usage.input + message.usage.output;
        if(!started)pushText(content);
        events.push({
          type: "text_end",
          contentIndex: 0,
          content,
          partial: message,
        });
        for (const call of calls) {
          const contentIndex=message.content.length;
          message.content.push(call);
          events.push({type:"toolcall_start",contentIndex,partial:message});
          events.push({type:"toolcall_end",contentIndex,toolCall:call,partial:message});
        }
        message.stopReason=data.choices?.[0]?.finish_reason==="length"?"length":calls.length?"toolUse":"stop";
        events.push({ type: "done", reason: message.stopReason, message });
        events.end(message);
      } catch (error) {
        const known=new Set(["CONTEXT_LIMIT","MODEL_HTTP_ERROR","EMPTY_RESPONSE","RESPONSE_TOO_LARGE","INVALID_TOOLS","INVALID_TOOL_CALL","INVALID_ARGUMENTS","UNSAFE_OR_UNSUPPORTED_RESPONSE","UNSAFE_RESPONSE","INVALID_CONTENT","INCOMPLETE_STREAM"]);
        const code=error instanceof Error&&known.has(error.message)?error.message:"MODEL_REQUEST_FAILED";
        config.onFailure?.(code);
        if (admitted && !settled) after();
        message.stopReason = options?.signal?.aborted ? "aborted" : "error";
        message.errorMessage = "MODEL_REQUEST_FAILED";
        events.push({
          type: "error",
          reason: message.stopReason,
          error: message,
        });
        events.end(message);
      }
    })();
    return events;
  };
  const models = createModels();
  models.setProvider(
    createProvider({
      id: "pra",
      auth: {
        apiKey: { name: "Runtime secret", resolve: async () => ({ auth: {} }) },
      },
      models: [
        {
          id: config.modelId,
          provider: "pra",
          name: config.modelId,
          api: "openai-completions",
          baseUrl: config.baseUrl,
          input: ["text"],
          reasoning: false,
          contextWindow: 65536,
          maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      api: { stream, streamSimple: stream },
    }),
  );
  return models;
}
