/** A new catalog can repair these errors. Retrying identical bytes cannot. */
export const catalogRegistrationIssues = new Set(["CATALOG_SIZE", "CATALOG_VERSION_CONFLICT", "INVALID_CATALOG", "INDEX_CHANGED"]);

export function persistentRegistrationIssue(code: unknown): string | undefined {
  if (typeof code !== "string") return undefined;
  if (catalogRegistrationIssues.has(code) || code === "PROTOCOL_MISMATCH") return code;
  return undefined;
}

export function reconnectDelay(consecutiveFailures: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.min(5, consecutiveFailures));
}
