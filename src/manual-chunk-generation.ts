import { createHash } from "node:crypto";
import { countTokens, previewMetrics, type Chunk } from "./chunking.js";
import { mapTrustedBbox } from "./v21-bbox.js";
import { evaluateEmbeddingEligibility, reliableSearchText } from "./v21-eligibility.js";
import type { V21ParsedDocument } from "./v21-preview.js";
import type { SourcePageMapping } from "./v21-parsed-document.js";

type NormalizedBbox = [number, number, number, number];

export type EffectiveManualAnnotation = {
  id: string;
  sourceBlockIds: string[];
  page: number;
  bbox: NormalizedBbox;
  type: string;
  readingOrder: number;
  layer: "detection" | "manual";
  excluded?: boolean;
  logicalGroupId?: string;
  manualText?: string;
  transcriptionSource?: "human";
  transcribedAt?: string;
};

export type ManualChunk = Chunk & {
  contentTypes: string[];
  manualGenerationKey: string;
  manualGenerationFingerprint: string;
  manualAnnotationIds: string[];
  manualPages: number[];
  normalizedModels?: unknown[];
  normalizationStatus?: string;
  embeddingEligible?: boolean;
  embeddingExclusionReasons?: string[];
  embeddingText?: string | null;
  imagePolicy?: "summary" | "reference" | "exclude";
};

export type ManualChunkGenerationInput = {
  document: V21ParsedDocument;
  sourceMapping: SourcePageMapping;
  scope:
    | { kind: "document" }
    | { kind: "page"; page: number; selectedAnnotationIds?: string[] };
  effectiveAnnotations: EffectiveManualAnnotation[];
  suppressedSourceBlockIds: string[];
  previousChunks: Chunk[];
  imagePolicy: "summary" | "reference" | "exclude";
  visualCopyVersion?: string;
};

/** Preserve the complete preview when an incremental manual generation is requested. */
export function preparePreviousChunksForManualGeneration(
  previousChunks: readonly Chunk[],
): Chunk[] {
  return structuredClone([...previousChunks]);
}

export function generateManualChunks(input: ManualChunkGenerationInput) {
  if (input.sourceMapping.sourceDocumentVersion !== input.document.sourceDocumentVersion)
    throw generationError("SOURCE_VERSION_MISMATCH", "页面映射与当前 Source Document 版本不匹配");
  const suppressed = new Set(input.suppressedSourceBlockIds);
  const active = input.effectiveAnnotations.filter((annotation) =>
    !annotation.excluded &&
    !(annotation.layer === "detection" && annotation.sourceBlockIds.some((id) => suppressed.has(id))),
  );
  const groups = new Map<string, EffectiveManualAnnotation[]>();
  for (const annotation of active) {
    const key = generationKey(annotation);
    const group = groups.get(key) ?? [];
    group.push(annotation);
    groups.set(key, group);
  }
  const selectedIds = input.scope.kind === "page"
    ? new Set(input.scope.selectedAnnotationIds ?? [])
    : new Set<string>();
  const targetPage = input.scope.kind === "page" ? input.scope.page : null;
  const previous = input.previousChunks as ManualChunk[];
  const bootstrapSelectedIncrement = selectedIds.size > 1 && previous.length === 0;
  const targetKeys = new Set([...groups].filter(([, annotations]) =>
    input.scope.kind === "document" ||
    bootstrapSelectedIncrement ||
    (selectedIds.size
      ? annotations.some((annotation) => selectedIds.has(annotation.id))
      : annotations.some((annotation) => annotation.page === targetPage)),
  ).map(([key]) => key));
  const previousByKey = new Map(previous
    .filter((chunk) => typeof chunk.manualGenerationKey === "string")
    .map((chunk) => [chunk.manualGenerationKey, chunk]));
  const generated = [...groups]
    .filter(([key]) => targetKeys.has(key))
    .map(([key, annotations]) => chunkForGroup(input, key, annotations))
    .filter((chunk): chunk is ManualChunk => Boolean(chunk))
    .map((chunk) => {
      const existing = previousByKey.get(chunk.manualGenerationKey);
      return existing?.manualGenerationFingerprint === chunk.manualGenerationFingerprint
        ? structuredClone(existing)
        : chunk;
    });
  const generatedSourceIds = new Set(generated.flatMap((chunk) => chunk.sourceBlockIds));
  const preserved = previous.filter((chunk) => {
    if (!chunk.manualGenerationKey) return true;
    if (input.scope.kind === "document") return false;
    if (selectedIds.size) {
      if (targetKeys.has(chunk.manualGenerationKey)) return false;
      if (!groups.has(chunk.manualGenerationKey) && chunk.sourceBlockIds.some((id) => generatedSourceIds.has(id)))
        return false;
      return true;
    }
    return !(chunk.manualPages ?? chunk.sourceSegments.map((segment) => segment.page))
      .includes(input.scope.page);
  });
  const chunks = [...preserved, ...generated].sort(chunkOrder);
  return { chunks, metrics: previewMetrics(chunks), semanticSignals: [] as never[] };
}

