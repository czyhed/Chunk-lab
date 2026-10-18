import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import {
  linkedTargetsForChunk,
  linkedTargetsForSource,
  scrollReviewTargetIntoView,
  updateReviewLinkSelection,
} from "../chunk-review-links.js";

const chunks = [
  {
    id: "chunk-a",
    sourceSegments: [{ blockId: "source-1" }, { blockId: "source-shared" }],
  },
  {
    id: "chunk-b",
    sourceSegments: [{ contentBlockId: "source-shared" }],
  },
  {
    id: "chunk-c",
    sourceSegments: [{ blockId: "source-3" }],
  },
  {
    id: "chunk-manual-transcription",
    sourceSegments: [{ contentBlockId: "manual-annotation:annotation-1" }],
    manualAnnotationIds: ["annotation-1"],
  },
];

assert.deepEqual(linkedTargetsForSource(chunks, "source-shared"), {
  chunkIds: ["chunk-a", "chunk-b"],
  primaryChunkId: "chunk-a",
  missing: false,
});
assert.deepEqual(linkedTargetsForSource(chunks, "source-missing"), {
  chunkIds: [],
  primaryChunkId: null,
  missing: true,
});
assert.deepEqual(linkedTargetsForSource(chunks, "annotation-1"), {
  chunkIds: ["chunk-manual-transcription"],
  primaryChunkId: "chunk-manual-transcription",
  missing: false,
});
assert.deepEqual(linkedTargetsForChunk(chunks, "chunk-b"), {
  sourceIds: ["source-shared"],
  chunkIds: ["chunk-a", "chunk-b"],
  primaryChunkId: "chunk-b",
});
assert.deepEqual(linkedTargetsForChunk(chunks, "chunk-manual-transcription"), {
  sourceIds: ["manual-annotation:annotation-1", "annotation-1"],
  chunkIds: ["chunk-manual-transcription"],
  primaryChunkId: "chunk-manual-transcription",
});

let selection = updateReviewLinkSelection(
  chunks,
  null,
  { kind: "source", id: "source-shared" },
);
assert.deepEqual(selection, {
  sourceIds: ["source-shared"],
  chunkIds: ["chunk-a", "chunk-b"],
  primaryChunkId: "chunk-a",
  missingSourceIds: [],
});

selection = updateReviewLinkSelection(
  chunks,
  selection,
  { kind: "source", id: "source-3" },
  true,
);
assert.deepEqual(selection.chunkIds, ["chunk-a", "chunk-b", "chunk-c"]);
assert.equal(selection.primaryChunkId, "chunk-a", "Ctrl add keeps a stable primary Chunk");

selection = updateReviewLinkSelection(
  chunks,
  selection,
  { kind: "source", id: "source-shared" },
  true,
);
assert.deepEqual(selection.sourceIds, ["source-3"]);
assert.deepEqual(selection.chunkIds, ["chunk-c"]);
assert.equal(selection.primaryChunkId, "chunk-c");

selection = updateReviewLinkSelection(
  chunks,
  selection,
  { kind: "source", id: "source-missing" },
);
assert.deepEqual(selection.missingSourceIds, ["source-missing"]);
assert.equal(selection.primaryChunkId, null);

selection = updateReviewLinkSelection(
  chunks,
  selection,
  { kind: "chunk", id: "chunk-b" },
);
assert.deepEqual(selection.sourceIds, ["source-shared"]);
assert.deepEqual(selection.chunkIds, ["chunk-a", "chunk-b"]);
assert.equal(selection.primaryChunkId, "chunk-b", "a clicked Chunk is the stable primary");

let scrollOptions: ScrollIntoViewOptions | undefined;
assert.equal(scrollReviewTargetIntoView({
  scrollIntoView(options) {
    if (typeof options === "object") scrollOptions = options;
  },
}), true);
assert.deepEqual(scrollOptions, {
  behavior: "smooth",
  block: "center",
  inline: "nearest",
}, "source-to-Chunk navigation scrolls every actual scrollable ancestor");

assert.equal(scrollReviewTargetIntoView({
  scrollIntoView(options) {
    if (typeof options === "object") scrollOptions = options;
  },
}, "start"), true);
assert.deepEqual(scrollOptions, {
  behavior: "smooth",
  block: "start",
  inline: "nearest",
}, "Chunk-to-source navigation preserves its requested alignment across scrollable ancestors");

