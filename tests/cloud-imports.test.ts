import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { CloudImports } from "../local/cloud-imports.ts";
import type { ImportJob } from "../local/library-client.ts";
function setup() {
  const db = new DatabaseSync(":memory:"),
    frames: any[] = [];
  let count = 0,
    cancels = 0,
    retries = 0;
  const job: ImportJob = {
    id: "local-job",
    source: "arxiv:2401.00001v1",
    status: "queued",
  };
  const library = {
    async registerArxiv() {
      count++;
      return { ...job };
    },
    async statuses() {
      return [{ ...job }];
    },
    async cancelRemote() {
      cancels++;
      job.status = "cancelled";
      return { ...job };
    },
    async retry() {
      retries++;
      job.status = "queued";
      return { ...job };
    },
  };
  const create = () => new CloudImports(db, library, (f) => frames.push(f));
  return {
    db,
    frames,
    job,
    library,
    create,
    stats: () => ({ count, cancels, retries }),
  };
}
const command = (id = "operation", generation = 0) => ({
  type: "library_import",
  id,
  generation,
  arxivId: "2401.00001v1",
  title: "Example",
});

test("local registration/outbox survives restart and duplicated cloud deliveries without duplicate work", async () => {
  const f = setup();
  try {
    let bridge = f.create();
    await Promise.all(
      Array.from({ length: 5 }, () => bridge.receive(command())),
    );
    assert.equal(f.stats().count, 1);
    bridge = f.create();
    await bridge.receive(command());
    assert.equal(f.stats().count, 1);
    f.job.status = "published";
    f.job.paper_id = "2401.00001v1";
    f.job.version = "published-index";
    await bridge.flush();
    assert.equal(f.frames.at(-1).phase, "published");
    await bridge.flush(true);
    assert.equal(f.frames.at(-1).indexVersion, "published-index");
    await bridge.receive({
      type: "library_ack",
      id: "operation",
      generation: 0,
      terminal: true,
    });
    const count = f.frames.length;
    await bridge.flush(true);
    assert.equal(f.frames.length, count);
    await bridge.receive(command());
    assert.equal(f.stats().count, 1);
    await assert.rejects(
      bridge.receive({ ...command(), path: "C:/private.pdf" }),
      /INVALID_IMPORT_COMMAND/,
    );
    await assert.rejects(
      bridge.receive({
        ...command(),
        arxivId: "https://arxiv.org/pdf/2401.00001",
      }),
      /INVALID_IMPORT_COMMAND/,
    );
  } finally {
    f.db.close();
  }
});
test("cancellation during an asynchronous registration leaves a tombstone, no late successful result", async () => {
  const f = setup();
  try {
    let resolve!: () => void;
    const blocked = new Promise<void>((r) => (resolve = r));
    const original = f.library.registerArxiv;
    f.library.registerArxiv = async () => {
      await blocked;
      return original();
    };
    const bridge = f.create(),
      registered = bridge.receive(command());
    await bridge.receive({
      type: "library_cancel",
      id: "operation",
      generation: 0,
    });
    assert.equal(f.frames.length, 0);
    resolve();
    await registered;
    assert.equal(f.stats().cancels, 1);
    assert.equal(f.frames.at(-1).type, "library_cancelled");
    await bridge.receive(command());
    assert.equal(f.stats().count, 1);
    await bridge.receive(command("operation", 1));
    assert.equal(f.stats().retries, 1);
    assert.equal(f.frames.at(-1).phase, "queued");
    await bridge.receive({
      type: "library_cancel",
      id: "operation",
      generation: 0,
    });
    assert.equal(f.stats().cancels, 2); // duplicate cancelled delivery earlier was idempotent, old generation adds none
  } finally {
    f.db.close();
  }
});
test("one project cancelling a shared import does not stop another project's processing", async () => {
  const f = setup();
  try {
    const bridge = f.create();
    await bridge.receive(command("a"));
    await bridge.receive(command("b"));
    await bridge.receive({ type: "library_cancel", id: "a", generation: 0 });
    assert.equal(f.stats().cancels, 0);
    assert.equal(f.job.status, "queued");
    await bridge.receive({ type: "library_cancel", id: "b", generation: 0 });
    assert.equal(f.stats().cancels, 1);
    assert.equal(f.job.status, "cancelled");
  } finally {
    f.db.close();
  }
});
test("failed registration is replayed until acknowledged, never automatically retried in the same generation", async () => {
  const f = setup();
  try {
    let calls = 0;
    f.library.registerArxiv = async () => {
      calls++;
      throw Error("DOWNLOAD_UNAVAILABLE");
    };
    const bridge = f.create();
    await bridge.receive(command());
    await bridge.receive(command());
    assert.equal(calls, 1);
    assert.equal(f.frames.at(-1).phase, "failed");
    await bridge.receive(command("operation", 1));
    assert.equal(calls, 2);
  } finally {
    f.db.close();
  }
});
