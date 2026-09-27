import assert from "node:assert/strict";
import type { Chunk } from "./chunking.js";
import {
  embeddingIdempotencyKey,
  parseEmbeddingProfiles,
  publicEmbeddingProfiles,
  runEmbeddingJob,
  type EmbeddingProfile,
} from "./embedding-job.js";

function chunk(id: string, text: string, eligible = true): Chunk {
  return {
    id,
    type: "text",
    text,
    automaticText: text,
    finalText: text,
    page: 1,
    bbox: null,
    sourceSegments: [],
    sourceBlockIds: [],
    tokenCount: 1,
    qualityFlags: [],
    relatedChunkIds: [],
    excluded: !eligible,
    contextText: "",
    contextCandidateReasons: [],
    contextReviewState: "not_generated",
    revisions: [],
    embeddingEligible: eligible,
    embeddingExclusionReasons: eligible ? [] : ["missing_reliable_search_text"],
  } as Chunk;
}

const profiles = parseEmbeddingProfiles({ NODE_ENV: "test" });
assert.deepEqual(publicEmbeddingProfiles(profiles), [
  { id: "deterministic-fake", name: "Deterministic Fake Embedding", dimensions: 16, maxTokens: 4096 },
  { id: "deterministic-partial", name: "Deterministic Partial Failure", dimensions: 16, maxTokens: 4096 },
]);
const chunks = [chunk("a", "合格文本 A"), chunk("b", "合格文本 B"), chunk("excluded", "不发送", false)];
const profile = profiles[1];
const key = embeddingIdempotencyKey("doc-1", profile, chunks);
assert.equal(key, embeddingIdempotencyKey("doc-1", profile, structuredClone(chunks)));

const initial = await runEmbeddingJob({
  documentId: "doc-1",
  chunks,
  profile,
  at: "2026-08-16T06:00:00.000Z",
});
assert.equal(initial.status, "partial_failure");
assert.deepEqual(initial.summary, { total: 3, succeeded: 1, failed: 1, skipped: 1 });
assert.equal(initial.items[0].vectorRecord?.vector.length, 16);
assert.equal(initial.items[1].errorCode, "EMBEDDING_REQUEST_FAILED");
assert.equal(initial.items[2].attempts, 0);

const retried = await runEmbeddingJob({
  documentId: "doc-1",
  chunks,
  profile,
  previous: initial,
  at: "2026-08-16T06:01:00.000Z",
});
assert.equal(retried.id, initial.id);
assert.equal(retried.idempotencyKey, initial.idempotencyKey);
assert.deepEqual(retried.summary, { total: 3, succeeded: 2, failed: 0, skipped: 1 });
assert.deepEqual(retried.items.map((item) => item.attempts), [1, 2, 0]);

const changedInput = structuredClone(chunks);
changedInput[0]!.finalText = "已修订文本";
const freshAfterRevision = await runEmbeddingJob({
  documentId: "doc-1", chunks: changedInput, profile,
  previous: initial,
  at: "2026-08-16T06:01:30.000Z",
});
assert.notEqual(freshAfterRevision.id, initial.id, "输入变化必须启动新任务而非重试旧快照");
assert.equal(freshAfterRevision.items[0]?.attempts, 1);

async function failedCode(
  embed: EmbeddingProfile["embed"],
  overrides: Partial<EmbeddingProfile> = {},
) {
  const testProfile: EmbeddingProfile = {
    id: "failure",
    name: "Failure",
    model: "fake",
    dimensions: 2,
    maxTokens: 100,
    timeoutMs: 10,
    embed,
    ...overrides,
  };
  return (await runEmbeddingJob({
    documentId: "doc-failure",
    chunks: [chunk("failure", "测试文本")],
    profile: testProfile,
    at: "2026-08-16T06:02:00.000Z",
  })).items[0].errorCode;
}

assert.equal(await failedCode(async () => [[1]]), "VECTOR_DIMENSION_MISMATCH");
assert.equal(await failedCode(async () => { throw new Error("HTTP 429 rate limit"); }), "EMBEDDING_RATE_LIMITED");
assert.equal(await failedCode(async () => { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); }), "EMBEDDING_TIMEOUT");
assert.equal(await failedCode(async () => [[1, 2]], { maxTokens: 1 }), "TOKEN_LIMIT_EXCEEDED");

const capturedInputs: string[] = [];
const eligibilityProfile: EmbeddingProfile = {
  id: "eligibility",
  name: "Eligibility Fake",
  model: "eligibility-fake-v1",
  dimensions: 2,
  maxTokens: 100,
  timeoutMs: 100,
  embed: async (texts) => {
    capturedInputs.push(...texts);
    return texts.map(() => [1, 0]);
  },
};
const confirmed = chunk("confirmed", "确认后的正文");
confirmed.contextText = "已确认 Context";
confirmed.contextReviewState = "confirmed";
const stale = chunk("stale", "stale 正文");
stale.contextText = "不得发送的 stale Context";
stale.contextReviewState = "stale";
const failed = chunk("failed-context", "失败 Context 的正文");
failed.contextText = "不得发送的失败 Context";
failed.contextReviewState = "failed";
const referenceImage = chunk("reference-image", "");
referenceImage.type = "image";
referenceImage.relatedChunkIds = ["confirmed"];
Object.assign(referenceImage, {
  imagePolicy: "reference",
  embeddingEligible: false,
  embeddingExclusionReasons: ["image_reference_uses_related_text"],
});
const eligibilityJob = await runEmbeddingJob({
  documentId: "doc-eligibility",
  chunks: [confirmed, stale, failed, referenceImage, chunk("ineligible", "不得发送的 Chunk", false)],
  profile: eligibilityProfile,
  at: "2026-08-16T06:03:00.000Z",
});
assert.deepEqual(capturedInputs, [
  "已确认 Context\n\n确认后的正文",
  "stale 正文",
  "失败 Context 的正文",
]);
assert.deepEqual(eligibilityJob.summary, { total: 5, succeeded: 3, failed: 0, skipped: 2 });
assert.equal(eligibilityJob.items.find((item) => item.chunkId === "reference-image")?.status, "skipped");

console.log("Issue 12 embedding job tests passed");
