import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
const { url } = JSON.parse(await readFile(".local/deployment.json", "utf8"));
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
const r = await fetch(url + "/api/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token }),
});
if (!r.ok) throw new Error("LOGIN_FAILED");
const s = (await fetch(url + "/api/state", {
  headers: { Cookie: r.headers.get("set-cookie")!.split(";")[0] },
}).then((r) => r.json())) as any;
console.log(
  JSON.stringify(
    {
      mode: s.mode,
      model: s.model,
      deviceOnline: s.deviceOnline,
      tasks: s.tasks?.map((t: any) => ({
        id: t.id,
        status: t.status,
        error: t.error,
        calls: t.calls,
        tools: t.tools,
      })),
      usage: s.usage,
    },
    null,
    2,
  ),
);
