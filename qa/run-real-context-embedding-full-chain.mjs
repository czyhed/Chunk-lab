import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

for (const name of [
  "EMBEDDING_BASE_URL",
  "EMBEDDING_API_KEY",
  "EMBEDDING_MODEL",
  "MODEL_PROFILES_JSON",
  "MINIO_ENDPOINT",
  "MINIO_BUCKET",
  "MINIO_ACCESS_KEY",
  "MINIO_SECRET_KEY",
  "RAG_PG_USER",
  "RAG_PG_PASSWORD",
  "RAG_PG_DATABASE",
]) if (!process.env[name]?.trim()) throw new Error(`${name} is required`);

const ledger = JSON.parse(
  await readFile(resolve(".workspace/real-mineru-matrix-ledger.json"), "utf8"),
);
const material = ledger.entries.find((entry) => entry.fileName === "产品技术白皮书.pdf");
assert.ok(material?.batchId && material?.documentId);
assert.equal(material.submissionCount, 1);
assert.equal(material.status, "done");
const callLedgerPath = resolve(".workspace/real-context-embedding-full-chain-ledger.json");
try {
  await access(callLedgerPath);
  throw new Error("Real model call ledger already exists; refusing paid replay");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No test port"));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitFor(url, child) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`app exited ${child.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("app did not become healthy");
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 3_000)),
  ]);
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!response.ok)
    throw new Error(`HTTP ${response.status}: ${payload.code ?? payload.error ?? "request failed"}`);
  return payload;
}

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const documentBase = `${baseUrl}/api/batches/${material.batchId}/documents/${material.documentId}`;
const appEnv = {
  ...process.env,
  NODE_ENV: "test",
  PORT: String(port),
  WORKSPACE_ROOT: resolve(".workspace/real-mineru-matrix-v1"),
  EMBEDDING_PROFILES_JSON: JSON.stringify([{
    id: "real-embedding-1024",
    name: "Configured real Embedding 1024",
    baseUrl: process.env.EMBEDDING_BASE_URL,
    apiKey: "${EMBEDDING_API_KEY}",
    model: process.env.EMBEDDING_MODEL,
    dimensions: 1024,
    maxTokens: 4096,
    timeoutMs: 60_000,
  }]),
  DATABASE_PROFILES_JSON: JSON.stringify([{
    id: "local-pgvector-v2-1024",
    name: "Local pgvector schema 2.0 (1024)",
    kind: "pgvector",
    schemaVersion: "2.0",
    host: "127.0.0.1",
    port: 54329,
    databaseEnv: "RAG_PG_DATABASE",
    userEnv: "RAG_PG_USER",
    passwordEnv: "RAG_PG_PASSWORD",
  }]),
};
const spawnApp = () => spawn(
  process.execPath,
  ["node_modules/tsx/dist/cli.mjs", "src/server.ts"],
  { cwd: resolve("."), env: appEnv, stdio: ["ignore", "ignore", "ignore"] },
);
let app = spawnApp();
let contextPaidCalls = 0;
let contextRetryCalls = 0;
let embeddingPaidCalls = 0;
let embeddingRetryCalls = 0;

async function persistCallLedger(status) {
  await writeFile(callLedgerPath, `${JSON.stringify({
    contractVersion: "real-model-call-ledger-1.0",
    status,
    batchId: material.batchId,
    documentId: material.documentId,
    contextPaidCalls,
    contextPaidRetries: contextRetryCalls,
    embeddingPaidBatchCalls: embeddingPaidCalls,
    embeddingPaidRetries: embeddingRetryCalls,
    vlmPaidCalls: 0,
    mineruPaidCalls: 0,
    automaticReplayAllowed: false,
  }, null, 2)}\n`, "utf8");
}
await persistCallLedger("started");

