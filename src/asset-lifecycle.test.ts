import assert from "node:assert/strict";
import { sweepAssetLifecycle } from "./asset-lifecycle.js";
import { MemoryAssetObjectStore } from "./object-store.js";
import type { AssetObjectStore } from "./object-store.js";

const store = new MemoryAssetObjectStore("lifecycle-assets");
const bytes = new TextEncoder().encode("lifecycle fixture");

async function put(
  assetClass: "source_original" | "office_visual_copy" | "diagnostic_package",
  documentId: string,
  createdAt: string,
  assetVersion: string,
) {
  return (await store.put({
    assetClass,
    bytes,
    contentType: assetClass === "source_original"
      ? "application/pdf"
      : assetClass === "office_visual_copy"
        ? "application/pdf"
        : "application/json",
    batchId: "lifecycle-acceptance",
    documentId,
    sourceDocumentVersion: "source-v1",
    assetVersion,
    extension: assetClass === "diagnostic_package" ? "json" : "pdf",
    createdAt,
  })).reference;
}

const protectedSource = await put(
  "source_original",
  "doc-live",
  "2026-07-01T00:00:00.000Z",
  "protected-v1",
);
const failedSource = await put(
  "source_original",
  "doc-failed",
  "2026-08-01T00:00:00.000Z",
  "failed-v1",
);
const orphanSource = await put(
  "source_original",
  "doc-missing",
  "2026-08-01T00:00:00.000Z",
  "orphan-v1",
);
const mixedSource = await put(
  "source_original",
  "doc-failed",
  "2026-08-01T00:00:00.000Z",
  "mixed-v1",
);
const expiredVisualCopy = await put(
  "office_visual_copy",
  "doc-live",
  "2026-07-01T00:00:00.000Z",
  "expired-v1",
);
const expiredDiagnostic = await put(
  "diagnostic_package",
  "doc-live",
  "2026-08-15T00:00:00.000Z",
  "diagnostic-v1",
);

const references = [
  { key: protectedSource.key, state: "active" as const },
  { key: failedSource.key, state: "failed" as const },
  { key: mixedSource.key, state: "failed" as const },
  { key: mixedSource.key, state: "active" as const },
  { key: expiredVisualCopy.key, state: "active" as const },
  { key: expiredDiagnostic.key, state: "active" as const },
];

const result = await sweepAssetLifecycle(store, {
  now: "2026-08-16T12:00:00.000Z",
  allowedPrefix: "v1/source-original/lifecycle-acceptance/",
  references,
  deleteGraceMs: 24 * 60 * 60 * 1000,
});
assert.deepEqual(result, {
  examined: 4,
  softDeleted: 2,
  retained: 2,
  alreadyDeleted: 0,
  failed: 0,
  reasons: { expired: 0, orphan: 2 },
  failures: [],
});
assert.equal((await store.head(protectedSource.key))?.deletedAt, null);
assert.equal((await store.head(mixedSource.key))?.deletedAt, null);
assert.equal((await store.head(failedSource.key))?.deleteAfter, "2026-08-17T12:00:00.000Z");
assert.equal((await store.head(orphanSource.key))?.deletedAt, "2026-08-16T12:00:00.000Z");

const expiringResult = await sweepAssetLifecycle(store, {
  now: "2026-08-16T12:00:00.000Z",
  allowedPrefix: "v1/office-visual-copy/lifecycle-acceptance/",
  references,
  deleteGraceMs: 0,
});
assert.equal(expiringResult.softDeleted, 1);
assert.equal(expiringResult.reasons.expired, 1);
assert.equal((await store.head(expiredVisualCopy.key))?.deletedAt, "2026-08-16T12:00:00.000Z");

const diagnosticResult = await sweepAssetLifecycle(store, {
  now: "2026-08-16T12:00:00.000Z",
  allowedPrefix: "v1/diagnostic-package/lifecycle-acceptance/",
  references,
  deleteGraceMs: 0,
});
assert.equal(diagnosticResult.softDeleted, 1);
assert.equal(diagnosticResult.reasons.expired, 1);

const repeated = await sweepAssetLifecycle(store, {
  now: "2026-08-16T13:00:00.000Z",
  allowedPrefix: "v1/source-original/lifecycle-acceptance/",
  references,
  deleteGraceMs: 0,
});
assert.equal(repeated.softDeleted, 0);
assert.equal(repeated.alreadyDeleted, 2);
assert.equal(
  store.auditRecords.filter((record) => record.action === "soft_delete").length,
  4,
  "idempotent sweep does not append duplicate tombstone audit records",
);

const isolatedStore = new MemoryAssetObjectStore("lifecycle-isolation");
const firstIsolated = (await isolatedStore.put({
  assetClass: "source_original",
  bytes,
  contentType: "application/pdf",
  batchId: "lifecycle-isolation",
  documentId: "missing-1",
  assetVersion: "source-v1",
  extension: "pdf",
  createdAt: "2026-08-01T00:00:00.000Z",
})).reference;
const secondIsolated = (await isolatedStore.put({
  assetClass: "source_original",
  bytes: new TextEncoder().encode("second payload"),
  contentType: "application/pdf",
  batchId: "lifecycle-isolation",
  documentId: "missing-2",
  assetVersion: "source-v1",
  extension: "pdf",
  createdAt: "2026-08-01T00:00:00.000Z",
})).reference;
const failingBoundary: AssetObjectStore = {
  put: (input) => isolatedStore.put(input),
  get: (key) => isolatedStore.get(key),
  head: (key) => isolatedStore.head(key),
  list: (filter) => isolatedStore.list(filter),
  collectGarbage: (input) => isolatedStore.collectGarbage(input),
  softDelete: (key, input) => key === firstIsolated.key
    ? Promise.reject(new Error("fixture storage credential must stay hidden"))
    : isolatedStore.softDelete(key, input),
};
const isolated = await sweepAssetLifecycle(failingBoundary, {
  now: "2026-08-16T12:00:00.000Z",
  allowedPrefix: "v1/source-original/lifecycle-isolation/",
  references: [],
  deleteGraceMs: 0,
});
assert.equal(isolated.softDeleted, 1);
assert.equal(isolated.failed, 1);
assert.deepEqual(isolated.failures, [{
  key: firstIsolated.key,
  code: "SOFT_DELETE_FAILED",
}]);
assert.equal((await isolatedStore.head(firstIsolated.key))?.deletedAt, null);
assert.equal((await isolatedStore.head(secondIsolated.key))?.deletedAt, "2026-08-16T12:00:00.000Z");

await assert.rejects(
  () => sweepAssetLifecycle(store, {
    now: "2026-08-16T12:00:00.000Z",
    allowedPrefix: "v1/",
    references,
    deleteGraceMs: 0,
  }),
  /dedicated prefix/,
);

console.log("Asset lifecycle sweep tests passed");
