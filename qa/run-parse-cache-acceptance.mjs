import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const baseUrl = process.env.PARSE_CACHE_BASE_URL || "http://127.0.0.1:3137";
const sourcePath = "materials/pdf/产品技术白皮书.pdf";
const outputDir = "output/parse-cache-acceptance";
await mkdir(outputDir, { recursive: true });

const original = new Uint8Array(await readFile(sourcePath));
const changed = new Uint8Array(original);
changed[changed.length - 1] ^= 1;
const configurations = {
  baseline: { modelVersion: "vlm", language: "ch", enableTable: true, enableFormula: true, isOcr: false },
  tableDisabled: { modelVersion: "vlm", language: "ch", enableTable: false, enableFormula: true, isOcr: false },
};

function sha(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function configHash(config) { return sha(Buffer.from(JSON.stringify({ parser_version: "mineru-api-v4", model_version: config.modelVersion, language: config.language, enable_table: config.enableTable, enable_formula: config.enableFormula, is_ocr: config.isOcr }))); }
async function upload(name, bytes, config) {
  const form = new FormData();
  form.append("config", JSON.stringify(config));
  form.append("files", new Blob([bytes], { type: "application/pdf" }), name);
  const response = await fetch(`${baseUrl}/api/batches`, { method: "POST", body: form });
  assert.equal(response.status, 202);
  const batch = await response.json();
  const document = batch.documents[0];
  let current = batch;
  const deadline = Date.now() + 20 * 60 * 1000;
  while (!["done", "failed"].includes(document.state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const polled = await fetch(`${baseUrl}/api/batches/${batch.id}`);
    assert.equal(polled.status, 200);
    current = await polled.json();
    Object.assign(document, current.documents[0]);
  }
  return { batch: current, document };
}

const first = await upload("产品技术白皮书.pdf", original, configurations.baseline);
const second = await upload("manual-renamed.pdf", original, configurations.baseline);
const changedUpload = await upload("manual-renamed.pdf", changed, configurations.baseline);
const configChanged = await upload("manual-config.pdf", original, configurations.tableDisabled);

assert.equal(first.document.contentSha256, second.document.contentSha256);
assert.equal(first.document.parserConfigFingerprint, second.document.parserConfigFingerprint);
assert.equal(second.document.parseCacheReused, true);
assert.notEqual(first.document.contentSha256, changedUpload.document.contentSha256);
assert.notEqual(first.document.parserConfigFingerprint, configChanged.document.parserConfigFingerprint);
assert.notEqual(first.document.id, second.document.id);
assert.notEqual(first.batch.id, second.batch.id);

const evidence = {
  generatedAt: new Date().toISOString(),
  source: { path: sourcePath, originalByteLength: original.length, modifiedByteLength: changed.length },
  configurationSummary: Object.fromEntries(Object.entries(configurations).map(([key, value]) => [key, { ...value, fingerprintSha256: configHash(value) }])),
  uploads: [first, second, changedUpload, configChanged].map(({ batch, document }) => ({
    batchId: batch.id,
    documentId: document.id,
    originalFileName: document.name,
    contentSha256: document.contentSha256,
    parserConfigFingerprint: document.parserConfigFingerprint,
    parseCacheStatus: document.parseCacheStatus,
    parseCacheReused: document.parseCacheReused === true,
    mineruBatchId: document.sourceContract?.parseJobId ?? null,
    state: document.state,
    publicAssetReferences: [document.parsedDocumentAssetRef, document.mineruResultAssetRef].filter(Boolean),
  })),
  acceptance: {
    sameContentDifferentName: second.document.parseCacheReused === true,
    changedBytesSameSize: first.document.contentSha256 !== changedUpload.document.contentSha256,
    changedConfigReparsed: first.document.parserConfigFingerprint !== configChanged.document.parserConfigFingerprint,
    sharedMineruBatchForReuse: first.document.sourceContract?.parseJobId === second.document.sourceContract?.parseJobId,
  },
};
await writeFile(`${outputDir}/acceptance.json`, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(JSON.stringify(evidence, null, 2));
