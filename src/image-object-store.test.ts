import assert from "node:assert/strict";
import {
  createConfiguredImageObjectStore,
  MemoryImageObjectStore,
} from "./image-object-store.js";

const store = new MemoryImageObjectStore("issue-10-images");
const input = {
  bytes: new Uint8Array([1, 2, 3, 4]),
  contentType: "image/png",
  source: "pdf_crop" as const,
  sourceDocumentVersion: "src-demo",
};
const first = await store.store(input);
const second = await store.store(input);

assert.equal(first.cacheHit, false);
assert.equal(second.cacheHit, true);
assert.equal(store.writeCount, 1);
assert.equal(first.reference.uri, second.reference.uri);
assert.match(first.reference.uri, /^s3:\/\/issue-10-images\/v1\/pdf-image-crop\//);
assert.equal(first.reference.contractVersion, "1.0");
assert.equal(first.reference.visibility, "private");
assert.equal(first.reference.assetClass, "pdf_image_crop");
assert.equal(first.reference.batchId, "image-batch");
assert.equal(first.reference.documentId, "image-document");
assert.equal(JSON.stringify(first.reference).includes("base64"), false);
assert.equal(JSON.stringify(first.reference).includes("AQIDBA"), false);
assert.equal(createConfiguredImageObjectStore({
  MINIO_ENDPOINT: "http://127.0.0.1:9000",
  MINIO_BUCKET: "configured-without-credentials",
}), null, "partial configuration stays isolated until an image route is used");

console.log("Image object store reference and cache tests passed");
