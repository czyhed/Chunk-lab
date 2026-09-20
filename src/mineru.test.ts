import assert from "node:assert/strict";
import {
  normalizeMineruContentList,
  sanitizeMineruResponse,
  submitMineruBatch,
} from "./mineru.js";

assert.deepEqual(sanitizeMineruResponse({
  code: 0,
  data: {
    batch_id: "batch-1",
    file_urls: ["https://signed.example/upload?X-Amz-Signature=hidden"],
    extract_result: [{ data_id: "doc-1", state: "done", full_zip_url: "https://signed.example/result" }],
  },
  Authorization: "Bearer hidden",
}), {
  code: 0,
  data: {
    batch_id: "batch-1",
    file_urls: ["[REDACTED_SIGNED_URL]"],
    extract_result: [{ data_id: "doc-1", state: "done", full_zip_url: "[REDACTED_SIGNED_URL]" }],
  },
});

const blocks = normalizeMineruContentList([
  {
    type: "title",
    text: "A1 智能料理机",
    text_level: 1,
    page_idx: 0,
    bbox: [12, 24, 320, 68],
    reading_order: 7,
    parent_id: "section-root",
    group_id: "product-a1",
    product_identity: "品牌 X / A1",
    source_backend: "mineru-vlm",
    source_version: "2.1.0",
  },
  {
    type: "text",
    text: "请先断开电源。",
    page_idx: 0,
    bbox: [12, 80, 320, 112],
    role: "warning",
    parentId: "section-root",
    groupId: "warning-1",
    productIdentity: "品牌 X / A1",
    parserVersion: "2.1.0",
  },
  {
    type: "table",
    table_body: "| 型号 | 功率 |\n| A1 | 1200W |",
    page_idx: 1,
    bbox: [20, 30, 400, 260],
  },
  {
    type: "image",
    image_caption: ["安装示意图"],
    page_idx: 1,
    bbox: [30, 280, 390, 620],
    img_path: "images/install.png",
  },
]);

assert.deepEqual(blocks[0], {
  id: "b-1",
  type: "text",
  text: "A1 智能料理机",
  page: 1,
  bbox: [12, 24, 320, 68],
  readingOrder: 7,
  role: "heading",
  parentId: "section-root",
  groupId: "product-a1",
  productIdentity: "品牌 X / A1",
  sourceBackend: "mineru-vlm",
  sourceVersion: "2.1.0",
});

assert.equal(blocks[1].readingOrder, 1, "array order is the deterministic fallback");
assert.equal(blocks[1].role, "warning");
assert.equal(blocks[1].parentId, "section-root");
assert.equal(blocks[1].groupId, "warning-1");
assert.equal(blocks[1].productIdentity, "品牌 X / A1");
assert.equal(blocks[1].sourceBackend, "mineru");
assert.equal(blocks[1].sourceVersion, "2.1.0");

assert.equal(blocks[2].role, "table");
assert.equal(blocks[2].readingOrder, 2);
assert.equal(blocks[2].sourceBackend, "mineru");
assert.equal(blocks[3].role, "image");
assert.equal(blocks[3].readingOrder, 3);
assert.equal(blocks[3].imagePath, "images/install.png");

const originalFetch = globalThis.fetch;
const originalBaseUrl = process.env.MINERU_BASE_URL;
process.env.MINERU_BASE_URL = "http://127.0.0.1:49999/api/v4";
let controlPlaneUrl = "";
const signedUploadHeaders: Array<HeadersInit | undefined> = [];
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.endsWith("/file-urls/batch")) {
    controlPlaneUrl = url;
    return Response.json({
      code: 0,
      msg: "ok",
      data: {
        batch_id: "fake-batch-1",
        file_urls: ["https://signed.example/ok", "https://signed.example/fail"],
      },
    });
  }
  signedUploadHeaders.push(init?.headers);
  return new Response(null, { status: url.endsWith("/fail") ? 503 : 200 });
};
try {
  const submission = await submitMineruBatch(
    "secret-test-token",
    [
      { id: "ok", name: "ok.pdf", path: "qa/v21-source-sample.pdf" },
      { id: "bad", name: "bad.pdf", path: "qa/v21-source-sample.pdf" },
    ],
    {
      modelVersion: "vlm",
      language: "ch",
      enableFormula: true,
      enableTable: true,
      isOcr: false,
    },
  );
  assert.deepEqual(submission, {
    batchId: "fake-batch-1",
    uploadedDocumentIds: ["ok"],
    failures: [
      {
        documentId: "bad",
        name: "bad.pdf",
        error: "MinerU upload failed: HTTP 503",
      },
    ],
  });
  assert.deepEqual(signedUploadHeaders, [undefined, undefined]);
  assert.equal(
    controlPlaneUrl,
    "http://127.0.0.1:49999/api/v4/file-urls/batch",
  );
} finally {
  globalThis.fetch = originalFetch;
  if (originalBaseUrl === undefined) delete process.env.MINERU_BASE_URL;
  else process.env.MINERU_BASE_URL = originalBaseUrl;
}

console.log("MinerU normalization tests passed");
