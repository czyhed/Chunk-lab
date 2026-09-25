import assert from "node:assert/strict";
import { readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { WorkspaceStore } from "./workspace.js";

const root = resolve(".workspace", `test-${process.pid}`);
const store = new WorkspaceStore(root);
await store.writeBatch("batch-1", { id: "batch-1", value: "可恢复" });
assert.deepEqual(await store.readBatch("batch-1"), {
  id: "batch-1",
  value: "可恢复",
});
assert.equal(await store.readBatch("missing"), null);

await store.writeSpuCatalog({ contractVersion: "spu-catalog-1", categories: [], spus: [] });
assert.deepEqual(await store.readSpuCatalog(), {
  contractVersion: "spu-catalog-1",
  categories: [],
  spus: [],
});

const concurrentWrites = Array.from({ length: 16 }, (_, sequence) =>
  store.writeBatch("concurrent", {
    id: "concurrent",
    sequence,
    payload: String(sequence).padStart(2, "0").repeat(128 * 1024),
  })
);
const concurrentResults = await Promise.allSettled(concurrentWrites);
assert.equal(
  concurrentResults.filter((result) => result.status === "fulfilled").length,
  concurrentWrites.length,
  "every same-Batch concurrent write succeeds",
);
const persistedConcurrent = JSON.parse(
  await readFile(resolve(root, "batches", "concurrent.json"), "utf8"),
) as { id: string; sequence: number };
assert.equal(
  persistedConcurrent.sequence,
  concurrentWrites.length - 1,
  "the last invoked write is the final persisted Batch state",
);
assert.deepEqual(
  (await readdir(resolve(root, "batches"))).filter((name) =>
    name.startsWith("concurrent.json") && name.endsWith(".tmp")
  ),
  [],
  "same-Batch concurrent writes leave no temporary files",
);

const expiredPath = resolve(root, "batches", "expired.json");
await writeFile(expiredPath, JSON.stringify({ id: "expired" }), "utf8");
const expiredAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
await utimes(expiredPath, expiredAt, expiredAt);
assert.equal(
  await store.readBatch("expired"),
  null,
  "Temporary Workspace batches older than 24 hours must expire",
);
assert.deepEqual(
  await store.readBatchForMaintenance<{ id: string }>("expired"),
  { id: "expired" },
  "maintenance can read reference metadata without reopening the expired editing session",
);

const source = resolve(root, "source.md");
await writeFile(source, "# A1", "utf8");
const asset = await store.saveAsset("batch-1", "doc-1", "manual.md", source);
assert.equal(asset.endsWith("doc-1.md"), true);

await assert.rejects(() => store.readBatch("../secret"), /Invalid workspace id/);

const diagnostic = {
  packageKind: "v21-diagnostic",
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  value: "safe diagnostic",
};
await store.writeDiagnostic("diag-1", diagnostic);
assert.deepEqual(await store.readDiagnostic("diag-1"), diagnostic);
assert.deepEqual(await store.readDiagnosticState("diag-1"), {
  status: "available",
  value: diagnostic,
});
await store.writeDiagnostic("expired-diag", {
  ...diagnostic,
  expiresAt: new Date(Date.now() - 1_000).toISOString(),
});
assert.equal(await store.readDiagnostic("expired-diag"), null);
assert.deepEqual(await store.readDiagnosticState("expired-diag"), {
  status: "expired",
});
assert.deepEqual(await store.readDiagnosticState("missing-diag"), {
  status: "missing",
});
await assert.rejects(
  () => store.writeDiagnostic("../secret", diagnostic),
  /Invalid workspace id/,
);
console.log("Workspace store tests passed");
