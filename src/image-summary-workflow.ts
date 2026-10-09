import {
  type Chunk,
} from "./chunking.js";
import {
  restoreReviewState,
  type ReviewState,
} from "./review-state.js";
import type { ImageObjectReference } from "./image-object-store.js";

export type ImageSummaryReviewInput = {
  imagePolicy: "summary" | "reference" | "exclude";
  humanSummary: string;
  humanSupplement: string;
  relatedChunkIds?: string[];
};

type ImageReviewChunk = Chunk & {
  imagePolicy?: "summary" | "reference" | "exclude";
  imageReferenceText?: string;
  imageObjectReference?: ImageObjectReference;
  vlmSummaryGenerated?: string;
  vlmSummaryReviewed?: string;
  vlmSummarySupplement?: string;
  vlmSummaryEffective?: string;
  vlmStatus?: "unconfigured" | "generating" | "awaiting_review" | "failed";
  imageSummarySavedAt?: string;
  reviewedModel?: Record<string, unknown>;
  display?: { text: string };
  searchText?: string;
  normalizationStatus?: string;
  embeddingEligible?: boolean;
  embeddingExclusionReasons?: string[];
  embeddingText?: null;
};

const ALLOWED_INPUT_FIELDS = new Set([
  "imagePolicy",
  "humanSummary",
  "humanSupplement",
  "relatedChunkIds",
]);

export function saveImageSummaryReview(
  review: ReviewState,
  chunkId: string,
  input: ImageSummaryReviewInput,
  at: string,
): ReviewState {
  validateImageSummaryInput(input, at);
  if (!review.draft) throw new Error("需要先采用 Chunk Draft");
  const beforeDraft = structuredClone(review.draft);
  const draft = structuredClone(review.draft);
  const chunk = draft.chunks.find((candidate) => candidate.id === chunkId) as
    | ImageReviewChunk
    | undefined;
  if (!chunk || chunk.type !== "image") throw new Error("图片 Chunk 不存在");

  const relatedChunkIds = normalizeRelatedChunkIds(
    draft.chunks,
    chunkId,
    input.relatedChunkIds ?? chunk.relatedChunkIds,
  );
  if (input.imagePolicy === "reference" && relatedChunkIds.length === 0)
    throw new Error(
      "仅引用图片必须关联至少一个有效文字 Chunk。影响：图片不会进入文本检索或 Embedding。下一步：搜索并选择同一文档内未排除的文字 Chunk 后重试。",
    );

  const generated = cleanText(chunk.vlmSummaryGenerated ?? "");
  const reviewed = cleanText(input.humanSummary);
  const supplement = cleanText(input.humanSupplement);
  if (input.imagePolicy === "summary" && !reviewed && !generated)
    throw new Error("摘要 + 引用图片必须先生成 VLM 摘要或填写人工摘要");
  const effective = [reviewed || generated, supplement].filter(Boolean).join("\n");
  const finalText = input.imagePolicy === "summary"
    ? effective
    : "";
  const previousFinalText = chunk.finalText;
  const previousPolicy = chunk.imagePolicy;

  Object.assign(chunk, {
    imagePolicy: input.imagePolicy,
    vlmSummaryReviewed: reviewed,
    vlmSummarySupplement: supplement,
    vlmSummaryEffective: effective,
    imageSummarySavedAt: at,
    relatedChunkIds,
    relatedChunkOrder: relatedChunkIds,
    invalidRelatedChunkIds: [],
    finalText,
    text: finalText,
    excluded: input.imagePolicy === "exclude",
    reviewedModel: {
      type: "image",
      imageId: chunk.imageId ?? chunk.id,
      ...(chunk.imageObjectReference
        ? { assetReference: chunk.imageObjectReference.uri }
        : {}),
      ...(chunk.productIdentity
        ? { productIdentity: chunk.productIdentity }
        : {}),
      ...(effective ? { summary: effective } : {}),
    },
    display: { text: finalText },
    searchText: finalText,
    normalizationStatus: "manual_fixed",
    embeddingEligible: Boolean(finalText) && input.imagePolicy === "summary",
    embeddingExclusionReasons: finalText && input.imagePolicy === "summary"
      ? []
      : [input.imagePolicy === "reference"
        ? "image_reference_uses_related_text"
        : "missing_reliable_search_text"],
    embeddingText: null,
  });

  const semanticInputChanged = previousFinalText !== finalText ||
    previousPolicy !== input.imagePolicy;
  if (semanticInputChanged && chunk.contextReviewState !== "not_generated") {
    chunk.contextReviewState = "stale";
    chunk.contextError = "图片策略或摘要已更新";
  }
  if (previousFinalText !== finalText)
    chunk.revisions.push({
      type: "text",
      at,
      before: previousFinalText,
      after: finalText,
    });

  return restoreReviewState({
    ...structuredClone(review),
    draft,
    undoStack: [...review.undoStack, beforeDraft].slice(-50),
    redoStack: [],
  });
}