function chunkForGroup(
  input: ManualChunkGenerationInput,
  key: string,
  annotations: EffectiveManualAnnotation[],
): ManualChunk | null {
  const orderedAnnotations = [...annotations].sort(annotationOrder);
  const type = orderedAnnotations.some((annotation) => annotation.type === "table")
    ? "table"
    : orderedAnnotations.some((annotation) => annotation.type === "image")
      ? "image"
      : "text";
  const imageOnly = type === "image" && orderedAnnotations.every((annotation) => annotation.type === "image");
  const located = orderedAnnotations.flatMap((annotation) =>
    imageOnly && !annotation.sourceBlockIds.length && !annotation.manualText?.trim()
      ? []
      : locatedBlocks(input, annotation),
  );
  const synthetic = orderedAnnotations
    .filter((annotation) => annotation.manualText?.trim() && !located.some((value) => value.annotation.id === annotation.id))
    .map((annotation) => ({ annotation, block: null, sourceLocation: null, documentIndex: Number.MAX_SAFE_INTEGER, text: annotation.manualText!.trim(), synthetic: true as const, syntheticKind: "transcription" as const }));
  const imageRegions = imageOnly && !located.length && !synthetic.length
    ? orderedAnnotations.map((annotation) => ({ annotation, block: null, sourceLocation: null, documentIndex: Number.MAX_SAFE_INTEGER, text: "", synthetic: true as const, syntheticKind: "image" as const }))
    : [];
  const unique = new Map(located.map((value) => [value.block.contentBlockId, value]));
  const blocks = [...unique.values()].sort((left, right) =>
    left.annotation.page - right.annotation.page ||
    left.annotation.readingOrder - right.annotation.readingOrder ||
    left.documentIndex - right.documentIndex,
  );
  const entries = [...blocks, ...synthetic, ...imageRegions].sort((left, right) =>
    left.annotation.page - right.annotation.page || left.annotation.readingOrder - right.annotation.readingOrder || left.documentIndex - right.documentIndex,
  );
  if (!entries.length)
    throw generationError("EMPTY_BBOX_INTERSECTION", "人工框未命中可信 Source Block；请填写人工转录文字，或改为图片/表格类型后重试", orderedAnnotations);
  const textParts = entries.map((entry) => entry.text ?? (entry.block ? reliableSearchText(entry.block) : "")).filter(Boolean);
  const text = textParts.join("\n");
  const automaticType = automaticManualType(
    orderedAnnotations.map((annotation) => annotation.type),
  );
  const sourceBlockIds = entries.flatMap((entry) =>
    entry.block
      ? [entry.block.contentBlockId]
      : entry.syntheticKind === "image" ? [] : [`manual-annotation:${entry.annotation.id}`],
  );
  const fingerprint = hash({
    document: input.document.parsedDocumentVersion,
    key,
    type,
    contentTypes: [...new Set(orderedAnnotations.map((annotation) => annotation.type))],
    imagePolicy: type === "image" ? input.imagePolicy : undefined,
    sourceBlockIds,
    annotations: orderedAnnotations.map(({ id, page, bbox, type: annotationType, sourceBlockIds: ids }) =>
      ({ id, page, bbox, type: annotationType, sourceBlockIds: ids })),
  });
  let chunkCursor = 0;
  const sourceSegments = entries.map((entry) => {
    const { block, sourceLocation, annotation, synthetic: isSynthetic } = entry;
    const syntheticKind = "syntheticKind" in entry ? entry.syntheticKind : undefined;
    if (isSynthetic) {
      const pageMapping = input.sourceMapping.pages.find((page) => page.page === annotation.page);
      if (!pageMapping)
        throw generationError("BBOX_UNTRUSTED", "人工框对应的来源定位缺失、过期、版本不匹配或越界", [annotation]);
      const pageWidth = syntheticKind === "image"
        ? pageMapping.pageWidth
        : pageMapping.bboxPageWidth ?? pageMapping.pageWidth;
      const pageHeight = syntheticKind === "image"
        ? pageMapping.pageHeight
        : pageMapping.bboxPageHeight ?? pageMapping.pageHeight;
      const sourceTextLength = syntheticKind === "transcription" ? (annotation.manualText ?? "").trim().length : 0;
      return {
        blockId: `${syntheticKind === "image" ? "manual-image-region" : "manual-annotation"}:${annotation.id}`,
        contentBlockId: `${syntheticKind === "image" ? "manual-image-region" : "manual-annotation"}:${annotation.id}`,
        rawBlockId: null,
        sourceDocumentVersion: input.document.sourceDocumentVersion,
        parsedDocumentVersion: input.document.parsedDocumentVersion,
        sourceViewKind: "original_file",
        page: annotation.page,
        bbox: [annotation.bbox[0] * pageWidth, annotation.bbox[1] * pageHeight, annotation.bbox[2] * pageWidth, annotation.bbox[3] * pageHeight],
        bboxEvidence: {
          page: annotation.page,
          pageWidth,
          pageHeight,
          coordinateUnit: "manual_normalized",
          coordinateOrigin: "top-left",
          sourceDocumentVersion: input.document.sourceDocumentVersion,
          orientation: pageMapping.orientation,
          transform: [1, 0, 0, 1, 0, 0],
          mappingVersion: "manual-annotation-v1",
        },
        sourceStart: 0,
        sourceEnd: sourceTextLength,
        chunkStart: 0,
        chunkEnd: sourceTextLength,
        isOverlap: false,
        mappingQuality: "exact",
        locationQuality: "exact",
        provenance: {
          kind: syntheticKind === "image" ? "human_image_region" : "human_transcription",
          annotationId: annotation.id,
          source: "human",
        },
      };
    }
    const trustedBlock = block!;
    const trustedLocation = sourceLocation!;
    if (chunkCursor > 0) chunkCursor += 1;
    const chunkStart = chunkCursor;
    const entryText = entries.find((entry) => entry.block?.contentBlockId === trustedBlock.contentBlockId)?.text ?? reliableSearchText(trustedBlock);
    chunkCursor += entryText.length;
    return {
      blockId: trustedBlock.contentBlockId,
      contentBlockId: trustedBlock.contentBlockId,
      rawBlockId: trustedBlock.rawBlockId,
      sourceDocumentVersion: trustedBlock.sourceDocumentVersion,
      parsedDocumentVersion: trustedBlock.parsedDocumentVersion,
      sourceViewKind: trustedLocation.sourceViewKind ?? "original_file",
      page: trustedLocation.page,
      bbox: trustedLocation.bbox ? [...trustedLocation.bbox] : null,
      bboxEvidence: trustedLocation.bboxEvidence ? structuredClone(trustedLocation.bboxEvidence) : undefined,
      sourceStart: 0,
      sourceEnd: entryText.length,
      chunkStart,
      chunkEnd: chunkStart + entryText.length,
      isOverlap: false,
      mappingQuality: "exact",
      locationQuality: "exact",
    };
  });
  const normalizedModels = entries
    .filter((entry) => entry.block?.normalized)
    .map((entry) => structuredClone(entry.block!.normalized));
  const reliableMergedTable = type === "table" && Boolean(text.trim()) && normalizedModels.some((model) =>
    model && typeof model === "object" &&
    (model as { type?: unknown }).type === "table" &&
    Array.isArray((model as { columns?: unknown }).columns) &&
    (model as { columns: unknown[] }).columns.length > 0 &&
    Array.isArray((model as { rows?: unknown }).rows) &&
    (model as { rows: unknown[] }).rows.length > 0,
  );
  if (type === "table" && !reliableMergedTable && !text.trim()) return null;
  const unusableTableFallback = type === "table" && !reliableMergedTable;
  const outputType = unusableTableFallback ? "text" : type;
  const outputAutomaticType = unusableTableFallback ? "paragraph" : automaticType;
  const eligibility = entries.map((entry) => entry.synthetic
    ? { embeddingEligible: Boolean(entry.text?.trim()), embeddingExclusionReasons: entry.text?.trim() ? [] : ["missing_reliable_search_text"], qualityFlags: [], embeddingText: null }
    : evaluateEmbeddingEligibility({
        block: entry.annotation.manualText?.trim()
          ? { ...entry.block!, searchText: entry.text, normalizationStatus: "manual_fixed" }
          : entry.block!,
        locationQuality: "exact",
        manualValidation: entry.annotation.manualText?.trim()
          ? { reviewedModelValid: true, sourceValid: true, searchTextValid: true }
          : undefined,
      }));
  const exclusionReasons = [...new Set(eligibility.flatMap((item, index) =>
    item.embeddingExclusionReasons.filter((reason) => {
      if (!["normalization_failed", "missing_reliable_search_text"].includes(reason)) return true;
      if (reliableMergedTable) return false;
      return !text.trim() || Boolean(entries[index]?.text?.trim());
    })))];
  const qualityFlags = [...new Set(eligibility.flatMap((item) => item.qualityFlags))] as never;
  const imageExclusionReasons = type === "image"
    ? [input.imagePolicy === "reference" ? "image_reference_uses_related_text" : "missing_reliable_search_text"]
    : exclusionReasons;
  const transcriptionRevisions = orderedAnnotations.filter((annotation) => annotation.manualText?.trim()).map((annotation) => ({
    type: "manual_transcription" as const,
    at: annotation.transcribedAt ?? "",
    annotationId: annotation.id,
    source: "human",
  }));
  return {
    id: `manual-${hash({ document: input.document.parsedDocumentVersion, key }).slice(0, 16)}`,
    type: outputType,
    automaticType: outputAutomaticType,
    finalType: outputAutomaticType,
    contentTypes: [...new Set(orderedAnnotations.map((annotation) => annotation.type))],
    imagePolicy: type === "image" ? input.imagePolicy : undefined,
    text,
    automaticText: text,
    finalText: text,
    page: entries[0]?.annotation.page ?? null,
    bbox: entries.length === 1 ? [...entries[0].annotation.bbox] : null,
    sourceSegments,
    sourceBlockIds,
    tokenCount: countTokens(text),
    qualityFlags: (type === "table" && !reliableMergedTable ? [...new Set([...qualityFlags, "normalization_failed"])] : qualityFlags) as never,
    relatedChunkIds: [],
    excluded: type === "image" && input.imagePolicy === "exclude",
    contextText: "",
    contextCandidateReasons: [],
    contextReviewState: "not_generated",
    revisions: transcriptionRevisions,
    normalizedModels,
    normalizationStatus: transcriptionRevisions.length ? "manual_fixed" : "normalized",
    embeddingEligible: type === "image" ? false : exclusionReasons.length === 0,
    embeddingExclusionReasons: imageExclusionReasons,
    embeddingText: null,
    manualGenerationKey: key,
    manualGenerationFingerprint: fingerprint,
    manualAnnotationIds: orderedAnnotations.map((annotation) => annotation.id),
    manualPages: [...new Set(orderedAnnotations.map((annotation) => annotation.page))].sort((a, b) => a - b),
  };
}

