/** Same database cursor alone cannot detect device disconnects. */
export function changeFingerprint(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return;
  const event = value as Record<string, unknown>;
  const device = event.deviceState as Record<string, unknown> | undefined;
  if (event.type !== "change" || !Number.isSafeInteger(event.cursor) ||
      !Array.isArray(event.active) || typeof event.readerChanged !== "boolean" ||
      !device || typeof device.connected !== "boolean" ||
      typeof device.ready !== "boolean" || typeof device.canImport !== "boolean" ||
      typeof device.phase !== "string") return;
  return JSON.stringify(event);
}
