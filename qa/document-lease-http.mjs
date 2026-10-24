import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

const port = 4491;
const env = {
  ...process.env,
  NODE_ENV: "test",
  DOCUMENT_LEASE_ENFORCEMENT: "1",
  REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  DOCUMENT_LEASE_TTL_SECONDS: "2",
  PORT: String(port),
  WORKSPACE_ROOT: ".workspace/document-lease-http",
  MINERU_API_TOKEN: "document-lease-test",
  EMBEDDING_BASE_URL: "http://127.0.0.1:9/v1",
  EMBEDDING_API_KEY: "document-lease-test",
  EMBEDDING_MODEL: "document-lease-test",
};
const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/server.ts"], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });
const base = `http://127.0.0.1:${port}`;
const headers = (userId, sessionId, leaseId) => ({ "x-user-id": userId, "x-session-id": sessionId, ...(leaseId ? { "x-document-lease-id": leaseId } : {}) });
async function waitForHealth() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start: ${output}`);
}
async function json(path, init) {
  const response = await fetch(`${base}${path}`, init);
  const body = await response.json();
  return { response, body };
}
try {
  await waitForHealth();
  const form = new FormData();
  form.append("files", new Blob(["# Lease document\n\nThis is a document for lease testing."], { type: "text/markdown" }), "lease.md");
  const created = await json("/api/batches", { method: "POST", body: form });
  assert.equal(created.response.status, 202);
  const batch = created.body;
  const document = batch.documents[0];
  const a = headers("user-a", "session-a");
  const b = headers("user-b", "session-b");
  const leaseA = await json(`/api/batches/${batch.id}/documents/${document.id}/lease`, { method: "POST", headers: a, body: "{}" });
  assert.equal(leaseA.response.status, 200);
  const leaseId = leaseA.body.leaseId;
  const leaseB = await json(`/api/batches/${batch.id}/documents/${document.id}/lease`, { method: "POST", headers: b, body: "{}" });
  assert.equal(leaseB.response.status, 423);
  const aHeaders = { ...a, ...headers("user-a", "session-a", leaseId), "content-type": "application/json" };
  const preview = await json(`/api/batches/${batch.id}/documents/${document.id}/chunks`, { method: "POST", headers: aHeaders, body: JSON.stringify({ strategy: "structure", chunkSize: 512, chunkOverlap: 0, imagePolicy: "summary" }) });
  assert.equal(preview.response.status, 200);
  const confirmed = await json(`/api/batches/${batch.id}/documents/${document.id}/review/confirm`, { method: "POST", headers: aHeaders, body: "{}" });
  assert.equal(confirmed.response.status, 200);
  const review = await json(`/api/batches/${batch.id}/documents/${document.id}/review`, { headers: a });
  const chunkId = review.body.reviewState.draft.chunks[0].id;
  const progress = await json(`/api/batches/${batch.id}/documents/${document.id}/review/progress`, { method: "POST", headers: aHeaders, body: JSON.stringify({ action: "mark-to-here", cursorChunkId: chunkId, expectedRevision: review.body.reviewRevision }) });
  assert.equal(progress.response.status, 200);
  const released = await json(`/api/batches/${batch.id}/documents/${document.id}/lease`, { method: "DELETE", headers: aHeaders, body: JSON.stringify({ leaseId }) });
  assert.equal(released.response.status, 200);
  const reacquired = await json(`/api/batches/${batch.id}/documents/${document.id}/lease`, { method: "POST", headers: b, body: "{}" });
  assert.equal(reacquired.response.status, 200);
  console.log("Document lease HTTP integration passed");
} finally {
  child.kill();
  await once(child, "exit").catch(() => {});
}
