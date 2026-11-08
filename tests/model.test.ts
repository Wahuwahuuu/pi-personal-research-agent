import { test } from "node:test";
import assert from "node:assert/strict";
import { liveModels } from "../src/live-model.ts";
import {
  parseModelSettings,
  modelDeploymentArgs,
} from "../src/model-settings.ts";
const config = {
  authorized: "explicitly-authorized",
  apiKey: "test-secret-DO-NOT-PERSIST",
  baseUrl: "https://model.invalid/v1",
  modelId: "test",
};
test("Qwen requests explicitly disable thinking and never persist provider reasoning", async () => {
  let sent: Record<string, unknown> | undefined;
  const settings = { ...config, modelId: "qwen3.7-flash" };
  const models = liveModels(
    settings,
    () => {},
    () => {},
    (async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({
        choices: [
          { message: { content: "OK", reasoning_content: "HIDDEN_SENTINEL" } },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      });
    }) as typeof fetch,
  );
  const events = [];
  for await (const event of models.stream(
    models.getModel("pra", settings.modelId)!,
    { messages: [{ role: "user", content: "test", timestamp: 0 }] },
  ))
    events.push(event);
  assert.equal(sent?.enable_thinking, false);
  assert.equal(sent?.preserve_thinking, false);
  assert.equal(sent?.max_tokens, 2048);
  assert.equal(sent?.stream, false);
  assert.ok(!JSON.stringify(events).includes("HIDDEN_SENTINEL"));
});
test("deployment profile carries only non-secret settings and keeps mock as the default", () => {
  assert.deepEqual(modelDeploymentArgs(), []);
  const input = {
    mode: "live",
    modelId: "qwen3.7-flash",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    thinking: "off",
  };
  const parsed = parseModelSettings(input);
  assert.deepEqual(modelDeploymentArgs(parsed), [
    "--var",
    "MODEL_MODE:live",
    "--var",
    "MODEL_ID:qwen3.7-flash",
    "--var",
    "MODEL_BASE_URL:https://dashscope.aliyuncs.com/compatible-mode/v1",
  ]);
  assert.throws(
    () => parseModelSettings({ ...input, apiKey: "fake-only" }),
    /UNKNOWN_MODEL_SETTING/,
  );
  assert.throws(
    () => parseModelSettings({ ...input, thinking: "on" }),
    /THINKING_MUST_BE_OFF/,
  );
  assert.throws(
    () =>
      parseModelSettings({
        ...input,
        baseUrl: "https://user:password@model.invalid/v1",
      }),
    /INVALID_MODEL_URL/,
  );
  assert.throws(
    () =>
      parseModelSettings({
        ...input,
        baseUrl: "https://model.invalid/v1?key=fake-only",
      }),
    /INVALID_MODEL_URL/,
  );
});
test("live model cannot be enabled without explicit authorization", () => {
  assert.throws(
    () =>
      liveModels(
        { ...config, authorized: "" },
        () => {},
        () => {},
      ),
    /PAID_CALLS_DISABLED/,
  );
});
test("provider drops hidden reasoning before Pi can persist it", async () => {
  let calls = 0,
    usage: unknown;
  const models = liveModels(
    config,
    () => {
      calls++;
    },
    (u) => (usage = u),
    (async (_url, init) => {
      assert.match(
        String(new Headers(init?.headers).get("Authorization")),
        /Bearer test-secret/,
      );
      return Response.json({
        choices: [
          {
            message: {
              content: "Visible evidence answer.",
              reasoning_content: "HIDDEN_SENTINEL",
            },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 23 },
      });
    }) as typeof fetch,
  );
  const stream = models.stream(models.getModel("pra", "test")!, {
    messages: [{ role: "user", content: "test", timestamp: 0 }],
  });
  const seen = [];
  for await (const event of stream) seen.push(event);
  const encoded = JSON.stringify(seen);
  assert.ok(encoded.includes("Visible evidence answer."));
  assert.ok(!encoded.includes("HIDDEN_SENTINEL"));
  assert.ok(!encoded.includes(config.apiKey));
  assert.equal(calls, 1);
  assert.deepEqual(usage, { input: 12, output: 23 });
});
test("unsafe model output and provider errors never enter persisted events", async () => {
  for (const body of [
    { choices: [{ message: { content: "<think>HIDDEN_SENTINEL</think>" } }] },
    { choices: [{ message: { content: config.apiKey } }] },
  ]) {
    const models = liveModels(
      config,
      () => {},
      () => {},
      (async () => Response.json(body)) as typeof fetch,
    );
    const events = [];
    for await (const e of models.stream(models.getModel("pra", "test")!, {
      messages: [],
    }))
      events.push(e);
    const encoded = JSON.stringify(events);
    assert.match(encoded, /MODEL_REQUEST_FAILED/);
    assert.ok(!encoded.includes("HIDDEN_SENTINEL"));
    assert.ok(!encoded.includes(config.apiKey));
  }
});
