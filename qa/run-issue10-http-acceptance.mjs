import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const baseUrl = process.env.ISSUE10_BASE_URL ?? "http://127.0.0.1:4400";
const fakeModelUrl = process.env.ISSUE10_FAKE_MODEL_URL ?? "http://127.0.0.1:4555";
const evidenceDirectory = resolve("output/issue10-image-reference-vlm");
const network = [];

async function request(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  network.push({
    method: init?.method ?? "GET",
    path: path.replace(/\/chunks\/[^/]+\//, "/chunks/:chunkId/"),
    status: response.status,
  });
  const payload = await response.json();
  assert.equal(response.ok, true, `${init?.method ?? "GET"} ${path}: ${response.status}`);
  return payload;
}

const profiles = await request("/api/model-profiles");
assert.deepEqual(profiles, {
  profiles: [{
    id: "fake-vlm",
    name: "本地 Fake VLM",
    capabilities: ["vlm", "context"],
  }],
});

const batch = await request("/api/demo", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ imageScenario: "three" }),
});
const batchId = batch.id;
const documentId = batch.documents[0].id;
const confirmed = await request(
  `/api/batches/${batchId}/documents/${documentId}/review/confirm`,
  { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
);
const images = confirmed.reviewState.draft.chunks.filter(
  (chunk) => chunk.type === "image",
);
assert.equal(images.length, 3);
const [summaryImage, referenceImage, excludedImage] = images;

const vlmPath = `/api/batches/${batchId}/documents/${documentId}/chunks/${encodeURIComponent(summaryImage.id)}/vlm-summary`;
const firstGeneration = await request(vlmPath, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ profileId: "fake-vlm" }),
});
assert.equal(firstGeneration.cacheHit, undefined);
const cachedGeneration = await request(vlmPath, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ profileId: "fake-vlm" }),
});
assert.equal(cachedGeneration.cacheHit, true);

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

await saveImage(summaryImage.id, {
  imagePolicy: "summary",
  humanSummary: "人工修订：杯体需沿顺时针方向锁定到主机。",
  humanSupplement: "适用于星澜 A1 型号，通电前确认卡扣到位。",
});
await saveImage(referenceImage.id, {
  imagePolicy: "reference",
  humanSummary: "",
  humanSupplement: "",
});
await saveImage(excludedImage.id, {
  imagePolicy: "exclude",
  humanSummary: "人工审计：该图片不进入检索。",
  humanSupplement: "",
});

await request(
  `/api/batches/${batchId}/documents/${documentId}/context/generate`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chunkIds: [summaryImage.id], profileId: "fake-vlm" }),
  },
);
await request(
  `/api/batches/${batchId}/documents/${documentId}/context/${encodeURIComponent(summaryImage.id)}/confirm`,
  { method: "POST" },
);
await saveImage(summaryImage.id, {
  imagePolicy: "summary",
  humanSummary: "人工修订：杯体需沿顺时针方向旋转并锁定到主机。",
  humanSupplement: "适用于星澜 A1 型号，通电前确认卡扣到位。",
});

const refreshed = await request(
  `/api/batches/${batchId}/documents/${documentId}/review`,
);
const refreshedImages = refreshed.reviewState.draft.chunks.filter(
  (chunk) => chunk.type === "image",
);
assert.deepEqual(refreshedImages.map((chunk) => chunk.imagePolicy), [
  "summary",
  "reference",
  "exclude",
]);
assert.deepEqual(refreshedImages.map((chunk) => chunk.embeddingEligible), [
  true,
  true,
  false,
]);
assert.equal(refreshedImages[0].contextReviewState, "stale");
assert.match(refreshedImages[0].vlmSummaryEffective, /人工修订.*顺时针.*A1/s);
assert.equal(refreshedImages[0].vlmSummaryGenerated, "杯体应沿箭头方向旋转并锁定到主机。");
assert.equal(refreshedImages[0].vlmProfileId, "fake-vlm");
assert.equal(refreshedImages[0].vlmModel, "deterministic-image-summary");
assert.equal(refreshedImages[0].vlmPromptVersion, "image-summary-v1");
assert.equal(refreshedImages[2].finalText, "");
assert.equal(refreshedImages.every((chunk) =>
  typeof chunk.imageObjectReference?.uri === "string" &&
  chunk.imageObjectReference.uri.startsWith("s3://")
), true);

const exported = await request(
  `/api/batches/${batchId}/export?contractVersion=2.1`,
);
const exportedImages = exported.documents[0].chunks.filter(
  (chunk) => chunk.contentType === "image",
);
assert.deepEqual(exportedImages.map((chunk) => chunk.finalText),
  refreshedImages.map((chunk) => chunk.finalText));
assert.deepEqual(exportedImages.map((chunk) => chunk.imagePolicy), [
  "summary",
  "reference",
  "exclude",
]);
assert.doesNotMatch(JSON.stringify(exportedImages), /data:image|;base64,|imageDataUrl/);

const fakeCalls = await (await fetch(`${fakeModelUrl}/requests`)).json();
assert.equal(fakeCalls.requests.filter((call) => call.role === "vlm").length, 1);
assert.equal(fakeCalls.requests.filter((call) => call.role === "context").length, 1);

const evidence = {
  acceptedAt: new Date().toISOString(),
  source: "Issue 10 formal acceptance criteria",
  batchId,
  documentId,
  profiles: profiles.profiles,
  policies: refreshedImages.map((chunk) => ({
    chunkId: chunk.id,
    policy: chunk.imagePolicy,
    embeddingEligible: chunk.embeddingEligible,
    contextReviewState: chunk.contextReviewState,
    objectUri: chunk.imageObjectReference.uri,
    effectiveText: chunk.finalText,
  })),
  summaryProvenance: {
    profileId: refreshedImages[0].vlmProfileId,
    model: refreshedImages[0].vlmModel,
    promptVersion: refreshedImages[0].vlmPromptVersion,
    status: refreshedImages[0].vlmStatus,
    cacheHit: refreshedImages[0].vlmCacheHit,
  },
  export: {
    contractVersion: exported.contractVersion,
    imageCount: exportedImages.length,
    finalTextMatchesRefresh: true,
    binaryFieldsPresent: false,
  },
  calls: {
    fakeVlm: 1,
    fakeContext: 1,
    realPaidVlm: 0,
  },
  network,
};
await mkdir(evidenceDirectory, { recursive: true });
await writeFile(
  resolve(evidenceDirectory, "http-acceptance.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify({
  ok: true,
  imageCount: exportedImages.length,
  policies: evidence.policies.map((item) => item.policy),
  fakeVlmCalls: evidence.calls.fakeVlm,
  realPaidVlmCalls: 0,
  contextState: evidence.policies[0].contextReviewState,
  exportConsistent: true,
}));
