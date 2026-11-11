import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const deployment = JSON.parse(await readFile(".local/deployment.json", "utf8"));
if (await readFile(".local/node.json", "utf8").catch(() => undefined))
  throw new Error("NODE_ALREADY_CONFIGURED");
const token = execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-File",
    "scripts/read-secret.ps1",
    resolve(".local/admin.secret"),
  ],
  { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
).trim();
const response = await fetch(deployment.url + "/api/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token }),
});
if (!response.ok) throw new Error("LOGIN_FAILED");
const pair = await fetch(deployment.url + "/api/device/pair", {
  method: "POST",
  headers: { Cookie: response.headers.get("set-cookie")!.split(";")[0] },
});
if (!pair.ok) throw new Error("PAIR_FAILED");
const data = (await pair.json()) as { token: string };
execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-File",
    "scripts/write-secret.ps1",
    resolve(".local/device.secret"),
  ],
  { input: data.token, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
);
const config = JSON.parse(await readFile("local/node.example.json", "utf8"));
config.endpoint = deployment.url;
if (process.env.HTTPS_PROXY) config.proxy = process.env.HTTPS_PROXY;
await writeFile(".local/node.json", JSON.stringify(config, null, 2));
console.log(
  "Local node paired. Configure Python, models and libraryRoot in .local/node.json before starting; the default starts with an empty library. Device credential DPAPI-protected; node not started.",
);
