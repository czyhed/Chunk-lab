import assert from "node:assert/strict";
import {
  ASSET_CONTRACT_VERSION,
  assetPolicy,
  buildAssetDescriptor,
  containsForbiddenPersistentPayload,
} from "./asset-contract.js";

const classes = [
  "source_original",
  "mineru_raw_response",
  "mineru_result_zip",
  "mineru_trusted_result",
  "parsed_document_snapshot",
  "office_visual_copy",
  "pdf_page_render",
  "pdf_image_crop",
  "extracted_image",
  "model_input",
  "export_package",
  "diagnostic_package",
] as const;

assert.equal(ASSET_CONTRACT_VERSION, "1.0");
for (const assetClass of classes) {
  const policy = assetPolicy(assetClass);
  assert.match(policy.prefix, /^v1\/[a-z0-9-]+$/);
  assert.equal(policy.visibility, "private");
}

assert.equal(assetPolicy("source_original").retention.kind, "document_delete");
assert.equal(assetPolicy("parsed_document_snapshot").retention.kind, "document_delete");
assert.equal(assetPolicy("pdf_image_crop").retention.kind, "document_delete");
assert.deepEqual(assetPolicy("mineru_result_zip").retention, { kind: "days", days: 30 });
assert.deepEqual(assetPolicy("office_visual_copy").retention, { kind: "days", days: 30 });
assert.deepEqual(assetPolicy("diagnostic_package").retention, { kind: "hours", hours: 24 });
assert.deepEqual(assetPolicy("export_package").retention, { kind: "days", days: 30 });

const input = {
  assetClass: "source_original" as const,
  bytes: new TextEncoder().encode("same bytes"),
  contentType: "application/pdf",
  batchId: "batch-1",
  documentId: "doc-1",
  sourceDocumentVersion: "source-v1",
  assetVersion: "original-v1",
  extension: "pdf",
  createdAt: "2026-08-16T07:00:00.000Z",
};
const first = buildAssetDescriptor(input);
const second = buildAssetDescriptor(input);
assert.deepEqual(first, second, "identical content and associations produce a stable descriptor");
assert.match(first.checksumSha256, /^[a-f0-9]{64}$/);
assert.equal(first.key.includes("batch-1/doc-1/source-v1/original-v1"), true);
assert.equal(first.key.endsWith(`${first.checksumSha256}.pdf`), true);
assert.equal(first.uri, `s3://${first.bucket}/${first.key}`);
assert.equal(first.overwriteRule, "immutable_checksum_key");
assert.equal(first.publicProjection, "metadata_only");

const changed = buildAssetDescriptor({
  ...input,
  bytes: new TextEncoder().encode("changed bytes"),
});
assert.notEqual(changed.key, first.key);

assert.equal(containsForbiddenPersistentPayload({ image: "data:image/png;base64,AA==" }), true);
assert.equal(containsForbiddenPersistentPayload({ authorization: "Bearer hidden" }), true);
assert.equal(containsForbiddenPersistentPayload({ signedUrl: "https://example.invalid?a=1" }), true);
assert.equal(containsForbiddenPersistentPayload({ object: first }), false);

console.log("Asset classification contract tests passed");
