import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import type { Chunk } from "./chunking.js";
import { restoreReviewState, serializeReviewState, type ReviewState } from "./review-state.js";
import { saveImageSummaryReview } from "./image-summary-workflow.js";

const imageChunk: Chunk & Record<string, unknown> = {
  id: "image-1",
  type: "image",
  automaticType: "image",
  finalType: "image",
  text: "",
  automaticText: "",
  finalText: "",
  page: 2,
  bbox: [10, 20, 30, 40],
  sourceSegments: [{ blockId: "image-block", page: 2, bbox: [10, 20, 30, 40], sourceStart: 0, sourceEnd: 0, chunkStart: 0, chunkEnd: 0, isOverlap: false }],
  sourceBlockIds: ["image-block"],
  tokenCount: 0,
  qualityFlags: [],
  productIdentity: "星澜 A1 智能料理机",
  relatedChunkIds: [],
  imageId: "asset-1",
  excluded: false,
  contextText: "旧 Context",
  contextCandidateReasons: ["图片需要补充检索语义"],
  contextReviewState: "confirmed",
  contextModel: "context-profile",
  revisions: [],
  imagePolicy: "summary",
  vlmSummaryGenerated: "机器识别的杯体锁定方向",
  vlmStatus: "awaiting_review",
};

const textChunk = (id: string, finalText: string): Chunk & Record<string, unknown> => ({
  id,
  type: "text",
  text: finalText,
  automaticText: finalText,
  finalText,
  page: 1,
  bbox: null,
  sourceSegments: [{ blockId: `${id}-block`, page: 1, bbox: null, sourceStart: 0, sourceEnd: finalText.length, chunkStart: 0, chunkEnd: finalText.length, isOverlap: false }],
  sourceBlockIds: [`${id}-block`],
  tokenCount: 10,
  qualityFlags: [],
  relatedChunkIds: [],
  excluded: false,
  contextText: "",
  contextCandidateReasons: [],
  contextReviewState: "not_generated",
  revisions: [],
  embeddingEligible: true,
  embeddingExclusionReasons: [],
});

const review: ReviewState = {
  preview: null,
  draft: {
    chunks: [imageChunk, textChunk("text-1", "杯体安装说明"), textChunk("text-2", "安全卡扣说明")],
    metrics: {
      chunkCount: 1,
      token: { minimum: 0, average: 0, maximum: 0 },
      tokenDistribution: { under80: 1, "80to255": 0, "256to511": 0, "512to1023": 0, "1024plus": 0 },
      actualOverlapRatio: 0,
      crossPageCount: 0,
      oversizedCount: 0,
      undersizedCount: 1,
      typeCounts: { text: 0, image: 1, table: 0 },
      missingProductIdentityCount: 0,
      contextCandidateCount: 1,
    },
    configuration: {
      strategy: "structure",
      chunkSize: 512,
      chunkOverlap: 64,
      bufferSize: 1,
      breakpointPercentile: 90,
      semanticMaxChunkSize: 768,
      imagePolicy: "summary",
    },
    confirmedAt: "2026-08-16T00:00:00.000Z",
  },
  undoStack: [],
  redoStack: [],
};

const saved = saveImageSummaryReview(review, "image-1", {
  imagePolicy: "summary",
  humanSummary: "人工确认杯体应顺时针锁定",
  humanSupplement: "适用于 A1 型号",
  relatedChunkIds: ["text-1", "text-2", "text-1"],
}, "2026-08-16T01:00:00.000Z");
const chunk = saved.draft!.chunks[0] as Chunk & Record<string, unknown>;
assert.equal(chunk.vlmSummaryGenerated, "机器识别的杯体锁定方向");
assert.equal(chunk.vlmSummaryReviewed, "人工确认杯体应顺时针锁定");
assert.equal(chunk.vlmSummarySupplement, "适用于 A1 型号");
assert.equal(chunk.vlmSummaryEffective, "人工确认杯体应顺时针锁定\n适用于 A1 型号");
assert.equal(chunk.finalText, chunk.vlmSummaryEffective);
assert.equal(chunk.embeddingEligible, true);
assert.deepEqual(chunk.embeddingExclusionReasons, []);
assert.ok(chunk.tokenCount > 0);
assert.equal(chunk.contextReviewState, "stale");
assert.equal(chunk.contextError, "图片策略或摘要已更新");
assert.equal(saved.undoStack.length, 1);
assert.deepEqual(chunk.relatedChunkIds, ["text-1", "text-2"], "summary links are optional and deduplicated");

