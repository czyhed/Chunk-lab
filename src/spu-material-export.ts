import { createHash } from "node:crypto";

export const SPU_DOCUMENT_TYPES = [
  "manual",
  "specification",
  "installation",
  "after_sales",
  "mixed",
  "other",
] as const;

export type SpuDocumentType = (typeof SPU_DOCUMENT_TYPES)[number];
export type SpuChunkReviewStatus =
  | "completed_published"
  | "completed_excluded"
  | "pending"
  | "reviewing"
  | "failed";
export type SpuChunkScope = "assigned" | "common" | "unassigned" | "conflicted";

export type SpuMaterialSourceSegment = {
  blockId: string;
  page: number | null;
  bbox: number[] | null;
  sourceStart: number;
  sourceEnd: number;
  chunkStart: number;
  chunkEnd: number;
  isOverlap: boolean;
};

export type SpuMaterialChunk = {
  chunkId: string;
  finalText: string;
  reviewStatus: SpuChunkReviewStatus;
  documentPublishEligible: boolean;
  documentPublishExclusionReasons?: readonly string[];
  sourceSegments: readonly SpuMaterialSourceSegment[];
  order?: number;
  title?: string;
  imageAssetReference?: unknown;
  tableArtifact?: unknown;
  scope?: SpuChunkScope;
  targetSpuIds?: readonly string[];
};

export type SpuMaterialExportInput = {
  batchId: string;
  documentId: string;
  sourceDocumentVersion: string;
  sourceName: string;
  spuId: string;
  documentType: SpuDocumentType;
  reviewRevision: number;
  chunks: readonly SpuMaterialChunk[];
  exportVersion: string;
  generatedAt: string;
  generatorVersion?: string;
};

export type SpuMaterialManifest = {
  contractVersion: "spu-document-export-1";
  batchId: string;
  documentId: string;
  sourceName: string;
  sourceDocumentVersion: string;
  targetSpuId: string;
  documentType: SpuDocumentType;
  reviewRevision: number;
  exportVersion: string;
  status: "complete" | "complete_with_exclusions";
  includedChunkIds: string[];
  excludedChunks: Array<{ chunkId: string; reason: string; scope?: SpuChunkScope; targetSpuIds?: string[] }>;
  chunks: ReadonlyArray<{
    chunkId: string;
    order: number;
    scope?: SpuChunkScope;
    targetSpuIds?: string[];
    sourceSegments: SpuMaterialSourceSegment[];
    tableArtifact?: unknown;
    assetReferences?: unknown[];
    tableVersionIds?: string[];
  }>;
  assets: Array<{ chunkId: string; reference: unknown }>;
  generatedAt: string;
  generatorVersion: string;
  contentHash: string;
};

export type SpuMaterialExport = {
  markdown: string;
  manifest: SpuMaterialManifest;
  status: SpuMaterialManifest["status"];
  exportVersion: string;
  contentHash: string;
};

export function spuMaterialFileName(input: {
  spuId: string;
  documentType: SpuDocumentType;
  sourceName: string;
  exportVersion: string;
}): string {
  const sourceWithoutExtension = input.sourceName.replace(/\.[^.]+$/, "");
  const sourceBaseName = sourceWithoutExtension
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/[-_.]{2,}/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 70) || "source";
  const suffix = /[^\x00-\x7F]/.test(sourceWithoutExtension) ? `-${shortSourceHash(sourceWithoutExtension)}` : "";
  return `${input.spuId}_${input.documentType}_${sourceBaseName}${suffix}_${input.exportVersion}.md`;
}

function shortSourceHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export type SpuMaterialFanoutInput = Omit<SpuMaterialExportInput, "spuId" | "chunks"> & {
  targetSpuIds: readonly string[];
  chunks: readonly SpuMaterialChunk[];
};

export type SpuMaterialFanoutResult = {
  status: "complete" | "complete_with_exclusions" | "blocked";
  results: Array<
    | { spuId: string; status: "blocked"; blockedChunkIds: string[]; reason: string }
    | ({ spuId: string; status: SpuMaterialExport["status"] } & SpuMaterialExport)
  >;
};

