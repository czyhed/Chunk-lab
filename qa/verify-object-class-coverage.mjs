import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const directory = resolve("output/evidence/object-storage-real-suppliers-production-readiness");
const read = async (name) => JSON.parse(await readFile(resolve(directory, name), "utf8"));
const [mineru, chain, minio, pageRender] = await Promise.all([
  read("real-mineru-matrix.json"),
  read("real-context-embedding-full-chain.json"),
  read("minio-production-like.json"),
  read("page-render-minio.json"),
]);

const mineruClasses = new Set(mineru.entries.flatMap((entry) =>
  Object.keys(entry.objectClassCounts ?? {})
));
const chainClasses = new Set(Object.keys(chain.objects.classCounts ?? {}));
const minioClasses = new Set([
  ...(minio.objectClasses ?? []),
  ...(minio.faultObjectClasses ?? []),
]);
const pageClasses = new Set((pageRender.classes ?? []).map((value) =>
  value.replace(/^v1\//, "").replaceAll("-", "_")
));

const coverage = [
  ["source_original", "real_supplier", "real-mineru-matrix.json", mineruClasses],
  ["mineru_raw_response", "real_supplier", "real-mineru-matrix.json", mineruClasses],
  ["mineru_result_zip", "real_supplier", "real-mineru-matrix.json", mineruClasses],
  ["mineru_trusted_result", "real_supplier", "real-mineru-matrix.json", mineruClasses],
  ["parsed_document_snapshot", "real_supplier", "real-mineru-matrix.json", mineruClasses],
  ["office_visual_copy", "real_supplier", "real-mineru-matrix.json", mineruClasses],
  ["pdf_page_render", "production_like_fake_vlm", "page-render-minio.json", pageClasses],
  ["pdf_image_crop", "production_like_fake_vlm", "page-render-minio.json", pageClasses],
  ["extracted_image", "production_like_fake_vlm", "page-render-minio.json", pageClasses],
  ["model_input", "real_supplier", "real-context-embedding-full-chain.json", chainClasses],
  ["export_package", "real_supplier", "real-context-embedding-full-chain.json", chainClasses],
  ["diagnostic_package", "production_like", "minio-production-like.json", minioClasses],
].map(([assetClass, evidenceKind, evidenceFile, classes]) => {
  assert.equal(classes.has(assetClass), true, `missing evidence for ${assetClass}`);
  return { assetClass, evidenceKind, evidenceFile, verified: true };
});

assert.equal(mineru.materialCount, 7);
assert.equal(mineru.mineruSubmissionCount, 7);
assert.equal(mineru.mineruAutomaticRetryCount, 0);
assert.equal(mineru.entries.every((entry) => entry.publicHeadsVerified && entry.s3HeadsVerified), true);
assert.equal(pageRender.heads.every((head) => head.versioned && head.checksummed), true);
assert.equal(minio.diagnosticPackageHeadPassed, true);

const result = {
  status: "passed_with_real_vlm_pending",
  contractVersion: "1.0",
  requiredClassCount: coverage.length,
  verifiedClassCount: coverage.filter((entry) => entry.verified).length,
  realSupplierClassCount: coverage.filter((entry) => entry.evidenceKind === "real_supplier").length,
  productionLikeClassCount: coverage.filter((entry) => entry.evidenceKind !== "real_supplier").length,
  coverage,
  limitation: "VLM-derived classes use fake VLM with real MinIO because no server VLM profile/model is configured.",
};
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, "object-class-coverage.json"), JSON.stringify(result, null, 2), "utf8");
console.log(JSON.stringify({
  status: result.status,
  requiredClassCount: result.requiredClassCount,
  verifiedClassCount: result.verifiedClassCount,
  realSupplierClassCount: result.realSupplierClassCount,
  productionLikeClassCount: result.productionLikeClassCount,
}));
