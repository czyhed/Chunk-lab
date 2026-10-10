import { createHash } from "node:crypto";
import {
  buildChunkPreview,
  countTokens,
  type ChunkRequest,
  type ParsedBlock,
  type SourceSegment,
} from "./chunking.js";
import type { EmbedTexts } from "./embedding.js";
import { evaluateEmbeddingEligibility, reliableSearchText } from "./v21-eligibility.js";
import {
  buildSourceSegment,
  type ProvenancedContentBlock,
  type SourceSegmentV21,
  type SourceViewKind,
  type LocationQuality,
  type BboxEvidence,
} from "./v21-provenance.js";
import {
  renderReviewedDisplay,
  serializeReviewedModelSearchText,
  type ReviewedModel,
} from "./v21-review-recompute.js";

export type V21ParsedDocument = {
  contractVersion: "2.1";
  sourceDocumentVersion: string;
  parsedDocumentVersion: string;
  normalizedContentVersion: string;
  normalizerVersion: string;
  normalizedModelVersion: string;
  parser?: string;
  parserVersion?: string;
  ordinaryBlocks?: unknown[];
  sourceAst?: unknown[];
  blocks: Array<ProvenancedContentBlock & {
    sourceLocation?: {
      sourceViewKind?: SourceViewKind;
      page: number | null;
      bbox: readonly [number, number, number, number] | null;
      locationQuality: LocationQuality;
      bboxEvidence?: BboxEvidence;
    };
  }>;
};

export async function buildV21Preview(
  document: V21ParsedDocument,
  request: ChunkRequest,
  embedTexts?: EmbedTexts,
  options?: { tableGroupIds?: Readonly<Record<string, string>> },
) {
  const blockById = new Map(document.blocks.map((block) => [block.contentBlockId, block]));
  const legacy = await buildChunkPreview(
    document.blocks
      .filter((block) => !block.excludedFromContentFlow)
      .map((block) => toChunkableBlock(block, options?.tableGroupIds?.[block.contentBlockId])),
    request,
    embedTexts,
  );
  const chunks = legacy.chunks.map((chunk) => {
    const segmentBlocks = chunk.sourceSegments.map((segment) => {
      const block = blockById.get(segment.blockId);
      if (!block) throw new Error(`Unknown Content Block ${segment.blockId}`);
      return { segment, block };
    });
    const eligibility = segmentBlocks.map(({ block }) =>
      evaluateEmbeddingEligibility({ block, locationQuality: "parsed_only" }),
    );
    const exclusionReasons = [...new Set(eligibility.flatMap((value) => value.embeddingExclusionReasons))];
    const contentTypes = [...new Set(segmentBlocks.map(({ block }) => block.contentType))];
    const automaticType = automaticChunkType(contentTypes, chunk.type);
    const normalizedModels = segmentBlocks.map(({ block }) => block.normalized);
    const eligibilityQualityFlags = [
      ...new Set(eligibility.flatMap((value) => value.qualityFlags)),
    ];
    const convertSegment = (segment: SourceSegment): SourceSegmentV21 & SourceSegment => {
      const block = blockById.get(segment.blockId)!;
      const location = sourceLocationFor(block);
      const v21 = buildSourceSegment({
        block,
        sourceViewKind: location.sourceViewKind,
        page: location.page,
        bbox: location.bbox,
        sourceStart: segment.sourceStart,
        sourceEnd: segment.sourceEnd,
        chunkStart: segment.chunkStart,
        chunkEnd: segment.chunkEnd,
        isOverlap: segment.isOverlap,
        mappingQuality: "exact",
        locationQuality: location.locationQuality,
        bboxEvidence: location.bboxEvidence,
      });
      return {
        ...v21,
        bbox: v21.bbox ? [...v21.bbox] : null,
        blockId: v21.contentBlockId,
        sourceStart: segment.sourceStart,
        sourceEnd: segment.sourceEnd,
        chunkStart: segment.chunkStart,
        chunkEnd: segment.chunkEnd,
      };
    };
    const sourceSegments = chunk.sourceSegments.map(convertSegment);
    const result = {
      ...chunk,
      ...(chunk.parentChunk ? { parentChunk: { ...chunk.parentChunk, sourceSegments: chunk.parentChunk.sourceSegments.map(convertSegment) } } : {}),
      automaticType,
      finalType: automaticType,
      sourceSegments,
      sourceBlockIds: [...new Set(sourceSegments.map((segment) => segment.contentBlockId))],
      eligibilityQualityFlags,
      embeddingEligible: exclusionReasons.length === 0,
      embeddingExclusionReasons: exclusionReasons,
      embeddingText: null,
      contentTypes,
      normalizedModels,
    };
    return automaticType === "table" ? withInitialTableReview(result, segmentBlocks) : result;
  }).map(normalizeUnusableTableChunk).filter((chunk): chunk is NonNullable<typeof chunk> => Boolean(chunk));
  const metadata = {
    contractVersion: "2.1" as const,
    sourceDocumentVersion: document.sourceDocumentVersion,
    parsedDocumentVersion: document.parsedDocumentVersion,
    normalizedContentVersion: document.normalizedContentVersion,
    normalizerVersion: document.normalizerVersion,
    normalizedModelVersion: document.normalizedModelVersion,
    strategyName: strategyName(request.strategy),
    tokenizer: { name: "cl100k_base", version: "llamaindex-0.12.1" },
    request,
  };
  return {
    ...metadata,
    previewVersion: `preview-${createHash("sha256")
      .update(JSON.stringify({ ...metadata, chunks }))
      .digest("hex")
      .slice(0, 16)}`,
    chunks,
    semanticSignals: legacy.semanticSignals,
    metrics: legacy.metrics,
  };
}

