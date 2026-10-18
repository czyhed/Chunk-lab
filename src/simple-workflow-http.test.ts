import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const listener = createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = (listener.address() as { port: number }).port;
await new Promise<void>((resolve) => listener.close(() => resolve()));
const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/server.ts"], {
  env: { ...process.env, NODE_ENV: "test", REDIS_DISABLED: "1", DOCUMENT_LEASE_ENFORCEMENT: "1",
    PORT: String(port), WORKSPACE_ROOT: await mkdtemp(join(tmpdir(), "chunk-workflow-")),
    RAG_LOCAL_MEMORY_DATABASE: "1", DATABASE_PROFILES_JSON: JSON.stringify([{ id: "local", name: "Local acceptance", kind: "pgvector" }]),
    MINERU_API_TOKEN: "fixture", EMBEDDING_BASE_URL: "http://127.0.0.1:9/v1", EMBEDDING_API_KEY: "fixture", EMBEDDING_MODEL: "fixture" },
  stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
const base = `http://127.0.0.1:${port}`;
const identity = { "x-user-id": "reader", "x-session-id": "tab-a", "content-type": "application/json" };
try {
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { ready = (await fetch(base + "/api/health")).ok; } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, "server starts");
  assert.equal((await fetch(base + "/parent-context.js")).status, 200, "browser can load the shared parent-context module");
  const form = new FormData();
  form.append("files", new Blob(["# Instructions\n\n" + "Wash the bottle by hand. Keep the lid dry. ".repeat(40)]), "workflow.md");
  const uploaded = await fetch(base + "/api/batches", { method: "POST", body: form });
  assert.equal(uploaded.status, 202);
  const batch = await uploaded.json() as { id: string; documents: Array<{ id: string; state: string }> };
  assert.equal(batch.documents[0].state, "done", "upload parses Markdown without manual gates");
  const path = `${base}/api/batches/${batch.id}/documents/${batch.documents[0].id}`;
  const acquire = () => fetch(path + "/lease", { method: "POST", headers: identity, body: "{}" });
  const first = await acquire();
  assert.equal(first.status, 200);
  const lease = await first.json() as { leaseId: string };
  const recovered = await acquire();
  assert.equal(recovered.status, 200, "same session recovers a lost lease response");
  assert.equal((await recovered.json() as { leaseId: string }).leaseId, lease.leaseId);
  const other = await fetch(path + "/lease", { method: "POST", headers: { ...identity, "x-session-id": "tab-b" }, body: "{}" });
  assert.equal(other.status, 423, "another tab cannot overwrite the document");
  const headers = { ...identity, "x-document-lease-id": lease.leaseId };
  const post = async (suffix: string, body: unknown) => {
    const response = await fetch(path + suffix, { method: "POST", headers, body: JSON.stringify(body) });
    const result = await response.json() as any;
    assert.equal(response.status, 200, `${suffix}: ${result.error ?? ""}`);
    return result;
  };
  const preview = await post("/chunks", { strategy: "parent-child", parentChunkSize: 128, chunkSize: 48, chunkOverlap: 0 });
  assert.ok(preview.chunks.every((chunk: any) => chunk.parentChunk), "parent contexts survive canonical preview conversion");
  const confirmed = await post("/review/confirm", {});
  const chunks = confirmed.reviewState.draft.chunks;
  const profiles = await (await fetch(base + "/api/embedding-profiles")).json() as any;
  const embedding = await post("/embedding-jobs", { profileId: profiles.profiles[0].id });
  assert.ok(embedding.job.summary.succeeded > 0, "plain documents embed without SPU or manual completion");
  assert.equal(embedding.job.summary.failed, 0);
  const database = await post("/database-jobs", { profileId: "local", embeddingJobId: embedding.job.id });
  assert.equal(database.job.summary.written, embedding.job.summary.succeeded);
  const recall = await post("/retrieval-tests", { query: "Wash the bottle", relevantChunkIds: [chunks[0].id], k: 5 });
  assert.ok(recall.results.length > 0, "retrieval returns stored hits");
  assert.ok(recall.results.some((item: any) => chunks.some((chunk: any) => chunk.id === item.chunkId) && item.parentChunk?.text.includes("Wash the bottle")), "retrieval returns expected child IDs and parent text");
  assert.ok(recall.results.every((item: any) => item.parentChunk?.text), "stored parents accompany child retrieval hits");
  const exported = await fetch(`${base}/api/batches/${batch.id}/export`);
  assert.equal(exported.status, 200, "export does not require per-chunk completion marks");
  assert.ok(JSON.stringify(await exported.json()).includes('"parentChunk"'), "export retains parent-child relations");
  await post("/chunks", { strategy: "structure", chunkSize: 512, chunkOverlap: 0 });
  const replacement = await post("/review/confirm", { confirmReplacement: true });
  const nextEmbedding = await post("/embedding-jobs", { profileId: profiles.profiles[0].id });
  await post("/database-jobs", { profileId: "local", embeddingJobId: nextEmbedding.job.id });
  const persisted = await (await fetch(path + "/database-records?profileId=local")).json() as any;
  assert.deepEqual(persisted.records.map((item: any) => item.chunkId).sort(), replacement.reviewState.draft.chunks.map((item: any) => item.id).sort(),
    "rechunking replaces obsolete indexed children rather than leaving stale search hits");
  await post("/chunks", { strategy: "parent-child", parentChunkSize: 128, chunkSize: 48, chunkOverlap: 0 });
  const originalAgain = await post("/review/confirm", { confirmReplacement: true });
  const superseded = await fetch(path + `/database-jobs/${database.job.id}/retry`, { method: "POST", headers, body: "{}" });
  assert.equal(superseded.status, 409, "retrying a superseded completed job cannot falsely report restored rows");
  const originalEmbedding = await post("/embedding-jobs", { profileId: profiles.profiles[0].id });
  const originalDatabase = await post("/database-jobs", { profileId: "local", embeddingJobId: originalEmbedding.job.id });
  const restored = await (await fetch(path + "/database-records?profileId=local")).json() as any;
  assert.deepEqual(restored.records.map((item: any) => item.chunkId).sort(), originalAgain.reviewState.draft.chunks.map((item: any) => item.id).sort(), "A-B-A must restore retired records");
  assert.equal((await post("/database-jobs", { profileId: "local", embeddingJobId: originalEmbedding.job.id })).reused, true, "the latest successful write remains idempotent");
  await post("/chunks", { strategy: "structure", chunkSize: 64, chunkOverlap: 0 });
  await post("/review/confirm", { confirmReplacement: true });
  const stale = await fetch(path + "/database-jobs", { method: "POST", headers,
    body: JSON.stringify({ profileId: "local", embeddingJobId: nextEmbedding.job.id }) });
  assert.equal(stale.status, 409, "outdated child vectors must not be paired with a new draft");
} finally {
  if (child.exitCode === null) { child.kill(); await once(child, "exit"); }
}
console.log("Simple workflow HTTP tests passed");
