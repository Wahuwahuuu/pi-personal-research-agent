export interface ModelSettings {
  mode: "mock" | "live";
  modelId: string;
  baseUrl: string;
  thinking: "off";
}

/** Non-secret deployment settings. API keys must never be accepted here. */
export function parseModelSettings(value: unknown): ModelSettings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_MODEL_SETTINGS");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (k) => !["mode", "modelId", "baseUrl", "thinking"].includes(k),
    )
  )
    throw new Error("UNKNOWN_MODEL_SETTING");
  if (v.mode !== "mock" && v.mode !== "live")
    throw new Error("INVALID_MODEL_MODE");
  if (
    typeof v.modelId !== "string" ||
    !/^[a-zA-Z0-9._/-]{1,128}$/.test(v.modelId)
  )
    throw new Error("INVALID_MODEL_ID");
  if (v.thinking !== "off") throw new Error("THINKING_MUST_BE_OFF");
  if (typeof v.baseUrl !== "string") throw new Error("INVALID_MODEL_URL");
  const url = new URL(v.baseUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("INVALID_MODEL_URL");
  return {
    mode: v.mode,
    modelId: v.modelId,
    baseUrl: v.baseUrl.replace(/\/$/, ""),
    thinking: "off",
  };
}

export function modelDeploymentArgs(settings?: ModelSettings): string[] {
  if (!settings) return [];
  return [
    "--var",
    `MODEL_MODE:${settings.mode}`,
    "--var",
    `MODEL_ID:${settings.modelId}`,
    "--var",
    `MODEL_BASE_URL:${settings.baseUrl}`,
  ];
}

/** Persist effective non-secret variables inside the frozen upload, not ephemeral CLI overrides. */
export function modelDeploymentVariables(settings?: ModelSettings): Record<string,string> {
  return settings ? {MODEL_MODE:settings.mode,MODEL_ID:settings.modelId,MODEL_BASE_URL:settings.baseUrl} : {};
}
