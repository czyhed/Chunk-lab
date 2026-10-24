import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const baseUrl = process.env.ISSUE13_BASE_URL ?? "http://127.0.0.1:4410";
const network = [];
async function request(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  network.push({
    method: init?.method ?? "GET",
    route: path.replace(/[0-9a-f-]{20,}/gi, ":id"),
    status: response.status,
  });
  const payload = await response.json();
  assert.equal(response.ok, true, `${path}: ${response.status}`);
  return payload;
}

const catalog = await request("/api/database-profiles");
assert.deepEqual(catalog.profiles, [{
  id: "local-pgvector",
  name: "本地 PostgreSQL + pgvector",
  kind: "pgvector",
  schemaVersion: "1.0",
}]);
assert.doesNotMatch(JSON.stringify(catalog), /password|baseUrl|Authorization|apiKey/i);

const batch = await request("/api/demo", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ imageScenario: "three" }),
});
const documentId = batch.documents[0].id;
const batchId = batch.id;
const confirmed = await request(
  `/api/batches/${batchId}/documents/${documentId}/review/confirm`,
  { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
);
const images = confirmed.reviewState.draft.chunks.filter((chunk) => chunk.type === "image");
assert.equal(images.length, 3);
const [summaryImage, referenceImage, excludedImage] = images;

async function saveImage(chunkId, body) {
  return request(
    `/api/batches/${batchId}/documents/${documentId}/chunks/${encodeURIComponent(chunkId)}/image-summary`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}
await request(
  `/api/batches/${batchId}/documents/${documentId}/chunks/${encodeURIComponent(summaryImage.id)}/vlm-summary`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileId: "fake-vlm" }),
  },
);
await saveImage(summaryImage.id, {
  imagePolicy: "summary",
  humanSummary: "人工确认：杯体沿顺时针方向锁定。",
  humanSupplement: "适用于星澜 A1 型号。",
});
await saveImage(referenceImage.id, { imagePolicy: "reference", humanSummary: "", humanSupplement: "" });
await saveImage(excludedImage.id, { imagePolicy: "exclude", humanSummary: "不进入检索。", humanSupplement: "" });

const review = await request(`/api/batches/${batchId}/documents/${documentId}/review`);
const draftChunks = review.reviewState.draft.chunks;
const ineligibleIds = draftChunks.filter((chunk) =>
  chunk.excluded || chunk.embeddingEligible !== true || chunk.embeddingExclusionReasons?.length,
).map((chunk) => chunk.id);
assert.ok(ineligibleIds.includes(excludedImage.id));
const embedding = await request(
  `/api/batches/${batchId}/documents/${documentId}/embedding-jobs`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileId: "deterministic-fake" }),
  },
);
const databasePath = `/api/batches/${batchId}/documents/${documentId}/database-jobs`;
const initial = await request(databasePath, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ profileId: "local-pgvector", embeddingJobId: embedding.job.id }),
});
assert.equal(initial.job.status, "partial_failure");
assert.equal(initial.job.summary.failed, 1);
assert.ok(initial.job.summary.written > 0);
assert.ok(initial.job.summary.skipped > 0);
assert.equal(initial.job.items.some((item) => item.chunkId === excludedImage.id && item.status === "skipped"), true);

const idempotent = await request(databasePath, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ profileId: "local-pgvector", embeddingJobId: embedding.job.id }),
});
assert.equal(idempotent.reused, true);
const retried = await request(`${databasePath}/${initial.job.id}/retry`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
assert.equal(retried.job.status, "completed");
assert.equal(retried.job.summary.failed, 0);
assert.equal(retried.job.items.some((item) => item.attempts === 2), true);

const records = await request(
  `/api/batches/${batchId}/documents/${documentId}/database-records?profileId=local-pgvector`,
);
assert.ok(records.records.length > 0);
assert.equal(records.records.some((record) => "vector" in record), false);
assert.doesNotMatch(JSON.stringify(records), /data:image|base64,/i);
const imageRecord = records.records.find((record) => record.chunkType === "image");
assert.ok(imageRecord?.imageObjectReference?.uri?.startsWith("s3://"));

const changedChunk = draftChunks.find((chunk) => chunk.type === "text" && chunk.embeddingEligible === true);
assert.ok(changedChunk);
await request(
  `/api/batches/${batchId}/documents/${documentId}/chunks/${encodeURIComponent(changedChunk.id)}/reviewed-model`,
  {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reviewedModel: { type: "paragraph", text: "仅这一条 Chunk 被修改并重新入库。" } }),
  },
);
const changedReview = await request(`/api/batches/${batchId}/documents/${documentId}/review`);
const changedEmbeddingJob = await request(
  `/api/batches/${batchId}/documents/${documentId}/embedding-jobs`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileId: "deterministic-fake" }),
  },
);
const changedDatabase = await request(databasePath, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ profileId: "local-pgvector", embeddingJobId: changedEmbeddingJob.job.id }),
});
assert.equal(changedDatabase.job.status, "completed");
assert.equal(changedDatabase.job.summary.written, 1);
assert.ok(changedDatabase.job.summary.unchanged > 0);
assert.equal(changedReview.reviewState.draft.chunks.find((chunk) => chunk.id === changedChunk.id).finalText, "仅这一条 Chunk 被修改并重新入库。");

const publicBatch = await request(`/api/batches/${batchId}`);
assert.equal(publicBatch.documents[0].databaseJob.status, "completed");

const evidence = {
  acceptedAt: new Date().toISOString(),
  batchId,
  documentId,
  catalog: catalog.profiles,
  initialSummary: initial.job.summary,
  retrySummary: retried.job.summary,
  changedRecordSummary: changedDatabase.job.summary,
  recordCount: records.records.length,
  imageReferencePersisted: Boolean(imageRecord?.imageObjectReference?.uri?.startsWith("s3://")),
  excludedChunkWritten: records.records.some((record) => record.chunkId === excludedImage.id),
  vectorValuesReturned: records.records.some((record) => "vector" in record),
  publicBatchRestored: publicBatch.documents[0].databaseJob.status === "completed",
  paidEmbeddingCalls: 0,
  paidVlmCalls: 0,
  network,
};
const directory = resolve("output/issue13-database-persistence");
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, "http-acceptance.json"), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, initial: evidence.initialSummary, retried: evidence.retrySummary, changed: evidence.changedRecordSummary }));
