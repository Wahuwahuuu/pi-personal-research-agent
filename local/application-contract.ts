/** Change the family when older code cannot preserve local data or receipt semantics. */
export const APPLICATION_CONTRACT = {
  format: 1, family: "pra-node-v1-20261113", protocol: 1, configuration: 1,
  nodeState: 1, libraryState: 1,
} as const;
export function assertApplicationCompatible(value: unknown) {
  if (!value || JSON.stringify(Object.entries(value as object).sort()) !==
      JSON.stringify(Object.entries(APPLICATION_CONTRACT).sort()))
    throw Error("LOCAL_APPLICATION_INCOMPATIBLE");
}
