import { execFileSync } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
const cli = (args: string[]) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      ["node_modules/wrangler/bin/wrangler.js", ...args, "--json"],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
const who = cli(["whoami"]);
if (!who.loggedIn || who.accounts.length !== 1)
  throw new Error(
    "A single authenticated account is required; select explicitly otherwise.",
  );
const credential = cli(["auth", "token"]);
if (typeof credential.token !== "string") throw new Error("UNSUPPORTED_AUTH");
const account = who.accounts[0].id;
const response = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${account}/subscriptions`,
  { headers: { Authorization: "Bearer " + credential.token } },
);
const body = (await response.json()) as any;
const subscriptions = Array.isArray(body.result) ? body.result : [];
const plans = subscriptions.map((s: any) => ({
  name: s.rate_plan?.public_name ?? s.rate_plan?.id ?? "unknown",
  price: s.price ?? s.rate_plan?.price ?? null,
  state: s.state ?? null,
}));
const report = {
  timestamp: new Date().toISOString(),
  authenticated: true,
  accountCount: 1,
  subscriptionReadStatus: response.status,
  subscriptionCheckSucceeded: body.success === true,
  plans,
  freeTierVerified: false,
  deployed: false,
  note: "No deployment or plan change performed. Empty subscriptions alone is not a runtime quota measurement.",
};
await mkdir("docs/validation", { recursive: true });
await writeFile(
  "docs/validation/cloud-preflight.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