async function generateContext(chunkId, allowHumanContextOverwrite) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    contextPaidCalls += 1;
    if (attempt === 2) contextRetryCalls += 1;
    await persistCallLedger("context_request_started");
    const generated = await requestJson(`${documentBase}/context/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chunkIds: [chunkId],
        profileId: "dashscope-context",
        allowHumanContextOverwrite,
      }),
    });
    const chunk = generated.reviewState.draft.chunks.find((candidate) => candidate.id === chunkId);
    assert.ok(chunk);
    if (chunk.contextReviewState === "awaiting_review") return chunk;
    if (attempt === 2) throw new Error("Real Context failed after one paid retry");
  }
  throw new Error("unreachable");
}

try {
  await waitFor(`${baseUrl}/api/health`, app);
  const modelCatalog = await requestJson(`${baseUrl}/api/model-profiles`);
  const contextProfile = modelCatalog.profiles.find((profile) => profile.id === "dashscope-context");
  assert.deepEqual(contextProfile?.capabilities, ["context"]);
  assert.equal(modelCatalog.profiles.some((profile) => profile.capabilities.includes("vlm")), false);

  const preview = await requestJson(`${documentBase}/chunks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      strategy: "structure",
      chunkSize: 512,
      chunkOverlap: 64,
      imagePolicy: "summary",
    }),
  });
  assert.equal(preview.chunks.length, 14);
  await requestJson(`${documentBase}/review/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });

  let review = await requestJson(`${documentBase}/review`);
  const selected = review.reviewState.draft.chunks.find((chunk) =>
    chunk.type === "text" &&
    chunk.finalType === "paragraph" &&
    chunk.embeddingEligible === true &&
    chunk.contextCandidateReasons?.length
  ) ?? review.reviewState.draft.chunks.find((chunk) =>
    chunk.type === "text" && chunk.embeddingEligible === true && chunk.contextCandidateReasons?.length
  );
  assert.ok(selected, "No eligible Context candidate in the real whitepaper");

  const firstGenerated = await generateContext(selected.id, false);
  assert.match(firstGenerated.contextText, /[\u3400-\u9fff]/u);
  assert.equal(firstGenerated.contextProfileId, "dashscope-context");
  assert.equal(firstGenerated.contextProfileName, "DashScope Context");
  assert.equal(firstGenerated.contextModel, "qwen3.7-flash-2026-07-15");
  assert.equal(firstGenerated.contextPromptVersion, "context-v1");
  const firstContextHash = createHash("sha256").update(firstGenerated.contextText).digest("hex");
  const firstContextLength = firstGenerated.contextText.length;

  const humanContext = "人工确认：本段属于产品技术白皮书，需结合相邻章节理解产品能力、适用范围与限制。";
  const manuallyReviewed = await requestJson(`${documentBase}/context/${encodeURIComponent(selected.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contextText: humanContext }),
  });
  const humanChunk = manuallyReviewed.reviewState.draft.chunks.find((chunk) => chunk.id === selected.id);
  assert.equal(humanChunk.contextReviewState, "human_modified");
  assert.equal(humanChunk.contextText, humanContext);

  const revisedText = `${selected.finalText}\n\n人工修订：该段内容已完成术语核对。`;
  await requestJson(`${documentBase}/chunks/${encodeURIComponent(selected.id)}/reviewed-model`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      reviewedModel: selected.reviewedModel?.type === "paragraph"
        ? { ...selected.reviewedModel, text: revisedText }
        : { type: "paragraph", text: revisedText },
    }),
  });
  review = await requestJson(`${documentBase}/review`);
  const staleChunk = review.reviewState.draft.chunks.find((chunk) => chunk.id === selected.id);
  assert.equal(staleChunk.contextReviewState, "stale");
  assert.equal(staleChunk.finalText, revisedText);

  const regenerated = await generateContext(selected.id, true);
  assert.match(regenerated.contextText, /[\u3400-\u9fff]/u);
  assert.equal(regenerated.contextModel, "qwen3.7-flash-2026-07-15");
  const confirmed = await requestJson(
    `${documentBase}/context/${encodeURIComponent(selected.id)}/confirm`,
    { method: "POST" },
  );
  const confirmedChunk = confirmed.reviewState.draft.chunks.find((chunk) => chunk.id === selected.id);
  assert.equal(confirmedChunk.contextReviewState, "confirmed");

  embeddingPaidCalls += 1;
  await persistCallLedger("embedding_request_started");
  let embedding = await requestJson(`${documentBase}/embedding-jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileId: "real-embedding-1024" }),
  });
  if (embedding.job.summary.failed > 0) {
    embeddingPaidCalls += 1;
    embeddingRetryCalls += 1;
    await persistCallLedger("embedding_retry_started");
    embedding = await requestJson(
      `${documentBase}/embedding-jobs/${embedding.job.id}/retry`,
      { method: "POST" },
    );
  }
  assert.equal(embedding.job.summary.failed, 0);
  assert.ok(embedding.job.summary.succeeded > 0);
  assert.equal(/"vector"\s*:/.test(JSON.stringify(embedding)), false);
  assert.equal(
    embedding.job.items
      .filter((item) => item.status === "succeeded")
      .every((item) => item.vectorRecord?.dimensions === 1024),
    true,
  );

  const database = await requestJson(`${documentBase}/database-jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      profileId: "local-pgvector-v2-1024",
      embeddingJobId: embedding.job.id,
    }),
  });
  assert.equal(database.job.status, "completed");
  assert.equal(database.job.summary.failed, 0);
  const records = await requestJson(
    `${documentBase}/database-records?profileId=local-pgvector-v2-1024`,
  );
  assert.equal(records.records.length, database.job.summary.written + database.job.summary.unchanged);
  assert.equal(records.records.every((record) => record.schemaVersion === "2.0"), true);
  assert.equal(records.records.every((record) => record.vectorDimensions === 1024), true);
  assert.equal(/"vector"\s*:/.test(JSON.stringify(records)), false);

  const exported = await requestJson(
    `${baseUrl}/api/batches/${material.batchId}/export?contractVersion=2.1`,
  );
  assert.equal(exported.selectedContractVersion, "2.1");
  const exportedDocument = exported.documents.find((document) => document.documentId === material.documentId);
  const exportedChunk = exportedDocument.chunks.find((chunk) => chunk.chunkId === selected.id);
  assert.equal(exportedChunk.contextReviewState, "confirmed");
  assert.equal(exportedChunk.contextProfileId, "dashscope-context");
  assert.equal(exportedChunk.contextModel, "qwen3.7-flash-2026-07-15");
  assert.equal(exportedChunk.finalText, revisedText);
  assert.equal(/data:|;base64,|presign|authorization/i.test(JSON.stringify(exported)), false);

  const objects = await requestJson(`${baseUrl}/api/batches/${material.batchId}/objects`);
  const objectClassCounts = objects.objects.reduce((counts, object) => {
    counts[object.assetClass] = (counts[object.assetClass] ?? 0) + 1;
    return counts;
  }, {});
  assert.ok(objectClassCounts.model_input >= 3);
  assert.ok(objectClassCounts.export_package >= 1);

  await stop(app);
  app = spawnApp();
  await waitFor(`${baseUrl}/api/health`, app);
  const recoveredReview = await requestJson(`${documentBase}/review`);
  const recoveredChunk = recoveredReview.reviewState.draft.chunks.find((chunk) => chunk.id === selected.id);
  assert.equal(recoveredChunk.contextReviewState, "confirmed");
  assert.equal(recoveredChunk.finalText, revisedText);
  const recoveredRecords = await requestJson(
    `${documentBase}/database-records?profileId=local-pgvector-v2-1024`,
  );
  assert.equal(recoveredRecords.records.length, records.records.length);
  assert.equal(/"vector"\s*:/.test(JSON.stringify(recoveredRecords)), false);

  const evidence = {
    status: "succeeded_without_vlm_profile",
    material: material.relativePath,
    batchId: material.batchId,
    documentId: material.documentId,
    previewChunkCount: preview.chunks.length,
    selectedChunkId: selected.id,
    serverProfiles: modelCatalog.profiles,
    vlmProfileAvailable: false,
    vlmPaidCallsThisRun: 0,
    context: {
      profileId: "dashscope-context",
      profileName: "DashScope Context",
      model: "qwen3.7-flash-2026-07-15",
      promptVersion: "context-v1",
      paidCallsThisRun: contextPaidCalls,
      paidRetryCallsThisRun: contextRetryCalls,
      containsChinese: true,
      firstGeneratedLength: firstContextLength,
      firstGeneratedSha256: firstContextHash,
      humanModifiedObserved: true,
      staleObservedAfterTextRevision: true,
      finalReviewState: recoveredChunk.contextReviewState,
      refreshRecovered: true,
    },
    embedding: {
      profileId: "real-embedding-1024",
      model: process.env.EMBEDDING_MODEL,
      observedDimensions: 1024,
      paidCallsThisRun: embeddingPaidCalls,
      paidRetryCallsThisRun: embeddingRetryCalls,
      summary: embedding.job.summary,
      publicResponseOmittedVectors: true,
    },
    database: {
      profileId: "local-pgvector-v2-1024",
      schemaVersion: "2.0",
      recordCount: records.records.length,
      jobSummary: database.job.summary,
      publicResponseOmittedVectors: true,
      refreshRecovered: true,
    },
    contract21: {
      exported: true,
      finalTextMatches: true,
      contextProvenanceMatches: true,
      forbiddenPayloadsAbsent: true,
    },
    objectClassCounts,
  };
  const directory = resolve("output/evidence/object-storage-real-suppliers-production-readiness");
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, "real-context-embedding-full-chain.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  );
  await persistCallLedger("completed");
  console.log(JSON.stringify({
    status: evidence.status,
    context: {
      paidCalls: contextPaidCalls,
      retries: contextRetryCalls,
      containsChinese: true,
      finalReviewState: recoveredChunk.contextReviewState,
    },
    embedding: {
      paidCalls: embeddingPaidCalls,
      retries: embeddingRetryCalls,
      dimensions: 1024,
      succeeded: embedding.job.summary.succeeded,
    },
    databaseRecordCount: records.records.length,
  }));
} finally {
  await stop(app);
}