function normalizeUnusableTableChunk<T extends { automaticType?: string; finalType?: string; type: string; finalText?: string; reviewedModel?: unknown; qualityFlags?: string[] }>(chunk: T): T | null {
  if (chunk.automaticType !== "table") return chunk;
  if (isUsableTableModel(chunk.reviewedModel)) return chunk;
  if (!String(chunk.finalText ?? "").trim()) return null;
  return {
    ...chunk,
    type: "text",
    automaticType: "paragraph",
    finalType: "paragraph",
    qualityFlags: [...new Set([...(chunk.qualityFlags ?? []), "normalization_failed"])],
  };
}

function isUsableTableModel(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const model = value as { type?: unknown; columns?: unknown; rows?: unknown };
  return model.type === "table" && Array.isArray(model.columns) && model.columns.length > 0 && Array.isArray(model.rows) && model.rows.length > 0;
}

function automaticChunkType(
  contentTypes: readonly string[],
  fallback: "text" | "table" | "image",
): string {
  if (contentTypes.includes("table")) return "table";
  if (contentTypes.includes("image")) return "image";
  if (contentTypes.length === 1) return contentTypes[0];
  if (contentTypes.includes("paragraph")) return "paragraph";
  return contentTypes[0] ?? (fallback === "text" ? "paragraph" : fallback);
}

function sourceLocationFor(block: V21ParsedDocument["blocks"][number]): {
  sourceViewKind: SourceViewKind;
  page: number | null;
  bbox: readonly [number, number, number, number] | null;
  locationQuality: LocationQuality;
  bboxEvidence?: BboxEvidence;
} {
  if (block.parser === "commonmark" && block.sourceRange)
    return {
      sourceViewKind: "markdown_source",
      page: null,
      bbox: null,
      locationQuality: "exact",
    };
  if (block.parser === "txt" && block.sourceRange)
    return {
      sourceViewKind: "txt_source",
      page: null,
      bbox: null,
      locationQuality: "exact",
    };
  if (block.sourceLocation?.locationQuality === "page_only")
    return {
      sourceViewKind: block.sourceLocation.sourceViewKind ?? "original_file",
      page: block.sourceLocation.page,
      bbox: null,
      locationQuality: "page_only",
    };
  if (
    block.sourceLocation?.locationQuality === "exact" &&
    block.sourceLocation.page !== null &&
    block.sourceLocation.bbox !== null
  )
    return {
      sourceViewKind: block.sourceLocation.sourceViewKind ?? "original_file",
      page: block.sourceLocation.page,
      bbox: block.sourceLocation.bbox,
      locationQuality: "exact",
      bboxEvidence: block.sourceLocation.bboxEvidence,
    };
  return {
    sourceViewKind: "parsed_document",
    page: null,
    bbox: null,
    locationQuality: "parsed_only",
  };
}