const restored = restoreReviewState(JSON.parse(serializeReviewState(saved)));
assert.equal(
  (restored.draft!.chunks[0] as Chunk & Record<string, unknown>).vlmSummaryEffective,
  chunk.vlmSummaryEffective,
  "saved image summaries survive authoritative ReviewState recovery",
);

assert.throws(
  () => saveImageSummaryReview(review, "image-1", {
    imagePolicy: "summary",
    humanSummary: "可信摘要",
    humanSupplement: "",
    finalText: "客户端伪造派生文本",
  } as never, "2026-08-16T01:00:00.000Z"),
  /派生字段只能由服务器计算/,
);

assert.throws(() => saveImageSummaryReview(review, "image-1", {
  imagePolicy: "reference",
  humanSummary: "不会进入引用策略的最终文本",
  humanSupplement: "",
  relatedChunkIds: [],
}, "2026-08-16T01:01:00.000Z"), /仅引用图片必须关联至少一个有效文字 Chunk/);

const referenceOnly = saveImageSummaryReview(review, "image-1", {
  imagePolicy: "reference",
  humanSummary: "不会进入引用策略的最终文本",
  humanSupplement: "",
  relatedChunkIds: ["text-1", "text-2", "text-1"],
}, "2026-08-16T01:01:00.000Z");
assert.equal(referenceOnly.draft!.chunks[0].finalText, "");
assert.equal(referenceOnly.draft!.chunks[0].excluded, false);
assert.equal(
  (referenceOnly.draft!.chunks[0] as Chunk & Record<string, unknown>).embeddingEligible,
  false,
);
assert.deepEqual(referenceOnly.draft!.chunks[0].relatedChunkIds, ["text-1", "text-2"]);
const withInvalidRelation = structuredClone(referenceOnly);
withInvalidRelation.draft!.chunks.find((candidate) => candidate.id === "text-1")!.excluded = true;
const invalidated = restoreReviewState(withInvalidRelation);
const invalidatedImage = invalidated.draft!.chunks[0] as Chunk & Record<string, unknown>;
assert.deepEqual(invalidatedImage.relatedChunkIds, ["text-2"]);
assert.deepEqual(invalidatedImage.invalidRelatedChunkIds, ["text-1"]);
assert.equal(invalidatedImage.relatedChunkStatus, "invalid");

const withAllRelationsInvalid = structuredClone(referenceOnly);
withAllRelationsInvalid.draft!.chunks.find((candidate) => candidate.id === "text-1")!.excluded = true;
withAllRelationsInvalid.draft!.chunks.find((candidate) => candidate.id === "text-2")!.excluded = true;
(withAllRelationsInvalid.draft!.chunks[0] as Chunk & Record<string, unknown>).contextReviewState = "confirmed";
const unavailableReference = restoreReviewState(withAllRelationsInvalid);
const unavailableImage = unavailableReference.draft!.chunks[0] as Chunk & Record<string, unknown>;
assert.deepEqual(unavailableImage.relatedChunkIds, []);
assert.equal(unavailableImage.relatedChunkStatus, "invalid");
assert.equal(unavailableImage.embeddingEligible, false);
assert.deepEqual(unavailableImage.embeddingExclusionReasons, ["reference_requires_related_text"]);
assert.equal(unavailableImage.contextReviewState, "stale");

unavailableReference.draft!.chunks.find((candidate) => candidate.id === "text-1")!.excluded = false;
const recoveredRelation = restoreReviewState(unavailableReference);
assert.deepEqual(recoveredRelation.draft!.chunks[0].relatedChunkIds, ["text-1"]);
assert.deepEqual(
  (recoveredRelation.draft!.chunks[0] as Chunk & Record<string, unknown>).invalidRelatedChunkIds,
  ["text-2"],
  "restoring a valid text Chunk recovers only that relation",
);

assert.throws(() => saveImageSummaryReview(review, "image-1", {
  imagePolicy: "reference",
  humanSummary: "",
  humanSupplement: "",
  relatedChunkIds: ["image-1"],
}, "2026-08-16T01:01:00.000Z"), /图片不能关联自身/);