export function createSpuMaterialFanout(input: SpuMaterialFanoutInput): SpuMaterialFanoutResult {
  const targetSpuIds = [...new Set(input.targetSpuIds.map((id) => id.trim()).filter(Boolean))];
  if (!targetSpuIds.length) throw new Error("至少需要一个目标 SPU");
  const unassigned = input.chunks.filter((chunk) => {
    const scope = chunk.scope ?? "unassigned";
    return scope === "unassigned" ||
      (scope === "assigned" && !(chunk.targetSpuIds ?? []).length) ||
      (scope === "conflicted" && !(chunk.targetSpuIds ?? []).length);
  });
  if (unassigned.length) {
    return {
      status: "blocked",
      results: targetSpuIds.map((spuId) => ({ spuId, status: "blocked" as const, blockedChunkIds: unassigned.map((chunk) => chunk.chunkId), reason: "unassigned_chunk_scope" })),
    };
  }
  const results = targetSpuIds.map((spuId) => {
    const conflicted = input.chunks.filter((chunk) =>
      (chunk.scope ?? "unassigned") === "conflicted" && (chunk.targetSpuIds ?? []).includes(spuId),
    );
    if (conflicted.length)
      return { spuId, status: "blocked" as const, blockedChunkIds: conflicted.map((chunk) => chunk.chunkId), reason: "conflicted_chunk_scope" };
    const chunks = input.chunks.filter((chunk) => {
      const scope = chunk.scope ?? "unassigned";
      return (scope === "common" && (!(chunk.targetSpuIds?.length) || chunk.targetSpuIds.includes(spuId))) ||
        (scope === "assigned" && (chunk.targetSpuIds ?? []).includes(spuId));
    });
    const exported = createSpuMaterialExport({ ...input, spuId, chunks });
    return { ...exported, spuId };
  });
  return {
    status: results.some((result) => result.status === "blocked") ? "blocked" : results.some((result) => result.status === "complete_with_exclusions") ? "complete_with_exclusions" : "complete",
    results,
  };
}

export function createSpuMaterialExport(
  input: SpuMaterialExportInput,
): SpuMaterialExport {
  validateInput(input);
  const ordered = input.chunks
    .map((chunk, index) => ({ chunk, index }))
    .sort((left, right) =>
      (left.chunk.order ?? left.index) - (right.chunk.order ?? right.index) ||
      left.chunk.chunkId.localeCompare(right.chunk.chunkId),
    )
    .map(({ chunk, index }) => ({ chunk, order: chunk.order ?? index }));
  const included = ordered.filter(({ chunk }) => chunk.documentPublishEligible);
  const excluded = ordered
    .filter(({ chunk }) => !chunk.documentPublishEligible)
    .map(({ chunk }) => ({
      chunkId: chunk.chunkId,
      reason: chunk.documentPublishExclusionReasons?.[0] ?? "document_publish_ineligible",
      ...(chunk.scope ? { scope: chunk.scope } : {}),
      ...(chunk.targetSpuIds ? { targetSpuIds: [...chunk.targetSpuIds] } : {}),
    }));
  const markdown = buildMarkdown(input, included.map(({ chunk }) => chunk));
  const canonicalPayload = {
    targetSpuId: input.spuId,
    documentType: input.documentType,
    sourceDocumentVersion: input.sourceDocumentVersion,
    reviewRevision: input.reviewRevision,
    chunks: ordered.map(({ chunk, order }) => ({
      chunkId: chunk.chunkId,
      order,
      finalText: chunk.finalText,
      documentPublishEligible: chunk.documentPublishEligible,
      scope: chunk.scope ?? null,
      targetSpuIds: [...(chunk.targetSpuIds ?? [])].sort(),
      sourceSegments: chunk.sourceSegments,
      tableArtifact: chunk.tableArtifact ?? null,
      imageAssetReference: chunk.imageAssetReference ?? null,
    })),
  };
  const contentHash = createHash("sha256").update(JSON.stringify(canonicalPayload)).digest("hex");
  const status = excluded.length ? "complete_with_exclusions" : "complete";
  const manifest: SpuMaterialManifest = {
    contractVersion: "spu-document-export-1",
    batchId: input.batchId,
    documentId: input.documentId,
    sourceName: input.sourceName,
    sourceDocumentVersion: input.sourceDocumentVersion,
    targetSpuId: input.spuId,
    documentType: input.documentType,
    reviewRevision: input.reviewRevision,
    exportVersion: input.exportVersion,
    status,
    includedChunkIds: included.map(({ chunk }) => chunk.chunkId),
    excludedChunks: excluded,
    chunks: included.map(({ chunk, order }) => ({
      chunkId: chunk.chunkId,
      order,
      ...(chunk.scope ? { scope: chunk.scope } : {}),
      ...(chunk.targetSpuIds ? { targetSpuIds: [...chunk.targetSpuIds] } : {}),
      sourceSegments: [...structuredClone(chunk.sourceSegments)],
      ...(chunk.tableArtifact ? { tableArtifact: structuredClone(chunk.tableArtifact) } : {}),
      ...(chunk.imageAssetReference ? { assetReferences: [structuredClone(chunk.imageAssetReference)] } : {}),
      ...tableVersionIdsFor(chunk.tableArtifact),
    })),
    assets: included.flatMap(({ chunk }) => chunk.imageAssetReference
      ? [{ chunkId: chunk.chunkId, reference: structuredClone(chunk.imageAssetReference) }]
      : []),
    generatedAt: input.generatedAt,
    generatorVersion: input.generatorVersion ?? "spu-material-export-v1",
    contentHash,
  };
  return { markdown, manifest, status, exportVersion: input.exportVersion, contentHash };
}

