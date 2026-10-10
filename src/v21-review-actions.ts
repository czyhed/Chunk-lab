import {
  countTokens,
  previewMetrics,
  type Chunk,
  type ChunkPreview,
  type ChunkPreviewMetrics,
  type ChunkRequest,
  type QualityFlag,
} from "./chunking.js";
import { planRecompute } from "./v21-recompute-scope.js";
import type { NormalizedContentType } from "./v21-contract.js";
import type { SourceSegmentV21 } from "./v21-provenance.js";

export type ReviewActionSegment = SourceSegmentV21 & { blockId: string };
export type ReviewActionChunk = Omit<Chunk, "sourceSegments"> & {
  sourceSegments: ReviewActionSegment[];
  replacedChunkId?: string;
  embeddingEligible?: boolean;
  embeddingExclusionReasons?: string[];
  embeddingText?: string | null;
  reviewedModel?: unknown;
  display?: unknown;
  searchText?: string;
  normalizationStatus?: string;
};

export type ReviewActionDraft = {
  chunks: ReviewActionChunk[];
  metrics: ReturnType<typeof previewMetrics>;
  configuration: ChunkRequest;
  confirmedAt: string;
};

export type ReviewActionState = {
  preview: (ChunkPreview & { configuration: ChunkRequest }) | null;
  draft: ReviewActionDraft | null;
  undoStack: ReviewActionDraft[];
  redoStack: ReviewActionDraft[];
};

export type ReviewSourceBlock = {
  contractVersion: "2.1";
  sourceDocumentVersion: string;
  parsedDocumentVersion: string;
  contentBlockId: string;
  rawBlockId: string | null;
  contentType: NormalizedContentType;
  searchText: string;
};

type StructuralMetadata = {
  documentId: string;
  draftVersion: string;
  at: string;
};

export type ReviewActionCommand =
  | { type: "exclude"; chunkId: string; at: string }
  | { type: "restore"; chunkId: string; at: string }
  | { type: "undo" }
  | { type: "redo" }
  | (StructuralMetadata & { type: "split"; chunkId: string; cursor: number })
  | (StructuralMetadata & { type: "merge-next"; chunkId: string })
  | (StructuralMetadata & { type: "source-create"; blockIds: string[] })
  | (StructuralMetadata & {
      type: "source-add" | "source-remove";
      chunkId: string;
      blockIds: string[];
    });

const HISTORY_LIMIT = 50;

export function applyReviewAction(
  reviewState: ReviewActionState,
  sourceBlocks: readonly ReviewSourceBlock[],
  command: ReviewActionCommand,
): ReviewActionState {
  if (command.type === "undo") return undo(reviewState);
  if (command.type === "redo") return redo(reviewState);
  validateTimestamp(command.at);
  return commit(reviewState, (draft) => {
    if (command.type === "exclude" || command.type === "restore") {
      const chunk = findChunk(draft, command.chunkId);
      chunk.excluded = command.type === "exclude";
      chunk.revisions.push({ type: "exclude", at: command.at });
      return;
    }
    if (command.type === "split") {
      splitChunk(draft, command);
      return;
    }
    if (command.type === "merge-next") {
      mergeNext(draft, command);
      return;
    }
    if (
      command.type === "source-create" ||
      command.type === "source-add" ||
      command.type === "source-remove"
    ) changeSources(draft, sourceBlocks, command);
  });
}

function splitChunk(
  draft: ReviewActionDraft,
  command: Extract<ReviewActionCommand, { type: "split" }>,
): void {
  const index = draft.chunks.findIndex((chunk) => chunk.id === command.chunkId);
  if (index < 0) throw new Error(`Chunk ${command.chunkId} does not exist`);
  const original = draft.chunks[index];
  if (
    !Number.isSafeInteger(command.cursor) ||
    command.cursor <= 0 ||
    command.cursor >= original.automaticText.length
  ) throw new Error("split cursor must be inside automaticText");
  if (original.finalText !== original.automaticText)
    throw new Error("split requires finalText to match automaticText for exact Source Segment mapping");
  const exactSegments = original.sourceSegments.map(requireExactSegment);
  const leftSegments = splitSegments(exactSegments, 0, command.cursor);
  const rightSegments = splitSegments(
    exactSegments,
    command.cursor,
    original.automaticText.length,
  );
  if (!leftSegments.length || !rightSegments.length)
    throw new Error("split cursor has no exact Source Segment on both sides");
  const leftText = original.automaticText.slice(0, command.cursor);
  const rightText = original.automaticText.slice(command.cursor);
  const left = structuralReplacement(
    original,
    leftText,
    leftSegments,
    command,
    `left:${command.cursor}:${leftText}`,
    "split",
  );
  const right = structuralReplacement(
    original,
    rightText,
    rightSegments,
    command,
    `right:${command.cursor}:${rightText}`,
    "split",
  );
  draft.chunks.splice(index, 1, left, right);
}