export function validateImageSummaryInput(
  input: ImageSummaryReviewInput,
  at: string,
): void {
  if (!input || typeof input !== "object") throw new Error("图片摘要请求无效");
  const unexpected = Object.keys(input).find((key) => !ALLOWED_INPUT_FIELDS.has(key));
  if (unexpected) throw new Error("派生字段只能由服务器计算");
  if (!["summary", "reference", "exclude"].includes(input.imagePolicy))
    throw new Error("图片策略无效");
  if (
    typeof input.humanSummary !== "string" ||
    typeof input.humanSupplement !== "string"
  ) throw new Error("人工摘要和人工补充必须是字符串");
  if (input.relatedChunkIds !== undefined && !Array.isArray(input.relatedChunkIds))
    throw new Error("relatedChunkIds 必须是字符串数组");
  if (input.relatedChunkIds?.some((id) => typeof id !== "string" || !id.trim()))
    throw new Error("relatedChunkIds 必须只包含有效 Chunk ID");
  if (new Date(at).toISOString() !== at) throw new Error("保存时间无效");
}

function normalizeRelatedChunkIds(
  chunks: readonly Chunk[],
  imageChunkId: string,
  requested: readonly string[],
): string[] {
  const ids = [...new Set(requested.map((id) => id.trim()))];
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  for (const id of ids) {
    const candidate = byId.get(id);
    if (!candidate) throw new Error("关联 Chunk 不存在或已失效");
    if (id === imageChunkId) throw new Error("图片不能关联自身");
    if (candidate.type !== "text") throw new Error("图片只能关联可检索的文字 Chunk");
    if (!versionsMatch(chunks.find((chunk) => chunk.id === imageChunkId)!, candidate))
      throw new Error("关联文字 Chunk 版本已过期");
    const searchable = candidate as Chunk & {
      embeddingEligible?: boolean;
      embeddingExclusionReasons?: string[];
    };
    if (
      candidate.excluded ||
      !candidate.finalText.trim() ||
      searchable.embeddingEligible !== true ||
      (searchable.embeddingExclusionReasons?.length ?? 0) > 0
    ) throw new Error("关联 Chunk 已排除、失效或不具备检索资格");
  }
  return ids;
}

function versionsMatch(image: Chunk, related: Chunk): boolean {
  const imageVersions = chunkVersions(image);
  const relatedVersions = chunkVersions(related);
  return (!imageVersions.sourceDocumentVersion || !relatedVersions.sourceDocumentVersion ||
      imageVersions.sourceDocumentVersion === relatedVersions.sourceDocumentVersion) &&
    (!imageVersions.parsedDocumentVersion || !relatedVersions.parsedDocumentVersion ||
      imageVersions.parsedDocumentVersion === relatedVersions.parsedDocumentVersion);
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

function cleanText(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}
