import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

type ProcessPair = { app: ChildProcess; fake: ChildProcess; appPort: number; fakePort: number };

async function freePort(): Promise<number> {
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

async function waitFor(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Child exited with ${child.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
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

async function start(workspaceRoot: string, fakeLog: string): Promise<ProcessPair> {
  const fakePort = await freePort();
  const appPort = await freePort();
  const fake = spawn(process.execPath, ["qa/fake-mineru-server.mjs"], {
    cwd: resolve("."),
    env: { ...process.env, FAKE_MINERU_PORT: String(fakePort), FAKE_MINERU_LOG: fakeLog },
    stdio: "ignore",
  });
  const app = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/server.ts"], {
    cwd: resolve("."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(appPort),
      WORKSPACE_ROOT: workspaceRoot,
      MINERU_API_TOKEN: "fake-token-not-a-secret",
      MINERU_BASE_URL: `http://127.0.0.1:${fakePort}/api/v4`,
      MINERU_PARSE_TIMEOUT_MS: "30000",
      EMBEDDING_BASE_URL: "http://127.0.0.1:9/v1",
      EMBEDDING_API_KEY: "fake-embedding-key",
      EMBEDDING_MODEL: "fake-embedding-model",
    },
    stdio: "ignore",
  });
  await Promise.all([
    waitFor(`http://127.0.0.1:${fakePort}/health`, fake),
    waitFor(`http://127.0.0.1:${appPort}/api/health`, app),
  ]);
  return { app, fake, appPort, fakePort };
}

type ReviewBlock = {
  contentBlockId: string;
  contentType: string;
  sourceLocation?: {
    page: number | null;
    bbox: [number, number, number, number] | null;
    locationQuality: string;
    bboxEvidence?: { pageWidth: number; pageHeight: number };
  };
};

function annotation(block: ReviewBlock, index: number, logicalGroupId?: string) {
  const location = block.sourceLocation;
  assert.equal(location?.locationQuality, "exact");
  assert.ok(location.bbox && location.bboxEvidence);
  const [x0, y0, x1, y1] = location.bbox;
  const { pageWidth, pageHeight } = location.bboxEvidence;
  return {
    id: `http-regression-${index}`,
    sourceBlockIds: [block.contentBlockId],
    page: location.page!,
    bbox: [x0 / pageWidth, y0 / pageHeight, x1 / pageWidth, y1 / pageHeight] as [number, number, number, number],
    type: block.contentType === "heading" ? "heading" : block.contentType,
    readingOrder: index,
    layer: "detection" as const,
    ...(logicalGroupId ? { logicalGroupId, layer: "manual" as const } : {}),
  };
}

const root = resolve(".");
const workspaceRoot = resolve(".workspace", `manual-chunk-http-${process.pid}`);
const fakeLog = resolve("output", `manual-chunk-http-${process.pid}.jsonl`);
let processes = await start(workspaceRoot, fakeLog);

try {
  const base = `http://127.0.0.1:${processes.appPort}`;
  const form = new FormData();
  form.append("config", JSON.stringify({ modelVersion: "vlm", language: "ch" }));
  const sourceBytes = await (await import("node:fs/promises")).readFile(resolve(root, "qa/fixtures/t02-source.pdf"));
  form.append("files", new Blob([new Uint8Array(sourceBytes)], { type: "application/pdf" }), "多图片PDF.pdf");
  const createdResponse = await fetch(`${base}/api/batches`, { method: "POST", body: form });
  assert.equal(createdResponse.status, 202);
  const created = await createdResponse.json() as { id: string; documents: Array<{ id: string; state: string }> };
  const document = created.documents[0]!;
  let batch = created;
  for (let index = 0; index < 8 && batch.documents[0]?.state !== "done"; index += 1) {
    batch = await (await fetch(`${base}/api/batches/${created.id}`)).json() as typeof batch;
  }
  assert.equal(batch.documents[0]?.state, "done");

  const reviewUrl = `${base}/api/batches/${created.id}/documents/${document.id}/review`;
  const initialReview = await (await fetch(reviewUrl)).json() as {
    parsedDocument: { blocks: ReviewBlock[]; sourceDocumentVersion: string; parsedDocumentVersion: string };
    reviewState: { preview: { chunks: Array<Record<string, unknown>> } | null; draft: unknown };
  };
  const blocks = initialReview.parsedDocument.blocks;
  const exact = blocks.filter((block) => block.sourceLocation?.locationQuality === "exact");
  const tables = exact.filter((block) => block.contentType === "table");
  assert.ok(tables.length >= 2, "fixture must expose two exact table blocks");
  const tablePages = new Set(tables.map((block) => block.sourceLocation!.page));
  assert.ok(tablePages.size >= 2, "fixture tables must span pages");
  const allAnnotations = exact.map((block, index) => annotation(block, index));
  const fullResponse = await fetch(`${base}/api/batches/${created.id}/documents/${document.id}/manual-chunks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scope: "document",
      effectiveAnnotations: allAnnotations,
      suppressedSourceBlockIds: [],
      imagePolicy: "reference",
      sourceDocumentVersion: initialReview.parsedDocument.sourceDocumentVersion,
      parsedDocumentVersion: initialReview.parsedDocument.parsedDocumentVersion,
    }),
  });
  assert.equal(fullResponse.status, 200);
  const full = await fullResponse.json() as { reviewState: { preview: { chunks: Array<Record<string, unknown>> } } };
  const fullChunks = full.reviewState.preview.chunks;
  assert.ok(fullChunks.length > 3, "full Preview must contain multiple ordinary Chunks");

  const emptyImageAnnotation = {
    id: "http-empty-brand-image",
    sourceBlockIds: [],
    page: 1,
    bbox: [0.001, 0.001, 0.01, 0.01],
    type: "image",
    readingOrder: -1,
    layer: "manual" as const,
  };
  const emptyImageResponse = await fetch(`${base}/api/batches/${created.id}/documents/${document.id}/manual-chunks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scope: "page",
      page: 1,
      selectedAnnotationIds: [emptyImageAnnotation.id],
      effectiveAnnotations: [emptyImageAnnotation],
      suppressedSourceBlockIds: [],
      previousChunks: fullChunks,
      imagePolicy: "reference",
      sourceDocumentVersion: initialReview.parsedDocument.sourceDocumentVersion,
      parsedDocumentVersion: initialReview.parsedDocument.parsedDocumentVersion,
    }),
  });
  assert.equal(emptyImageResponse.status, 200, `empty manual image generation succeeds: ${await emptyImageResponse.clone().text()}`);
  const emptyImagePreview = await emptyImageResponse.json() as { reviewState: { preview: { chunks: Array<Record<string, unknown>> } } };
  const emptyImageChunk = emptyImagePreview.reviewState.preview.chunks.find(
    (chunk) => (chunk.manualAnnotationIds as string[] | undefined)?.includes(emptyImageAnnotation.id),
  )!;
  assert.equal(emptyImageChunk.type, "image");
  assert.equal(emptyImageChunk.finalText, "");
  assert.equal(emptyImageChunk.embeddingEligible, false);
  assert.ok(
    (emptyImageChunk.sourceSegments as Array<Record<string, unknown>>).some(
      (segment) => segment.bboxEvidence,
    ),
    "empty manual image keeps coordinate evidence for trusted PDF cropping",
  );
  const referenceTextChunk = emptyImagePreview.reviewState.preview.chunks.find(
    (chunk) => chunk.type === "text" && chunk.embeddingEligible === true && String(chunk.finalText ?? "").trim(),
  )!;
  const confirmEmptyImage = await fetch(`${reviewUrl}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(confirmEmptyImage.status, 200);
  const emptyImageId = String(emptyImageChunk.id);
  const imageSummaryUrl = `${base}/api/batches/${created.id}/documents/${document.id}/chunks/${encodeURIComponent(emptyImageId)}/image-summary`;
  const referenceSave = await fetch(imageSummaryUrl, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      imagePolicy: "reference",
      humanSummary: "",
      humanSupplement: "",
      relatedChunkIds: [referenceTextChunk.id],
    }),
  });
  assert.equal(referenceSave.status, 200, `reference-only empty image save succeeds: ${await referenceSave.clone().text()}`);
  const referencePayload = await referenceSave.json() as { reviewState: { draft: { chunks: Array<Record<string, unknown>> } } };
  const savedEmptyImage = referencePayload.reviewState.draft.chunks.find((chunk) => chunk.id === emptyImageId)!;
  assert.equal(savedEmptyImage.finalText, "");
  assert.deepEqual(savedEmptyImage.relatedChunkIds, [referenceTextChunk.id]);
  assert.equal(savedEmptyImage.embeddingEligible, false);
  const vlmAttempt = await fetch(`${base}/api/batches/${created.id}/documents/${document.id}/chunks/${encodeURIComponent(emptyImageId)}/vlm-summary`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profileId: "missing-vlm-profile" }),
  });
  assert.equal(vlmAttempt.status, 409, "reference-only empty image never calls VLM");

  const tableAnnotations = tables.slice(0, 2).map((block, index) => annotation(block, index, "http-cross-page-table"));
  const tableIds = tableAnnotations.flatMap((item) => item.sourceBlockIds);
  const tableChunkIds = new Set(fullChunks
    .filter((chunk) => ((chunk.sourceBlockIds as string[] | undefined) ?? []).some((id) => tableIds.includes(id)))
    .map((chunk) => String(chunk.id)));
  assert.equal(tableChunkIds.size, 2, "the two table annotations produce two direct table Chunks before merge");
  const ordinaryIds = fullChunks
    .filter((chunk) => !tableChunkIds.has(String(chunk.id)))
    .map((chunk) => String(chunk.id));
  const incrementalResponse = await fetch(`${base}/api/batches/${created.id}/documents/${document.id}/manual-chunks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scope: "page",
      page: tableAnnotations[1]!.page,
      selectedAnnotationIds: tableAnnotations.map((item) => item.id),
      effectiveAnnotations: [...allAnnotations.filter((item) => !tableIds.some((id) => item.sourceBlockIds.includes(id))), ...tableAnnotations],
      suppressedSourceBlockIds: tableIds,
      previousChunks: fullChunks,
      imagePolicy: "reference",
      sourceDocumentVersion: initialReview.parsedDocument.sourceDocumentVersion,
      parsedDocumentVersion: initialReview.parsedDocument.parsedDocumentVersion,
    }),
  });
  assert.equal(incrementalResponse.status, 200);
  const incremental = await incrementalResponse.json() as { reviewState: { preview: { chunks: Array<Record<string, unknown>> } } };
  const mergedChunks = incremental.reviewState.preview.chunks;
  assert.equal(mergedChunks.filter((chunk) => chunk.manualGenerationKey === "group:http-cross-page-table").length, 1);
  assert.ok(ordinaryIds.every((id) => mergedChunks.some((chunk) => chunk.id === id)), "unaffected ordinary Chunks remain after partial merge");
  assert.equal(mergedChunks.length, fullChunks.length - 1, "two table Chunks become one while ordinary Chunks remain");

  await stop(processes.app);
  await stop(processes.fake);
  processes = await start(workspaceRoot, fakeLog);
  const restored = await (await fetch(`http://127.0.0.1:${processes.appPort}/api/batches/${created.id}/documents/${document.id}/review`)).json() as typeof incremental;
  const restoredChunks = restored.reviewState.preview.chunks;
  assert.equal(restoredChunks.filter((chunk) => chunk.manualGenerationKey === "group:http-cross-page-table").length, 1);
  assert.ok(ordinaryIds.every((id) => restoredChunks.some((chunk) => chunk.id === id)), "persisted review keeps ordinary Chunks after reopen");
  assert.equal(restoredChunks.length, mergedChunks.length);
  const restoredDraft = (restored as unknown as { reviewState: { draft: { chunks: Array<Record<string, unknown>> } } }).reviewState.draft.chunks;
  const restoredEmptyImage = restoredDraft.find((chunk) => chunk.id === emptyImageId)!;
  assert.equal(restoredEmptyImage.imagePolicy, "reference", "refresh restores the empty image policy");
  assert.deepEqual(restoredEmptyImage.relatedChunkIds, [referenceTextChunk.id], "refresh restores the related text Chunk");
  assert.equal(restoredEmptyImage.finalText, "");
  assert.equal(restoredEmptyImage.embeddingEligible, false);
} finally {
  await Promise.all([stop(processes.app), stop(processes.fake)]);
}

console.log("manual chunk HTTP regression passed");