function mergeNext(
  draft: ReviewActionDraft,
  command: Extract<ReviewActionCommand, { type: "merge-next" }>,
): void {
  const index = draft.chunks.findIndex((chunk) => chunk.id === command.chunkId);
  const left = draft.chunks[index];
  const right = draft.chunks[index + 1];
  if (!left || !right || !compatible(left, right))
    throw new Error("merge-next requires adjacent compatible Chunks");
  const overlapPrefix = verifiedOverlapPrefix(left, right);
  const separator = overlapPrefix === 0 && left.automaticText && right.automaticText ? "\n\n" : "";
  const automaticText = left.automaticText + separator + right.automaticText.slice(overlapPrefix);
  const finalOverlap = overlapPrefix > 0 &&
      left.finalText.endsWith(right.finalText.slice(0, overlapPrefix))
    ? overlapPrefix
    : 0;
  const finalSeparator = finalOverlap === 0 && left.finalText && right.finalText ? "\n\n" : "";
  const finalText = left.finalText + finalSeparator + right.finalText.slice(finalOverlap);
  const offset = left.automaticText.length + separator.length;
  const segments: ReviewActionSegment[] = [
    ...clone(left.sourceSegments),
    ...clone(right.sourceSegments)
      .filter((segment) => segment.chunkEnd === null || segment.chunkEnd > overlapPrefix)
      .map((segment) => ({
      ...segment,
      chunkStart: segment.chunkStart === null ? null : segment.chunkStart - overlapPrefix + offset,
      chunkEnd: segment.chunkEnd === null ? null : segment.chunkEnd - overlapPrefix + offset,
      isOverlap: false,
    })),
  ];
  const merged = structuralReplacement(
    left,
    automaticText,
    segments,
    command,
    `merge:${right.id}:${automaticText}`,
    "merge",
    finalText,
  );
  draft.chunks.splice(index, 2, merged);
}

function verifiedOverlapPrefix(
  left: ReviewActionChunk,
  right: ReviewActionChunk,
): number {
  let prefix = 0;
  for (const segment of right.sourceSegments) {
    if (
      !segment.isOverlap ||
      segment.chunkStart !== prefix ||
      segment.chunkEnd === null ||
      segment.chunkEnd <= prefix ||
      segment.sourceStart === null ||
      segment.sourceEnd === null ||
      !left.sourceSegments.some((candidate) =>
        candidate.contentBlockId === segment.contentBlockId &&
        candidate.sourceStart === segment.sourceStart &&
        candidate.sourceEnd === segment.sourceEnd
      )
    ) break;
    prefix = segment.chunkEnd;
  }
  if (!prefix || !left.automaticText.endsWith(right.automaticText.slice(0, prefix)))
    return 0;
  return prefix;
}

function changeSources(
  draft: ReviewActionDraft,
  sourceBlocks: readonly ReviewSourceBlock[],
  command: Extract<ReviewActionCommand, { type: "source-create" | "source-add" | "source-remove" }>,
): void {
  const selectedIds = unique(command.blockIds);
  if (!selectedIds.length) throw new Error("source action requires at least one Content Block");
  selectedIds.forEach((id) => requireSourceBlock(sourceBlocks, id));

  if (command.type === "source-create") {
    const blocks = orderedBlocks(sourceBlocks, selectedIds);
    const type = compatibleBlockType(blocks);
    const automaticText = blocks.map((block) => reliableSearchText(block)).join("\n\n");
    const seed = blankChunk(type, automaticText, blockOnlySegments(blocks));
    const created = structuralReplacement(
      seed,
      automaticText,
      seed.sourceSegments,
      { ...command, chunkId: "source-create" },
      `create:${selectedIds.join(",")}:${automaticText}`,
      "source",
    );
    delete created.replacedChunkId;
    draft.chunks.push(created);
    return;
  }

  const index = draft.chunks.findIndex((chunk) => chunk.id === command.chunkId);
  if (index < 0) throw new Error(`Chunk ${command.chunkId} does not exist`);
  const original = draft.chunks[index];
  const currentIds = segmentBlockIds(original);
  const nextIds = command.type === "source-add"
    ? unique([...currentIds, ...selectedIds])
    : currentIds.filter((id) => !selectedIds.includes(id));
  if (!nextIds.length) throw new Error("source-remove cannot remove every Source Segment");
  const blocks = orderedBlocks(sourceBlocks, nextIds);
  const automaticText = blocks.map((block) => reliableSearchText(block)).join("\n\n");
  draft.chunks[index] = structuralReplacement(
    original,
    automaticText,
    blockOnlySegments(blocks),
    command,
    `${command.type}:${nextIds.join(",")}:${automaticText}`,
    "source",
  );
}

