import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectFrozenRelease, verifyFrozenRelease } from "../scripts/frozen-release.ts";

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "pra-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = join(root, "release");
  await mkdir(join(release, "worker"), { recursive: true }); await mkdir(join(release, "assets"));
  await writeFile(join(release, "worker", "worker.js"), "export default {};");
  await writeFile(join(release, "assets", "index.html"), "<main>ready</main>");
  const config = { name: "example", main: join(release, "worker", "worker.js"),
    assets: { directory: join(release, "assets") }, vars: { BUILD_ID: "a".repeat(40) } };
  const save = () => writeFile(join(release, "wrangler.json"), JSON.stringify(config));
  await save();
  return { root, release, config, save, expected: { name: config.name, build: config.vars.BUILD_ID } };
}
test("frozen release hashes code, assets and configuration while excluding deployment receipts", async t => {
  const f = await fixture(t), checked = await inspectFrozenRelease(f.root, f.release, f.expected);
  assert.equal(checked.files, 3); assert.match(checked.digest, /^[a-f0-9]{64}$/);
  await writeFile(join(f.release, "verification.json"), "{}");
  await mkdir(join(f.release, ".wrangler")); await writeFile(join(f.release, ".wrangler", "cache"), "runtime");
  assert.equal((await verifyFrozenRelease(f.root, checked)).digest, checked.digest);
});
for (const part of ["code", "asset", "config", "added-module"]) test("frozen upload rejects changed " + part, async t => {
  const f = await fixture(t), checked = await inspectFrozenRelease(f.root, f.release, f.expected);
  const path = part === "code" ? "worker/worker.js" : part === "asset" ? "assets/index.html" : part === "config" ? "wrangler.json" : "worker/added.js";
  await writeFile(join(f.release, path), part === "config" ? JSON.stringify({ ...f.config, compatibility_date: "2026-11-08" }) : "changed");
  await assert.rejects(verifyFrozenRelease(f.root, checked), /FROZEN_RELEASE_CHANGED/);
});
test("frozen release rejects identity changes, build hooks, environment overrides and escaped inputs", async t => {
  const f = await fixture(t);
  await assert.rejects(inspectFrozenRelease(f.root, f.release, { ...f.expected, name: "other" }), /IDENTITY_MISMATCH/);
  for (const field of ["build", "env"]) {
    (f.config as any)[field] = {}; await f.save();
    await assert.rejects(inspectFrozenRelease(f.root, f.release, f.expected), /CONFIG_INVALID/);
    delete (f.config as any)[field];
  }
  f.config.main = join(f.root, "outside.js"); await writeFile(f.config.main, "outside"); await f.save();
  await assert.rejects(inspectFrozenRelease(f.root, f.release, f.expected), /PATH_ESCAPE/);
  await assert.rejects(inspectFrozenRelease(f.release, f.root, f.expected), /PATH_ESCAPE/);
});
test("frozen release rejects a junction that would redirect assets outside the release", async t => {
  const f = await fixture(t), outside = join(f.root, "outside");
  await mkdir(outside); await writeFile(join(outside, "private"), "outside");
  await symlink(outside, join(f.release, "assets", "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(inspectFrozenRelease(f.root, f.release, f.expected), /PATH_ESCAPE/);
});
