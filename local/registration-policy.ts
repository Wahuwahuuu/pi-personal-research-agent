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

/** Never return upstream error text: it can contain URLs or credential-bearing headers. */
export function connectionIssue(error:unknown):string {
  const code=error&&typeof error==="object"?Reflect.get(error,"code"):undefined;
  if(code==="ECONNREFUSED")return "NODE_CONNECTION_REFUSED";
  if(code==="ENOTFOUND"||code==="EAI_AGAIN")return "NODE_DNS_FAILED";
  if(code==="ETIMEDOUT"||error instanceof Error&&error.message==="Opening handshake has timed out")return "NODE_CONNECTION_TIMEOUT";
  if(["CERT_HAS_EXPIRED","DEPTH_ZERO_SELF_SIGNED_CERT","UNABLE_TO_VERIFY_LEAF_SIGNATURE","ERR_TLS_CERT_ALTNAME_INVALID"].includes(code))return "NODE_TLS_FAILED";
  if(["ECONNRESET","ENETUNREACH","EHOSTUNREACH","EPIPE"].includes(code))return "NODE_NETWORK_INTERRUPTED";
  return "NODE_CONNECTION_FAILED";
}
