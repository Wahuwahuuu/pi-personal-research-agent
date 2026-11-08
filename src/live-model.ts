import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
export interface LiveConfig {
  authorized: string;
  apiKey: string;
  baseUrl: string;
  modelId: string;
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
        const messages = context.messages.map((m) => ({
          role: m.role === "toolResult" ? "user" : m.role,
          content:
            typeof m.content === "string"
              ? m.content
              : m.content
                  .filter((c) => c.type === "text")
                  .map((c) => (c as { text: string }).text)
                  .join("\n"),
        }));
        if (new TextEncoder().encode(JSON.stringify(messages)).length > 20000)
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
            max_tokens: 2048,
            stream: false,
            ...(config.modelId.startsWith("qwen")
              ? { enable_thinking: false, preserve_thinking: false }
              : {}),
          }),
          signal: options?.signal
            ? AbortSignal.any([options.signal, AbortSignal.timeout(90000)])
            : AbortSignal.timeout(90000),
        });
        if (!response.ok) throw new Error("MODEL_HTTP_ERROR");
        // Bounded body, do not retain/log raw API responses.
        const reader = response.body?.getReader();
        if (!reader) throw new Error("EMPTY_RESPONSE");
        let raw = "",
          bytes = 0;
        const decoder = new TextDecoder();
        while (true) {
          const r = await reader.read();
          if (r.done) break;
          bytes += r.value.length;
          if (bytes > 1000000) {
            await reader.cancel();
            throw new Error("RESPONSE_TOO_LARGE");
          }
          raw += decoder.decode(r.value, { stream: true });
        }
        raw += decoder.decode();
        const data = JSON.parse(raw);
        const content = data.choices?.[0]?.message?.content;
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
          !content.trim() ||
          /<\/?(?:think|thinking|analysis)>/i.test(content) ||
          content.includes(config.apiKey) ||
          data.choices?.[0]?.message?.tool_calls?.length
        )
          throw new Error("UNSAFE_OR_UNSUPPORTED_RESPONSE");
        message.usage.input = usage?.input ?? 24000;
        message.usage.output = usage?.output ?? 2048;
        message.usage.totalTokens = message.usage.input + message.usage.output;
        events.push({ type: "start", partial: message });
        message.content = [{ type: "text", text: "" }];
        events.push({ type: "text_start", contentIndex: 0, partial: message });
        message.content = [{ type: "text", text: content }];
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
        events.push({ type: "done", reason: "stop", message });
        events.end(message);
      } catch {
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