function structuralReplacement(
  original: ReviewActionChunk,
  automaticText: string,
  sourceSegments: ReviewActionSegment[],
  command: StructuralMetadata & { chunkId: string },
  fingerprint: string,
  revisionType: "split" | "merge" | "source",
  finalText = automaticText,
): ReviewActionChunk {
  const plan = planRecompute({
    documentId: command.documentId,
    draftVersion: command.draftVersion,
    chunkId: command.chunkId,
    change: { kind: "source_boundary", fingerprint },
    affectedChunkIds: [command.chunkId],
    affectedContentGroupIds: [],
  });
  if (plan.scope !== "local" || !plan.identity.chunkId)
    throw new Error("local structural action unexpectedly requires a document Preview");
  const invalidated = clone(original);
  if (invalidated.contextReviewState !== "not_generated")
    invalidated.contextReviewState = "stale";
  const next: ReviewActionChunk = {
    ...clone(invalidated),
    id: plan.identity.chunkId,
    replacedChunkId: plan.identity.replacedChunkId ?? undefined,
    automaticText,
    finalText,
    text: finalText,
    sourceSegments: clone(sourceSegments),
    sourceBlockIds: segmentBlockIds({ ...original, sourceSegments }),
    tokenCount: countTokens(finalText),
    contextScope: [],
    revisions: [...clone(original.revisions), { type: revisionType, at: command.at }],
    embeddingEligible: false,
    embeddingExclusionReasons: ["manual_review_required"],
    embeddingText: null,
  };
  delete (next as ReviewActionChunk & { reviewedModel?: unknown }).reviewedModel;
  delete (next as ReviewActionChunk & { display?: unknown }).display;
  delete (next as ReviewActionChunk & { searchText?: unknown }).searchText;
  delete (next as ReviewActionChunk & { normalizationStatus?: unknown }).normalizationStatus;
  if (next.contextReviewState === "stale")
    next.contextError = "Chunk structure or Source Segment changed";
  return next;
}

function blankChunk(
  type: Chunk["type"],
  text: string,
  sourceSegments: ReviewActionSegment[],
): ReviewActionChunk {
  return {
    id: "source-create",
    type,
    text,
    automaticText: text,
    finalText: text,
    page: null,
    bbox: null,
    sourceSegments,
    sourceBlockIds: segmentBlockIds({ sourceSegments }),
    tokenCount: countTokens(text),
    qualityFlags: [],
    relatedChunkIds: [],
    excluded: false,
    contextText: "",
    contextCandidateReasons: [],
    contextReviewState: "not_generated",
    embeddingEligible: false,
    embeddingExclusionReasons: ["manual_review_required"],
    embeddingText: null,
    revisions: [],
  };
}

function blockOnlySegments(
  blocks: readonly ReviewSourceBlock[],
): ReviewActionSegment[] {
  return blocks.map((block) => ({
    sourceDocumentVersion: block.sourceDocumentVersion,
    parsedDocumentVersion: block.parsedDocumentVersion,
    contentBlockId: block.contentBlockId,
    rawBlockId: block.rawBlockId,
    sourceViewKind: "parsed_document",
    page: null,
    bbox: null,
    sourceStart: null,
    sourceEnd: null,
    chunkStart: null,
    chunkEnd: null,
    isOverlap: false,
    mappingQuality: "block-only",
    locationQuality: "parsed_only",
    blockId: block.contentBlockId,
  }));
}

function splitSegments(
  segments: readonly SourceSegmentV21[],
  from: number,
  to: number,
): ReviewActionSegment[] {
  return segments.flatMap((segment) => {
    const start = Math.max(segment.chunkStart!, from);
    const end = Math.min(segment.chunkEnd!, to);
    if (start >= end) return [];
    const sourceStart = segment.sourceStart! + start - segment.chunkStart!;
    const sourceEnd = sourceStart + end - start;
    return [{
      ...clone(segment),
      blockId: segment.contentBlockId,
      sourceStart,
      sourceEnd,
      chunkStart: start - from,
      chunkEnd: end - from,
    }];
  });
}

function requireExactSegment(value: ReviewActionSegment): ReviewActionSegment {
  if (
    value.mappingQuality !== "exact" ||
    value.sourceStart === null ||
    value.sourceEnd === null ||
    value.chunkStart === null ||
    value.chunkEnd === null
  ) throw new Error("split requires exact Source Segment ranges");
  return value;
}

