const TRANSIENT_CHUNK_FIELDS = [
  "imageEditorDraft",
  "imageRelatedQuery",
  "contextEditorDraft",
  "tableEditorDraft",
  "tableRetrievalDraft",
  "tableRelatedQuery",
  "tableSelectedCellIds",
];

export function mergeContextGenerationResult(serverReviewState, localReviewState, generatedChunkIds) {
  const generated = new Set(generatedChunkIds);
  const localChunks = new Map((localReviewState?.draft?.chunks ?? []).map((chunk) => [chunk.id, chunk]));
  if (!serverReviewState?.draft?.chunks) return serverReviewState;

  serverReviewState.draft.chunks = serverReviewState.draft.chunks.map((serverChunk) => {
    const localChunk = localChunks.get(serverChunk.id);
    if (!localChunk) return serverChunk;
    if (!generated.has(serverChunk.id)) return localChunk;
    const merged = { ...serverChunk };
    for (const field of TRANSIENT_CHUNK_FIELDS) {
      if (Object.hasOwn(localChunk, field)) merged[field] = localChunk[field];
    }
    return merged;
  });
  return serverReviewState;
}
