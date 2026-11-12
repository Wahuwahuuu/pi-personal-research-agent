import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { controlKey, requestStop, trayRunning } from "./lifecycle.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function exchange(port: number, token: string, action?: "shutdown"): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve, reject) => {
    const body = action ? JSON.stringify({action}) : undefined;
    const req = request({ hostname: "127.0.0.1", port, path: "/local/" + (action ? "control" : "status"),
      method: action ? "POST" : "GET", headers: {Authorization: "Bearer " + token, ...(body ? {"Content-Type":"application/json"} : {})} }, res => {
      let value = "";
      res.setEncoding("utf8");
      res.on("data", part => { value += part; if (value.length > 1024*1024) req.destroy(Error("LOCAL_RESPONSE_LIMIT")); });
      res.on("end", () => {
        if (res.statusCode === 401) return reject(Error("LOCAL_AUTH_REQUIRED"));
        if (res.statusCode !== 200) return reject(Error("LOCAL_STOP_REJECTED"));
        try { resolve(JSON.parse(value)); } catch { reject(Error("LOCAL_RESPONSE_INVALID")); }
      });
      res.on("error", () => reject(Error("LOCAL_STOP_CONNECTION_FAILED")));
    });
    req.setTimeout(3000, () => req.destroy(Error("LOCAL_STOP_TIMEOUT")));
    req.on("error", error => {
      if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") resolve(undefined);
      else reject(Error("LOCAL_STOP_CONNECTION_FAILED"));
    });
    req.end(body);
  });
}
function portClosed(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({host:"127.0.0.1",port});
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.setTimeout(1000, () => { socket.destroy(); reject(Error("LOCAL_STOP_TIMEOUT")); });
    socket.once("error", error => {
      if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") resolve(true);
      else reject(Error("LOCAL_STOP_CONNECTION_FAILED"));
    });
  });
}
export async function stopNode(configPath: string, waitMs = 15000): Promise<{stopped: true}> {
  configPath = resolve(configPath);
  const config = JSON.parse(await readFile(configPath, "utf8")) as {dataDir: string;port?: number;localSecretFile?: string};
  const port = config.port ?? 48731;
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || typeof config.dataDir !== "string" || !config.dataDir)
    throw Error("INVALID_LOCAL_CONFIGURATION");
  const dataDir = resolve(root, config.dataDir);
  let token = process.env.PRA_LOCAL_TOKEN ?? "";
  if (!await portClosed(port)) {
    if (!token && process.platform === "win32") {
      const result = spawnSync("powershell.exe", ["-NoProfile","-NonInteractive","-File",resolve(root,"scripts/read-secret.ps1"),
        resolve(root,config.localSecretFile ?? resolve(dataDir,"local.secret"))],
        {encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"],timeout:15000});
      if (result.status === 0) token = result.stdout.trim();
    }
    if (token.length < 32 || token.length > 256) throw Error("LOCAL_CREDENTIAL_UNAVAILABLE");
    const state = await exchange(port, token);
    if (state && state.instanceId !== controlKey(configPath)) throw Error("LOCAL_CONFIGURATION_MISMATCH");
    if (state) {
      const reply = await exchange(port, token, "shutdown");
      if (reply && (reply.accepted !== true || reply.instanceId !== controlKey(configPath))) throw Error("LOCAL_STOP_REJECTED");
    }
  }
  // Also stops a tray whose child has already exited; no process-name matching.
  await requestStop(configPath, dataDir);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await portClosed(port) && !await trayRunning(configPath, dataDir)) return {stopped:true};
    await delay(100);
  }
  throw Error("LOCAL_STOP_TIMEOUT");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await stopNode(process.argv[2] ?? resolve(root,".local/node.json")))); }
  catch (error) {
    const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "LOCAL_STOP_FAILED";
    console.error(code); process.exitCode=1;
  }
}