assert.throws(() => saveImageSummaryReview(review, "image-1", {
  imagePolicy: "summary",
  humanSummary: "可信摘要",
  humanSupplement: "",
  relatedChunkIds: ["missing"],
}, "2026-08-16T01:01:00.000Z"), /关联 Chunk 不存在或已失效/);

const summaryWithoutSource = structuredClone(review);
delete (summaryWithoutSource.draft!.chunks[0] as Chunk & Record<string, unknown>).vlmSummaryGenerated;
assert.throws(() => saveImageSummaryReview(summaryWithoutSource, "image-1", {
  imagePolicy: "summary",
  humanSummary: "",
  humanSupplement: "只有补充文字不能替代摘要来源",
  relatedChunkIds: [],
}, "2026-08-16T01:01:30.000Z"), /必须先生成 VLM 摘要或填写人工摘要/);

const versionedReview = structuredClone(review);
for (const segment of versionedReview.draft!.chunks[0]!.sourceSegments)
  Object.assign(segment, { sourceDocumentVersion: "source-current", parsedDocumentVersion: "parsed-current" });
for (const segment of versionedReview.draft!.chunks[1]!.sourceSegments)
  Object.assign(segment, { sourceDocumentVersion: "source-current", parsedDocumentVersion: "parsed-stale" });
assert.throws(() => saveImageSummaryReview(versionedReview, "image-1", {
  imagePolicy: "reference",
  humanSummary: "",
  humanSupplement: "",
  relatedChunkIds: ["text-1"],
}, "2026-08-16T01:01:40.000Z"), /关联文字 Chunk 版本已过期/);

const staleRestoredReview = structuredClone(referenceOnly);
for (const segment of staleRestoredReview.draft!.chunks[0]!.sourceSegments)
  Object.assign(segment, { sourceDocumentVersion: "source-current", parsedDocumentVersion: "parsed-current" });
for (const segment of staleRestoredReview.draft!.chunks.find((candidate) => candidate.id === "text-1")!.sourceSegments)
  Object.assign(segment, { sourceDocumentVersion: "source-current", parsedDocumentVersion: "parsed-stale" });
const staleRestored = restoreReviewState(staleRestoredReview);
const staleRestoredImage = staleRestored.draft!.chunks[0] as Chunk & Record<string, unknown>;
assert.deepEqual(staleRestoredImage.relatedChunkIds, ["text-2"], "reload removes a relation from an old parsed version");
assert.deepEqual(staleRestoredImage.invalidRelatedChunkIds, ["text-1"]);
assert.equal(staleRestoredImage.relatedChunkStatus, "invalid");

const excluded = saveImageSummaryReview(review, "image-1", {
  imagePolicy: "exclude",
  humanSummary: "保留为审计信息",
  humanSupplement: "不进入检索",
}, "2026-08-16T01:02:00.000Z");
assert.equal(excluded.draft!.chunks[0].finalText, "");
assert.equal(excluded.draft!.chunks[0].excluded, true);
assert.equal(
  (excluded.draft!.chunks[0] as Chunk & Record<string, unknown>).embeddingEligible,
  false,
);
assert.equal(
  (excluded.draft!.chunks[0] as Chunk & Record<string, unknown>).vlmSummaryGenerated,
  "机器识别的杯体锁定方向",
);

console.log("Image summary authoritative workflow tests passed");

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string")
        return reject(new Error("No test port"));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitFor(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Image-summary test server exited with ${child.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
  ]);
}

