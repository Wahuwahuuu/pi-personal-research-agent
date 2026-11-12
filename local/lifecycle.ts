import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

export function controlKey(configPath: string): string {
  const path = resolve(configPath);
  return createHash("sha256").update(process.platform === "win32" ? path.toLowerCase() : path).digest("hex");
}
export function controlDirectory(configPath: string, dataDir: string): string {
  return join(resolve(dataDir), ".control", controlKey(configPath));
}
export async function requestStop(configPath: string, dataDir: string): Promise<void> {
  const directory = controlDirectory(configPath, dataDir);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, "stop-" + randomUUID() + ".tmp");
  await writeFile(temporary, JSON.stringify({ version: 1, requestedAt: Date.now() }), { mode: 0o600 });
  await rename(temporary, join(directory, "stop"));
}
export async function trayRunning(configPath: string, dataDir: string): Promise<boolean> {
  let value: { pid?: number; instance?: string };
  try { value = JSON.parse(await readFile(join(controlDirectory(configPath, dataDir), "tray.json"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw Error("TRAY_STATE_UNREADABLE");
  }
  if (!Number.isSafeInteger(value.pid) || value.pid! <= 0 || typeof value.instance !== "string")
    throw Error("TRAY_STATE_INVALID");
  // Never terminate a PID from a file. A reused PID can only cause a conservative timeout.
  try { process.kill(value.pid!, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw Error("TRAY_STATE_UNREADABLE");
  }
}
