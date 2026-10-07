import type { Chunk } from "./chunking.js";
import {
  applyManualContext,
  confirmContext,
  generateSelectedContexts,
  type ContextGenerationOptions,
  type ContextGenerator,
  type ContextSourceBlock,
} from "./contextual.js";
import type { ReviewState } from "./review-state.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function fingerprint(chunk: Chunk): string {
  return JSON.stringify({
    finalText: chunk.finalText,
    sourceSegments: chunk.sourceSegments,
    parentSectionId: chunk.parentSectionId ?? null,
    productIdentity: chunk.productIdentity ?? null,
    type: chunk.type,
    contentGroupIds:
      (chunk as Chunk & { contentGroupIds?: string[] }).contentGroupIds ?? [],
    approvedEnrichmentFingerprint:
      (chunk as Chunk & { approvedEnrichmentFingerprint?: string })
        .approvedEnrichmentFingerprint ?? null,
  });
}

function withDraftHistory(
  review: ReviewState,
  chunks: Chunk[],
): ReviewState {
  if (!review.draft) throw new Error("没有已确认的 Chunk Draft");
  const result = clone(review);
  result.undoStack = [...result.undoStack, clone(result.draft!)].slice(-50);
  result.redoStack = [];
  result.draft!.chunks = chunks;
  return result;
}

export async function generateDraftContexts(
  review: ReviewState,
  chunkIds: string[],
  blocks: ContextSourceBlock[],
  generate: ContextGenerator,
  options: ContextGenerationOptions,
): Promise<{ review: ReviewState; baselineChunks: Chunk[] }> {
  if (!review.draft) throw new Error("没有已确认的 Chunk Draft");
  const baselineChunks = clone(review.draft.chunks);
  const generated = await generateSelectedContexts(
    baselineChunks,
    chunkIds,
    blocks,
    generate,
    options,
  );
  return {
    review: withDraftHistory(review, generated),
    baselineChunks,
  };
}

export function applyGeneratedContexts(
  current: ReviewState,
  baselineChunks: Chunk[],
  generatedChunks: Chunk[],
  selectedChunkIds: string[],
): ReviewState {
  if (!current.draft) throw new Error("没有已确认的 Chunk Draft");
  const selected = new Set(selectedChunkIds);
  const baselineById = new Map(baselineChunks.map((chunk) => [chunk.id, chunk]));
  const generatedById = new Map(generatedChunks.map((chunk) => [chunk.id, chunk]));
  const chunks = current.draft.chunks.map((chunk) => {
    if (!selected.has(chunk.id)) return clone(chunk);
    const baseline = baselineById.get(chunk.id);
    const generated = generatedById.get(chunk.id);
    if (!baseline || !generated) return clone(chunk);
    if (fingerprint(chunk) !== fingerprint(baseline))
      return {
        ...clone(chunk),
        contextReviewState: "stale" as const,
        contextError: "生成期间 Chunk 输入已变化，结果未应用",
      };
    return clone(generated);
  });
  return withDraftHistory(current, chunks);
}

export function confirmDraftContext(
  review: ReviewState,
  chunkId: string,
): ReviewState {
  if (!review.draft) throw new Error("没有已确认的 Chunk Draft");
  return withDraftHistory(
    review,
    confirmContext(review.draft.chunks, chunkId),
  );
}

export function editDraftContext(
  review: ReviewState,
  chunkId: string,
  contextText: string,
): ReviewState {
  if (!review.draft) throw new Error("没有已确认的 Chunk Draft");
  return withDraftHistory(
    review,
    applyManualContext(review.draft.chunks, chunkId, contextText),
  );
}

export function reconcileDraftContextInvalidation(
  previous: ReviewState,
  next: ReviewState,
): ReviewState {
  if (!previous.draft || !next.draft) return clone(next);
  const result = clone(next);
  const previousById = new Map(
    previous.draft.chunks.map((chunk) => [chunk.id, chunk]),
  );
  result.draft!.chunks = result.draft!.chunks.map((chunk) => {
    const before = previousById.get(chunk.id);
    if (!before || fingerprint(before) === fingerprint(chunk)) return chunk;
    if (
      before.contextReviewState === "not_generated" &&
      !before.contextText.trim()
    )
      return {
        ...chunk,
        contextText: "",
        contextReviewState: "not_generated" as const,
        contextError: undefined,
      };
    return {
      ...chunk,
      contextText: before.contextText,
      contextReviewState: "stale" as const,
      contextError: "Chunk 内容或来源已变化，需要重新生成或人工确认 Context",
    };
  });
  return result;
}