function toChunkableBlock(block: ProvenancedContentBlock & V21ParsedDocument["blocks"][number], groupId?: string): ParsedBlock {
  const type = block.contentType === "table"
    ? "table"
    : block.contentType === "image"
      ? "image"
      : "text";
  const protectedText = ["formula", "code", "warning", "unsupported"].includes(
    block.contentType,
  );
  const role = ["heading", "paragraph", "list", "caption", "warning"].includes(
    block.contentType,
  )
    ? block.contentType
    : protectedText
      ? "caption"
      : type;
  return {
    id: block.contentBlockId,
    type,
    text: reliableSearchText(block),
    page: block.sourceLocation?.page ?? null,
    bbox: block.sourceLocation?.bbox ? [...block.sourceLocation.bbox] : null,
    readingOrder: Number(block.contentBlockId.split(":").at(-1)) - 1,
    role: role as ParsedBlock["role"],
    sourceBackend: block.parser,
    sourceVersion: block.parserVersion,
    ...(groupId ? { groupId } : {}),
    ...(protectedText ? { groupId: block.contentBlockId } : {}),
    ...(block.normalized?.type === "image"
      ? { imagePath: block.normalized.assetReference }
      : {}),
  };
}

function withInitialTableReview<T extends {
  id: string;
  tableId?: string;
  normalizedModels: unknown[];
  sourceSegments: SourceSegmentV21[];
}>(
  chunk: T,
  segmentBlocks: Array<{ block: ProvenancedContentBlock; segment: SourceSegment }>,
) {
  const tableBlocks = segmentBlocks.filter(
    ({ block }, index, all) =>
      block.normalized?.type === "table" &&
      all.findIndex((candidate) => candidate.block.contentBlockId === block.contentBlockId) === index,
  );
  if (!tableBlocks.length) return chunk;
  const first = tableBlocks[0].block.normalized;
  if (!first || first.type !== "table" || !first.columns.length) return chunk;
  const tableId = chunk.tableId ?? `table:${tableBlocks.map(({ block }) => block.contentBlockId).join("+")}`;
  const rows: Array<Array<{ cellId: string; text: string; rowSpan: number; colSpan: number }>> = [];
  const rowGroups: Array<{
    rowGroupId: string;
    order: number;
    repeatedHeader: boolean;
    sourceSegmentIds: string[];
    rowStart: number;
    rowCount: number;
  }> = [];
  tableBlocks.forEach(({ block }, groupIndex) => {
    const normalized = block.normalized;
    if (!normalized || normalized.type !== "table" || !normalized.rows.length) return;
    const rowStart = rows.length;
    normalized.rows.forEach((row, rowIndex) => {
      rows.push(first.columns.map((_, columnIndex) => ({
        cellId: `${tableId}:g${groupIndex + 1}:r${rowIndex + 1}:c${columnIndex + 1}`,
        text: String(row[columnIndex] ?? ""),
        rowSpan: 1,
        colSpan: 1,
      })));
    });
    rowGroups.push({
      rowGroupId: `${tableId}:group:${groupIndex + 1}`,
      order: groupIndex,
      repeatedHeader: groupIndex > 0,
      sourceSegmentIds: [block.contentBlockId],
      rowStart,
      rowCount: normalized.rows.length,
    });
  });
  if (!rows.length) return chunk;
  const reviewedModel: Extract<ReviewedModel, { type: "table" }> = {
    type: "table",
    tableId,
    ...(first.title ? { title: first.title } : {}),
    columns: [...first.columns],
    rows,
    rowGroups,
  };
  const finalText = serializeReviewedModelSearchText(reviewedModel);
  return {
    ...chunk,
    tableId,
    reviewedModel,
    reviewRevision: 0,
    reviewedModelRevisions: [],
    text: finalText,
    finalText,
    searchText: finalText,
    display: renderReviewedDisplay(reviewedModel, finalText),
    tokenCount: countTokens(finalText),
  };
}

function strategyName(strategy: ChunkRequest["strategy"]): string {
  return {
    structure: "Structure-Aware",
    sentence: "SentenceSplitter",
    token: "TokenTextSplitter",
    semantic: "Semantic Boundary",
    "parent-child": "Parent-Child",
  }[strategy];
}