console.log("T08 Chunk review link tests passed");

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
      throw new Error(`T08 test server exited with ${child.exitCode}`);
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
const workspaceRoot = resolve(".workspace", `t08-integration-${process.pid}`);
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
  const documentId = demo.documents[0].id;
  const reviewResponse = await fetch(
    `${baseUrl}/api/batches/${demo.id}/documents/${documentId}/review`,
  );
  const review = await reviewResponse.json() as {
    reviewState: {
      preview: {
        chunks: Array<{
          id: string;
          automaticText: string;
          finalText: string;
          automaticType?: string;
          finalType?: string;
          sourceBlockIds: string[];
          revisions: unknown[];
        }>;
      };
    };
    sourceBlocks: Array<{ contentBlockId: string; contentType: string }>;
  };
  assert.ok(review.reviewState.preview.chunks.length > 0);
  for (const chunk of review.reviewState.preview.chunks) {
    assert.ok(chunk.automaticType, "Preview preserves the automatic Chunk type");
    assert.equal(chunk.finalType, chunk.automaticType);
    assert.deepEqual(chunk.revisions, []);
  }

  const sourceTypesBefore = review.sourceBlocks.map((block) => [
    block.contentBlockId,
    block.contentType,
  ]);
  const confirmResponse = await fetch(
    `${baseUrl}/api/batches/${demo.id}/documents/${documentId}/review/confirm`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  );
  assert.equal(confirmResponse.status, 200);
  const confirmed = await confirmResponse.json() as {
    reviewState: {
      draft: {
        chunks: Array<{
          id: string;
          automaticText: string;
          finalText: string;
          automaticType: string;
          finalType: string;
          sourceBlockIds: string[];
        }>;
      };
    };
  };
  const editable = confirmed.reviewState.draft.chunks.find(
    (chunk) => chunk.finalType === "paragraph",
  );
  assert.ok(editable, "demo fixture exposes a paragraph Chunk for T08 review");
  const originalId = editable.id;
  const originalAutomaticText = editable.automaticText;
  const originalSourceIds = editable.sourceBlockIds;
  const revisedText = `${editable.finalText}\n人工核对文本。`;

  const textResponse = await fetch(
    `${baseUrl}/api/batches/${demo.id}/documents/${documentId}/chunks/${encodeURIComponent(originalId)}/reviewed-model`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewedModel: { type: "paragraph", text: revisedText } }),
    },
  );
  assert.equal(textResponse.status, 200);
  const textReview = await textResponse.json() as {
    reviewState: { draft: { chunks: Array<Record<string, unknown>> } };
  };
  const textChunk = textReview.reviewState.draft.chunks.find(
    (chunk) => chunk.id === originalId,
  );
  assert.ok(textChunk, "text-only revision keeps the stable Chunk ID");
  assert.equal(textChunk.automaticText, originalAutomaticText);
  assert.equal(textChunk.finalText, revisedText);
  assert.equal(textChunk.automaticType, "paragraph");
  assert.equal(textChunk.finalType, "paragraph");

  const typeResponse = await fetch(
    `${baseUrl}/api/batches/${demo.id}/documents/${documentId}/chunks/${encodeURIComponent(originalId)}/reviewed-model`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reviewedModel: { type: "heading", level: 2, text: revisedText },
      }),
    },
  );
  assert.equal(typeResponse.status, 200);
  const typedReview = await typeResponse.json() as {
    reviewState: { draft: { chunks: Array<Record<string, unknown>> } };
  };
  const typedChunk = typedReview.reviewState.draft.chunks.find(
    (chunk) => chunk.replacedChunkId === originalId,
  );
  assert.ok(typedChunk, "type revision creates a replacement Chunk ID");
  assert.notEqual(typedChunk.id, originalId);
  assert.equal(typedChunk.automaticType, "paragraph");
  assert.equal(typedChunk.finalType, "heading");
  assert.deepEqual(typedChunk.sourceBlockIds, originalSourceIds);

  const sourceAfterResponse = await fetch(
    `${baseUrl}/api/batches/${demo.id}/documents/${documentId}/review`,
  );
  const sourceAfter = await sourceAfterResponse.json() as {
    sourceBlocks: Array<{ contentBlockId: string; contentType: string }>;
  };
  assert.deepEqual(
    sourceAfter.sourceBlocks.map((block) => [block.contentBlockId, block.contentType]),
    sourceTypesBefore,
    "Chunk type review never writes back to source annotation types",
  );

  const undoResponse = await fetch(
    `${baseUrl}/api/batches/${demo.id}/documents/${documentId}/review/actions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "undo" }),
    },
  );
  assert.equal(undoResponse.status, 200);
  const undone = await undoResponse.json() as {
    reviewState: { draft: { chunks: Array<Record<string, unknown>> } };
  };
  const undoneChunk = undone.reviewState.draft.chunks.find(
    (chunk) => chunk.id === originalId,
  );
  assert.ok(undoneChunk, "undo restores the pre-type-revision Chunk ID");
  assert.equal(undoneChunk.finalType, "paragraph");
  assert.equal(undoneChunk.finalText, revisedText);

  const redoTypeResponse = await fetch(
    `${baseUrl}/api/batches/${demo.id}/documents/${documentId}/review/actions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "redo" }),
    },
  );
  const redoneType = await redoTypeResponse.json() as {
    reviewState: { draft: { chunks: Array<Record<string, unknown>> } };
  };
  assert.ok(
    redoneType.reviewState.draft.chunks.some(
      (chunk) => chunk.replacedChunkId === originalId && chunk.finalType === "heading",
    ),
    "redo reapplies the type replacement",
  );
  await fetch(
    `${baseUrl}/api/batches/${demo.id}/documents/${documentId}/review/actions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "undo" }),
    },
  );

  const restoreAutomaticResponse = await fetch(
    `${baseUrl}/api/batches/${demo.id}/documents/${documentId}/chunks/${encodeURIComponent(originalId)}/reviewed-model`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reviewedModel: {
          type: "plain_text_repair",
          classification: "paragraph",
          text: originalAutomaticText,
        },
      }),
    },
  );
  assert.equal(restoreAutomaticResponse.status, 200);
  const restoredAutomatic = await restoreAutomaticResponse.json() as {
    reviewState: {
      draft: {
        chunks: Array<{
          id: string;
          finalText: string;
          automaticText: string;
          sourceSegments: Array<{
            blockId: string;
            chunkStart: number;
            chunkEnd: number;
          }>;
          sourceBlockIds: string[];
        }>;
      };
    };
  };
  const automaticChunk = restoredAutomatic.reviewState.draft.chunks.find(
    (chunk) => chunk.id === originalId,
  );
  assert.ok(automaticChunk);
  assert.equal(automaticChunk.finalText, automaticChunk.automaticText);

  const unaffectedBefore = restoredAutomatic.reviewState.draft.chunks
    .filter((chunk) => chunk.id !== originalId)
    .map((chunk) => structuredClone(chunk));
  const firstSegment = automaticChunk.sourceSegments.find(
    (segment) => segment.chunkEnd - segment.chunkStart > 1,
  );
  assert.ok(firstSegment, "fixture exposes an exact segment with an interior cursor");
  const splitResponse = await fetch(
    `${baseUrl}/api/batches/${demo.id}/documents/${documentId}/review/actions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "split",
        chunkId: originalId,
        cursor: firstSegment.chunkStart + 1,
      }),
    },
  );
  assert.equal(splitResponse.status, 200);
  const splitReview = await splitResponse.json() as {
    reviewState: {
      draft: {
        chunks: Array<{
          id: string;
          replacedChunkId?: string;
          sourceBlockIds: string[];
          excluded: boolean;
        }>;
      };
    };
  };
  const splitChunks = splitReview.reviewState.draft.chunks.filter(
    (chunk) => chunk.replacedChunkId === originalId,
  );
  assert.equal(splitChunks.length, 2);
  assert.ok(splitChunks.every((chunk) => chunk.sourceBlockIds.length > 0));

  const mergeResponse = await fetch(
    `${baseUrl}/api/batches/${demo.id}/documents/${documentId}/review/actions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "merge-next", chunkId: splitChunks[0].id }),
    },
  );
  assert.equal(mergeResponse.status, 200);
  const mergedReview = await mergeResponse.json() as {
    reviewState: {
      draft: {
        chunks: Array<{
          id: string;
          sourceBlockIds: string[];
          excluded: boolean;
        }>;
      };
    };
  };
  const mergedChunk = mergedReview.reviewState.draft.chunks.find(
    (chunk) => !unaffectedBefore.some((candidate) => candidate.id === chunk.id),
  );
  assert.ok(mergedChunk);

  const excludeResponse = await fetch(
    `${baseUrl}/api/batches/${demo.id}/documents/${documentId}/review/actions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "exclude", chunkId: mergedChunk.id }),
    },
  );
  const excludedReview = await excludeResponse.json() as {
    reviewState: { draft: { chunks: Array<{ id: string; excluded: boolean }> } };
  };
  assert.equal(
    excludedReview.reviewState.draft.chunks.find((chunk) => chunk.id === mergedChunk.id)?.excluded,
    true,
  );
  const restoreResponse = await fetch(
    `${baseUrl}/api/batches/${demo.id}/documents/${documentId}/review/actions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "restore", chunkId: mergedChunk.id }),
    },
  );
  assert.equal(restoreResponse.status, 200);

  if (mergedChunk.sourceBlockIds.length > 1) {
    const removeResponse = await fetch(
      `${baseUrl}/api/batches/${demo.id}/documents/${documentId}/review/actions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "source-remove",
          chunkId: mergedChunk.id,
          blockIds: [mergedChunk.sourceBlockIds.at(-1)],
        }),
      },
    );
    assert.equal(removeResponse.status, 200);
    const sourceChanged = await removeResponse.json() as {
      reviewState: { draft: { chunks: Array<Record<string, unknown>> } };
    };
    for (const beforeChunk of unaffectedBefore) {
      const afterChunk = sourceChanged.reviewState.draft.chunks.find(
        (chunk) => chunk.id === beforeChunk.id,
      );
      assert.deepEqual(afterChunk, beforeChunk, "source change leaves unrelated Chunks unchanged");
    }
  }

  const manualDemoResponse = await fetch(`${baseUrl}/api/demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const manualDemo = await manualDemoResponse.json() as {
    id: string;
    documents: Array<{ id: string }>;
  };
  const manualDocumentId = manualDemo.documents[0].id;
  const manualReviewResponse = await fetch(
    `${baseUrl}/api/batches/${manualDemo.id}/documents/${manualDocumentId}/review`,
  );
  const manualReview = await manualReviewResponse.json() as {
    sourceBlocks: Array<{
      contentBlockId: string;
      sourceDocumentVersion: string;
      parsedDocumentVersion: string;
    }>;
  };
  const manualSource = manualReview.sourceBlocks[0];
  const manualGenerationResponse = await fetch(
    `${baseUrl}/api/batches/${manualDemo.id}/documents/${manualDocumentId}/manual-chunks`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "document",
        effectiveAnnotations: [{
          id: manualSource.contentBlockId,
          sourceBlockIds: [manualSource.contentBlockId],
          page: 1,
          bbox: [0.1, 0.05, 0.95, 0.15],
          type: "heading",
          readingOrder: 0,
          layer: "detection",
        }],
        suppressedSourceBlockIds: [],
        imagePolicy: "summary",
        sourceDocumentVersion: manualSource.sourceDocumentVersion,
        parsedDocumentVersion: manualSource.parsedDocumentVersion,
      }),
    },
  );
  assert.equal(manualGenerationResponse.status, 200);
  const manualGeneration = await manualGenerationResponse.json() as {
    reviewState: {
      preview: {
        chunks: Array<{
          automaticType: string;
          finalType: string;
          sourceBlockIds: string[];
        }>;
      };
    };
  };
  assert.ok(manualGeneration.reviewState.preview.chunks.length > 1, "manual generation preserves the existing automatic Chunks");
  const generatedHeading = manualGeneration.reviewState.preview.chunks.find(
    (chunk) => chunk.sourceBlockIds.length === 1 && chunk.sourceBlockIds[0] === manualSource.contentBlockId,
  );
  assert.equal(generatedHeading?.automaticType, "heading");
  assert.equal(generatedHeading?.finalType, "heading");

  const manualConfirmResponse = await fetch(
    `${baseUrl}/api/batches/${manualDemo.id}/documents/${manualDocumentId}/review/confirm`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  );
  assert.equal(manualConfirmResponse.status, 200);
  const restoredManualResponse = await fetch(
    `${baseUrl}/api/batches/${manualDemo.id}/documents/${manualDocumentId}/review`,
  );
  const restoredManual = await restoredManualResponse.json() as {
    reviewState: {
      preview: null;
      draft: {
        configuration: { strategy: string };
        chunks: Array<{
          id: string;
          automaticText: string;
          automaticType: string;
          sourceBlockIds: string[];
        }>;
      };
    };
  };
  assert.equal(restoredManual.reviewState.preview, null);
  assert.equal(restoredManual.reviewState.draft.configuration.strategy, "manual");
  assert.equal(restoredManual.reviewState.draft.chunks[0].automaticType, "heading");
  assert.deepEqual(restoredManual.reviewState.draft.chunks[0].sourceBlockIds, [
    manualSource.contentBlockId,
  ]);

  const manualChunk = restoredManual.reviewState.draft.chunks[0];
  const manualSplitResponse = await fetch(
    `${baseUrl}/api/batches/${manualDemo.id}/documents/${manualDocumentId}/review/actions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "split",
        chunkId: manualChunk.id,
        cursor: 1,
      }),
    },
  );
  assert.equal(manualSplitResponse.status, 200, "an adopted manual Chunk supports exact splitting");
  const manuallySplit = await manualSplitResponse.json() as {
    reviewState: {
      draft: {
        chunks: Array<{ replacedChunkId?: string; sourceBlockIds: string[] }>;
      };
    };
  };
  const manualSplitChunks = manuallySplit.reviewState.draft.chunks.filter(
    (chunk) => chunk.replacedChunkId === manualChunk.id,
  );
  assert.equal(manualSplitChunks.length, 2);
  assert.ok(manualSplitChunks.every(
    (chunk) => chunk.sourceBlockIds.includes(manualSource.contentBlockId),
  ));
} finally {
  await stop(app);
}

console.log("T08 Preview type provenance tests passed");
