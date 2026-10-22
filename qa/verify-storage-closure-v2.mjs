import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";

for (const name of [
  "MINIO_ENDPOINT",
  "MINIO_BUCKET",
  "MINIO_ACCESS_KEY",
  "MINIO_SECRET_KEY",
]) if (!process.env[name]?.trim()) throw new Error(`${name} is required`);

const baseUrl = process.env.APP_BASE_URL ?? "http://127.0.0.1:4180";
const matrix = JSON.parse(await readFile(
  resolve("output/evidence/object-storage-real-suppliers-production-readiness/real-mineru-matrix.json"),
  "utf8",
));
const vlmEvidence = JSON.parse(await readFile(
  resolve("output/evidence/dashscope-vlm-real-acceptance/real-vlm-chain.json"),
  "utf8",
));
const responseBodies = [];
async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${path.split("?")[0]}`);
  responseBodies.push(text);
  return JSON.parse(text);
}

const s3 = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT,
  region: process.env.MINIO_REGION || "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
  },
});
const containerHealth = Object.fromEntries(["rag-minio", "rag-postgres"].map((name) => [
  name,
  execFileSync("docker", ["inspect", "-f", "{{.State.Health.Status}}", name], {
    encoding: "utf8",
    windowsHide: true,
  }).trim(),
]));
assert.deepEqual(containerHealth, { "rag-minio": "healthy", "rag-postgres": "healthy" });

let publicHeadCount = 0;
let s3HeadCount = 0;
const materialResults = [];
try {
  for (const entry of matrix.entries) {
    const batch = await getJson(`/api/batches/${entry.batchId}`);
    const document = batch.documents.find((candidate) => candidate.id === entry.documentId);
    assert.equal(document?.state, "done", `${entry.fileName} did not recover as done`);
    const listed = await getJson(`/api/batches/${entry.batchId}/objects`);
    const selected = [];
    for (const [assetClass, expectedCount] of Object.entries(entry.objectClassCounts)) {
      const candidates = listed.objects.filter((object) =>
        object.assetClass === assetClass &&
        (assetClass === "mineru_raw_response" || object.documentId === entry.documentId)
      );
      assert.equal(candidates.length >= expectedCount, true, `${entry.fileName} missing ${assetClass}`);
      selected.push(...candidates.slice(0, expectedCount));
    }
    for (const object of selected) {
      const publicHead = await getJson(
        `/api/batches/${entry.batchId}/objects/head?key=${encodeURIComponent(object.key)}`,
      );
      assert.equal(publicHead.object.key, object.key);
      assert.equal(publicHead.object.checksumSha256, object.checksumSha256);
      assert.equal(/"(?:body|bytes|binary|base64|dataUrl|presignedUrl)"\s*:/.test(JSON.stringify(publicHead)), false);
      publicHeadCount += 1;
      const head = await s3.send(new HeadObjectCommand({
        Bucket: process.env.MINIO_BUCKET,
        Key: object.key,
      }));
      assert.equal(head.Metadata?.checksumsha256 ?? head.Metadata?.sha256, object.checksumSha256);
      assert.equal(Number(head.ContentLength), object.byteLength);
      assert.equal(head.ContentType, object.contentType);
      s3HeadCount += 1;
    }
    materialResults.push({
      relativePath: entry.relativePath,
      batchId: entry.batchId,
      documentId: entry.documentId,
      state: document.state,
      requiredObjectsVerified: selected.length,
    });
  }

  const profiles = await getJson("/api/model-profiles");
  const profileIds = profiles.profiles.map((profile) => profile.id);
  assert.equal(profileIds.length, 6);
  for (const id of [
    "dashscope-context",
    "dashscope-vlm",
    "dashscope-context-qwen36-flash",
    "dashscope-context-qwen-max",
    "dashscope-vlm-qwen37-flash",
    "dashscope-vlm-qwen-ocr",
  ]) assert.equal(profileIds.includes(id), true, `missing profile ${id}`);

  const { batchId, documentId, selectedImageChunkId } = vlmEvidence.material;
  const review = await getJson(`/api/batches/${batchId}/documents/${documentId}/review`);
  const chunk = review.reviewState.draft.chunks.find((candidate) => candidate.id === selectedImageChunkId);
  assert.ok(chunk, "selected image Chunk was not restored");
  assert.equal(chunk.vlmProfileId, "dashscope-vlm");
  assert.equal(chunk.vlmModel, "qwen3.8-max");
  assert.equal(chunk.vlmPromptVersion, "image-summary-v1");
  assert.equal(/[\u4e00-\u9fff]/u.test(chunk.vlmSummaryEffective), true);
  assert.equal(chunk.contextProfileId, "dashscope-context");
  assert.equal(chunk.contextReviewState, "confirmed");
  assert.equal(/[\u4e00-\u9fff]/u.test(chunk.contextText), true);
  assert.equal(chunk.embeddingEligible, true);

  const documentObjects = await getJson(`/api/batches/${batchId}/objects?documentId=${documentId}`);
  const vlmClassMinimums = { pdf_page_render: 1, pdf_image_crop: 1, model_input: 4 };
  for (const [assetClass, minimum] of Object.entries(vlmClassMinimums)) {
    const candidates = documentObjects.objects.filter((object) => object.assetClass === assetClass);
    assert.equal(candidates.length >= minimum, true, `real VLM chain missing ${assetClass}`);
    for (const object of candidates.slice(0, minimum)) {
      const publicHead = await getJson(
        `/api/batches/${batchId}/objects/head?key=${encodeURIComponent(object.key)}`,
      );
      assert.equal(publicHead.object.checksumSha256, object.checksumSha256);
      publicHeadCount += 1;
      const head = await s3.send(new HeadObjectCommand({ Bucket: process.env.MINIO_BUCKET, Key: object.key }));
      assert.equal(head.Metadata?.checksumsha256 ?? head.Metadata?.sha256, object.checksumSha256);
      s3HeadCount += 1;
    }
  }

  const database = await getJson(
    `/api/batches/${batchId}/documents/${documentId}/database-records?profileId=local-pgvector-v2-1024`,
  );
  assert.equal(database.records.length, 38);
  const imageRecord = database.records.find((record) => record.chunkId === selectedImageChunkId);
  assert.ok(imageRecord);
  assert.equal(imageRecord.vectorDimensions, 1024);
  assert.equal(imageRecord.imageObjectReference?.uri?.startsWith("s3://"), true);
  const databaseText = JSON.stringify(database);
  assert.equal(/"vector"\s*:/.test(databaseText), false);
  assert.equal(/"(?:connectionString|password|host|port|database|user)"\s*:/.test(databaseText), false);

  const exported = await getJson(`/api/batches/${batchId}/export?contractVersion=2.1`);
  const exportedDocument = exported.documents.find((document) => document.documentId === documentId);
  const exportedChunk = exportedDocument?.chunks.find((candidate) => candidate.chunkId === selectedImageChunkId);
  assert.ok(exportedChunk);
  assert.equal(exportedDocument.contractVersion, "2.1");
  assert.equal(exportedChunk.contextReviewState, "confirmed");
  assert.equal(exportedChunk.embeddingEligible, true);
  assert.equal(exportedChunk.embeddingText.length, 609);
  assert.equal(exportedChunk.imageSummary.profileId, "dashscope-vlm");
  assert.equal(exportedChunk.imageSummary.model, "qwen3.8-max");
  assert.equal(exportedChunk.imageSummary.promptVersion, "image-summary-v1");
  assert.equal(/"(?:vector|binary|base64|dataUrl|presignedUrl)"\s*:/.test(JSON.stringify(exported)), false);

  const secretNames = [
    "MINERU_API_TOKEN",
    "MINIO_ACCESS_KEY",
    "MINIO_SECRET_KEY",
    "EMBEDDING_API_KEY",
    "CONTEXT_API_KEY",
    "DASHSCOPE_VLM_API_KEY",
    "RAG_PG_USER",
    "RAG_PG_PASSWORD",
    "RAG_PG_DATABASE",
  ];
  const secretValues = secretNames.map((name) => process.env[name]).filter((value) => value?.length >= 8);
  const combinedResponses = responseBodies.join("\n");
  for (const secret of secretValues) assert.equal(combinedResponses.includes(secret), false);
  for (const pattern of [
    /authorization\s*[:=]\s*(?:bearer|basic)\s+[a-z0-9._~+/=-]+/i,
    /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"']+/i,
    /[?&](?:X-Amz-(?:Credential|Signature|Security-Token)|Signature)=/i,
    /data:(?:image|application)\/[a-z0-9.+-]+;base64,/i,
  ]) assert.equal(pattern.test(combinedResponses), false);

  const evidence = {
    status: "succeeded",
    acceptanceScope: "desktop-web-and-public-http",
    containersRestartedAndHealthy: containerHealth,
    applicationRestartRecovered: true,
    materialCount: materialResults.length,
    materials: materialResults,
    publicHeadCount,
    s3HeadCount,
    modelProfiles: {
      count: profileIds.length,
      defaults: ["dashscope-context", "dashscope-vlm"],
      alternativesCalled: false,
    },
    realVlm: {
      chunkId: selectedImageChunkId,
      profileId: chunk.vlmProfileId,
      model: chunk.vlmModel,
      promptVersion: chunk.vlmPromptVersion,
      chineseSummaryRecovered: true,
    },
    context: { profileId: chunk.contextProfileId, state: chunk.contextReviewState, chineseRecovered: true },
    embedding: { dimensions: 1024, eligible: true },
    database: { publicRecordCount: database.records.length, imageRecordRecovered: true, vectorValuesProjected: false },
    export: { contractVersion: "2.1", embeddingTextLength: exportedChunk.embeddingText.length, provenanceRecovered: true },
    secretScan: { configuredValuesChecked: secretValues.length, findings: 0 },
    paidSupplierCallsThisVerification: { mineru: 0, vlm: 0, context: 0, embedding: 0 },
  };
  const directory = resolve("output/evidence/storage-production-like-closure-v2");
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "restart-public-api-s3.json"), JSON.stringify(evidence, null, 2), "utf8");
  console.log(JSON.stringify({
    status: evidence.status,
    materialCount: evidence.materialCount,
    publicHeadCount,
    s3HeadCount,
    databaseRecordCount: evidence.database.publicRecordCount,
    exportContractVersion: evidence.export.contractVersion,
    secretFindings: 0,
  }));
} finally {
  s3.destroy();
}
