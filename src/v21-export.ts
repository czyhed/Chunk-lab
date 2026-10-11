import type { Chunk } from "./chunking.js";
export type ExportContractVersion = "2.1" | "legacy";
export type DeliveryState = "completed" | "pending" | "failed";
export type VisualCopyState =
  | "not_requested"
  | "generating"
  | "ready"
  | "failed";

export type ExportSourceSegment = {
  sourceDocumentVersion: string;
  parsedDocumentVersion: string;
  contentBlockId: string;
  rawBlockId: string | null;
  sourceViewKind: string;
  page: number | null;
  bbox: [number, number, number, number] | null;
  sourceStart: number | null;
  sourceEnd: number | null;
  chunkStart: number | null;
  chunkEnd: number | null;
  isOverlap: boolean;
  mappingQuality: string;
  locationQuality: string;
  provenance?: { kind: "human_transcription"; annotationId: string; source: "human" };
};

export type ContextReviewState =
  | "not_generated"
  | "generating"
  | "awaiting_review"
  | "confirmed"
  | "human_modified"
  | "failed"
  | "stale";

export type V21ExportableChunk = {
  contractVersion: "2.1";
  parsedDocumentVersion: string;
  normalizationStatus: string;
  chunkId: string;
  contentType: string;
  normalizedModel: unknown;
  reviewedModel: unknown;
  reviewRevision?: number;
  automaticText: string;
  finalText: string;
  contextText: string;
  contextReviewState: ContextReviewState;
  embeddingEligible: boolean;
  embeddingExclusionReasons: readonly string[];
  sourceSegments: readonly ExportSourceSegment[];
  sourceViewKinds: readonly string[];
  locationQualitySummary: string;
  mappingQualitySummary: string;
  productIdentity: string | null;
  parentSectionId: string | null;
  parentChunk?: Chunk["parentChunk"];
  relatedChunkIds: readonly string[];
  qualityFlags: readonly string[];
  revisions: readonly unknown[];
  chunkingStrategy: string;
  chunkingParameters: Readonly<Record<string, unknown>>;
  parserVersion: string | null;
  normalizerVersion: string;
  normalizedModelVersion: string;
  embeddingModel: string | null;
  contextModel: string | null;
  contextProfileId?: string;
  contextProfileName?: string;
  contextCandidateReasons: readonly string[];
  contextScope: readonly string[];
  skippedNeighborReasons: readonly {
    chunkId: string;
    reasons: readonly string[];
  }[];
  imageSummary?: {
    machineSummary: string;
    humanSummary: string;
    humanSupplement: string;
    effectiveSummary: string;
    profileId: string | null;
    profileName: string | null;
    model: string | null;
    promptVersion: string | null;
    generatedAt: string | null;
    status: "unconfigured" | "generating" | "awaiting_review" | "failed";
    cacheHit: boolean;
  };
  imagePolicy?: "summary" | "reference" | "exclude";
  imageAssetReference?: {
    scheme: "s3";
    bucket: string;
    key: string;
    uri: string;
    contentType: string;
    checksumSha256: string;
    etag: string | null;
    versionId: string | null;
    source: "source_image" | "pdf_crop";
  };
};

export type LegacyExportableChunk = {
  chunkId: string;
  finalText: string;
  sourceBlockIds: readonly string[];
  qualityFlags: readonly string[];
  revisions: readonly unknown[];
};

type ExportDocumentBase = {
  documentId: string;
  name: string;
  deliveryState: DeliveryState;
  failureReason?: string;
  visualCopyState: VisualCopyState;
  qualityFlags: readonly string[];
};

export type V21ExportDocumentInput = ExportDocumentBase & {
  contractVersion: "2.1";
  sourceDocumentVersion?: string;
  parsedDocumentVersion?: string;
  draft?: { chunks: readonly V21ExportableChunk[] };
};

export type LegacyExportDocumentInput = ExportDocumentBase & {
  contractVersion: "legacy";
  draft?: { chunks: readonly LegacyExportableChunk[] };
};

export type ExportDocumentInput =
  | V21ExportDocumentInput
  | LegacyExportDocumentInput;

export type BatchExportInput = {
  batchId: string;
  exportedAt: string;
  selectedContractVersion?: ExportContractVersion;
  documents: readonly ExportDocumentInput[];
};

export class ExportContractSelectionError extends Error {
  readonly code = "CONTRACT_SELECTION_REQUIRED";
  readonly availableContractVersions: ExportContractVersion[];

  constructor(availableContractVersions: ExportContractVersion[]) {
    super("A contract version must be selected before exporting a mixed batch");
    this.name = "ExportContractSelectionError";
    this.availableContractVersions = availableContractVersions;
  }
}