function automaticManualType(types: readonly string[]): string {
  if (types.includes("table")) return "table";
  if (types.includes("image")) return "image";
  for (const type of ["heading", "list", "formula", "code", "warning", "caption"])
    if (types.includes(type)) return type;
  return "paragraph";
}

function locatedBlocks(input: ManualChunkGenerationInput, annotation: EffectiveManualAnnotation) {
  assertNormalizedBbox(annotation);
  if (!annotation.sourceBlockIds.length && annotation.manualText?.trim()) {
    if (!input.sourceMapping.pages.some((page) => page.page === annotation.page))
      throw generationError("BBOX_UNTRUSTED", "人工框对应的来源定位缺失、过期、版本不匹配或越界", [annotation]);
    return [];
  }
  const suppressed = new Set(input.suppressedSourceBlockIds);
  const explicitIds = annotation.sourceBlockIds;
  const candidates = explicitIds.length
    ? explicitIds.map((id) => {
        const block = input.document.blocks.find((candidate) => candidate.contentBlockId === id);
        if (!block) throw generationError("SOURCE_BLOCK_MISSING", "人工框引用的 Source Block 不存在", [annotation]);
        return block;
      })
    : input.document.blocks.filter((block) =>
        block.sourceLocation?.page === annotation.page && !suppressed.has(block.contentBlockId));
  const located = candidates.flatMap((block) => {
    const documentIndex = input.document.blocks.indexOf(block);
    const sourceLocation = block.sourceLocation;
    const pageMapping = input.sourceMapping.pages.find((page) => page.page === annotation.page);
    if (!sourceLocation || !pageMapping)
      throw generationError("BBOX_UNTRUSTED", "人工框对应的来源定位缺失、过期、版本不匹配或越界", [annotation]);
    const mapped = mapTrustedBbox({
      sourceDocumentVersion: block.sourceDocumentVersion,
      visualCopyVersion: input.visualCopyVersion,
      sourceViewKind: sourceLocation.sourceViewKind ?? "original_file",
      page: sourceLocation.page,
      bbox: sourceLocation.bbox,
      evidence: sourceLocation.bboxEvidence,
      pageGeometry: {
        mediaBox: pageMapping.mediaBox,
        cropBox: pageMapping.cropBox,
        rotation: pageMapping.orientation,
        cssWidth: 1,
        cssHeight: 1,
        devicePixelRatio: 1,
      },
      current: {
        sourceDocumentVersion: input.document.sourceDocumentVersion,
        visualCopyVersion: input.visualCopyVersion,
      },
    });
    if (mapped.quality !== "exact")
      throw generationError("BBOX_UNTRUSTED", "人工框对应的来源定位缺失、过期、版本不匹配或越界", [annotation]);
    if (!boxesIntersect(mapped.cssBox, annotation.bbox)) {
      if (explicitIds.length)
        throw generationError("EMPTY_BBOX_INTERSECTION", "人工框未命中可信 Source Block", [annotation]);
      return [];
    }
    return [{ block, sourceLocation, annotation, documentIndex, text: annotation.manualText?.trim() || block.searchText, synthetic: false as const }];
  });
  if (!located.length && !annotation.manualText?.trim())
    throw generationError("EMPTY_BBOX_INTERSECTION", "人工框未命中可信 Source Block", [annotation]);
  return located;
}

