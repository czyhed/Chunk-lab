import type { Chunk } from "./chunking.js";
import { parentContextFor } from "./parent-context.js";
import type {
  BatchExportInput,
  ExportContractVersion,
  ExportDocumentInput,
  ExportSourceSegment,
  V21ExportableChunk,
} from "./v21-export.js";

type RuntimeBatch = {
  id: string;
  documents: readonly RuntimeDocument[];
};

type RuntimeDocument = {
  id: string;
  name: string;
  state: "pending" | "running" | "done" | "failed";
  error?: string;
  parsedDocumentV21?: {
    contractVersion: "2.1";
    sourceDocumentVersion: string;
    parsedDocumentVersion: string;
    normalizerVersion: string;
    normalizedModelVersion: string;
    parserVersion?: string;
    blocks: readonly RuntimeBlock[];
  };
  sourceContract?: { visualCopy?: { state: string } };
  reviewState: { draft?: RuntimeDraft | null };
  [key: string]: unknown;
};

type RuntimeBlock = {
  contentBlockId: string;
  contentType: string;
  normalizationStatus: string;
  normalized: unknown;
};

type RuntimeDraft = {
  configuration: Readonly<Record<string, unknown>>;
  chunks: readonly RuntimeChunk[];
};

type RuntimeChunk = {
  id: string;
  type: string;
  automaticText: string;
  finalText: string;
  contextText: string;
  contextReviewState: V21ExportableChunk["contextReviewState"];
  embeddingEligible?: boolean;
  embeddingExclusionReasons?: readonly string[];
  sourceSegments: readonly (Record<string, unknown> & { blockId?: string })[];
  productIdentity?: string;
  parentSectionId?: string;
  parentChunk?: Chunk["parentChunk"];
  relatedChunkIds: readonly string[];
  qualityFlags: readonly string[];
  revisions: readonly unknown[];
  contextModel?: string;
  contextProfileId?: string;
  contextProfileName?: string;
  contextCandidateReasons: readonly string[];
  contextScope?: readonly string[];
  skippedNeighborReasons?: readonly {
    chunkId: string;
    reasons: readonly string[];
  }[];
  normalizedModels?: readonly unknown[];
  reviewedModel?: unknown;
  reviewRevision?: number;
  reviewedModelRevisions?: readonly unknown[];
  normalizationStatus?: string;
  contentTypes?: readonly string[];
  vlmSummaryGenerated?: string;
  vlmSummaryReviewed?: string;
  vlmSummarySupplement?: string;
  vlmSummaryEffective?: string;
  vlmProfileId?: string;
  vlmProfileName?: string;
  vlmModel?: string;
  vlmPromptVersion?: string;
  vlmGeneratedAt?: string;
  vlmStatus?: "unconfigured" | "generating" | "awaiting_review" | "failed";
  vlmCacheHit?: boolean;
  imagePolicy?: "summary" | "reference" | "exclude";
  imageObjectReference?: V21ExportableChunk["imageAssetReference"];
};

export function projectRuntimeBatchExport(
  batch: RuntimeBatch,
  options: {
    exportedAt: string;
    selectedContractVersion?: ExportContractVersion;
    embeddingModel: string | null;
  },
): BatchExportInput {
  return {
    batchId: batch.id,
    exportedAt: options.exportedAt,
    ...(options.selectedContractVersion
      ? { selectedContractVersion: options.selectedContractVersion }
      : {}),
    documents: batch.documents.map((document) =>
      projectDocument(document, options.embeddingModel),
    ),
  };
}

function projectDocument(
  document: RuntimeDocument,
  embeddingModel: string | null,
): ExportDocumentInput {
  const contractVersion = document.parsedDocumentV21 ? "2.1" : "legacy";
  const deliveryState =
    document.state === "failed"
      ? "failed"
      : document.state === "done" && document.reviewState.draft
        ? "completed"
        : "pending";
  const base = {
    documentId: document.id,
    name: document.name,
    contractVersion,
    deliveryState,
    ...(document.error ? { failureReason: document.error } : {}),
    visualCopyState: visualCopyState(document),
    qualityFlags: [] as string[],
  } as const;
  const draft = document.reviewState.draft;
  if (contractVersion === "legacy")
    return {
      ...base,
      contractVersion,
      ...(draft
        ? {
            draft: {
              chunks: draft.chunks.map((chunk) => ({
                chunkId: chunk.id,
                finalText: chunk.finalText,
                sourceBlockIds: chunk.sourceSegments.map((segment) =>
                  requiredString(segment.blockId, "legacy source block"),
                ),
                qualityFlags: [...chunk.qualityFlags],
                revisions: structuredClone(chunk.revisions),
              })),
            },
          }
        : {}),
    };
  const parsed = document.parsedDocumentV21!;
  return {
    ...base,
    contractVersion,
    sourceDocumentVersion: parsed.sourceDocumentVersion,
    parsedDocumentVersion: parsed.parsedDocumentVersion,
    ...(draft
      ? {
          draft: {
            chunks: draft.chunks.map((chunk) =>
              projectV21Chunk(chunk, draft, parsed, embeddingModel),
            ),
          },
        }
      : {}),
  };
}

