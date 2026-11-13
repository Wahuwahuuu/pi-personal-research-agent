export interface ReleaseContract {
  format: 1;
  family: string;
  appStateSchema: number;
  piStorageSchema: number;
  nodeProtocol: number;
  nodeConfiguration: number;
  runtime: { agents: string; piDurable: string; piAi: string };
}

/** A schema fingerprint alone does not prove old code can honor new data semantics.
 * Bump family for incompatible persistence, deletion, billing or recovery changes. */
export const RELEASE_CONTRACT: ReleaseContract = Object.freeze({
  format: 1,
  family: "pra-v1-state4-pi2-canonical-memory-20261113",
  appStateSchema: 4,
  piStorageSchema: 2,
  nodeProtocol: 1,
  nodeConfiguration: 1,
  runtime: Object.freeze({ agents: "0.33.0", piDurable: "1.5.0", piAi: "1.5.0" }),
});

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === keys.slice().sort().join(",");
}
export function parseReleaseContract(raw: unknown): ReleaseContract {
  if (!exactKeys(raw, ["format","family","appStateSchema","piStorageSchema","nodeProtocol","nodeConfiguration","runtime"]) ||
      raw.format !== 1 || typeof raw.family !== "string" || !/^[a-z0-9][a-z0-9.-]{0,95}$/.test(raw.family) ||
      !exactKeys(raw.runtime, ["agents","piDurable","piAi"]))
    throw Error("UNKNOWN_RELEASE_CONTRACT");
  const versions = [raw.appStateSchema,raw.piStorageSchema,raw.nodeProtocol,raw.nodeConfiguration];
  if (versions.some(v => typeof v !== "number" || !Number.isSafeInteger(v) || v < 1 || v > 1000) ||
      Object.values(raw.runtime).some(v => typeof v !== "string" || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(v)))
    throw Error("UNKNOWN_RELEASE_CONTRACT");
  return {
    format: 1, family: raw.family,
    appStateSchema: raw.appStateSchema as number, piStorageSchema: raw.piStorageSchema as number,
    nodeProtocol: raw.nodeProtocol as number, nodeConfiguration: raw.nodeConfiguration as number,
    runtime: { agents: raw.runtime.agents as string, piDurable: raw.runtime.piDurable as string, piAi: raw.runtime.piAi as string },
  };
}
export function assertReleaseCompatible(current: unknown, target: unknown): void {
  if (JSON.stringify(parseReleaseContract(current)) !== JSON.stringify(parseReleaseContract(target)))
    throw Error("INCOMPATIBLE_RELEASE_CONTRACT");
}