function startServer(port: number, workspaceRoot: string): ChildProcess {
  return spawn(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "src/server.ts"],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        NODE_ENV: "test",
        PORT: String(port),
        WORKSPACE_ROOT: workspaceRoot,
        MINERU_API_TOKEN: "image-summary-test-token",
        EMBEDDING_BASE_URL: "http://127.0.0.1:1",
        EMBEDDING_API_KEY: "image-summary-test-key",
        EMBEDDING_MODEL: "test-embedding",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

const port = await freePort();
const workspaceRoot = resolve(".workspace", `image-summary-${process.pid}`);
let server = startServer(port, workspaceRoot);
let batchId = "";
let documentId = "";
let imageChunkId = "";
try {
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(`${baseUrl}/api/health`, server);
  const demo = await (await fetch(`${baseUrl}/api/demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })).json() as { id: string; documents: Array<{ id: string }> };
  batchId = demo.id;
  documentId = demo.documents[0].id;
  const confirmedResponse = await fetch(
    `${baseUrl}/api/batches/${batchId}/documents/${documentId}/review/confirm`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  );
  assert.equal(confirmedResponse.status, 200);
  const confirmed = await confirmedResponse.json() as {
    reviewState: { draft: { chunks: Array<Record<string, unknown>> } };
  };
  imageChunkId = confirmed.reviewState.draft.chunks.find(
    (candidate) => candidate.type === "image",
  )!.id as string;
  const apiRelatedIds = confirmed.reviewState.draft.chunks
    .filter((candidate) => candidate.type === "text" && candidate.embeddingEligible === true)
    .slice(0, 2)
    .map((candidate) => String(candidate.id));
  assert.equal(apiRelatedIds.length, 2);
  const endpoint = `${baseUrl}/api/batches/${batchId}/documents/${documentId}/chunks/${encodeURIComponent(imageChunkId)}/image-summary`;

  const forged = await fetch(endpoint, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      imagePolicy: "summary",
      humanSummary: "人工审核的杯体锁定方向",
      humanSupplement: "适用于 A1 型号",
      relatedChunkIds: apiRelatedIds,
      finalText: "客户端伪造",
    }),
  });
  assert.equal(forged.status, 400);

  const savedResponse = await fetch(endpoint, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      imagePolicy: "summary",
      humanSummary: "人工审核的杯体锁定方向",
      humanSupplement: "适用于 A1 型号",
      relatedChunkIds: [...apiRelatedIds, apiRelatedIds[0]],
    }),
  });
  assert.equal(savedResponse.status, 200);
  const savedPayload = await savedResponse.json() as {
    reviewState: { draft: { chunks: Array<Record<string, unknown>> } };
  };
  const savedChunk = savedPayload.reviewState.draft.chunks.find(
    (candidate) => candidate.id === imageChunkId,
  )!;
  assert.equal(savedChunk.vlmSummaryEffective, "人工审核的杯体锁定方向\n适用于 A1 型号");
  assert.equal(savedChunk.embeddingEligible, true);
  assert.deepEqual(savedChunk.embeddingExclusionReasons, []);
  assert.deepEqual(savedChunk.relatedChunkIds, apiRelatedIds);

  const missingReference = await fetch(endpoint, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      imagePolicy: "reference",
      humanSummary: "",
      humanSupplement: "",
      relatedChunkIds: [],
    }),
  });
  assert.equal(missingReference.status, 400);
  assert.deepEqual(await missingReference.json(), {
    error: "仅引用图片必须关联至少一个有效文字 Chunk。影响：图片不会进入文本检索或 Embedding。下一步：搜索并选择同一文档内未排除的文字 Chunk 后重试。",
    code: "IMAGE_REFERENCE_REQUIRED",
    impact: "图片策略未保存；图片不会进入文本检索、Context 或 Embedding。",
    recovery: "请搜索并选择同一文档内至少一个有效文字 Chunk 后重试。",
  });

  const forgedRelation = await fetch(endpoint, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      imagePolicy: "reference",
      humanSummary: "",
      humanSupplement: "",
      relatedChunkIds: ["other-document-chunk"],
    }),
  });
  assert.equal(forgedRelation.status, 400);

  const referenceSaved = await fetch(endpoint, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      imagePolicy: "reference",
      humanSummary: "",
      humanSupplement: "",
      relatedChunkIds: apiRelatedIds,
    }),
  });
  assert.equal(referenceSaved.status, 200);
  const referenceChunk = ((await referenceSaved.json()) as {
    reviewState: { draft: { chunks: Array<Record<string, unknown>> } };
  }).reviewState.draft.chunks.find((candidate) => candidate.id === imageChunkId)!;
  assert.equal(referenceChunk.finalText, "");
  assert.equal(referenceChunk.embeddingEligible, false);
  assert.deepEqual(referenceChunk.relatedChunkIds, apiRelatedIds);

  const restoredSummary = await fetch(endpoint, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      imagePolicy: "summary",
      humanSummary: "人工审核的杯体锁定方向",
      humanSupplement: "适用于 A1 型号",
      relatedChunkIds: apiRelatedIds,
    }),
  });
  assert.equal(restoredSummary.status, 200);

  const exportPayload = await (await fetch(
    `${baseUrl}/api/batches/${batchId}/export?contractVersion=2.1`,
  )).json() as { documents: Array<{ chunks: Array<Record<string, unknown>> }> };
  const exported = exportPayload.documents[0].chunks.find(
    (candidate) => candidate.chunkId === imageChunkId,
  )!;
  assert.equal(exported.finalText, savedChunk.finalText);
  assert.deepEqual(exported.imageSummary, {
    machineSummary: "",
    humanSummary: "人工审核的杯体锁定方向",
    humanSupplement: "适用于 A1 型号",
    effectiveSummary: "人工审核的杯体锁定方向\n适用于 A1 型号",
    profileId: null,
    profileName: null,
    model: null,
    promptVersion: null,
    generatedAt: null,
    status: "unconfigured",
    cacheHit: false,
  });
  assert.equal(exported.imagePolicy, "summary");
  assert.deepEqual(exported.relatedChunkIds, apiRelatedIds);
  assert.match(
    String((exported.imageAssetReference as Record<string, unknown>).uri),
    /^s3:\/\/[^/]+\/v1\/pdf-image-crop\//,
  );
  assert.doesNotMatch(JSON.stringify(exported), /data:image|base64,/);

  const referenceForInvalidation = await fetch(endpoint, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      imagePolicy: "reference",
      humanSummary: "",
      humanSupplement: "",
      relatedChunkIds: apiRelatedIds,
    }),
  });
  assert.equal(referenceForInvalidation.status, 200);
  let latestImage: Record<string, unknown> | undefined;
  for (const relatedChunkId of apiRelatedIds) {
    const excludedRelation = await fetch(
      `${baseUrl}/api/batches/${batchId}/documents/${documentId}/review/actions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "exclude", chunkId: relatedChunkId }),
      },
    );
    assert.equal(excludedRelation.status, 200);
    const payload = await excludedRelation.json() as {
      reviewState: { draft: { chunks: Array<Record<string, unknown>> } };
    };
    latestImage = payload.reviewState.draft.chunks.find((candidate) => candidate.id === imageChunkId);
  }
  assert.deepEqual(latestImage?.relatedChunkIds, []);
  assert.deepEqual(latestImage?.invalidRelatedChunkIds, apiRelatedIds);
  assert.equal(latestImage?.relatedChunkStatus, "invalid");
  assert.deepEqual(latestImage?.embeddingExclusionReasons, ["reference_requires_related_text"]);

  for (const relatedChunkId of apiRelatedIds) {
    const restoredRelation = await fetch(
      `${baseUrl}/api/batches/${batchId}/documents/${documentId}/review/actions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "restore", chunkId: relatedChunkId }),
      },
    );
    assert.equal(restoredRelation.status, 200);
    const payload = await restoredRelation.json() as {
      reviewState: { draft: { chunks: Array<Record<string, unknown>> } };
    };
    latestImage = payload.reviewState.draft.chunks.find((candidate) => candidate.id === imageChunkId);
  }
  assert.deepEqual(latestImage?.relatedChunkIds, apiRelatedIds);
  assert.deepEqual(latestImage?.invalidRelatedChunkIds, []);
  assert.equal(latestImage?.relatedChunkStatus, "valid");

  const summaryAfterInvalidation = await fetch(endpoint, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      imagePolicy: "summary",
      humanSummary: "人工审核的杯体锁定方向",
      humanSupplement: "适用于 A1 型号",
      relatedChunkIds: apiRelatedIds,
    }),
  });
  assert.equal(summaryAfterInvalidation.status, 200);
} finally {
  await stop(server);
}

server = startServer(port, workspaceRoot);
try {
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(`${baseUrl}/api/health`, server);
  const recovered = await (await fetch(
    `${baseUrl}/api/batches/${batchId}/documents/${documentId}/review`,
  )).json() as { reviewState: { draft: { chunks: Array<Record<string, unknown>> } } };
  const recoveredChunk = recovered.reviewState.draft.chunks.find(
    (candidate) => candidate.id === imageChunkId,
  )!;
  assert.equal(
    recoveredChunk.vlmSummaryEffective,
    "人工审核的杯体锁定方向\n适用于 A1 型号",
  );
  assert.equal(recoveredChunk.embeddingEligible, true);
} finally {
  await stop(server);
}

console.log("Image summary API persistence and recovery tests passed");