function projectV21Chunk(
  chunk: RuntimeChunk,
  draft: RuntimeDraft,
  parsed: NonNullable<RuntimeDocument["parsedDocumentV21"]>,
  embeddingModel: string | null,
): V21ExportableChunk {
  if (chunk.embeddingEligible === undefined)
    throw new Error(`Chunk ${chunk.id} is missing embedding eligibility`);
  const segments = chunk.sourceSegments.map(projectSegment);
  const blockById = new Map(
    parsed.blocks.map((block) => [block.contentBlockId, block]),
  );
  const blocks = segments.map((segment) => {
    const block = blockById.get(segment.contentBlockId);
    if (block) return block;
    if (segment.provenance?.kind === "human_transcription")
      return {
        contentBlockId: segment.contentBlockId,
        contentType: "paragraph",
        normalizationStatus: "manual_fixed",
        normalized: {
          type: "paragraph",
          text: chunk.finalText,
          provenance: structuredClone(segment.provenance),
        },
      } satisfies RuntimeBlock;
    throw new Error(`Chunk ${chunk.id} has an unknown Content Block`);
  });
  const contentTypes = chunk.contentTypes?.length
    ? [...chunk.contentTypes]
    : [...new Set(blocks.map((block) => block.contentType))];
  return {
    contractVersion: "2.1",
    parsedDocumentVersion: parsed.parsedDocumentVersion,
    normalizationStatus:
      chunk.normalizationStatus ?? summarizeNormalization(blocks),
    chunkId: chunk.id,
    contentType: contentTypes.join("+") || chunk.type,
    normalizedModel:
      chunk.normalizedModels?.length
        ? structuredClone(chunk.normalizedModels)
        : blocks.map((block) => structuredClone(block.normalized)),
    reviewedModel: structuredClone(chunk.reviewedModel ?? null),
    ...(chunk.reviewRevision !== undefined
      ? { reviewRevision: chunk.reviewRevision }
      : {}),
    automaticText: chunk.automaticText,
    finalText: chunk.finalText,
    contextText: chunk.contextText,
    contextReviewState: chunk.contextReviewState,
    embeddingEligible: chunk.embeddingEligible,
    embeddingExclusionReasons: [...(chunk.embeddingExclusionReasons ?? [])],
    sourceSegments: segments,
    sourceViewKinds: [...new Set(segments.map((segment) => segment.sourceViewKind))],
    locationQualitySummary: worstQuality(
      segments.map((segment) => segment.locationQuality),
      ["exact", "page_only", "parsed_only", "unavailable"],
    ),
    mappingQualitySummary: worstQuality(
      segments.map((segment) => segment.mappingQuality),
      ["exact", "cell", "row", "block-only"],
    ),
    productIdentity: chunk.productIdentity ?? null,
    parentSectionId: chunk.parentSectionId ?? null,
    ...(chunk.parentChunk ? { parentChunk: parentContextFor(chunk as unknown as Chunk, draft.chunks as unknown as Chunk[]) } : {}),
    relatedChunkIds: [...chunk.relatedChunkIds],
    qualityFlags: [...chunk.qualityFlags],
    revisions: structuredClone([
      ...chunk.revisions,
      ...(chunk.reviewedModelRevisions ?? []),
    ]),
    chunkingStrategy: requiredString(
      draft.configuration.strategy,
      "chunking strategy",
    ),
    chunkingParameters: structuredClone(draft.configuration),
    parserVersion: parsed.parserVersion ?? null,
    normalizerVersion: parsed.normalizerVersion,
    normalizedModelVersion: parsed.normalizedModelVersion,
    embeddingModel,
    contextModel: chunk.contextModel ?? null,
    ...(chunk.contextProfileId
      ? { contextProfileId: chunk.contextProfileId }
      : {}),
    ...(chunk.contextProfileName
      ? { contextProfileName: chunk.contextProfileName }
      : {}),
    contextCandidateReasons: [...chunk.contextCandidateReasons],
    contextScope: [...(chunk.contextScope ?? [])],
    skippedNeighborReasons: structuredClone(chunk.skippedNeighborReasons ?? []),
    ...(chunk.type === "image"
      ? {
          imageSummary: {
            machineSummary: chunk.vlmSummaryGenerated ?? "",
            humanSummary: chunk.vlmSummaryReviewed ?? "",
            humanSupplement: chunk.vlmSummarySupplement ?? "",
            effectiveSummary: chunk.vlmSummaryEffective ?? "",
            profileId: chunk.vlmProfileId ?? null,
            profileName: chunk.vlmProfileName ?? null,
            model: chunk.vlmModel ?? null,
            promptVersion: chunk.vlmPromptVersion ?? null,
            generatedAt: chunk.vlmGeneratedAt ?? null,
            status: chunk.vlmStatus ?? "unconfigured",
            cacheHit: chunk.vlmCacheHit ?? false,
          },
          imagePolicy: chunk.imagePolicy ?? "reference",
          ...(chunk.imageObjectReference
            ? { imageAssetReference: structuredClone(chunk.imageObjectReference) }
            : {}),
        }
      : {}),
  };
}

