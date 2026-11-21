import {TOOL_TIMEOUT_MS, type Operation} from "./domain.ts";

/** Only the cloud compares its absolute deadline with its own clock. */
export function toolDispatchFrame(operation: Operation, now = Date.now()) {
  return {type: "operation" as const, operation,
    timeoutMs: Math.max(0, Math.min(TOOL_TIMEOUT_MS, operation.deadline - now))};
}

/** A relative timer tolerates device clock skew; cloud expiry remains authoritative. */
export function localToolTimeout(deadline: number, timeoutMs: unknown, now = Date.now()): number | undefined {
  if (!Number.isFinite(deadline)) return undefined;
  if (timeoutMs === undefined) return Math.max(1, Math.min(180000, deadline - now));
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > TOOL_TIMEOUT_MS)
    return undefined;
  return Math.max(1, Math.ceil(timeoutMs));
}