function tableVersionIdsFor(value: unknown): { tableVersionIds?: string[] } {
  if (!value || typeof value !== "object") return {};
  const table = value as Record<string, unknown>;
  const nested = table.tableVersion && typeof table.tableVersion === "object"
    ? (table.tableVersion as Record<string, unknown>).tableVersionId
    : undefined;
  const ids = [table.tableVersionId, nested].filter((candidate): candidate is string => typeof candidate === "string" && Boolean(candidate.trim()));
  return ids.length ? { tableVersionIds: [...new Set(ids)] } : {};
}

export function buildSpuMaterialMarkdown(input: {
  markdown?: string;
  manifest?: SpuMaterialManifest;
} & Partial<SpuMaterialExportInput> & { chunks?: readonly SpuMaterialChunk[] }): string {
  if (input.markdown !== undefined) return input.markdown;
  if (!input.batchId || !input.documentId || !input.sourceDocumentVersion ||
      !input.sourceName || !input.spuId || !input.documentType ||
      input.reviewRevision === undefined || !input.chunks)
    throw new Error("Markdown export input is incomplete");
  validateInput(input as SpuMaterialExportInput);
  const ordered = input.chunks
    .map((chunk, index) => ({ chunk, index }))
    .sort((left, right) =>
      (left.chunk.order ?? left.index) - (right.chunk.order ?? right.index) ||
      left.chunk.chunkId.localeCompare(right.chunk.chunkId),
    )
    .map(({ chunk }) => chunk);
  return buildMarkdown(input as SpuMaterialExportInput, ordered.filter((chunk) => chunk.documentPublishEligible));
}

function buildMarkdown(
  input: SpuMaterialExportInput,
  chunks: readonly SpuMaterialChunk[],
): string {
  const body = deduplicateOverlap(chunks.map((chunk) => ({ chunk, markdown: renderChunkMarkdown(chunk) })).filter((entry) => entry.markdown));
  return [
    "# 商品资料",
    "",
    `- SPU: ${input.spuId}`,
    `- 文档类型: ${input.documentType}`,
    `- 来源文档: ${input.sourceName}`,
    `- 来源版本: ${input.sourceDocumentVersion}`,
    `- Review Revision: ${input.reviewRevision}`,
    `- 导出版本: ${input.exportVersion}`,
    "",
    ...body,
    "",
  ].join("\n");
}

function renderChunkMarkdown(chunk: SpuMaterialChunk): string {
  const sections: string[] = [];
  if (chunk.title?.trim()) sections.push(`## ${chunk.title.trim()}`);
  const table = renderTableArtifact(chunk.tableArtifact);
  if (table) sections.push(table);
  else if (chunk.finalText.trim()) sections.push(chunk.finalText.trim());
  const asset = assetUri(chunk.imageAssetReference);
  if (asset) sections.push(`![${chunk.title?.trim() || chunk.chunkId}](${asset})`);
  return sections.join("\n\n");
}