function projectSegment(value: Record<string, unknown>): ExportSourceSegment {
  const bbox = value.bbox;
  if (
    bbox !== null &&
    (!Array.isArray(bbox) ||
      bbox.length !== 4 ||
      bbox.some((coordinate) => typeof coordinate !== "number"))
  ) throw new Error("Contract 2.1 Source Segment has an invalid bbox");
  return {
    sourceDocumentVersion: requiredString(
      value.sourceDocumentVersion,
      "source document version",
    ),
    parsedDocumentVersion: requiredString(
      value.parsedDocumentVersion,
      "parsed document version",
    ),
    contentBlockId: requiredString(value.contentBlockId, "Content Block ID"),
    rawBlockId: nullableString(value.rawBlockId),
    sourceViewKind: requiredString(value.sourceViewKind, "source view kind"),
    page: nullableNumber(value.page),
    bbox: bbox === null ? null : [...bbox] as [number, number, number, number],
    sourceStart: nullableNumber(value.sourceStart),
    sourceEnd: nullableNumber(value.sourceEnd),
    chunkStart: nullableNumber(value.chunkStart),
    chunkEnd: nullableNumber(value.chunkEnd),
    isOverlap: value.isOverlap === true,
    mappingQuality: requiredString(value.mappingQuality, "mapping quality"),
    locationQuality: requiredString(value.locationQuality, "location quality"),
    ...(humanTranscriptionProvenance(value.provenance)
      ? { provenance: structuredClone(value.provenance) }
      : {}),
  };
}

function humanTranscriptionProvenance(value: unknown): value is ExportSourceSegment["provenance"] {
  return Boolean(
    value && typeof value === "object" &&
    (value as Record<string, unknown>).kind === "human_transcription" &&
    typeof (value as Record<string, unknown>).annotationId === "string" &&
    (value as Record<string, unknown>).source === "human",
  );
}

function summarizeNormalization(blocks: readonly RuntimeBlock[]): string {
  const states = [...new Set(blocks.map((block) => block.normalizationStatus))];
  return states.length === 1 ? states[0] : "mixed";
}

function worstQuality(
  values: readonly string[],
  order: readonly string[],
): string {
  const unknown = values.find((value) => !order.includes(value));
  if (unknown) throw new Error(`Unknown quality value ${unknown}`);
  return values.reduce(
    (worst, value) =>
      order.indexOf(value) > order.indexOf(worst) ? value : worst,
    order[0],
  );
}

function visualCopyState(document: RuntimeDocument) {
  const value = document.sourceContract?.visualCopy?.state;
  return ["not_requested", "generating", "ready", "failed"].includes(
    value ?? "",
  )
    ? value as "not_requested" | "generating" | "ready" | "failed"
    : "not_requested";
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required`);
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return requiredString(value, "string value");
}

function nullableNumber(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("numeric Source Segment value is invalid");
  return value;
}
