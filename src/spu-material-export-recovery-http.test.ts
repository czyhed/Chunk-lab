import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No test port"));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitFor(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("server did not become ready");
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise<void>((resolveStop) => child.once("exit", () => resolveStop()));
}

const port = await freePort();
const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/server.ts"], {
  cwd: resolve("."),
  env: {
    ...process.env,
    NODE_ENV: "test",
    REDIS_DISABLED: "1",
    PORT: String(port),
    WORKSPACE_ROOT: resolve(".workspace", `spu-material-recovery-${process.pid}`),
    MINERU_API_TOKEN: "spu-material-fixture-token",
    EMBEDDING_BASE_URL: "http://127.0.0.1:9/v1",
    EMBEDDING_API_KEY: "spu-material-fixture-key",
    EMBEDDING_MODEL: "fixture-model",
    SPU_MATERIAL_TEST_FAIL_OBJECT_KEY_INCLUDES: "SPU-10002",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/health`, child);
  const demo = await (await fetch(`${base}/api/demo`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json() as { id: string; documents: Array<{ id: string }> };
  const documentId = demo.documents[0]!.id;
  const prefix = `${base}/api/batches/${demo.id}/documents/${documentId}`;
  await fetch(`${prefix}/review/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const review = await (await fetch(`${prefix}/review`)).json() as { reviewRevision: number; reviewState: { draft: { chunks: Array<{ id: string; finalText: string }> } } };
  const chunks = review.reviewState.draft.chunks;
  assert.ok(chunks.length >= 2);
  const completion = await fetch(`${prefix}/review/progress`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "mark-to-here", cursorChunkId: chunks.at(-1)!.id, expectedRevision: review.reviewRevision }) });
  assert.equal(completion.status, 200);
  const completed = await completion.json() as { reviewRevision: number };
  const scope = await fetch(`${prefix}/spu-material-scope`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetSpuIds: ["SPU-10001", "SPU-10002"], spuId: "SPU-10001", documentType: "manual", expectedRevision: completed.reviewRevision }) });
  assert.equal(scope.status, 200);
  for (const [index, chunk] of chunks.entries()) {
    const scopeUpdate = await fetch(`${prefix}/chunks/${chunk.id}/spu-scope`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "assigned", targetSpuIds: [index === 0 ? "SPU-10001" : "SPU-10002"] }),
    });
    assert.equal(scopeUpdate.status, 200);
  }

  const first = await fetch(`${prefix}/spu-material-export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ spuId: "SPU-10001", targetSpuIds: ["SPU-10001", "SPU-10002"], documentType: "manual" }) });
  assert.equal(first.status, 200);
  const partial = await first.json() as { status: string; children: Array<{ spuId: string; status: string; exportVersion: string; markdownKey?: string }> };
  assert.equal(partial.status, "partial_failure");
  const successful = partial.children.find((entry) => entry.spuId === "SPU-10001")!;
  const failed = partial.children.find((entry) => entry.spuId === "SPU-10002")!;
  assert.ok(successful.markdownKey);
  assert.equal(failed.status, "failed");

  const statusBeforeRetry = await (await fetch(`${prefix}/spu-material-export?spuId=SPU-10001`)).json() as { current: { exportVersion: string; markdownKey: string } | null };
  assert.equal(statusBeforeRetry.current?.markdownKey, successful.markdownKey);
  const retry = await fetch(`${prefix}/spu-material-export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ spuId: "SPU-10001", targetSpuIds: ["SPU-10001", "SPU-10002"], documentType: "manual" }) });
  assert.equal(retry.status, 200);
  const recovered = await retry.json() as { status: string; children: Array<{ spuId: string; status: string; exportVersion: string; markdownKey?: string; reused?: boolean }> };
  assert.ok(["complete", "complete_with_exclusions"].includes(recovered.status));
  const recoveredSuccessful = recovered.children.find((entry) => entry.spuId === "SPU-10001")!;
  const recoveredFailed = recovered.children.find((entry) => entry.spuId === "SPU-10002")!;
  assert.equal(recoveredSuccessful.reused, true);
  assert.equal(recoveredSuccessful.markdownKey, successful.markdownKey);
  assert.ok(["complete", "complete_with_exclusions"].includes(recoveredFailed.status));
  assert.equal(recoveredFailed.exportVersion, failed.exportVersion);
} finally {
  await stop(child);
}

console.log("SPU material export recovery HTTP tests passed");
