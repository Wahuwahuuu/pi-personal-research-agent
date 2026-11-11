import { HttpsProxyAgent } from "https-proxy-agent";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { nodeCatalog, catalogPages } from "../local/catalog.ts";
export async function verifyLibraryQueue(
  base: string,
  api: (path: string, method?: string, body?: unknown) => Promise<any>,
) {
  const run = crypto.randomUUID();
  const importedProject = await api("projects", "POST", {
    requestId: run + ":project",
    title: "Import protocol test",
  });
  const versionOne = "import-protocol-" + run + "-v1",
    versionTwo = "import-protocol-" + run + "-v2";
  const token = (
    await api("device/pair", "POST", {
      label: "Import protocol check",
      requestId: crypto.randomUUID(),
    })
  ).token;
  let ws: WebSocket | undefined,
    frames: any[] = [];
  const catalog = await nodeCatalog(undefined, true);
  async function until(fn: () => Promise<any>, label: string) {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const value = await fn();
      if (value) return value;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw Error("IMPORT_CHECK_TIMEOUT:" + label);
  }
  const post = (value: any) => ws!.send(JSON.stringify(value));
  async function connect(version: string, include = false) {
    ws?.terminate();
    frames = [];
    const c = {
      ...catalog,
      indexVersion: version,
      papers: [
        ...catalog.papers,
        ...(include
          ? [
              {
                paper_id: "2401.00001v1",
                title: "Protocol paper",
                abstract: "Synthetic software test.",
              },
            ]
          : []),
      ],
      evidence: catalog.evidence.map((e) => ({ ...e, index_version: version })),
    };
    const pages = catalogPages(c);
    ws = new WebSocket(base.replace("http", "ws") + "/api/device/connect", {
      headers: { Authorization: "Bearer " + token },
      agent:
        base.startsWith("https:") && process.env.HTTPS_PROXY
          ? new HttpsProxyAgent(process.env.HTTPS_PROXY)
          : undefined,
    });
    ws.on("error", () => {});
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      frames.push(m);
      if (m.type === "hello_ack") {
        post({ type: "catalog_begin", pages: pages.length });
        pages.forEach((value, page) =>
          post({ type: "catalog_page", page, value }),
        );
        post({ type: "catalog_end" });
      }
    });
    await new Promise<void>((ok, no) => {
      ws!.once("open", ok);
      ws!.once("error", no);
    });
    post({
      type: "hello",
      version: 1,
      deviceId: "imports",
      indexVersion: version,
      retainedIndexes: [version],
      tools: ["search_papers", "retrieve_chunks"],
      capabilities: ["library-v1"],
    });
    await until(
      async () => frames.some((m) => m.type === "catalog_ack"),
      "catalog",
    );
    post({ type: "availability", ready: false, phase: "paused" });
  }
  try {
    const before = await api("state"),
      cursor = before.cursor;
    const request = {
      requestId: run + ":queue-one",
      projectId: importedProject.id,
      arxivId: "2401.00001v1",
    };
    const job = await api("imports", "POST", request);
    assert.equal((await api("imports", "POST", request)).id, job.id);
    assert.equal(job.status, "queued");
    await connect(versionOne);
    await until(
      async () =>
        frames.find((m) => m.type === "library_import" && m.id === job.id),
      "dispatch",
    );
    post({
      type: "library_result",
      id: job.id,
      generation: 0,
      phase: "indexing",
    });
    await until(
      async () =>
        (await api("imports")).items.find((j: any) => j.id === job.id)
          ?.phase === "indexing",
      "progress",
    );
    const receipt = {
      type: "library_result",
      id: job.id,
      generation: 0,
      phase: "published",
      paperId: "2401.00001v1",
      indexVersion: versionTwo,
    };
    post(receipt);
    await until(
      async () => frames.find((m) => m.type === "library_ack" && !m.terminal),
      "catalog-gate",
    );
    assert.equal(
      (await api("imports")).items.find((j: any) => j.id === job.id).status,
      "processing",
    );
    await connect(versionTwo, true);
    await until(
      async () =>
        frames.find((m) => m.type === "library_import" && m.id === job.id),
      "reconnect",
    );
    for (let n = 0; n < 5; n++) post(receipt);
    await until(
      async () =>
        (await api("imports")).items.find((j: any) => j.id === job.id)
          ?.status === "published",
      "publish",
    );
    const second = await api("imports", "POST", {
      requestId: run + ":queue-two",
      projectId: importedProject.id,
      arxivId: "2401.00002v1",
    });
    await until(
      async () =>
        frames.find((m) => m.type === "library_import" && m.id === second.id),
      "second",
    );
    await api("imports/" + second.id + "/cancel", "POST", {
      requestId: run + ":cancel-import",
    });
    await until(
      async () =>
        frames.find((m) => m.type === "library_cancel" && m.id === second.id),
      "cancel",
    );
    post({ ...receipt, id: second.id });
    post({ type: "library_cancelled", id: second.id, generation: 0 });
    await until(
      async () =>
        !(await api("imports")).items.find((j: any) => j.id === second.id)
          ?.cancelPending,
      "cancel-ack",
    );
    assert.equal(
      (await api("imports")).items.find((j: any) => j.id === second.id).status,
      "cancelled",
    );
    const retry = await api("imports/" + second.id + "/retry", "POST", {
      requestId: run + ":retry-import",
    });
    assert.equal(retry.generation, 1);
    await until(
      async () =>
        frames.find(
          (m) =>
            m.type === "library_import" &&
            m.id === second.id &&
            m.generation === 1,
        ),
      "retry",
    );
    post({
      type: "library_result",
      id: second.id,
      generation: 0,
      phase: "published",
      paperId: "2401.00002v1",
      indexVersion: versionTwo,
    });
    post({
      type: "library_result",
      id: second.id,
      generation: 1,
      phase: "failed",
      error: "DOWNLOAD_UNAVAILABLE",
    });
    await until(
      async () =>
        (await api("imports")).items.find((j: any) => j.id === second.id)
          ?.status === "failed",
      "retry-failure",
    );
    const project = await api("projects", "POST", {
      requestId: run + ":import-project",
      title: "Disposable import project",
    });
    const removed = await api("imports", "POST", {
      requestId: run + ":removed-import",
      projectId: project.id,
      arxivId: "2401.00003v1",
      title: "Private project note",
    });
    await until(
      async () =>
        frames.find((m) => m.type === "library_import" && m.id === removed.id),
      "project-import",
    );
    await api("projects/" + project.id, "DELETE", {
      requestId: run + ":delete-import-project",
    });
    await until(
      async () =>
        frames.find((m) => m.type === "library_cancel" && m.id === removed.id),
      "project-cancel",
    );
    post({
      type: "library_result",
      id: removed.id,
      generation: 0,
      phase: "published",
      paperId: "2401.00003v1",
      indexVersion: versionTwo,
    });
    post({ type: "library_cancelled", id: removed.id, generation: 0 });
    assert.ok(
      !(await api("imports")).items.some((j: any) => j.id === removed.id),
    );
    const revoked = await api("imports", "POST", {
      requestId: run + ":revoke",
      projectId: importedProject.id,
      arxivId: "2401.00004v1",
    });
    await until(
      async () =>
        frames.find((m) => m.type === "library_import" && m.id === revoked.id),
      "revoke-import",
    );
    await api("imports/" + revoked.id + "/cancel", "POST", {
      requestId: run + ":cancel-revoked",
    });
    const device = (await api("devices")).find(
      (d: any) => d.label === "Import protocol check" && !d.revoked,
    );
    assert.ok(device);
    await api("device/revoke", "POST", { id: device.id });
    const revokedState = (await api("imports")).items.find(
      (j: any) => j.id === revoked.id,
    );
    assert.equal(revokedState.cancelPending, false);
    await api("imports/" + revoked.id + "/retry", "POST", {
      requestId: run + ":retry-revoked",
    });
    const after = await api("state");
    assert.equal(typeof before.usage.requests,"number");
    assert.equal(after.usage.requests, before.usage.requests);
    assert.equal(
      after.notices.filter(
        (n: any) => n.id === "import:" + job.id || n.key === "import:" + job.id,
      ).length,
      1,
    );
    assert.ok(
      (await api("changes?after=" + cursor)).events.some((e: any) =>
        e.changes.some((c: any) => c.entity === "imports"),
      ),
    );
    return [
      "cloud import queue persists offline, survives reconnect and confirms a catalog before publishing without model calls",
      "import cancellation rejects late results; explicit retry changes generation; duplicate completion creates one notice",
    ];
  } finally {
    ws?.terminate();
  }
}