function generationKey(annotation: EffectiveManualAnnotation): string {
  return annotation.logicalGroupId ? `group:${annotation.logicalGroupId}` : `annotation:${annotation.id}`;
}

function annotationOrder(left: EffectiveManualAnnotation, right: EffectiveManualAnnotation): number {
  return left.page - right.page || left.readingOrder - right.readingOrder || left.id.localeCompare(right.id);
}

function chunkOrder(left: Chunk, right: Chunk): number {
  const leftManual = left as ManualChunk;
  const rightManual = right as ManualChunk;
  return (leftManual.manualPages?.[0] ?? left.page ?? Number.MAX_SAFE_INTEGER) -
      (rightManual.manualPages?.[0] ?? right.page ?? Number.MAX_SAFE_INTEGER) ||
    (leftManual.manualGenerationKey ?? left.id).localeCompare(rightManual.manualGenerationKey ?? right.id);
}

function boxesIntersect(left: readonly number[], right: readonly number[]): boolean {
  return left[0] < right[2] && left[2] > right[0] && left[1] < right[3] && left[3] > right[1];
}

function assertNormalizedBbox(annotation: EffectiveManualAnnotation): void {
  const bbox = annotation.bbox;
  if (bbox.length !== 4 || !bbox.every(Number.isFinite) || bbox[0] < 0 || bbox[1] < 0 ||
      bbox[2] > 1 || bbox[3] > 1 || bbox[2] <= bbox[0] || bbox[3] <= bbox[1])
    throw generationError("ANNOTATION_BBOX_INVALID", "人工框坐标无效", [annotation]);
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function generationError(
  code: string,
  message: string,
  annotations: EffectiveManualAnnotation[] = [],
): Error & {
  code: string;
  statusCode: number;
  details?: { problemAnnotations: Array<Pick<EffectiveManualAnnotation, "id" | "page" | "type" | "bbox">> };
} {
  return Object.assign(new Error(message), {
    code,
    statusCode: 422,
    ...(annotations.length
      ? {
          details: {
            problemAnnotations: annotations.map(({ id, page, type, bbox }) => ({
              id,
              page,
              type,
              bbox: [...bbox] as EffectiveManualAnnotation["bbox"],
            })),
          },
        }
      : {}),
  });
}
