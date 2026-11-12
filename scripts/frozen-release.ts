import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function assertReleaseVariables(vars: Record<string, unknown> = {}) {
  if (Object.keys(vars).some(key => /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)$/i.test(key)))
    throw Error("INLINE_RELEASE_CREDENTIAL_FORBIDDEN");
}

export interface FrozenRelease {
  directory: string;
  configPath: string;
  config: Record<string, any>;
  digest: string;
  files: number;
}
function within(root: string, target: string) {
  const p = relative(root, target);
  return p !== "" && p !== ".." && !p.startsWith(".." + sep) && !isAbsolute(p);
}
async function safePath(root: string, path: string) {
  if (!within(root, path) || (await lstat(path)).isSymbolicLink() || await realpath(path) !== path)
    throw Error("FROZEN_RELEASE_PATH_ESCAPE");
}
async function inventory(directory: string, path: string, out: Map<string, Buffer>) {
  await safePath(directory, path);
  const entry = await lstat(path);
  if (entry.isDirectory()) {
    for (const name of (await readdir(path)).sort()) await inventory(directory, resolve(path, name), out);
  } else if (entry.isFile()) out.set(relative(directory, path).split(sep).join("/"), await readFile(path));
  else throw Error("FROZEN_RELEASE_FILE_REQUIRED");
}
/** Check the exact local upload inputs; verification receipts and Wrangler caches are not inputs. */
export async function inspectFrozenRelease(
  rootPath: string, releasePath: string, expected: { name: string; build: string },
): Promise<FrozenRelease> {
  const root = await realpath(resolve(rootPath)), directory = resolve(releasePath);
  await safePath(root, directory);
  const configPath = resolve(directory, "wrangler.json");
  await safePath(directory, configPath);
  const bytes = await readFile(configPath);
  let config: Record<string, any>;
  try { config = JSON.parse(bytes.toString("utf8")); } catch { throw Error("FROZEN_RELEASE_CONFIG_INVALID"); }
  if (config.name !== expected.name || config.vars?.BUILD_ID !== expected.build)
    throw Error("FROZEN_RELEASE_IDENTITY_MISMATCH");
  assertReleaseVariables(config.vars);
  // A frozen upload may not run a new build or select a second environment.
  if (config.build || config.env || typeof config.main !== "string" || !isAbsolute(config.main) ||
      typeof config.assets?.directory !== "string" || !isAbsolute(config.assets.directory))
    throw Error("FROZEN_RELEASE_CONFIG_INVALID");
  const main = resolve(config.main), worker = dirname(main), assets = resolve(config.assets.directory);
  await safePath(directory, worker); await safePath(directory, main); await safePath(directory, assets);
  if (!(await lstat(main)).isFile() || !(await lstat(assets)).isDirectory())
    throw Error("FROZEN_RELEASE_FILE_REQUIRED");
  const entries = new Map<string, Buffer>([["wrangler.json", bytes]]);
  await inventory(directory, worker, entries); await inventory(directory, assets, entries);
  const hash = createHash("sha256");
  for (const [path, value] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(JSON.stringify([path, value.length]) + "\n"); hash.update(value);
  }
  return { directory, configPath, config, digest: hash.digest("hex"), files: entries.size };
}
export async function verifyFrozenRelease(root: string, release: FrozenRelease) {
  const current = await inspectFrozenRelease(root, release.directory, {
    name: release.config.name, build: release.config.vars.BUILD_ID,
  });
  if (current.digest !== release.digest) throw Error("FROZEN_RELEASE_CHANGED");
  return current;
}