export function buildBatchExport(input: BatchExportInput) {
  const availableContractVersions = contractVersions(input.documents);
  const selectedContractVersion = selectContract(
    input.selectedContractVersion,
    availableContractVersions,
  );
  const manifest = input.documents.map((document) =>
    manifestEntry(document, selectedContractVersion),
  );
  const documents = input.documents.flatMap((document) => {
    if (
      document.contractVersion !== selectedContractVersion ||
      document.deliveryState !== "completed"
    )
      return [];
    if (!document.draft)
      throw new Error(`Completed document ${document.documentId} has no confirmed Draft`);
    return [
      document.contractVersion === "2.1"
        ? exportV21Document(document)
        : exportLegacyDocument(document),
    ];
  });
  return {
    batchId: input.batchId,
    exportedAt: input.exportedAt,
    selectedContractVersion,
    availableContractVersions,
    manifest,
    documents,
  };
}

function contractVersions(
  documents: readonly ExportDocumentInput[],
): ExportContractVersion[] {
  const present = new Set(documents.map((document) => document.contractVersion));
  return (["2.1", "legacy"] as const).filter((version) => present.has(version));
}

function selectContract(
  requested: ExportContractVersion | undefined,
  available: ExportContractVersion[],
): ExportContractVersion {
  if (requested) {
    if (!available.includes(requested))
      throw new Error(`Contract version ${requested} is not present in this batch`);
    return requested;
  }
  if (available.length === 1) return available[0];
  if (available.length > 1) throw new ExportContractSelectionError(available);
  throw new Error("Cannot export an empty batch");
}

function manifestEntry(
  document: ExportDocumentInput,
  selected: ExportContractVersion,
) {
  const selectedContract = document.contractVersion === selected;
  const exported = selectedContract && document.deliveryState === "completed";
  const qualityFlags = [
    ...document.qualityFlags,
    ...(document.visualCopyState === "failed"
      ? ["visual_copy_unavailable"]
      : []),
  ];
  return {
    documentId: document.documentId,
    name: document.name,
    contractVersion: document.contractVersion,
    format:
      document.contractVersion === "2.1"
        ? "chunk-contract-2.1-json"
        : "legacy-json",
    deliveryState: document.deliveryState,
    exported,
    reason: !selectedContract
      ? "contract_not_selected"
      : document.deliveryState === "pending"
        ? "pending"
        : document.deliveryState === "failed"
          ? document.failureReason || "failed"
          : null,
    qualityFlags: [...new Set(qualityFlags)],
    embeddingIneligibleCount:
      document.contractVersion === "2.1" && document.draft
        ? document.draft.chunks.filter((chunk) => !chunk.embeddingEligible).length
        : 0,
  };
}

function exportV21Document(document: V21ExportDocumentInput) {
  if (!document.draft) throw new Error("Contract 2.1 export requires a Draft");
  if (!document.sourceDocumentVersion || !document.parsedDocumentVersion)
    throw new Error("Contract 2.1 export requires source and parsed document versions");
  return {
    contractVersion: "2.1" as const,
    format: "chunk-contract-2.1-json" as const,
    documentId: document.documentId,
    name: document.name,
    sourceDocumentVersion: document.sourceDocumentVersion,
    parsedDocumentVersion: document.parsedDocumentVersion,
    chunks: document.draft.chunks.map(exportV21Chunk),
  };
}