function commit(
  state: ReviewActionState,
  update: (draft: ReviewActionDraft) => void,
): ReviewActionState {
  if (!state.draft) throw new Error("No confirmed Chunk Draft");
  const before = clone(state.draft);
  const draft = clone(state.draft);
  update(draft);
  draft.chunks = draft.chunks.map((chunk) =>
    normalizeChunk(chunk, draft.configuration),
  );
  draft.metrics = actionMetrics(draft.chunks);
  return {
    ...clone(state),
    draft,
    undoStack: [...state.undoStack.map(clone), before].slice(-HISTORY_LIMIT),
    redoStack: [],
  };
}

function undo(state: ReviewActionState): ReviewActionState {
  if (!state.draft || !state.undoStack.length) return clone(state);
  const undoStack = state.undoStack.map(clone);
  const draft = undoStack.pop()!;
  return {
    ...clone(state),
    draft,
    undoStack,
    redoStack: [clone(state.draft), ...state.redoStack.map(clone)].slice(0, HISTORY_LIMIT),
  };
}

function redo(state: ReviewActionState): ReviewActionState {
  if (!state.draft || !state.redoStack.length) return clone(state);
  const redoStack = state.redoStack.map(clone);
  const draft = redoStack.shift()!;
  return {
    ...clone(state),
    draft,
    undoStack: [...state.undoStack.map(clone), clone(state.draft)].slice(-HISTORY_LIMIT),
    redoStack,
  };
}

function normalizeChunk(
  chunk: ReviewActionChunk,
  configuration: ChunkRequest,
): ReviewActionChunk {
  const tokenCount = countTokens(chunk.finalText);
  const maximum = configuration.strategy === "semantic"
    ? configuration.semanticMaxChunkSize
    : configuration.chunkSize;
  const preserved = chunk.qualityFlags.filter(
    (flag) => flag !== "oversized" && flag !== "undersized",
  );
  return {
    ...chunk,
    tokenCount,
    qualityFlags: [
      ...preserved,
      ...(tokenCount > maximum ? (["oversized"] as QualityFlag[]) : []),
      ...(tokenCount < 80 ? (["undersized"] as QualityFlag[]) : []),
    ],
  };
}

function actionMetrics(chunks: readonly ReviewActionChunk[]): ChunkPreviewMetrics {
  return previewMetrics(chunks.map((chunk): Chunk => ({
    ...clone(chunk),
    sourceSegments: chunk.sourceSegments.map((segment) => ({
      blockId: segment.contentBlockId,
      page: segment.page,
      bbox: segment.bbox ? [...segment.bbox] : null,
      sourceStart: segment.sourceStart ?? 0,
      sourceEnd: segment.sourceEnd ?? 0,
      chunkStart: segment.chunkStart ?? 0,
      chunkEnd: segment.chunkEnd ?? 0,
      isOverlap: segment.isOverlap,
    })),
  })));
}

function compatible(left: ReviewActionChunk, right: ReviewActionChunk): boolean {
  if ((left.finalType ?? left.type) !== (right.finalType ?? right.type)) return false;
  if (left.type !== right.type) return false;
  if (left.type === "table") return Boolean(left.tableId && left.tableId === right.tableId);
  if (left.type === "image") return false;
  return true;
}

function compatibleBlockType(blocks: readonly ReviewSourceBlock[]): Chunk["type"] {
  const types = unique(blocks.map((block) =>
    block.contentType === "table" ? "table" : block.contentType === "image" ? "image" : "text",
  ));
  if (types.length !== 1) throw new Error("source action requires compatible Content Block types");
  return types[0];
}

function reliableSearchText(block: ReviewSourceBlock): string {
  if (!block.searchText.trim())
    throw new Error(`Content Block ${block.contentBlockId} lacks reliable searchText`);
  return block.searchText;
}

function orderedBlocks(
  sourceBlocks: readonly ReviewSourceBlock[],
  ids: readonly string[],
): ReviewSourceBlock[] {
  const selected = new Set(ids);
  return sourceBlocks.filter((block) => selected.has(block.contentBlockId));
}

function requireSourceBlock(
  blocks: readonly ReviewSourceBlock[],
  id: string,
): ReviewSourceBlock {
  const block = blocks.find((candidate) => candidate.contentBlockId === id);
  if (!block) throw new Error(`Content Block ${id} does not exist`);
  return block;
}

function segmentBlockIds(value: { sourceSegments: readonly ReviewActionSegment[] }): string[] {
  return unique(value.sourceSegments.map((segment) => segment.contentBlockId));
}

function findChunk(draft: ReviewActionDraft, chunkId: string): ReviewActionChunk {
  const chunk = draft.chunks.find((candidate) => candidate.id === chunkId);
  if (!chunk) throw new Error(`Chunk ${chunkId} does not exist`);
  return chunk;
}

function validateTimestamp(at: string): void {
  if (!Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at)
    throw new Error("review action time must be an ISO timestamp");
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