function renderTableArtifact(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const table = value as { title?: unknown; columns?: unknown; rows?: unknown };
  if (!Array.isArray(table.columns) || !Array.isArray(table.rows)) return "";
  const columns = table.columns.map(cellText);
  if (!columns.length) return "";
  const rows = table.rows.map((row) => Array.isArray(row) ? row.map(cellText) : []);
  const lines = [
    `| ${columns.map(escapeTableCell).join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${columns.map((_, index) => escapeTableCell(row[index] ?? "")).join(" | ")} |`),
  ];
  return [typeof table.title === "string" && table.title.trim() ? `### ${table.title.trim()}` : "", ...lines].filter(Boolean).join("\n");
}

function cellText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "text" in value && typeof value.text === "string") return value.text;
  return "";
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function assetUri(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const reference = value as { uri?: unknown; bucket?: unknown; key?: unknown };
  if (typeof reference.uri === "string" && reference.uri.startsWith("asset://minio/")) return reference.uri;
  if (typeof reference.bucket === "string" && typeof reference.key === "string")
    return `asset://minio/${reference.key}`;
  if (typeof reference.uri === "string") {
    const match = /^s3:\/\/[^/]+\/(.+)$/.exec(reference.uri.trim());
    if (match?.[1]) return `asset://minio/${match[1]}`;
  }
  return "";
}

function deduplicateOverlap(parts: ReadonlyArray<{ chunk: SpuMaterialChunk; markdown: string }>): string[] {
  const result: string[] = [];
  let previous: { chunk: SpuMaterialChunk; markdown: string } | undefined;
  for (const part of parts) {
    if (!result.length) {
      result.push(part.markdown);
      previous = part;
      continue;
    }
    const overlap = previous && hasContinuousSource(previous.chunk, part.chunk)
      ? longestSuffixPrefix(previous.markdown, part.markdown)
      : 0;
    result.push(overlap >= 8 ? part.markdown.slice(overlap).trimStart() : part.markdown);
    previous = part;
  }
  return result.filter(Boolean);
}

function hasContinuousSource(previous: SpuMaterialChunk, next: SpuMaterialChunk): boolean {
  return previous.sourceSegments.some((left) => next.sourceSegments.some((right) =>
    left.blockId === right.blockId && left.sourceEnd === right.sourceStart,
  ));
}

function longestSuffixPrefix(left: string, right: string): number {
  const max = Math.min(left.length, right.length, 512);
  for (let length = max; length >= 8; length -= 1)
    if (left.slice(-length) === right.slice(0, length)) return length;
  return 0;
}

function validateInput(input: SpuMaterialExportInput): void {
  for (const [name, value] of Object.entries({
    batchId: input.batchId,
    documentId: input.documentId,
    sourceDocumentVersion: input.sourceDocumentVersion,
    sourceName: input.sourceName,
    spuId: input.spuId,
    exportVersion: input.exportVersion,
    generatedAt: input.generatedAt,
  })) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  }
  if (!SPU_DOCUMENT_TYPES.includes(input.documentType))
    throw new Error("documentType is invalid");
  if (!Number.isSafeInteger(input.reviewRevision) || input.reviewRevision < 0)
    throw new Error("reviewRevision is invalid");
  if (new Date(input.generatedAt).toISOString() !== input.generatedAt)
    throw new Error("generatedAt must be an ISO timestamp");
  const blocking = input.chunks.filter((chunk) =>
    chunk.reviewStatus === "pending" || chunk.reviewStatus === "reviewing" || chunk.reviewStatus === "failed",
  );
  if (blocking.length)
    throw new Error(`存在未完成审核 Chunk：${blocking.map((chunk) => chunk.chunkId).join(",")}`);
  for (const chunk of input.chunks) {
    if (!chunk.chunkId.trim()) throw new Error("chunkId is required");
    if (chunk.documentPublishEligible && !chunk.finalText.trim() && !assetUri(chunk.imageAssetReference))
      throw new Error(`可发布 Chunk 缺少 finalText：${chunk.chunkId}`);
    if (chunk.reviewStatus === "completed_excluded" && chunk.documentPublishEligible)
      throw new Error(`排除 Chunk 不能标记为可发布：${chunk.chunkId}`);
  }
}
