import {
  countTokens,
  previewMetrics,
  type Chunk,
  type ChunkPreview,
  type ChunkPreviewMetrics,
  type ChunkRequest,
  type QualityFlag,
} from "./chunking.js";
import { invalidateContext } from "./contextual.js";

export type DraftSnapshot = {
  chunks: Chunk[];
  metrics: ChunkPreviewMetrics;
  configuration: ChunkRequest;
  confirmedAt: string;
};

export type ReviewState = {
  preview: (ChunkPreview & { configuration: ChunkRequest }) | null;
  draft: DraftSnapshot | null;
  undoStack: DraftSnapshot[];
  redoStack: DraftSnapshot[];
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function normalizeDraft(draft: DraftSnapshot): DraftSnapshot {
  const normalized = clone(draft);
  const budget =
    normalized.configuration.strategy === "semantic"
      ? normalized.configuration.semanticMaxChunkSize
      : normalized.configuration.chunkSize;
  for (const chunk of normalized.chunks) {
    chunk.tokenCount = countTokens(chunk.finalText);
    const preserved = chunk.qualityFlags.filter(
      (flag) => flag !== "oversized" && flag !== "undersized",
    );
    chunk.qualityFlags = [
      ...preserved,
      ...(chunk.tokenCount > budget ? (["oversized"] as QualityFlag[]) : []),
      ...(chunk.tokenCount < 80 ? (["undersized"] as QualityFlag[]) : []),
    ];
  }
  normalizeImageRelations(normalized.chunks);
  normalized.metrics = previewMetrics(normalized.chunks);
  return normalized;
}

function normalizeImageRelations(chunks: Chunk[]): void {
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  for (const chunk of chunks) {
    if (chunk.type !== "image") continue;
    const image = chunk as Chunk & {
      imagePolicy?: "summary" | "reference" | "exclude";
      embeddingEligible?: boolean;
      embeddingExclusionReasons?: string[];
      invalidRelatedChunkIds?: string[];
      relatedChunkOrder?: string[];
      relatedChunkStatus?: "optional" | "valid" | "missing" | "invalid" | "not_required";
    };
    const original = [...new Set([
      ...(image.relatedChunkOrder ?? []),
      ...(image.relatedChunkIds ?? []),
      ...(image.invalidRelatedChunkIds ?? []),
    ])];
    const valid = original.filter((id) => {
      const related = byId.get(id);
      const searchable = related as Chunk & {
        embeddingEligible?: boolean;
        embeddingExclusionReasons?: string[];
      } | undefined;
      return Boolean(
        searchable &&
        searchable.id !== image.id &&
        searchable.type === "text" &&
        chunkVersionsMatch(image, searchable) &&
        !searchable.excluded &&
        searchable.finalText.trim() &&
        searchable.embeddingEligible === true &&
        (searchable.embeddingExclusionReasons?.length ?? 0) === 0,
      );
    });
    const invalid = original.filter((id) => !valid.includes(id));
    image.relatedChunkIds = valid;
    image.relatedChunkOrder = original;
    image.invalidRelatedChunkIds = invalid;
    if (
      invalid.length &&
      image.imagePolicy === "reference" &&
      image.contextReviewState !== "not_generated"
    ) {
      image.contextReviewState = "stale";
      image.contextError = "关联文字 Chunk 已排除、删除、替换或失去检索资格";
    }
    if (image.excluded || image.imagePolicy === "exclude") {
      image.relatedChunkStatus = "not_required";
      image.embeddingEligible = false;
      image.embeddingExclusionReasons = ["missing_reliable_search_text"];
    } else if (image.imagePolicy === "reference") {
      image.relatedChunkStatus = valid.length
        ? invalid.length ? "invalid" : "valid"
        : invalid.length ? "invalid" : "missing";
      image.embeddingEligible = false;
      image.embeddingExclusionReasons = [valid.length
        ? "image_reference_uses_related_text"
        : "reference_requires_related_text"];
    } else if (image.imagePolicy === "summary") {
      image.relatedChunkStatus = invalid.length
        ? "invalid"
        : valid.length ? "valid" : "optional";
      image.embeddingEligible = Boolean(image.finalText.trim());
      image.embeddingExclusionReasons = image.embeddingEligible
        ? []
        : ["missing_reliable_search_text"];
    }
  }
}

function chunkVersionsMatch(left: Chunk, right: Chunk): boolean {
  const leftVersions = chunkVersions(left);
  const rightVersions = chunkVersions(right);
  return (!leftVersions.sourceDocumentVersion || !rightVersions.sourceDocumentVersion ||
      leftVersions.sourceDocumentVersion === rightVersions.sourceDocumentVersion) &&
    (!leftVersions.parsedDocumentVersion || !rightVersions.parsedDocumentVersion ||
      leftVersions.parsedDocumentVersion === rightVersions.parsedDocumentVersion);
}

function chunkVersions(chunk: Chunk): {
  sourceDocumentVersion?: string;
  parsedDocumentVersion?: string;
} {
  const segments = chunk.sourceSegments as Array<Chunk["sourceSegments"][number] & {
    sourceDocumentVersion?: string;
    parsedDocumentVersion?: string;
  }>;
  return {
    sourceDocumentVersion: segments.find((segment) => segment.sourceDocumentVersion)?.sourceDocumentVersion,
    parsedDocumentVersion: segments.find((segment) => segment.parsedDocumentVersion)?.parsedDocumentVersion,
  };
}

export function createReviewState(): ReviewState {
  return { preview: null, draft: null, undoStack: [], redoStack: [] };
}

export function setPreview(
  state: ReviewState,
  preview: ChunkPreview,
  configuration: ChunkRequest,
): ReviewState {
  return {
    ...clone(state),
    preview: { ...clone(preview), configuration: clone(configuration) },
  };
}

export function confirmPreview(state: ReviewState): ReviewState {
  if (!state.preview) throw new Error("No Chunk Preview to confirm");
  return {
    preview: null,
    draft: {
      chunks: clone(state.preview.chunks),
      metrics: clone(state.preview.metrics),
      configuration: clone(state.preview.configuration),
      confirmedAt: new Date().toISOString(),
    },
    undoStack: [],
    redoStack: [],
  };
}

function updateDraft(
  state: ReviewState,
  update: (draft: DraftSnapshot) => void,
): ReviewState {
  if (!state.draft) throw new Error("No confirmed Chunk Draft");
  const before = clone(state.draft);
  const draft = clone(state.draft);
  update(draft);
  return {
    ...clone(state),
    draft,
    undoStack: [...state.undoStack.map(clone), before].slice(-50),
    redoStack: [],
  };
}

function findChunk(draft: DraftSnapshot, chunkId: string): Chunk {
  const chunk = draft.chunks.find((candidate) => candidate.id === chunkId);
  if (!chunk) throw new Error(`Chunk ${chunkId} does not exist`);
  return chunk;
}

export function applyTextRevision(
  state: ReviewState,
  chunkId: string,
  finalText: string,
): ReviewState {
  if (!finalText.trim()) throw new Error("Chunk cannot be empty");
  return updateDraft(state, (draft) => {
    const chunk = findChunk(draft, chunkId);
    const before = chunk.finalText;
    chunk.finalText = finalText;
    chunk.text = finalText;
    chunk.revisions.push({
      type: "text",
      at: new Date().toISOString(),
      before,
      after: finalText,
    });
    Object.assign(chunk, invalidateContext(chunk));
  });
}

export function toggleExcluded(state: ReviewState, chunkId: string): ReviewState {
  return updateDraft(state, (draft) => {
    const chunk = findChunk(draft, chunkId);
    chunk.excluded = !chunk.excluded;
    chunk.revisions.push({ type: "exclude", at: new Date().toISOString() });
  });
}

export function undoRevision(state: ReviewState): ReviewState {
  if (!state.draft || !state.undoStack.length) return clone(state);
  const undoStack = state.undoStack.map(clone);
  const previous = undoStack.pop()!;
  return {
    ...clone(state),
    draft: previous,
    undoStack,
    redoStack: [clone(state.draft), ...state.redoStack.map(clone)].slice(0, 50),
  };
}

export function redoRevision(state: ReviewState): ReviewState {
  if (!state.draft || !state.redoStack.length) return clone(state);
  const redoStack = state.redoStack.map(clone);
  const next = redoStack.shift()!;
  return {
    ...clone(state),
    draft: next,
    undoStack: [...state.undoStack.map(clone), clone(state.draft)].slice(-50),
    redoStack,
  };
}

export function serializeReviewState(state: ReviewState): string {
  return JSON.stringify(state);
}

export function restoreReviewState(value: unknown): ReviewState {
  if (!value || typeof value !== "object")
    throw new Error("Invalid review state");
  const candidate = value as Partial<ReviewState>;
  if (!Array.isArray(candidate.undoStack) || !Array.isArray(candidate.redoStack))
    throw new Error("Invalid review state");
  const restored = clone(candidate as ReviewState);
  restored.draft = restored.draft ? normalizeDraft(restored.draft) : null;
  restored.undoStack = restored.undoStack.map(normalizeDraft);
  restored.redoStack = restored.redoStack.map(normalizeDraft);
  return restored;
}
