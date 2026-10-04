import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

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
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`T9.5 test server exited with ${child.exitCode}`);
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

const port = await freePort();
const workspaceRoot = resolve(".workspace", `t95-integration-${process.pid}`);
const app = spawn(
  process.execPath,
  ["node_modules/tsx/dist/cli.mjs", "src/server.ts"],
  {
    cwd: resolve("."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      WORKSPACE_ROOT: workspaceRoot,
      CONTEXT_BASE_URL: "",
      CONTEXT_API_KEY: "",
      CONTEXT_MODEL: "",
      MODEL_PROFILES_JSON: "[]",
      MINERU_API_TOKEN: "test-mineru-token",
      EMBEDDING_BASE_URL: "http://127.0.0.1:9/v1",
      EMBEDDING_API_KEY: "test-embedding-key",
      EMBEDDING_MODEL: "test-embedding-model",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

try {
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(`${baseUrl}/api/health`, app);
  const profiles = await (await fetch(`${baseUrl}/api/model-profiles`)).json() as {
    profiles: Array<{ capabilities: string[] }>;
  };
  assert.equal(
    profiles.profiles.some((profile) => profile.capabilities.includes("context")),
    false,
    "the integration scenario has no Context model profile",
  );
  const demoResponse = await fetch(`${baseUrl}/api/demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(demoResponse.status, 200);
  const demo = await demoResponse.json() as {
    id: string;
    documents: Array<{ id: string }>;
  };
  const documentId = demo.documents[0]!.id;
  const reviewUrl = `${baseUrl}/api/batches/${demo.id}/documents/${documentId}/review`;
  const review = await (await fetch(reviewUrl)).json() as {
    sourceBlocks: Array<{
      contentBlockId: string;
      sourceLocation: { page: number; bbox: [number, number, number, number] };
    }>;
    parsedDocument: { sourceDocumentVersion: string; parsedDocumentVersion: string };
  };
  const source = review.sourceBlocks[0]!;
  const detectionMember = {
    id: source.contentBlockId,
    sourceBlockIds: [source.contentBlockId],
    page: source.sourceLocation.page,
    bbox: [0.08, 0.05, 0.92, 0.1],
    type: "heading",
    readingOrder: 0,
    layer: "detection",
  };
  const manualMember = {
    id: "manual-transcription-1",
    sourceBlockIds: [],
    page: source.sourceLocation.page,
    bbox: [0.1, 0.12, 0.45, 0.16],
    type: "text",
    readingOrder: 1,
    layer: "manual",
    manualText: "人工识别的补充文字",
    transcriptionSource: "human",
  };
  const merged = {
    id: "manual-mixed-group-region",
    sourceBlockIds: [source.contentBlockId],
    page: source.sourceLocation.page,
    bbox: [0.08, 0.05, 0.92, 0.16],
    type: "text",
    readingOrder: 0,
    layer: "manual",
    logicalGroupId: "mixed-group-1",
    groupMembers: [detectionMember, manualMember],
    regionMemberIds: [detectionMember.id, manualMember.id],
  };
  const saveResponse = await fetch(`${reviewUrl}/annotations`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      annotations: [merged],
      suppressedSourceBlockIds: [source.contentBlockId],
      detectionExclusionOverrides: { "page-number-source": false },
    }),
  });
  assert.equal(saveResponse.status, 200, "mixed-layer annotation groups save through the public API");

  const restored = await (await fetch(reviewUrl)).json() as {
    annotationState: {
      annotations: Array<{ groupMembers: typeof merged.groupMembers }>;
      suppressedSourceBlockIds: string[];
      detectionExclusionOverrides: Record<string, boolean>;
    };
  };
  assert.deepEqual(restored.annotationState.annotations[0]!.groupMembers, [
    detectionMember,
    manualMember,
  ]);
  assert.deepEqual(restored.annotationState.suppressedSourceBlockIds, [
    source.contentBlockId,
  ]);
  assert.deepEqual(restored.annotationState.detectionExclusionOverrides, {
    "page-number-source": false,
  });

  const transcription = {
    id: "manual-transcription-only",
    sourceBlockIds: [],
    page: 1,
    bbox: [0.2, 0.2, 0.7, 0.28],
    type: "heading",
    readingOrder: 2,
    layer: "manual",
    manualText: "未解析区域的人工转录标题",
    transcriptionSource: "human",
  };
  const generationResponse = await fetch(`${reviewUrl.replace("/review", "/manual-chunks")}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scope: "document",
      effectiveAnnotations: [transcription],
      suppressedSourceBlockIds: [],
      imagePolicy: "summary",
      sourceDocumentVersion: review.parsedDocument.sourceDocumentVersion,
      parsedDocumentVersion: review.parsedDocument.parsedDocumentVersion,
    }),
  });
  assert.equal(generationResponse.status, 200, `an empty parsed region accepts human transcription: ${await generationResponse.clone().text()}`);
  const generated = await generationResponse.json() as {
    reviewState: { preview: { chunks: Array<Record<string, unknown>> } };
  };
  const chunk = generated.reviewState.preview.chunks[0]!;
  assert.equal(chunk.finalText, transcription.manualText);
  assert.equal(chunk.embeddingEligible, true);
  assert.deepEqual(chunk.embeddingExclusionReasons, []);
  assert.ok(
    Array.isArray(chunk.contextCandidateReasons) && chunk.contextCandidateReasons.length > 0,
    "manual Preview receives server-side Context candidate reasons",
  );
  assert.equal((chunk.sourceSegments as Array<Record<string, unknown>>)[0]!.page, 1);
  assert.deepEqual((chunk.revisions as Array<Record<string, unknown>>)[0]!.type, "manual_transcription");

  const confirmResponse = await fetch(`${reviewUrl}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(confirmResponse.status, 200);
  const restoredDraft = await (await fetch(reviewUrl)).json() as {
    reviewState: { draft: { chunks: Array<Record<string, unknown>> } };
  };
  assert.equal(restoredDraft.reviewState.draft.chunks[0]!.finalText, transcription.manualText);
  const draftChunkId = String(restoredDraft.reviewState.draft.chunks[0]!.id);
  const manualContextText = "这是无模型环境下保存的人工 Context。";
  const manualContextResponse = await fetch(`${reviewUrl.replace("/review", `/context/${encodeURIComponent(draftChunkId)}`)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contextText: manualContextText }),
  });
  assert.equal(manualContextResponse.status, 200, "manual Context remains writable without a model profile");
  const generatedContextResponse = await fetch(`${reviewUrl.replace("/review", "/context/generate")}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chunkIds: [draftChunkId] }),
  });
  assert.equal(generatedContextResponse.status, 503, "model generation reports service unconfigured separately");
  assert.equal((await generatedContextResponse.json() as { code?: string }).code, "CONTEXT_SERVICE_UNAVAILABLE");
  const refreshedDraft = await (await fetch(reviewUrl)).json() as {
    reviewState: { draft: { chunks: Array<Record<string, unknown>> } };
  };
  assert.equal(refreshedDraft.reviewState.draft.chunks[0]!.contextText, manualContextText);
  assert.equal(refreshedDraft.reviewState.draft.chunks[0]!.contextReviewState, "human_modified");
  const exportResponse = await fetch(`${baseUrl}/api/batches/${demo.id}/export?contractVersion=2.1`);
  assert.equal(exportResponse.status, 200, `human transcription survives Contract 2.1 export: ${await exportResponse.clone().text()}`);
  const exported = await exportResponse.json() as {
    documents: Array<{ chunks: Array<Record<string, unknown>> }>;
  };
  const exportedChunk = exported.documents[0]!.chunks.find((candidate) => candidate.finalText === transcription.manualText)!;
  assert.deepEqual((exportedChunk.sourceSegments as Array<Record<string, unknown>>)[0]!.provenance, {
    kind: "human_transcription",
    annotationId: transcription.id,
    source: "human",
  });
  assert.equal(exportedChunk.contextText, manualContextText);
  assert.equal(exportedChunk.contextReviewState, "human_modified");
} finally {
  await stop(app);
}

console.log("T9.5 manual annotation and Context eligibility tests passed");
