import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const baseUrl = process.env.ISSUE12_BASE_URL ?? "http://127.0.0.1:4400";
const network = [];
async function request(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  network.push({ method: init?.method ?? "GET", route: path.replace(/[0-9a-f-]{20,}/gi, ":id"), status: response.status });
  const payload = await response.json();
  assert.equal(response.ok, true, `${path}: ${response.status}`);
  return payload;
}

const catalog = await request("/api/embedding-profiles");
assert.equal(catalog.profiles.some((profile) => profile.id === "deterministic-partial"), true);
assert.doesNotMatch(JSON.stringify(catalog), /apiKey|baseUrl|Authorization/);

const batch = await request("/api/demo", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
const documentId = batch.documents[0].id;
const confirmed = await request(
  `/api/batches/${batch.id}/documents/${documentId}/review/confirm`,
  { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
);
const draftChunks = confirmed.reviewState.draft.chunks;
const ineligibleIds = draftChunks.filter((chunk) =>
  chunk.excluded || chunk.embeddingEligible !== true || chunk.embeddingExclusionReasons?.length
).map((chunk) => chunk.id);
assert.ok(ineligibleIds.length > 0);

const createPath = `/api/batches/${batch.id}/documents/${documentId}/embedding-jobs`;
const initial = await request(createPath, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ profileId: "deterministic-partial" }),
});
assert.equal(initial.reused, false);
assert.equal(initial.job.summary.failed, 1);
assert.ok(initial.job.summary.succeeded > 0);
assert.ok(initial.job.summary.skipped > 0);
assert.equal(initial.job.items.filter((item) => item.status === "skipped").every(
  (item) => ineligibleIds.includes(item.chunkId),
), true);
assert.equal(initial.job.items.filter((item) => item.status === "succeeded").every(
  (item) => item.vectorRecord.schemaVersion === "1.0" &&
    item.vectorRecord.vector.length === 16,
), true);

const idempotent = await request(createPath, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ profileId: "deterministic-partial" }),
});
assert.equal(idempotent.reused, true);
assert.equal(idempotent.job.id, initial.job.id);

const retried = await request(`${createPath}/${initial.job.id}/retry`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
assert.equal(retried.job.summary.failed, 0);
assert.equal(retried.job.status, "completed");
const retriedItem = retried.job.items.find((item) =>
  initial.job.items.some((previous) => previous.chunkId === item.chunkId && previous.status === "failed")
);
assert.equal(retriedItem.attempts, 2);

const recovered = await request(`${createPath}/${initial.job.id}`);
assert.deepEqual(recovered.job, retried.job);
assert.doesNotMatch(JSON.stringify(recovered), /data:image|base64,|Authorization|apiKey/);

const evidence = {
  acceptedAt: new Date().toISOString(),
  catalog: catalog.profiles,
  jobId: initial.job.id,
  idempotencyKeyPresent: typeof initial.job.idempotencyKey === "string",
  initialSummary: initial.job.summary,
  retrySummary: retried.job.summary,
  retryAttempt: retriedItem.attempts,
  vectorSchemaVersion: "1.0",
  vectorDimensions: 16,
  ineligibleIds,
  paidEmbeddingCalls: 0,
  network,
};
const directory = resolve("output/issue12-embedding-job");
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, "http-acceptance.json"), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({
  ok: true,
  initial: evidence.initialSummary,
  retried: evidence.retrySummary,
  paidEmbeddingCalls: 0,
}));