function exportV21Chunk(chunk: V21ExportableChunk) {
  validateV21Chunk(chunk);
  return {
    contractVersion: "2.1" as const,
    parsedDocumentVersion: chunk.parsedDocumentVersion,
    normalizationStatus: chunk.normalizationStatus,
    chunkId: chunk.chunkId,
    contentType: chunk.contentType,
    normalizedModel: structuredClone(chunk.normalizedModel),
    reviewedModel: structuredClone(chunk.reviewedModel),
    ...(chunk.reviewRevision !== undefined
      ? { reviewRevision: chunk.reviewRevision }
      : {}),
    automaticText: chunk.automaticText,
    finalText: chunk.finalText,
    contextText: chunk.contextText,
    contextReviewState: chunk.contextReviewState,
    embeddingText: embeddingText(chunk),
    embeddingEligible: chunk.embeddingEligible,
    embeddingExclusionReasons: [...chunk.embeddingExclusionReasons],
    sourceSegments: structuredClone(chunk.sourceSegments),
    sourceViewKinds: [...chunk.sourceViewKinds],
    locationQualitySummary: chunk.locationQualitySummary,
    mappingQualitySummary: chunk.mappingQualitySummary,
    productIdentity: chunk.productIdentity,
    parentSectionId: chunk.parentSectionId,
    ...(chunk.parentChunk ? { parentChunk: structuredClone(chunk.parentChunk) } : {}),
    relatedChunkIds: [...chunk.relatedChunkIds],
    qualityFlags: [...chunk.qualityFlags],
    revisions: structuredClone(chunk.revisions),
    chunkingStrategy: chunk.chunkingStrategy,
    chunkingParameters: structuredClone(chunk.chunkingParameters),
    parserVersion: chunk.parserVersion,
    normalizerVersion: chunk.normalizerVersion,
    normalizedModelVersion: chunk.normalizedModelVersion,
    embeddingModel: chunk.embeddingModel,
    contextModel: chunk.contextModel,
    ...(chunk.contextProfileId
      ? { contextProfileId: chunk.contextProfileId }
      : {}),
    ...(chunk.contextProfileName
      ? { contextProfileName: chunk.contextProfileName }
      : {}),
    contextCandidateReasons: [...chunk.contextCandidateReasons],
    contextScope: [...chunk.contextScope],
    skippedNeighborReasons: structuredClone(chunk.skippedNeighborReasons),
    ...(chunk.imageSummary
      ? { imageSummary: structuredClone(chunk.imageSummary) }
      : {}),
    ...(chunk.imagePolicy ? { imagePolicy: chunk.imagePolicy } : {}),
    ...(chunk.imageAssetReference
      ? { imageAssetReference: structuredClone(chunk.imageAssetReference) }
      : {}),
  };
}

function embeddingText(chunk: V21ExportableChunk): string | null {
  if (!chunk.embeddingEligible) return null;
  if (
    (chunk.contextReviewState === "confirmed" ||
      chunk.contextReviewState === "human_modified") &&
    chunk.contextText.trim()
  )
    return `${chunk.contextText.trim()}\n\n${chunk.finalText}`;
  return chunk.finalText;
}

function validateV21Chunk(chunk: V21ExportableChunk): void {
  if (chunk.contractVersion !== "2.1")
    throw new Error("Contract 2.1 Chunk has an invalid contract version");
  const requiredStrings: Array<[string, string]> = [
    ["parsedDocumentVersion", chunk.parsedDocumentVersion],
    ["normalizationStatus", chunk.normalizationStatus],
    ["chunkId", chunk.chunkId],
    ["contentType", chunk.contentType],
    ["normalizerVersion", chunk.normalizerVersion],
    ["normalizedModelVersion", chunk.normalizedModelVersion],
  ];
  const missing = requiredStrings.find(([, value]) => !value);
  if (missing) throw new Error(`Contract 2.1 Chunk is missing ${missing[0]}`);
  if (chunk.embeddingEligible && chunk.embeddingExclusionReasons.length)
    throw new Error("Eligible Chunk cannot have embedding exclusion reasons");
  if (!chunk.embeddingEligible && !chunk.embeddingExclusionReasons.length)
    throw new Error("Ineligible Chunk requires an embedding exclusion reason");
  if (!chunk.sourceSegments.length)
    throw new Error("Contract 2.1 Chunk requires authoritative Source Segments");
  assertNoDiagnosticFields(chunk.normalizedModel);
  assertNoDiagnosticFields(chunk.reviewedModel);
  assertNoDiagnosticFields(chunk.revisions);
  assertNoDiagnosticFields(chunk.chunkingParameters);
  for (const segment of chunk.sourceSegments) {
    if (
      !segment.sourceDocumentVersion ||
      !segment.parsedDocumentVersion ||
      !segment.contentBlockId ||
      !segment.sourceViewKind ||
      !segment.mappingQuality ||
      !segment.locationQuality
    )
      throw new Error("Contract 2.1 Source Segment is incomplete");
  }
}

const DIAGNOSTIC_KEYS = new Set([
  "raw",
  "rawTableHtml",
  "displayHtml",
  "diagnostic",
  "diagnostics",
  "requestUrl",
  "authorization",
  "apiKey",
  "headers",
]);

function assertNoDiagnosticFields(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoDiagnosticFields(item);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (DIAGNOSTIC_KEYS.has(key))
      throw new Error(`Ordinary export contains diagnostic field ${key}`);
    assertNoDiagnosticFields(nested);
  }
}

function exportLegacyDocument(document: LegacyExportDocumentInput) {
  if (!document.draft) throw new Error("Legacy export requires a Draft");
  return {
    contractVersion: "legacy" as const,
    format: "legacy-json" as const,
    documentId: document.documentId,
    name: document.name,
    chunks: document.draft.chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      finalText: chunk.finalText,
      sourceBlockIds: [...chunk.sourceBlockIds],
      qualityFlags: [...chunk.qualityFlags],
      revisions: structuredClone(chunk.revisions),
    })),
  };
}
