import assert from "node:assert/strict";
import { MemoryAssetObjectStore } from "./object-store.js";

const store = new MemoryAssetObjectStore("acceptance-assets");
const bytes = new TextEncoder().encode("object payload");
const stored = await store.put({
  assetClass: "mineru_trusted_result",
  bytes,
  contentType: "application/json",
  batchId: "acceptance-batch-1",
  documentId: "doc-1",
  sourceDocumentVersion: "source-v1",
  assetVersion: "trusted-v1",
  extension: "json",
  createdAt: "2026-08-16T07:00:00.000Z",
});
const repeated = await store.put({
  assetClass: "mineru_trusted_result",
  bytes,
  contentType: "application/json",
  batchId: "acceptance-batch-1",
  documentId: "doc-1",
  sourceDocumentVersion: "source-v1",
  assetVersion: "trusted-v1",
  extension: "json",
  createdAt: "2026-08-16T07:00:00.000Z",
});
assert.equal(stored.cacheHit, false);
assert.equal(repeated.cacheHit, true);
assert.equal(store.writeCount, 1);
assert.deepEqual(await store.get(stored.reference.key), bytes);
assert.equal((await store.head(stored.reference.key))?.checksumSha256, stored.reference.checksumSha256);
assert.equal(new TextDecoder().decode(await store.getRange(stored.reference.key, 0, 4)), "objec");
assert.equal((await store.list({ batchId: "acceptance-batch-1" })).length, 1);

await assert.rejects(
  () => store.softDelete(stored.reference.key, {
    at: "2026-08-16T08:00:00.000Z",
    deleteAfter: "2026-08-17T08:00:00.000Z",
    activeReferenceCount: 1,
    reason: "document_delete",
  }),
  /active references/,
);
const deleted = await store.softDelete(stored.reference.key, {
  at: "2026-08-16T08:00:00.000Z",
  deleteAfter: "2026-08-17T08:00:00.000Z",
  activeReferenceCount: 0,
  reason: "document_delete",
});
assert.equal(deleted.deletedAt, "2026-08-16T08:00:00.000Z");
assert.equal((await store.softDelete(stored.reference.key, {
  at: "2026-08-16T09:00:00.000Z",
  deleteAfter: "2026-08-18T08:00:00.000Z",
  activeReferenceCount: 0,
  reason: "document_delete",
})).deleteAfter, deleted.deleteAfter, "soft delete is idempotent");

const early = await store.collectGarbage({
  now: "2026-08-17T07:59:59.000Z",
  allowedPrefix: "v1/mineru-trusted-result/acceptance-batch-1/",
});
assert.deepEqual(early, { examined: 1, deleted: 0, retained: 1 });
const collected = await store.collectGarbage({
  now: "2026-08-17T08:00:00.000Z",
  allowedPrefix: "v1/mineru-trusted-result/acceptance-batch-1/",
});
assert.deepEqual(collected, { examined: 1, deleted: 1, retained: 0 });
assert.equal(await store.head(stored.reference.key), null);
assert.equal(store.auditRecords.filter((record) => record.action === "physical_delete").length, 1);
assert.deepEqual(await store.collectGarbage({
  now: "2026-08-18T08:00:00.000Z",
  allowedPrefix: "v1/mineru-trusted-result/acceptance-batch-1/",
}), { examined: 0, deleted: 0, retained: 0 }, "GC is idempotent");
await assert.rejects(
  () => store.collectGarbage({ now: "2026-08-18T08:00:00.000Z", allowedPrefix: "v1/" }),
  /dedicated prefix/,
);

console.log("Object store lifecycle tests passed");
