declare const __PRA_SOURCE_BUILD__: string | undefined;
/** Replaced by the verified build pipeline, never read from a runtime environment variable. */
export const SOURCE_BUILD = typeof __PRA_SOURCE_BUILD__ === "string" ? __PRA_SOURCE_BUILD__ : undefined;
