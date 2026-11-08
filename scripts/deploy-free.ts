import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  parseModelSettings,
  modelDeploymentArgs,
} from "../src/model-settings.ts";
// No billing mutations; the operator has confirmed Workers Free for this account.
const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };
const settingsText = await readFile(".local/model-settings.json", "utf8").catch(
  (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  },
);
const settings = settingsText
  ? parseModelSettings(JSON.parse(settingsText))
  : undefined;
const cli = (args: string[], input?: string) =>
  execFileSync(
    process.execPath,
    ["node_modules/wrangler/bin/wrangler.js", ...args],
    {
      encoding: "utf8",
      windowsHide: true,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      input,
    },
  );
const who = JSON.parse(cli(["whoami", "--json"]));
if (!who.loggedIn || who.accounts.length !== 1)
  throw new Error("ONE_AUTHENTICATED_ACCOUNT_REQUIRED");
const auth = JSON.parse(cli(["auth", "token", "--json"]));
const account = who.accounts[0].id,
  name = "pi-personal-research-agent";
const response = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts`,
  { headers: { Authorization: "Bearer " + auth.token } },
);
const listing = (await response.json()) as any;
if (!response.ok || !listing.success)
  throw new Error("CANNOT_CHECK_EXISTING_WORKER");
const previous = await readFile(".local/deployment.json", "utf8")
  .then(JSON.parse)
  .catch(() => undefined);
if (listing.result.some((s: any) => s.id === name) && previous?.name !== name)
  throw new Error("REFUSING_TO_OVERWRITE_UNRECOGNIZED_WORKER");
await mkdir(".local", { recursive: true });
let token: string;
if (previous) {
  token = execFileSync(
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
} else {
  token = crypto.randomUUID() + crypto.randomUUID();
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      "scripts/write-secret.ps1",
      resolve(".local/admin.secret"),
    ],
    {
      input: token,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}
// Secret is sent on stdin, never as a command argument or log line.
const output = cli(["deploy", ...modelDeploymentArgs(settings)]);
const url = output.match(
  /https:\/\/pi-personal-research-agent\.[a-z0-9-]+\.workers\.dev/,
)?.[0];
if (!url) throw new Error("DEPLOYED_URL_NOT_FOUND");
await writeFile(
  ".local/deployment.json",
  JSON.stringify(
    {
      name,
      url,
      mode: settings?.mode ?? "mock",
      modelId: settings?.mode === "live" ? settings.modelId : "deterministic-v1",
      thinking: "off",
      freePlanConfirmedByUser: true,
      deployed: new Date().toISOString(),
    },
    null,
    2,
  ),
);
cli(["secret", "bulk"], JSON.stringify({ ADMIN_TOKEN: token }));
console.log(
  JSON.stringify({
    url,
    mode: settings?.mode ?? "mock",
    modelId: settings?.mode === "live" ? settings.modelId : "deterministic-v1",
    thinking: "off",
    adminCredential: "DPAPI protected .local/admin.secret",
    planChanged: false,
  }),
);
