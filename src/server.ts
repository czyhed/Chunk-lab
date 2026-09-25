import { createHash, randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import {
  createDeterministicEmbeddingClient,
  createEmbeddingClient,
} from "./embedding.js";
import {
  CONTEXT_PROMPT_VERSION,
  createContextClient,
} from "./context-client.js";
import {
  applyGeneratedContexts,
  confirmDraftContext,
  editDraftContext,
  generateDraftContexts,
  reconcileDraftContextInvalidation,
} from "./context-review.js";
import { markContextCandidates } from "./contextual.js";
import { GenerationGate } from "./generation-gate.js";
import {
  buildChunkPreview,
  type Chunk,
  type ChunkRequest,
  type ParsedBlock,
} from "./chunking.js";
import { parseChunkRequest } from "./chunk-request.js";
import {
  generateManualChunks,
  preparePreviousChunksForManualGeneration,
  type EffectiveManualAnnotation,
} from "./manual-chunk-generation.js";
import {
  createReviewState,
  restoreReviewState,
  setPreview,
  type ReviewState,
} from "./review-state.js";
import {
  saveImageSummaryReview,
  type ImageSummaryReviewInput,
  validateImageSummaryInput,
} from "./image-summary-workflow.js";
import { WorkspaceStore } from "./workspace.js";
import {
  downloadMineruResult,
  getMineruBatch,
  submitMineruBatch,
  type ParseConfig,
} from "./mineru.js";
import {
  applyMineruResults,
  mineruBatchIdsFor,
  resetDocumentForReparse,
} from "./parse-lifecycle.js";
import {
  beginVisualCopy,
  classifySource,
  finishVisualCopy,
  sourceVersionFromFile,
  type SourceDocumentRecord,
} from "./v21-input.js";
import { createOfficeVisualCopy } from "./v21-visual-copy.js";
import {
  buildLocalParsedDocument,
  buildMineruParsedDocument,
  type ParsedDocumentBlock,
  type SourcePageMapping,
} from "./v21-parsed-document.js";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import type { SourceSegmentV21 } from "./v21-provenance.js";
import { buildV21Preview, type V21ParsedDocument } from "./v21-preview.js";
import {
  adoptPreview,
  completePreviewGeneration,
  configurationFingerprint,
  createPreviewGateState,
  startPreviewGeneration,
  updateConfigurationDraft,
  type PreviewGateState,
} from "./v21-preview-gate.js";
import {
  recomputeReviewedChunk,
  type ReviewedModel,
  type ReviewableChunk,
} from "./v21-review-recompute.js";
import {
  applyReviewAction,
  type ReviewActionCommand,
  type ReviewActionState,
} from "./v21-review-actions.js";
import { planRecompute } from "./v21-recompute-scope.js";
import { buildPublicBatch } from "./v21-public-batch.js";
import {
  buildBatchExport,
  ExportContractSelectionError,
  type ExportContractVersion,
} from "./v21-export.js";
import { projectRuntimeBatchExport } from "./v21-runtime-export.js";
import {
  buildDiagnosticPackage,
  hasBboxPageAnomaly,
  type DiagnosticCategory,
  type DiagnosticPackage,
} from "./v21-diagnostic-package.js";
import {
  parseModelProfiles,
  publicModelProfiles,
} from "./model-profiles.js";
import { createVlmClient, VLM_PROMPT_VERSION } from "./vlm-client.js";
import { resolveTrustedImageInput } from "./trusted-image-input.js";
import {
  MemoryImageObjectStore,
  type ImageObjectStore,
  type StoreImageInput,
  type StoredImage,
} from "./image-object-store.js";
import {
  embeddingIdempotencyKey,
  embeddingJobStaleReasons,
  parseEmbeddingProfiles,
  publicEmbeddingProfiles,
  runEmbeddingJob,
  type EmbeddingJob,
} from "./embedding-job.js";
import {
  databaseIdempotencyKey,
  parseDatabaseProfiles,
  publicDatabaseProfiles,
  runDatabaseJob,
  type DatabaseJob,
} from "./database-job.js";
import {
  publicTableArtifact,
  publicTableVersion,
  TableRetrievalService,
  MemoryTableRetrievalRepository,
  tableArtifactFromReviewedModel,
  type ReviewedTableModel,
  type TableArtifact,
  type TableSourceChunkRelation,
} from "./table-retrieval.js";
import { createConfiguredTableRetrievalTarget } from "./table-retrieval-persistence.js";
import { evaluateRecallAtK } from "./retrieval-evaluation.js";
import type { AssetDescriptor, AssetClass } from "./asset-contract.js";
import {
  createConfiguredAssetObjectStore,
  MemoryAssetObjectStore,
  type AssetObjectStore,
} from "./object-store.js";
import {
  createSpuMaterialExport,
  createSpuMaterialFanout,
  SPU_DOCUMENT_TYPES,
  spuMaterialFileName,
  type SpuDocumentType,
  type SpuMaterialExport,
} from "./spu-material-export.js";
import {
  createSpu as createSpuRecord,
  createSpuCategory,
  emptySpuCatalog,
  previewSpu,
  searchSpus,
  suggestCategoryCode,
  type SpuCatalog,
  type SpuRecord,
} from "./spu-catalog.js";
import {
  sweepAssetLifecycle,
  type AssetLifecycleReference,
} from "./asset-lifecycle.js";
import {
  createConfiguredParseCacheRepository,
  MemoryParseCacheRepository,
  ParseCacheService,
  type ParseCacheRecord,
} from "./parse-cache.js";
import {
  createMemoryDocumentLeaseStore,
  createRedisDocumentLeaseStore,
  type DocumentLease,
  type DocumentLeaseIdentity,
  type DocumentLeaseStore,
} from "./document-lease.js";

if (process.env.NODE_ENV !== "test") {
  try {
    loadEnvFile(resolve(".env"));
  } catch {}
}

class AssetBackedImageObjectStore implements ImageObjectStore {
  constructor(private readonly assetStore: AssetObjectStore) {}

  async store(input: StoreImageInput): Promise<StoredImage> {
    const assetClass = input.source === "pdf_crop"
      ? "pdf_image_crop" as const
      : "extracted_image" as const;
    const stored = await this.assetStore.put({
      assetClass,
      bytes: input.bytes,
      contentType: input.contentType,
      batchId: input.batchId ?? "image-batch",
      documentId: input.documentId ?? "image-document",
      sourceDocumentVersion: input.sourceDocumentVersion,
      assetVersion: "image-v1",
      extension: input.contentType === "image/jpeg"
        ? "jpg"
        : input.contentType === "image/webp"
          ? "webp"
          : "png",
    });
    const reference = stored.reference;
    return {
      cacheHit: stored.cacheHit,
      reference: {
        contractVersion: "1.0",
        assetClass,
        scheme: "s3",
        bucket: reference.bucket,
        key: reference.key,
        uri: reference.uri,
        contentType: reference.contentType,
        checksumSha256: reference.checksumSha256,
        etag: reference.etag,
        versionId: reference.versionId,
        source: input.source,
        batchId: reference.batchId,
        documentId: reference.documentId ?? input.documentId ?? "image-document",
        sourceDocumentVersion: input.sourceDocumentVersion,
        visibility: reference.visibility,
      },
    };
  }
}

const token = process.env.MINERU_API_TOKEN;
if (!token) throw new Error("MINERU_API_TOKEN is required");
const configuredParseTimeoutMs = Number(process.env.MINERU_PARSE_TIMEOUT_MS);
const parseTimeoutMs =
  Number.isFinite(configuredParseTimeoutMs) && configuredParseTimeoutMs > 0
    ? configuredParseTimeoutMs
    : 15 * 60 * 1000;
const embeddingBaseUrl = process.env.EMBEDDING_BASE_URL;
const embeddingApiKey = process.env.EMBEDDING_API_KEY;
const embeddingModel = process.env.EMBEDDING_MODEL;
if (!embeddingBaseUrl || !embeddingApiKey || !embeddingModel)
  throw new Error("Embedding configuration is required");
const embedTexts = createEmbeddingClient({
  baseUrl: embeddingBaseUrl,
  apiKey: embeddingApiKey,
  model: embeddingModel,
});
const semanticEmbedTexts = createDeterministicEmbeddingClient();
const contextBaseUrl = process.env.CONTEXT_BASE_URL;
const contextApiKey = process.env.CONTEXT_API_KEY;
const contextModel = process.env.CONTEXT_MODEL;
const contextTimeoutMs = Number(process.env.CONTEXT_TIMEOUT_MS) || 30_000;
const generateContext =
  contextBaseUrl && contextApiKey && contextModel
    ? createContextClient({
        baseUrl: contextBaseUrl,
        apiKey: contextApiKey,
        model: contextModel,
        timeoutMs: contextTimeoutMs,
      })
    : null;
const modelProfiles = parseModelProfiles(
  process.env.MODEL_PROFILES_JSON,
  process.env,
);
const assetObjectStore = process.env.NODE_ENV === "test"
  ? new MemoryAssetObjectStore("memory-assets", {
      ...(process.env.SPU_MATERIAL_TEST_FAIL_OBJECT_KEY_INCLUDES
        ? { failObjectKeyIncludesOnce: process.env.SPU_MATERIAL_TEST_FAIL_OBJECT_KEY_INCLUDES }
        : {}),
    })
  : createConfiguredAssetObjectStore(process.env);
const parseCacheRepository = process.env.NODE_ENV === "test"
  ? new MemoryParseCacheRepository()
  : createConfiguredParseCacheRepository(process.env);
if (process.env.NODE_ENV === "production" && !parseCacheRepository)
  throw new Error("Production Parse Cache requires remote PostgreSQL");
const parseCacheService = parseCacheRepository ? new ParseCacheService(parseCacheRepository) : null;
const imageObjectStore: ImageObjectStore | null = assetObjectStore
  ? new AssetBackedImageObjectStore(assetObjectStore)
  : process.env.NODE_ENV === "test"
    ? new MemoryImageObjectStore()
    : null;
const embeddingProfiles = parseEmbeddingProfiles(process.env);
const databaseProfiles = parseDatabaseProfiles(process.env);
const tableEmbeddingProfile = embeddingProfiles.length === 1 ? embeddingProfiles[0] : undefined;
const configuredTableTarget = tableEmbeddingProfile
  ? createConfiguredTableRetrievalTarget(process.env, tableEmbeddingProfile.dimensions)
  : null;
if (process.env.NODE_ENV === "production" && (!tableEmbeddingProfile || !configuredTableTarget))
  throw new Error("Production Table Retrieval requires one Embedding profile and one PG profile");
const tableRetrievalRepository = configuredTableTarget?.repository ?? new MemoryTableRetrievalRepository();
const tableRetrievalService = new TableRetrievalService({
  repository: tableRetrievalRepository,
  embedTexts: tableEmbeddingProfile?.embed ?? createDeterministicEmbeddingClient(16),
  profile: tableEmbeddingProfile
    ? {
        id: tableEmbeddingProfile.id,
        model: tableEmbeddingProfile.model,
        dimensions: tableEmbeddingProfile.dimensions,
      }
    : { id: "table-retrieval-deterministic", model: "deterministic-fake-v1", dimensions: 16 },
});

type DocumentRecord = {
  id: string;
  name: string;
  state: "pending" | "running" | "done" | "failed";
  error?: string;
  progress?: { extractedPages: number; totalPages: number };
  markdown?: string;
  blocks?: ParsedBlock[];
  rawContentList?: unknown[];
  parsedDocumentV21?: V21ParsedDocument & { blocks: ParsedDocumentBlock[] };
  sourceAsset?: {
    path?: string;
    mimeType: string;
    objectReference?: AssetDescriptor;
  };
  visualCopyAsset?: {
    path?: string;
    mimeType: "application/pdf";
    objectReference?: AssetDescriptor;
  };
  contentListAsset?: AssetDescriptor;
  trustedResultAsset?: AssetDescriptor;
  parsedDocumentAsset?: AssetDescriptor;
  mineruRawResponseAssets?: AssetDescriptor[];
  mineruZipAsset?: AssetDescriptor;
  diagnosticPackageAssets?: Array<{
    packageId: string;
    reference: AssetDescriptor;
  }>;
  deletedAt?: string;
  deleteAfter?: string;
  sourceContract?: Omit<SourceDocumentRecord, "id" | "name" | "mimeType">;
  parseConfig?: ParseConfig;
  contentSha256?: string;
  reviewRevision?: number;
  reviewProgress?: {
    lastEditedChunkId: string | null;
    lastEditedSourceBlockId: string | null;
    lastViewedPage: number | null;
    completedChunkIds: string[];
    updatedAt: string;
  };
  parserConfigFingerprint?: string;
  parseCacheStatus?: ParseCacheRecord["status"];
  parseCacheReused?: boolean;
  parseCacheKey?: { contentSha256: string; parserConfigFingerprint: string };
  parseStartedAt?: string;
  reviewState: ReviewState;
  previewGateState?: PreviewGateState;
  sourceMapping?: SourcePageMapping;
  diagnosticCategories?: DiagnosticCategory[];
  manualGenerationEvidence?: { request: unknown; response: unknown };
  embeddingJobs?: EmbeddingJob[];
  databaseJobs?: DatabaseJob[];
  spuId?: string;
  pendingSpuIds?: string[];
  targetSpuIds?: string[];
  spuScopeStatus?: "confirmed" | "unassigned" | "conflicted";
  spuScopeRevision?: number;
  spuDocumentType?: SpuDocumentType;
  spuMaterialExportSequence?: number;
  spuMaterialCurrent?: Record<string, {
    exportKey: string;
    spuId: string;
    documentType: SpuDocumentType;
    sourceDocumentVersion: string;
    reviewRevision: number;
    exportVersion: string;
    status: SpuMaterialExport["status"];
    markdownReference?: AssetDescriptor;
    manifestReference?: AssetDescriptor;
    currentReference?: AssetDescriptor;
    contentHash?: string;
    updatedAt: string;
  }>;
  spuMaterialExports?: Array<{
    exportKey: string;
    spuId: string;
    documentType: SpuDocumentType;
    sourceDocumentVersion: string;
    reviewRevision: number;
    exportVersion: string;
    status: SpuMaterialExport["status"] | "blocked" | "failed";
    markdownReference?: AssetDescriptor;
    manifestReference?: AssetDescriptor;
    currentReference?: AssetDescriptor;
    contentHash?: string;
    inputFingerprint?: string;
    blockedChunkIds?: string[];
    reason?: string;
    generatedAt: string;
  }>;
  annotationState?: {
    annotations: EffectiveManualAnnotation[];
    suppressedSourceBlockIds: string[];
    detectionExclusionOverrides?: Record<string, boolean>;
  };
};
type BatchRecord = {
  id: string;
  mineruBatchIds?: string[];
  mineruBatchId?: string;
  mineruRawResponseAssets?: AssetDescriptor[];
  exportAssets?: AssetDescriptor[];
  documents: DocumentRecord[];
};

const batches = new Map<string, BatchRecord>();
const spuMaterialExportLocks = new Map<string, Promise<void>>();
const generationGate = new GenerationGate();
const workspaceStore = new WorkspaceStore(process.env.WORKSPACE_ROOT);
await workspaceStore.initialize();
let spuCatalogCache: SpuCatalog | null = null;
let spuCatalogWrite = Promise.resolve();
const documentLeaseStore: DocumentLeaseStore = process.env.REDIS_DISABLED === "1"
  ? createMemoryDocumentLeaseStore(Number(process.env.DOCUMENT_LEASE_TTL_SECONDS) || 60)
  : createRedisDocumentLeaseStore({
      url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
      ttlSeconds: Number(process.env.DOCUMENT_LEASE_TTL_SECONDS) || 60,
    });
const enforceDocumentLeases = process.env.NODE_ENV !== "test" || process.env.DOCUMENT_LEASE_ENFORCEMENT === "1";
const app = Fastify({
  disableRequestLogging: true,
  logger: {
    level: "warn",
    base: null,
    serializers: {
      req: (request) => ({ method: request.method }),
      res: (reply) => ({ statusCode: reply.statusCode }),
    },
  },
  bodyLimit: 2 * 1024 * 1024,
});

function confirmedSpuIds(document: DocumentRecord): string[] {
  const ids = document.targetSpuIds?.map((id) => id.trim()).filter(Boolean) ?? [];
  return ids.length ? [...new Set(ids)] : document.spuId ? [document.spuId] : [];
}

async function validateSpuScopeIds(ids: string[]): Promise<string | null> {
  const catalog = await readSpuCatalog();
  const known = new Set(catalog.spus.map((spu) => spu.spuId));
  const modern = ids.find((id) => /^SPU-[A-Z]{2,8}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/.test(id));
  if (modern && !known.has(modern)) return modern;
  return null;
}

async function readSpuCatalog(): Promise<SpuCatalog> {
  if (!spuCatalogCache)
    spuCatalogCache = await workspaceStore.readSpuCatalog<SpuCatalog>() ?? emptySpuCatalog();
  return spuCatalogCache;
}

async function updateSpuCatalog<T>(operation: (catalog: SpuCatalog) => T): Promise<T> {
  const previous = spuCatalogWrite;
  let result!: T;
  const write = previous.catch(() => undefined).then(async () => {
    const catalog = await readSpuCatalog();
    result = operation(catalog);
    await workspaceStore.writeSpuCatalog(catalog);
  });
  spuCatalogWrite = write;
  await write;
  return result;
}

function publicSpu(spu: SpuRecord): Omit<SpuRecord, "creationRequestId"> {
  const { creationRequestId: _creationRequestId, ...result } = spu;
  return result;
}

async function serializeSpuMaterialExport<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = spuMaterialExportLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => current);
  spuMaterialExportLocks.set(key, queued);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (spuMaterialExportLocks.get(key) === queued) spuMaterialExportLocks.delete(key);
  }
}

function spuExportStaleReasons(document: DocumentRecord, entry: {
  sourceDocumentVersion: string;
  reviewRevision: number;
  documentType?: SpuDocumentType;
}): string[] {
  const reasons: string[] = [];
  if (entry.sourceDocumentVersion !== document.sourceContract?.sourceDocumentVersion)
    reasons.push("source_document_version_changed");
  if (entry.reviewRevision !== (document.reviewRevision ?? 0))
    reasons.push("review_revision_changed");
  if (entry.documentType && document.spuDocumentType && entry.documentType !== document.spuDocumentType)
    reasons.push("document_type_changed");
  return reasons;
}

function spuObjectPart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 128);
}

function spuMaterialObjectKeys(input: {
  spuId: string;
  documentId: string;
  documentType: SpuDocumentType;
  sourceDocumentVersion: string;
  exportVersion: string;
  sourceName: string;
}): { markdown: string; manifest: string; current: string } {
  const base = [
    "spu",
    spuObjectPart(input.spuId),
    "documents",
    spuObjectPart(input.documentId),
    "types",
    input.documentType,
    "sources",
    spuObjectPart(input.sourceDocumentVersion),
    "exports",
    spuObjectPart(input.exportVersion),
  ].join("/");
  return {
    markdown: `${base}/${spuMaterialFileName(input)}`,
    manifest: `${base}/manifest.json`,
    current: ["spu", spuObjectPart(input.spuId), "documents", spuObjectPart(input.documentId), "current.json"].join("/"),
  };
}

async function softDeleteOrphan(reference: AssetDescriptor | undefined): Promise<void> {
  if (!reference || !assetObjectStore) return;
  await assetObjectStore.softDelete(reference.key, {
    at: new Date().toISOString(),
    deleteAfter: new Date().toISOString(),
    activeReferenceCount: 0,
    reason: "orphan",
  }).catch(() => undefined);
}

async function writeSpuMaterialExportObjects(input: {
  batch: BatchRecord;
  document: DocumentRecord;
  spuId: string;
  documentType: SpuDocumentType;
  sourceDocumentVersion: string;
  exported: SpuMaterialExport;
}): Promise<{
  markdownReference: AssetDescriptor;
  manifestReference: AssetDescriptor;
  currentReference: AssetDescriptor;
}> {
  if (!assetObjectStore) throw new Error("对象存储尚未配置");
  const keys = spuMaterialObjectKeys({
    spuId: input.spuId,
    documentId: input.document.id,
    documentType: input.documentType,
    sourceDocumentVersion: input.sourceDocumentVersion,
    exportVersion: input.exported.exportVersion,
    sourceName: input.document.name,
  });
  let markdownReference: AssetDescriptor | undefined;
  let manifestReference: AssetDescriptor | undefined;
  try {
    markdownReference = (await assetObjectStore.put({
      assetClass: "spu_material_markdown",
      bytes: new TextEncoder().encode(input.exported.markdown),
      contentType: "text/markdown; charset=utf-8",
      batchId: input.batch.id,
      documentId: input.document.id,
      sourceDocumentVersion: input.sourceDocumentVersion,
      assetVersion: input.exported.exportVersion,
      extension: "md",
      objectKey: keys.markdown,
    })).reference;
    manifestReference = (await assetObjectStore.put({
      assetClass: "spu_material_manifest",
      bytes: new TextEncoder().encode(JSON.stringify(input.exported.manifest)),
      contentType: "application/json",
      batchId: input.batch.id,
      documentId: input.document.id,
      sourceDocumentVersion: input.sourceDocumentVersion,
      assetVersion: input.exported.exportVersion,
      extension: "json",
      objectKey: keys.manifest,
    })).reference;
    const currentReference = (await assetObjectStore.put({
      assetClass: "spu_material_current",
      bytes: new TextEncoder().encode(JSON.stringify({
        contractVersion: "spu-document-export-1",
        targetSpuId: input.spuId,
        documentId: input.document.id,
        documentType: input.documentType,
        sourceDocumentVersion: input.sourceDocumentVersion,
        exportVersion: input.exported.exportVersion,
        markdownKey: markdownReference.key,
        manifestKey: manifestReference.key,
        contentHash: input.exported.contentHash,
        generatedAt: input.exported.manifest.generatedAt,
      })),
      contentType: "application/json",
      batchId: input.batch.id,
      documentId: input.document.id,
      sourceDocumentVersion: null,
      assetVersion: "current",
      extension: "json",
      objectKey: keys.current,
    })).reference;
    return { markdownReference, manifestReference, currentReference };
  } catch (error) {
    await Promise.all([softDeleteOrphan(markdownReference), softDeleteOrphan(manifestReference)]);
    throw error;
  }
}

function requestLeaseIdentity(request: { headers: Record<string, string | string[] | undefined> }): DocumentLeaseIdentity {
  const header = (name: string) => {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  return {
    userId: header("x-user-id")?.trim() || "control-center-user",
    sessionId: header("x-session-id")?.trim() || "control-center-session",
  };
}

function leaseResponse(lease: DocumentLease | null, ttlSeconds: number) {
  return {
    locked: Boolean(lease),
    ttlSeconds,
    holder: lease
      ? { userId: lease.userId, sessionId: lease.sessionId, acquiredAt: lease.acquiredAt, lastHeartbeatAt: lease.lastHeartbeatAt }
      : null,
  };
}

function ensureReviewProgress(document: DocumentRecord) {
  document.reviewRevision ??= 0;
  document.reviewProgress ??= {
    lastEditedChunkId: null,
    lastEditedSourceBlockId: null,
    lastViewedPage: null,
    completedChunkIds: [],
    updatedAt: new Date().toISOString(),
  };
  return document.reviewProgress;
}

function touchReviewProgress(document: DocumentRecord, changedChunkIds: string[] = []) {
  const progress = ensureReviewProgress(document);
  const changed = new Set(changedChunkIds);
  progress.completedChunkIds = progress.completedChunkIds.filter((id) => !changed.has(id));
  progress.lastEditedChunkId = changedChunkIds.at(-1) ?? progress.lastEditedChunkId;
  progress.updatedAt = new Date().toISOString();
  document.reviewRevision = (document.reviewRevision ?? 0) + 1;
}

async function requireDocumentLease(
  request: { headers: Record<string, string | string[] | undefined>; params: Record<string, string>; body?: unknown },
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
  document: DocumentRecord,
): Promise<DocumentLease | null> {
  const contentSha256 = document.contentSha256;
  if (!contentSha256) {
    reply.code(409).send({ error: "文档缺少内容指纹，暂不能进入处理工作区", code: "DOCUMENT_FINGERPRINT_REQUIRED" });
    return null;
  }
  const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
  if (body.expectedRevision !== undefined && Number(body.expectedRevision) !== (document.reviewRevision ?? 0)) {
    reply.code(409).send({ error: "Draft 版本已变化，请重新加载", code: "REVIEW_REVISION_CONFLICT", reviewRevision: document.reviewRevision ?? 0 });
    return null;
  }
  const leaseId = typeof body.leaseId === "string"
    ? body.leaseId
    : (() => {
        const header = request.headers["x-document-lease-id"];
        return Array.isArray(header) ? header[0] : header;
      })();
  const current = await documentLeaseStore.get(contentSha256);
  const identity = requestLeaseIdentity(request);
  if (!current.lease || current.lease.leaseId !== leaseId || current.lease.userId !== identity.userId || current.lease.sessionId !== identity.sessionId) {
    reply.code(423).send({ error: "文档当前未由本会话持有处理租约", code: "DOCUMENT_LEASE_REQUIRED", ...leaseResponse(current.lease, current.ttlSeconds) });
    return null;
  }
  return current.lease;
}

app.addHook("preHandler", async (request, reply) => {
  if (!enforceDocumentLeases) return;
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const params = request.params as Record<string, string>;
  if (!params.documentId || request.url.includes("/lease")) return;
  const document = await getDocument(params.batchId, params.documentId);
  if (!document) return;
  const lease = await requireDocumentLease({
    headers: request.headers,
    params,
    body: request.body,
  }, reply, document);
  if (!lease) return reply;
});

function ensurePreviewGate(
  document: DocumentRecord,
  configuration: ChunkRequest,
): PreviewGateState {
  const state = structuredClone(
    document.previewGateState ?? createPreviewGateState(configuration),
  );
  if (!state.preview && document.reviewState.preview) {
    const ticket = { key: `${document.id}:preview`, revision: 0 };
    state.latestGenerationTicket = ticket;
    state.preview = {
      snapshot: structuredClone(document.reviewState.preview),
      configuration: structuredClone(document.reviewState.preview.configuration),
      configurationFingerprint: configurationFingerprint(
        document.reviewState.preview.configuration,
      ),
      generationTicket: ticket,
      expired: false,
    };
    state.configurationDraft = {
      configuration: structuredClone(document.reviewState.preview.configuration),
      fingerprint: state.preview.configurationFingerprint,
    };
  }
  if (document.reviewState.draft)
    state.draft = {
      snapshot: structuredClone(document.reviewState.draft),
      configurationFingerprint: configurationFingerprint(
        document.reviewState.draft.configuration,
      ),
    };
  return state;
}

await app.register(multipart, {
  limits: { files: 50, fileSize: 200 * 1024 * 1024, fields: 10 },
});
await app.register(fastifyStatic, {
  root: resolve("."),
  allowedPath: (pathName) =>
    ["logo.png", "index.html", "styles.css", "related-chunk-workspace.css", "app.js"].includes(pathName.replace(/^\/+/, "")),
});

app.get("/", async (_request, reply) => reply.sendFile("index.html"));
app.get("/pdf-surface.js", async (_request, reply) => {
  reply.type("text/javascript");
  return reply.send(await readFile(resolve("pdf-surface.js")));
});
app.get("/pdf-render-coordinator.js", async (_request, reply) => {
  reply.type("text/javascript");
  return reply.send(await readFile(resolve("pdf-render-coordinator.js")));
});
app.get("/chunk-review-links.js", async (_request, reply) => {
  reply.type("text/javascript");
  return reply.send(await readFile(resolve("chunk-review-links.js")));
});
app.get("/review-layout.js", async (_request, reply) => {
  reply.type("text/javascript");
  return reply.send(await readFile(resolve("review-layout.js")));
});
app.get("/bbox-mapping.js", async (_request, reply) => {
  reply.type("text/javascript");
  return reply.send(await readFile(resolve("bbox-mapping.js")));
});
app.get("/manual-annotations.js", async (_request, reply) => {
  reply.type("text/javascript");
  return reply.send(await readFile(resolve("manual-annotations.js")));
});
app.get("/user-facing-errors.js", async (_request, reply) => {
  reply.type("text/javascript");
  return reply.send(await readFile(resolve("user-facing-errors.js")));
});
app.get("/related-chunk-candidates.js", async (_request, reply) => {
  reply.type("text/javascript");
  return reply.send(await readFile(resolve("related-chunk-candidates.js")));
});
app.get("/batch-refresh.js", async (_request, reply) => {
  reply.type("text/javascript");
  return reply.send(await readFile(resolve("batch-refresh.js")));
});
app.get("/table-editor-operations.js", async (_request, reply) => {
  reply.type("text/javascript");
  return reply.send(await readFile(resolve("table-editor-operations.js")));
});
app.get("/context-generation-state.js", async (_request, reply) => {
  reply.type("text/javascript");
  return reply.send(await readFile(resolve("context-generation-state.js")));
});
app.get<{ Params: { file: "pdf.mjs" | "pdf.worker.mjs" } }>(
  "/vendor/pdfjs/:file",
  async (request, reply) => {
    if (!["pdf.mjs", "pdf.worker.mjs"].includes(request.params.file))
      return reply.code(404).send({ error: "PDF.js asset not found" });
    reply.type("text/javascript");
    return reply.send(
      await readFile(resolve("node_modules/pdfjs-dist/build", request.params.file)),
    );
  },
);
app.get("/parent-context.js", async (_request, reply) => {
  reply.type("text/javascript");
  return reply.send(await readFile(resolve("parent-context.js")));
});
app.get("/api/health", async () => ({ ok: true }));
app.get("/api/agentic-retrieval-config", async () => ({
  agenticRetrievalUiUrl: process.env.AGENTIC_RETRIEVAL_UI_URL?.trim() ?? "",
}));
app.get<{ Querystring: { query?: string } }>("/api/spu-categories", async (request) => {
  const query = request.query.query?.trim().toLocaleLowerCase() ?? "";
  const categories = (await readSpuCatalog()).categories
    .filter((category) => !query || category.name.toLocaleLowerCase().includes(query) || category.code.toLocaleLowerCase().includes(query))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  return { categories };
});
app.post<{ Body: { name?: unknown } }>("/api/spu-categories/preview", async (request, reply) => {
  if (typeof request.body?.name !== "string" || !request.body.name.trim())
    return reply.code(400).send({ error: "类目名称不能为空", code: "SPU_CATEGORY_INVALID" });
  return { suggestedCode: suggestCategoryCode(request.body.name) };
});
app.post<{ Body: { name?: unknown; code?: unknown } }>("/api/spu-categories", async (request, reply) => {
  if (typeof request.body?.name !== "string" || typeof request.body?.code !== "string")
    return reply.code(400).send({ error: "类目名称和编码不能为空", code: "SPU_CATEGORY_INVALID" });
  try {
    const category = await updateSpuCatalog((catalog) => createSpuCategory(catalog, { name: request.body.name as string, code: request.body.code as string }));
    return reply.code(201).send({ category });
  } catch (error) {
    return reply.code(409).send({ error: error instanceof Error ? error.message : "类目创建失败", code: "SPU_CATEGORY_CONFLICT" });
  }
});
app.get<{ Querystring: { query?: string; categoryId?: string; limit?: string } }>("/api/spus", async (request) => ({
  spus: searchSpus(await readSpuCatalog(), {
    query: request.query.query,
    categoryId: request.query.categoryId,
    limit: Number(request.query.limit) || 20,
  }).map(publicSpu),
}));
app.post<{ Body: { productName?: unknown; categoryId?: unknown; brand?: unknown; modelSeries?: unknown } }>("/api/spus/preview", async (request, reply) => {
  if (typeof request.body?.productName !== "string" || typeof request.body?.categoryId !== "string")
    return reply.code(400).send({ error: "商品名称和大类不能为空", code: "SPU_DRAFT_INVALID" });
  try {
    const result = previewSpu(await readSpuCatalog(), {
      productName: request.body.productName,
      categoryId: request.body.categoryId,
      brand: typeof request.body.brand === "string" ? request.body.brand : "",
      modelSeries: typeof request.body.modelSeries === "string" ? request.body.modelSeries : "",
    });
    return { candidateSpuId: result.candidateSpuId, matches: result.matches.map(publicSpu) };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : "SPU 预览失败", code: "SPU_DRAFT_INVALID" });
  }
});
app.post<{ Body: { productName?: unknown; categoryId?: unknown; brand?: unknown; modelSeries?: unknown; creationRequestId?: unknown; candidateSpuId?: unknown } }>("/api/spus", async (request, reply) => {
  if (typeof request.body?.productName !== "string" || typeof request.body?.categoryId !== "string" || typeof request.body?.creationRequestId !== "string")
    return reply.code(400).send({ error: "商品名称、大类和创建请求标识不能为空", code: "SPU_CREATE_INVALID" });
  try {
    const result = await updateSpuCatalog((catalog) => createSpuRecord(catalog, {
      productName: request.body.productName as string,
      categoryId: request.body.categoryId as string,
      brand: typeof request.body.brand === "string" ? request.body.brand : "",
      modelSeries: typeof request.body.modelSeries === "string" ? request.body.modelSeries : "",
      creationRequestId: request.body.creationRequestId as string,
      candidateSpuId: typeof request.body.candidateSpuId === "string" ? request.body.candidateSpuId : undefined,
    }));
    return reply.code(result.reused ? 200 : 201).send({ spu: publicSpu(result.spu), reused: result.reused });
  } catch (error) {
    return reply.code(409).send({ error: error instanceof Error ? error.message : "SPU 创建失败", code: "SPU_CREATE_CONFLICT" });
  }
});
app.get<{ Params: { batchId: string; documentId: string } }>(
  "/api/batches/:batchId/documents/:documentId/lease",
  async (request, reply) => {
    const document = await getDocument(request.params.batchId, request.params.documentId);
    if (!document) return reply.code(404).send({ error: "文档不存在或已过期" });
    if (!document.contentSha256)
      return reply.code(409).send({ error: "文档缺少内容指纹", code: "DOCUMENT_FINGERPRINT_REQUIRED" });
    const current = await documentLeaseStore.get(document.contentSha256);
    return leaseResponse(current.lease, current.ttlSeconds);
  },
);
app.post<{ Params: { batchId: string; documentId: string }; Body: { leaseId?: unknown } }>(
  "/api/batches/:batchId/documents/:documentId/lease",
  async (request, reply) => {
    const document = await getDocument(request.params.batchId, request.params.documentId);
    if (!document) return reply.code(404).send({ error: "文档不存在或已过期" });
    if (!document.contentSha256)
      return reply.code(409).send({ error: "文档缺少内容指纹", code: "DOCUMENT_FINGERPRINT_REQUIRED" });
    const identity = requestLeaseIdentity(request);
    // A lost response or page refresh must not lock its own session out.
    const current = await documentLeaseStore.get(document.contentSha256);
    const existingLeaseId = current.lease?.userId === identity.userId && current.lease.sessionId === identity.sessionId
      ? current.lease.leaseId : null;
    if (existingLeaseId) {
      if (current.lease?.leaseId === existingLeaseId && current.lease.userId === identity.userId && current.lease.sessionId === identity.sessionId) {
        const renewed = await documentLeaseStore.renew(document.contentSha256, existingLeaseId);
        if (renewed.ok) return { editable: true, leaseId: renewed.lease.leaseId, ...leaseResponse(renewed.lease, renewed.ttlSeconds) };
      }
    }
    const acquired = await documentLeaseStore.acquire(document.contentSha256, identity);
    if (!acquired.ok)
      return reply.code(423).send({ error: "文档正在由其他会话处理", code: "DOCUMENT_LEASE_UNAVAILABLE", ...leaseResponse(acquired.lease, acquired.ttlSeconds) });
    return { editable: true, leaseId: acquired.lease.leaseId, ...leaseResponse(acquired.lease, acquired.ttlSeconds) };
  },
);
app.post<{ Params: { batchId: string; documentId: string }; Body: { leaseId?: unknown } }>(
  "/api/batches/:batchId/documents/:documentId/lease/renew",
  async (request, reply) => {
    const document = await getDocument(request.params.batchId, request.params.documentId);
    const leaseId = typeof request.body?.leaseId === "string" ? request.body.leaseId : null;
    if (!document || !document.contentSha256 || !leaseId)
      return reply.code(400).send({ error: "缺少文档租约" });
    const current = await documentLeaseStore.get(document.contentSha256);
    const identity = requestLeaseIdentity(request);
    if (current.lease && (current.lease.userId !== identity.userId || current.lease.sessionId !== identity.sessionId))
      return reply.code(423).send({ error: "文档正在由其他会话处理", code: "DOCUMENT_LEASE_UNAVAILABLE", ...leaseResponse(current.lease, current.ttlSeconds) });
    const renewed = await documentLeaseStore.renew(document.contentSha256, leaseId);
    if (!renewed.ok)
      return reply.code(423).send({ error: "文档租约已失效", code: "DOCUMENT_LEASE_EXPIRED", ...leaseResponse(renewed.lease, renewed.ttlSeconds) });
    return { editable: true, leaseId, ...leaseResponse(renewed.lease, renewed.ttlSeconds) };
  },
);
app.delete<{ Params: { batchId: string; documentId: string }; Body: { leaseId?: unknown } }>(
  "/api/batches/:batchId/documents/:documentId/lease",
  async (request, reply) => {
    const document = await getDocument(request.params.batchId, request.params.documentId);
    const leaseId = typeof request.body?.leaseId === "string" ? request.body.leaseId : null;
    if (!document || !document.contentSha256 || !leaseId)
      return reply.code(400).send({ error: "缺少文档租约" });
    const current = await documentLeaseStore.get(document.contentSha256);
    const identity = requestLeaseIdentity(request);
    if (!current.lease || current.lease.leaseId !== leaseId || current.lease.userId !== identity.userId || current.lease.sessionId !== identity.sessionId)
      return reply.code(423).send({ error: "文档租约不属于当前会话", code: "DOCUMENT_LEASE_RELEASE_REJECTED" });
    const released = await documentLeaseStore.release(document.contentSha256, leaseId);
    if (!released) return reply.code(423).send({ error: "文档租约不属于当前会话", code: "DOCUMENT_LEASE_RELEASE_REJECTED" });
    return { released: true };
  },
);
app.post<{
  Params: { batchId: string; documentId: string };
  Body: { action?: unknown; chunkIds?: unknown; cursorChunkId?: unknown; lastViewedPage?: unknown; expectedRevision?: unknown };
}>(
  "/api/batches/:batchId/documents/:documentId/review/progress",
  async (request, reply) => {
    const batch = await getBatch(request.params.batchId);
    const document = batch?.documents.find((candidate) => candidate.id === request.params.documentId);
    if (!batch || !document || !document.reviewState.draft)
      return reply.code(404).send({ error: "文档 Draft 不存在" });
    ensureReviewProgress(document);
    const chunks = document.reviewState.draft.chunks;
    const action = request.body.action;
    const current = new Set(document.reviewProgress!.completedChunkIds);
    if (action === "mark-to-here") {
      if (typeof request.body.cursorChunkId !== "string") return reply.code(400).send({ error: "缺少目标 Chunk" });
      const end = chunks.findIndex((chunk) => chunk.id === request.body.cursorChunkId);
      if (end < 0) return reply.code(400).send({ error: "目标 Chunk 不存在" });
      chunks.slice(0, end + 1).forEach((chunk) => current.add(chunk.id));
      document.reviewProgress!.lastEditedChunkId = request.body.cursorChunkId;
    } else if (action === "mark-selected" || action === "unmark-selected") {
      if (!Array.isArray(request.body.chunkIds) || request.body.chunkIds.some((id) => typeof id !== "string")) return reply.code(400).send({ error: "缺少 Chunk ID 集合" });
      for (const id of request.body.chunkIds) {
        if (!chunks.some((chunk) => chunk.id === id)) return reply.code(400).send({ error: "Chunk 不存在" });
        if (action === "mark-selected") current.add(id); else current.delete(id);
      }
    } else return reply.code(400).send({ error: "未知的进度操作" });
    document.reviewProgress!.completedChunkIds = [...current].filter((id) => chunks.some((chunk) => chunk.id === id));
    document.reviewProgress!.updatedAt = new Date().toISOString();
    document.reviewRevision = (document.reviewRevision ?? 0) + 1;
    await persistBatch(batch);
    return { reviewRevision: document.reviewRevision, reviewProgress: structuredClone(document.reviewProgress) };
  },
);
app.get("/api/model-profiles", async () => ({
  profiles: publicModelProfiles(modelProfiles),
}));
app.get("/api/embedding-profiles", async () => ({
  profiles: publicEmbeddingProfiles(embeddingProfiles),
}));
app.get("/api/database-profiles", async () => ({
  profiles: publicDatabaseProfiles(databaseProfiles),
}));

app.post<{
  Body: {
    logicalTableId?: unknown;
    reviewedModel?: unknown;
    artifact?: unknown;
    finalSummary?: unknown;
    sourceChunks?: unknown;
    sourceSegments?: unknown;
    batchId?: unknown;
    documentId?: unknown;
    chunkId?: unknown;
    rawTableHtml?: unknown;
    markdown?: unknown;
    renderedHtml?: unknown;
  };
}>("/api/table-retrieval/versions", async (request, reply) => {
  try {
    const body = request.body ?? {};
    const artifact = parseTableArtifact(body);
    const sourceChunks = parseTableSourceChunks(body.sourceChunks);
    let scopedBatch: BatchRecord | undefined;
    let scopedDocument: DocumentRecord | undefined;
    let scopedChunk: (Chunk & { tableRetrievalDraft?: Record<string, unknown> }) | undefined;
    const scopeValues = [body.batchId, body.documentId, body.chunkId];
    if (scopeValues.some((value) => value !== undefined)) {
      if (!scopeValues.every((value) => typeof value === "string" && value.trim()))
        throw new Error("batchId、documentId 和 chunkId 必须同时提供");
      scopedBatch = await getBatch(body.batchId as string);
      scopedDocument = scopedBatch?.documents.find((candidate) => candidate.id === body.documentId);
      scopedChunk = scopedDocument?.reviewState.draft?.chunks.find(
        (candidate) => candidate.id === body.chunkId,
      ) as (Chunk & { tableRetrievalDraft?: Record<string, unknown> }) | undefined;
      if (!scopedBatch || !scopedDocument || !scopedChunk)
        throw new Error("表格 Chunk 不存在或已过期");
      if (scopedChunk.type !== "table") throw new Error("目标 Chunk 不是表格");
      if (!sourceChunks.length) throw new Error("请至少关联一个文字 Chunk");
      validateScopedTableSources(sourceChunks, scopedDocument);
    }
    const result = await tableRetrievalService.createVersion({
      logicalTableId: requiredTableString(body.logicalTableId, "logicalTableId"),
      artifact,
      finalSummary: requiredTableString(body.finalSummary ?? "", "finalSummary", true),
      sourceChunks,
      ...(typeof body.rawTableHtml === "string" ? { rawTableHtml: body.rawTableHtml } : {}),
      ...(typeof body.markdown === "string" ? { markdown: body.markdown } : {}),
      ...(typeof body.renderedHtml === "string" ? { renderedHtml: body.renderedHtml } : {}),
    });
    let reviewState: ReviewState | undefined;
    if (scopedBatch && scopedDocument && scopedChunk) {
      scopedChunk.tableRetrievalDraft = {
        logicalTableId: result.version.logicalTableId,
        finalSummary: result.version.finalSummary,
        sourceChunkIds: result.bundle?.sourceChunkIds ?? [],
        tableVersionId: result.version.tableVersionId,
        vectorReady: result.bundle?.vectorReady === true,
      };
      scopedDocument.reviewRevision = (scopedDocument.reviewRevision ?? 0) + 1;
      reviewState = scopedDocument.reviewState;
      await persistBatch(scopedBatch);
    }
    return {
      version: publicTableVersion(result.version),
      bundle: result.bundle
        ? {
            bundleId: result.bundle.bundleId,
            tableVersionId: result.bundle.tableVersionId,
            sourceChunkIds: result.bundle.sourceChunkIds,
            embeddingInputHash: result.bundle.embeddingInputHash,
            vectorReady: result.bundle.vectorReady,
          }
        : null,
      queryValidation: result.validation,
      ...(reviewState ? { reviewState } : {}),
    };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : "Table Version 输入无效" });
  }
});

app.post<{ Body: { query?: unknown } }>("/api/table-retrieval/search", async (request, reply) => {
  const query = request.body?.query;
  if (typeof query !== "string" || !query.trim())
    return reply.code(400).send({ error: "query 不能为空" });
  try {
    return { results: await tableRetrievalService.search(query) };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : "普通检索失败" });
  }
});

app.get<{ Params: { tableVersionId: string } }>(
  "/api/table-retrieval/versions/:tableVersionId",
  async (request, reply) => {
    const version = await tableRetrievalRepository.getVersion(request.params.tableVersionId);
    if (!version) return reply.code(404).send({ error: "Table Version 不存在" });
    return publicTableArtifact(version);
  },
);

app.post<{ Params: { tableVersionId: string } }>(
  "/api/table-retrieval/versions/:tableVersionId/query-ready",
  async (request, reply) => {
    try {
      const version = await tableRetrievalService.confirmQueryReady(request.params.tableVersionId);
      return { version: publicTableVersion(version) };
    } catch (error) {
      return reply.code(422).send({ error: error instanceof Error ? error.message : "query_ready 校验失败" });
    }
  },
);

app.get<{
  Params: { batchId: string; documentId: string };
  Querystring: { spuId?: string; exportVersion?: string };
}>(
  "/api/batches/:batchId/documents/:documentId/spu-material-export",
  async (request, reply) => {
    const document = await getDocument(request.params.batchId, request.params.documentId);
    if (!document)
      return reply.code(404).send({ error: "文档不存在或已过期" });
    const all = document.spuMaterialExports ?? [];
    const latestAttemptFor = (spuId?: string) => {
      const entries = spuId ? all.filter((entry) => entry.spuId === spuId) : all;
      return entries.at(-1) ?? null;
    };
    const latestFor = (spuId?: string) => {
      if (request.query.exportVersion)
        return all.filter((entry) =>
          (!spuId || entry.spuId === spuId) && entry.exportVersion === request.query.exportVersion,
        ).at(-1) ?? null;
      const current = spuId ? document.spuMaterialCurrent?.[spuId] : undefined;
      if (current) return current;
      const entries = spuId ? all.filter((entry) => entry.spuId === spuId) : all;
      return entries.at(-1) ?? null;
    };
    const latest = latestFor(request.query.spuId);
    const latestAttempt = latestAttemptFor(request.query.spuId);
    const latestStaleReasons = latest ? spuExportStaleReasons(document, latest) : [];
    const children = [...new Set((document.targetSpuIds ?? Object.keys(document.spuMaterialCurrent ?? {}).concat(all.map((entry) => entry.spuId))).filter(Boolean))]
      .map((spuId) => latestAttemptFor(spuId) ?? latestFor(spuId))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    const nextExportSequence = Math.max(
      document.spuMaterialExportSequence ?? 0,
      0,
      ...all.map((entry) => Number(entry.exportVersion.replace(/^v/, ""))).filter((value) => Number.isSafeInteger(value)),
    ) + 1;
    const nextExportVersion = `v${nextExportSequence}`;
    const targetSpuIds = document.targetSpuIds ?? (document.spuId ? [document.spuId] : []);
    const publicAttempt = (entry: NonNullable<typeof latestAttempt>) => ({
      exportVersion: entry.exportVersion,
      sourceDocumentVersion: entry.sourceDocumentVersion,
      status: spuExportStaleReasons(document, entry).length ? "stale" : entry.status,
      ...(entry.reason ? { reason: entry.reason } : {}),
      ...(entry.blockedChunkIds ? { blockedChunkIds: entry.blockedChunkIds } : {}),
    });
    return {
      spuId: document.spuId ?? null,
      targetSpuIds,
      pendingSpuIds: document.pendingSpuIds ?? targetSpuIds,
      scopeStatus: document.spuScopeStatus ?? (document.spuId ? "confirmed" : "unassigned"),
      documentType: document.spuDocumentType ?? null,
      reviewRevision: document.reviewRevision ?? 0,
      nextExportVersion,
      filenamePreviews: document.spuDocumentType ? targetSpuIds.map((spuId) => ({
        spuId,
        exportVersion: nextExportVersion,
        fileName: spuMaterialFileName({ spuId, documentType: document.spuDocumentType!, sourceName: document.name, exportVersion: nextExportVersion }),
      })) : [],
      status: latestAttempt ? (spuExportStaleReasons(document, latestAttempt).length ? "stale" : latestAttempt.status) : latestStaleReasons.length ? "stale" : latest?.status ?? (document.spuId && document.spuDocumentType ? "pending" : "not_started"),
      ...(latestStaleReasons.length ? { staleReasons: latestStaleReasons } : {}),
      ...(latestAttempt ? { latestAttempt: publicAttempt(latestAttempt) } : {}),
      current: latest
        ? {
            exportVersion: latest.exportVersion,
            sourceDocumentVersion: latest.sourceDocumentVersion,
            ...(latest.markdownReference ? { markdownKey: latest.markdownReference.key } : {}),
            ...(latest.manifestReference ? { manifestKey: latest.manifestReference.key } : {}),
            ...(latest.currentReference ? { currentKey: latest.currentReference.key } : {}),
            contentHash: latest.contentHash,
          }
        : null,
      children: children.map((entry) => ({
        spuId: entry.spuId,
        documentType: entry.documentType,
        sourceDocumentVersion: entry.sourceDocumentVersion,
        exportVersion: entry.exportVersion,
        status: spuExportStaleReasons(document, entry).length ? "stale" : entry.status,
        ...(spuExportStaleReasons(document, entry).length ? { staleReasons: spuExportStaleReasons(document, entry) } : {}),
        ...(entry.markdownReference ? { markdownKey: entry.markdownReference.key } : {}),
        ...(entry.markdownReference ? { fileName: entry.markdownReference.key.split("/").at(-1) } : {}),
        ...(entry.manifestReference ? { manifestKey: entry.manifestReference.key } : {}),
        contentHash: entry.contentHash,
        ...( "blockedChunkIds" in entry && entry.blockedChunkIds ? { blockedChunkIds: entry.blockedChunkIds } : {}),
        ...( "reason" in entry && entry.reason ? { reason: entry.reason } : {}),
      })),
    };
  },
);

app.put<{
  Params: { batchId: string; documentId: string };
  Body: { targetSpuIds?: unknown };
}>(
  "/api/batches/:batchId/documents/:documentId/spu-material-selection",
  async (request, reply) => {
    const batch = await getBatch(request.params.batchId);
    const document = batch?.documents.find((candidate) => candidate.id === request.params.documentId);
    if (!batch || !document) return reply.code(404).send({ error: "文档不存在或已过期" });
    if (!Array.isArray(request.body?.targetSpuIds))
      return reply.code(400).send({ error: "targetSpuIds 必须是字符串数组", code: "SPU_SCOPE_REQUIRED" });
    const targetSpuIds = [...new Set(request.body.targetSpuIds
      .filter((id): id is string => typeof id === "string" && Boolean(id.trim()))
      .map((id) => id.trim()))];
    const unknownSpuId = await validateSpuScopeIds(targetSpuIds);
    if (unknownSpuId)
      return reply.code(409).send({ error: `SPU ${unknownSpuId} 不存在，请先创建或复用 SPU`, code: "SPU_NOT_FOUND", spuId: unknownSpuId });
    document.pendingSpuIds = targetSpuIds;
    await persistBatch(batch);
    return { pendingSpuIds: [...targetSpuIds] };
  },
);

app.post<{
  Params: { batchId: string; documentId: string };
  Body: { targetSpuIds?: unknown; spuId?: unknown; documentType?: unknown; expectedRevision?: unknown };
}>(
  "/api/batches/:batchId/documents/:documentId/spu-material-scope",
  async (request, reply) => {
    const batch = await getBatch(request.params.batchId);
    const document = batch?.documents.find((candidate) => candidate.id === request.params.documentId);
    if (!batch || !document) return reply.code(404).send({ error: "文档不存在或已过期" });
    const draft = document.reviewState.draft;
    const hasCanonicalChunks = Boolean(document.parsedDocumentV21 && draft && draft.chunks.every((chunk) => Array.isArray(chunk.sourceSegments)));
    if (!document.sourceContract || !hasCanonicalChunks || !draft)
      return reply.code(409).send({ error: "当前工作区缺少规范 Source Document 合同，只能只读查看", code: "LEGACY_WORKSPACE_READ_ONLY" });
    if (request.body?.expectedRevision !== undefined && Number(request.body.expectedRevision) !== (document.reviewRevision ?? 0))
      return reply.code(409).send({ error: "Draft 版本已变化，请重新加载", code: "REVIEW_REVISION_CONFLICT", reviewRevision: document.reviewRevision ?? 0 });
    if (!Array.isArray(request.body?.targetSpuIds))
      return reply.code(400).send({ error: "targetSpuIds 必须是字符串数组", code: "SPU_SCOPE_REQUIRED" });
    const targetSpuIds = [...new Set(request.body.targetSpuIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).map((id) => id.trim()))];
    if (!targetSpuIds.length) return reply.code(400).send({ error: "至少需要一个目标 SPU", code: "SPU_SCOPE_REQUIRED" });
    const unknownSpuId = await validateSpuScopeIds(targetSpuIds);
    if (unknownSpuId) return reply.code(409).send({ error: `SPU ${unknownSpuId} 不存在，请先创建或复用 SPU`, code: "SPU_NOT_FOUND", spuId: unknownSpuId });
    if (typeof request.body.documentType !== "string" || !SPU_DOCUMENT_TYPES.includes(request.body.documentType as SpuDocumentType))
      return reply.code(400).send({ error: "文档类型无效", code: "DOCUMENT_TYPE_REQUIRED", allowedDocumentTypes: [...SPU_DOCUMENT_TYPES] });
    const previousTargets = new Set(document.targetSpuIds ?? []);
    const scopeChanged = previousTargets.size !== targetSpuIds.length || targetSpuIds.some((id) => !previousTargets.has(id));
    document.targetSpuIds = targetSpuIds;
    document.pendingSpuIds = [...targetSpuIds];
    document.spuId = typeof request.body.spuId === "string" && targetSpuIds.includes(request.body.spuId.trim())
      ? request.body.spuId.trim()
      : targetSpuIds[0];
    document.spuDocumentType = request.body.documentType as SpuDocumentType;
    document.spuScopeStatus = "confirmed";
    document.spuScopeRevision = (document.spuScopeRevision ?? 0) + 1;
    for (const chunk of draft.chunks) {
      const scopedChunk = chunk as Chunk & { spuScopeOverride?: boolean };
      if (targetSpuIds.length === 1 && chunk.scope === "unassigned" && scopedChunk.spuScopeOverride !== true) {
        chunk.scope = "assigned";
        chunk.targetSpuIds = [...targetSpuIds];
        continue;
      }
      if (targetSpuIds.length === 1 && chunk.scope === "common" && scopedChunk.spuScopeOverride !== true) {
        chunk.scope = "assigned";
        chunk.targetSpuIds = [...targetSpuIds];
        continue;
      }
      if (scopeChanged && chunk.scope) {
        const validTargets = (chunk.targetSpuIds ?? []).filter((id) => targetSpuIds.includes(id));
        if ((chunk.scope === "assigned" || chunk.scope === "conflicted") && !validTargets.length) {
          chunk.scope = "unassigned";
          chunk.targetSpuIds = [];
        } else if (chunk.scope === "assigned" || chunk.scope === "conflicted") {
          chunk.targetSpuIds = validTargets;
        } else if (chunk.scope === "common" && (chunk.targetSpuIds ?? []).some((id) => !targetSpuIds.includes(id))) {
          chunk.targetSpuIds = validTargets;
        }
        continue;
      }
      if (chunk.scope) continue;
      // Ordinary Chunks inherit the document defaults; only explicit overrides carry a scope.
      chunk.scope = targetSpuIds.length === 1 ? "assigned" : "common";
      chunk.targetSpuIds = [...targetSpuIds];
    }
    await persistBatch(batch);
    return { targetSpuIds: [...targetSpuIds], spuId: document.spuId, documentType: document.spuDocumentType, scopeStatus: document.spuScopeStatus, scopeRevision: document.spuScopeRevision };
  },
);

app.put<{
  Params: { batchId: string; documentId: string; chunkId: string };
  Body: { scope?: unknown; targetSpuIds?: unknown; expectedRevision?: unknown };
}>(
  "/api/batches/:batchId/documents/:documentId/chunks/:chunkId/spu-scope",
  async (request, reply) => {
    const batch = await getBatch(request.params.batchId);
    const document = batch?.documents.find((candidate) => candidate.id === request.params.documentId);
    const chunk = document?.reviewState.draft?.chunks.find((candidate) => candidate.id === request.params.chunkId);
    if (!batch || !document || !chunk) return reply.code(404).send({ error: "Draft Chunk 不存在" });
    if (!document.sourceContract || !document.parsedDocumentV21 || !document.reviewState.draft)
      return reply.code(409).send({ error: "当前工作区缺少规范 Source Document 合同，只能只读查看", code: "LEGACY_WORKSPACE_READ_ONLY" });
    if (request.body?.expectedRevision !== undefined && Number(request.body.expectedRevision) !== (document.reviewRevision ?? 0))
      return reply.code(409).send({ error: "Draft 版本已变化，请重新加载", code: "REVIEW_REVISION_CONFLICT", reviewRevision: document.reviewRevision ?? 0 });
    const scope = request.body?.scope;
    if (scope !== "assigned" && scope !== "common" && scope !== "unassigned" && scope !== "conflicted")
      return reply.code(400).send({ error: "无效的 SPU scope", code: "SPU_SCOPE_INVALID" });
    const documentTargets = new Set((document.targetSpuIds ?? []).map((id) => id.trim()).filter(Boolean));
    if (document.spuScopeStatus !== "confirmed" || !documentTargets.size)
      return reply.code(409).send({ error: "请先确认文档级 SPU 范围", code: "SPU_SCOPE_NOT_CONFIRMED" });
    const rawTargets = request.body?.targetSpuIds;
    const targetSpuIds = Array.isArray(rawTargets)
      ? [...new Set(rawTargets.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).map((id) => id.trim()))]
      : [];
    const unknownSpuId = await validateSpuScopeIds(targetSpuIds);
    if (unknownSpuId) return reply.code(409).send({ error: `SPU ${unknownSpuId} 不存在，请先创建或复用 SPU`, code: "SPU_NOT_FOUND", spuId: unknownSpuId });
    if ((scope === "assigned" || scope === "conflicted") && !targetSpuIds.length)
      return reply.code(400).send({ error: `${scope} scope 需要 targetSpuIds`, code: "SPU_SCOPE_TARGETS_REQUIRED" });
    if (scope === "common" && targetSpuIds.some((id) => !documentTargets.has(id)))
      return reply.code(400).send({ error: "common scope 的目标 SPU 必须属于文档范围", code: "SPU_SCOPE_TARGETS_INVALID" });
    if ((scope === "assigned" || scope === "conflicted") && targetSpuIds.some((id) => !documentTargets.has(id)))
      return reply.code(400).send({ error: "Chunk 目标 SPU 必须属于文档范围", code: "SPU_SCOPE_TARGETS_INVALID" });
    chunk.scope = scope;
    chunk.targetSpuIds = targetSpuIds;
    (chunk as Chunk & { spuScopeOverride?: boolean }).spuScopeOverride = true;
    document.reviewRevision = (document.reviewRevision ?? 0) + 1;
    await persistBatch(batch);
    return { chunkId: chunk.id, scope: chunk.scope, targetSpuIds: [...targetSpuIds], reviewRevision: document.reviewRevision };
  },
);

app.get<{
  Params: { batchId: string; documentId: string; artifact: "markdown" | "manifest" };
  Querystring: { spuId?: string; exportVersion?: string };
}>(
  "/api/batches/:batchId/documents/:documentId/spu-material-export/:artifact",
  async (request, reply) => {
    if (request.params.artifact !== "markdown" && request.params.artifact !== "manifest")
      return reply.code(404).send({ error: "SPU 商品资料产物不存在" });
    const document = await getDocument(request.params.batchId, request.params.documentId);
    if (request.query.exportVersion && !request.query.spuId && document) {
      const matchingSpuIds = new Set((document.spuMaterialExports ?? [])
        .filter((entry) => entry.exportVersion === request.query.exportVersion)
        .map((entry) => entry.spuId));
      if (matchingSpuIds.size > 1)
        return reply.code(400).send({ error: "多 SPU 历史版本需要指定 spuId", code: "SPU_ID_REQUIRED_FOR_HISTORICAL_EXPORT" });
    }
    const historical = request.query.exportVersion
      ? document?.spuMaterialExports?.filter((entry) =>
          (!request.query.spuId || entry.spuId === request.query.spuId) && entry.exportVersion === request.query.exportVersion,
        ).at(-1)
      : undefined;
    const latest = historical ?? (request.query.spuId
      ? document?.spuMaterialCurrent?.[request.query.spuId] ?? document?.spuMaterialExports?.filter((entry) => entry.spuId === request.query.spuId).at(-1)
      : document?.spuMaterialExports?.at(-1));
    const reference = request.params.artifact === "markdown"
      ? latest?.markdownReference
      : latest?.manifestReference;
    if (!document || !latest || !reference || !assetObjectStore)
      return reply.code(404).send({ error: "SPU 商品资料产物不存在", code: "SPU_MATERIAL_EXPORT_NOT_FOUND" });
    try {
      const bytes = await assetObjectStore.get(reference.key);
      reply.type(request.params.artifact === "markdown" ? "text/markdown; charset=utf-8" : "application/json");
      if (request.params.artifact === "markdown")
        reply.header("content-disposition", `inline; filename="${reference.key.split("/").at(-1)}"`);
      return reply.send(bytes);
    } catch {
      return reply.code(404).send({ error: "SPU 商品资料产物不存在", code: "SPU_MATERIAL_EXPORT_NOT_FOUND" });
    }
  },
);

app.post<{
  Params: { batchId: string; documentId: string };
  Body: {
    spuId?: unknown;
    targetSpuIds?: unknown;
    documentType?: unknown;
    expectedRevision?: unknown;
    selectedChunkIds?: unknown;
    regenerate?: unknown;
  };
}>(
  "/api/batches/:batchId/documents/:documentId/spu-material-export",
  async (request, reply) => serializeSpuMaterialExport(
    `${request.params.batchId}:${request.params.documentId}`,
    async () => {
    const batch = await getBatch(request.params.batchId);
    const document = batch?.documents.find(
      (candidate) => candidate.id === request.params.documentId,
    );
    if (!batch || !document)
      return reply.code(404).send({ error: "文档不存在或已过期" });
    if (request.body?.selectedChunkIds !== undefined)
      return reply.code(400).send({
        error: "SPU 商品资料导出不接受 selectedChunkIds",
        code: "SELECTED_CHUNKS_NOT_SUPPORTED",
      });
    const draft = document.reviewState.draft;
    const hasCanonicalChunks = Boolean(
      document.parsedDocumentV21 &&
      draft &&
      draft.chunks.every((chunk) => Array.isArray(chunk.sourceSegments)),
    );
    if (!document.sourceContract || !hasCanonicalChunks || !draft)
      return reply.code(409).send({
        error: "当前工作区缺少规范 Source Document 合同，只能只读查看",
        code: "LEGACY_WORKSPACE_READ_ONLY",
      });
    if (typeof request.body?.spuId !== "string" || !request.body.spuId.trim())
      return reply.code(400).send({ error: "SPU 不能为空", code: "SPU_REQUIRED" });
    if (typeof request.body?.documentType !== "string" ||
        !SPU_DOCUMENT_TYPES.includes(request.body.documentType as SpuDocumentType))
      return reply.code(400).send({
        error: "文档类型无效",
        code: "DOCUMENT_TYPE_REQUIRED",
        allowedDocumentTypes: [...SPU_DOCUMENT_TYPES],
      });
    const currentRevision = document.reviewRevision ?? 0;
    if (request.body.expectedRevision !== undefined &&
        Number(request.body.expectedRevision) !== currentRevision)
      return reply.code(409).send({
        error: "Draft 版本已变化，请重新加载",
        code: "REVIEW_REVISION_CONFLICT",
        reviewRevision: currentRevision,
      });
    const requestedSpuId = request.body.spuId.trim();
    const requestedDocumentType = request.body.documentType as SpuDocumentType;
    if (document.spuDocumentType && requestedDocumentType !== document.spuDocumentType)
      return reply.code(409).send({ error: "文档类型必须使用已确认范围", code: "DOCUMENT_TYPE_FORGED" });
    const confirmedTargetSpuIds = [...new Set((document.targetSpuIds ?? []).map((id) => id.trim()).filter(Boolean))];
    if (document.spuScopeStatus !== "confirmed" || !confirmedTargetSpuIds.length)
      return reply.code(409).send({ error: "请先确认文档级 SPU 范围", code: "SPU_SCOPE_NOT_CONFIRMED" });
    const requestedTargetSpuIds = confirmedTargetSpuIds;
    if (Array.isArray(request.body.targetSpuIds)) {
      const proposed = [...new Set(request.body.targetSpuIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).map((id) => id.trim()))].sort();
      const confirmed = [...requestedTargetSpuIds].sort();
      if (proposed.length !== confirmed.length || proposed.some((id, index) => id !== confirmed[index]))
        return reply.code(409).send({ error: "targetSpuIds 必须使用服务端已确认的文档范围", code: "SPU_SCOPE_FORGED", targetSpuIds: requestedTargetSpuIds });
    }
    if (!requestedTargetSpuIds.includes(requestedSpuId))
      return reply.code(409).send({ error: "请求 SPU 不在服务端已确认范围内", code: "SPU_OUTSIDE_DOCUMENT_SCOPE", targetSpuIds: requestedTargetSpuIds });
    document.spuId = requestedSpuId;
    document.targetSpuIds = requestedTargetSpuIds;
    document.spuScopeStatus = "confirmed";
    document.spuDocumentType = requestedDocumentType;
    const sourceDocumentVersion = document.sourceContract.sourceDocumentVersion;
    const chunks = draft.chunks.map((chunk) => {
      const persisted = chunk as Chunk & {
        documentPublishEligible?: boolean;
        documentPublishExclusionReasons?: string[];
        reviewedModel?: ReviewedModel;
        tableRetrievalDraft?: Record<string, unknown>;
      };
      const sourceBlocks = new Map(document.parsedDocumentV21!.blocks.flatMap((block) => [
        [block.contentBlockId, block],
        ...(block.rawBlockId ? [[block.rawBlockId, block] as const] : []),
      ]));
      const parent = chunk.parentSectionId ? sourceBlocks.get(chunk.parentSectionId) : undefined;
      const table = persisted.reviewedModel?.type === "table"
        ? {
            ...(persisted.reviewedModel.title ? { title: persisted.reviewedModel.title } : {}),
            columns: [...persisted.reviewedModel.columns],
            rows: persisted.reviewedModel.rows.map((row) => row.map((cell) => cell.text)),
            ...(persisted.tableRetrievalDraft ? { tableVersion: structuredClone(persisted.tableRetrievalDraft) } : {}),
          }
        : undefined;
      const completed = new Set(ensureReviewProgress(document).completedChunkIds).has(chunk.id);
      const eligible = persisted.documentPublishEligible !== false && !chunk.excluded &&
        (Boolean(chunk.finalText.trim()) || Boolean(chunk.imageObjectReference));
      return {
        chunkId: chunk.id,
        finalText: chunk.finalText,
        reviewStatus: completed
          ? eligible ? "completed_published" as const : "completed_excluded" as const
          : "pending" as const,
        documentPublishEligible: eligible,
        documentPublishExclusionReasons: persisted.documentPublishExclusionReasons ??
          (eligible ? [] : [chunk.excluded ? "chunk_excluded" : "document_publish_ineligible"]),
        sourceSegments: chunk.sourceSegments,
        order: chunk.sourceSegments[0]?.page ?? undefined,
        ...(parent?.normalized?.type === "heading" ? { title: parent.normalized.text } : {}),
        imageAssetReference: chunk.imageObjectReference,
        ...(table ? { tableArtifact: table } : {}),
        scope: chunk.scope ?? "unassigned",
        targetSpuIds: chunk.targetSpuIds ?? [],
      };
    });
    const exportKey = createHash("sha256").update(JSON.stringify({
      spuId: requestedSpuId,
      targetSpuIds: [...requestedTargetSpuIds].sort(),
      documentType: requestedDocumentType,
      sourceDocumentVersion,
      reviewRevision: currentRevision,
      chunks: chunks.map((chunk) => ({
        chunkId: chunk.chunkId,
        finalText: chunk.finalText,
        reviewStatus: chunk.reviewStatus,
        eligible: chunk.documentPublishEligible,
        sourceSegments: chunk.sourceSegments,
        scope: chunk.scope,
        targetSpuIds: chunk.targetSpuIds,
        tableArtifact: chunk.tableArtifact,
        imageAssetReference: chunk.imageAssetReference,
        title: chunk.title,
      })),
    })).digest("hex");
    const reused = [...(document.spuMaterialExports ?? [])].reverse().find((entry) => entry.exportKey === exportKey);
    const reusedChildren = requestedTargetSpuIds.map((spuId) =>
      [...(document.spuMaterialExports ?? [])].reverse().find((entry) =>
        entry.exportKey === createHash("sha256").update(`${exportKey}:${spuId}:current`).digest("hex"),
      ),
    ).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    if (requestedTargetSpuIds.length === 1 && reused && reused.status !== "failed" && request.body?.regenerate !== true)
      return {
        reused: true,
        exportVersion: reused.exportVersion,
        status: reused.status,
        ...(reused.markdownReference ? { markdownKey: reused.markdownReference.key } : {}),
        ...(reused.manifestReference ? { manifestKey: reused.manifestReference.key } : {}),
        ...(reused.currentReference ? { currentKey: reused.currentReference.key } : {}),
        ...(reused.contentHash ? { contentHash: reused.contentHash } : {}),
      };
    if (requestedTargetSpuIds.length > 1 && reusedChildren.length === requestedTargetSpuIds.length &&
        reusedChildren.every((entry) => entry.status === "complete" || entry.status === "complete_with_exclusions") &&
        request.body?.regenerate !== true)
      return {
        reused: true,
        status: reusedChildren.some((entry) => entry.status === "blocked") ? "blocked" : reusedChildren.some((entry) => entry.status === "complete_with_exclusions") ? "complete_with_exclusions" : "complete",
        targetSpuIds: requestedTargetSpuIds,
        children: reusedChildren.map((entry) => ({
          spuId: entry.spuId,
          status: entry.status,
          exportVersion: entry.exportVersion,
          ...(entry.markdownReference ? { markdownKey: entry.markdownReference.key } : {}),
          ...(entry.manifestReference ? { manifestKey: entry.manifestReference.key } : {}),
          ...(entry.currentReference ? { currentKey: entry.currentReference.key } : {}),
          ...(entry.contentHash ? { contentHash: entry.contentHash } : {}),
        })),
      };
    if (!assetObjectStore)
      return reply.code(503).send({ error: "对象存储尚未配置，导出未持久化", code: "OBJECT_STORE_UNAVAILABLE" });
    const retryRecord = request.body?.regenerate !== true
      ? (reused?.status === "failed" ? reused : reusedChildren.find((entry) => entry.status === "failed"))
      : undefined;
    const exportSequence = retryRecord
      ? Number(retryRecord.exportVersion.replace(/^v/, ""))
      : Math.max(
      document.spuMaterialExportSequence ?? 0,
      0,
      ...(document.spuMaterialExports ?? [])
        .map((entry) => Number(entry.exportVersion.replace(/^v/, "")))
        .filter((value) => Number.isSafeInteger(value)),
    ) + 1;
    const exportVersion = `v${exportSequence}`;
    if (requestedTargetSpuIds.length > 1) {
      const fanout = createSpuMaterialFanout({
        batchId: batch.id,
        documentId: document.id,
        sourceDocumentVersion,
        sourceName: document.name,
        documentType: requestedDocumentType,
        reviewRevision: currentRevision,
        exportVersion,
        generatedAt: new Date().toISOString(),
        targetSpuIds: requestedTargetSpuIds,
        chunks,
      });
      const children: Array<Record<string, unknown>> = [];
      for (const child of fanout.results) {
        const childExportKey = createHash("sha256").update(
          `${exportKey}:${child.spuId}:${request.body?.regenerate === true ? exportVersion : "current"}`,
        ).digest("hex");
        const existingChild = request.body?.regenerate !== true
          ? [...(document.spuMaterialExports ?? [])].reverse().find((entry) => entry.exportKey === childExportKey)
          : undefined;
        if (request.body?.regenerate !== true && existingChild &&
            (existingChild.status === "complete" || existingChild.status === "complete_with_exclusions")) {
          children.push({
            spuId: existingChild.spuId,
            status: existingChild.status,
            exportVersion: existingChild.exportVersion,
            ...(existingChild.markdownReference ? { markdownKey: existingChild.markdownReference.key } : {}),
            ...(existingChild.manifestReference ? { manifestKey: existingChild.manifestReference.key } : {}),
            ...(existingChild.currentReference ? { currentKey: existingChild.currentReference.key } : {}),
            ...(existingChild.contentHash ? { contentHash: existingChild.contentHash } : {}),
            reused: true,
          });
          continue;
        }
        if (child.status === "blocked") {
          const record = {
              exportKey: childExportKey,
              spuId: child.spuId,
              documentType: requestedDocumentType,
              sourceDocumentVersion,
              reviewRevision: currentRevision,
              exportVersion,
              status: "blocked" as const,
              blockedChunkIds: [...child.blockedChunkIds],
              reason: child.reason,
              generatedAt: new Date().toISOString(),
            } satisfies NonNullable<DocumentRecord["spuMaterialExports"]>[number];
          document.spuMaterialExports = [
            ...(document.spuMaterialExports ?? []),
            record,
          ];
          document.spuMaterialExportSequence = exportSequence;
          await persistBatch(batch);
          children.push({ spuId: child.spuId, status: child.status, exportVersion, blockedChunkIds: child.blockedChunkIds, reason: child.reason });
          continue;
        }
        let references: Awaited<ReturnType<typeof writeSpuMaterialExportObjects>>;
        try {
          references = await writeSpuMaterialExportObjects({
            batch,
            document,
            spuId: child.spuId,
            documentType: requestedDocumentType,
            sourceDocumentVersion,
            exported: child,
          });
        } catch (error) {
          const failed = {
            exportKey: childExportKey,
            spuId: child.spuId,
            documentType: requestedDocumentType,
            sourceDocumentVersion,
            reviewRevision: currentRevision,
            exportVersion,
            status: "failed" as const,
            reason: error instanceof Error ? error.message : "对象存储写入失败",
            generatedAt: new Date().toISOString(),
          } satisfies NonNullable<DocumentRecord["spuMaterialExports"]>[number];
          document.spuMaterialExports = [...(document.spuMaterialExports ?? []), failed];
          document.spuMaterialExportSequence = exportSequence;
          await persistBatch(batch);
          children.push({ spuId: child.spuId, status: "failed", exportVersion, reason: failed.reason });
          continue;
        }
        const { markdownReference, manifestReference, currentReference } = references;
        const record = {
            exportKey: childExportKey,
            spuId: child.spuId,
            documentType: requestedDocumentType,
            sourceDocumentVersion,
            reviewRevision: currentRevision,
            exportVersion,
            status: child.status,
            markdownReference,
            manifestReference,
            currentReference,
            contentHash: child.contentHash,
            generatedAt: child.manifest.generatedAt,
          } satisfies NonNullable<DocumentRecord["spuMaterialExports"]>[number];
        document.spuMaterialExports = [...(document.spuMaterialExports ?? []), record];
        document.spuMaterialCurrent = {
          ...(document.spuMaterialCurrent ?? {}),
          [child.spuId]: { ...record, updatedAt: child.manifest.generatedAt },
        };
        document.spuMaterialExportSequence = exportSequence;
        await persistBatch(batch);
        children.push({ spuId: child.spuId, status: child.status, exportVersion, markdownKey: markdownReference.key, manifestKey: manifestReference.key, currentKey: currentReference.key, contentHash: child.contentHash });
      }
      const status = children.some((child) => child.status === "failed")
        ? "partial_failure"
        : fanout.status;
      return { reused: false, status, targetSpuIds: requestedTargetSpuIds, children };
    }
    let generated: SpuMaterialExport;
    try {
      generated = createSpuMaterialExport({
        batchId: batch.id,
        documentId: document.id,
        sourceDocumentVersion,
        sourceName: document.name,
        spuId: requestedSpuId,
        documentType: requestedDocumentType,
        reviewRevision: currentRevision,
        chunks,
        exportVersion,
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : "SPU 商品资料导出被阻断",
        code: "SPU_MATERIAL_EXPORT_BLOCKED",
      });
    }
    try {
      const { markdownReference, manifestReference, currentReference } = await writeSpuMaterialExportObjects({
        batch,
        document,
        spuId: requestedSpuId,
        documentType: requestedDocumentType,
        sourceDocumentVersion,
        exported: generated,
      });
      const record = {
        exportKey,
        spuId: requestedSpuId,
        documentType: requestedDocumentType,
        sourceDocumentVersion,
        reviewRevision: currentRevision,
        exportVersion,
        status: generated.status,
        markdownReference,
        manifestReference,
        currentReference,
        contentHash: generated.contentHash,
        generatedAt: generated.manifest.generatedAt,
      } satisfies NonNullable<DocumentRecord["spuMaterialExports"]>[number];
      document.spuMaterialExports = [...(document.spuMaterialExports ?? []), record];
      document.spuMaterialCurrent = {
        ...(document.spuMaterialCurrent ?? {}),
        [requestedSpuId]: { ...record, updatedAt: generated.manifest.generatedAt },
      };
      document.spuMaterialExportSequence = exportSequence;
      await persistBatch(batch);
      return {
        reused: false,
        exportVersion,
        status: generated.status,
        markdownKey: markdownReference.key,
        manifestKey: manifestReference.key,
        currentKey: currentReference.key,
        contentHash: generated.contentHash,
      };
    } catch (error) {
      const failed = {
        exportKey,
        spuId: requestedSpuId,
        documentType: requestedDocumentType,
        sourceDocumentVersion,
        reviewRevision: currentRevision,
        exportVersion,
        status: "failed" as const,
        reason: error instanceof Error ? error.message : "对象存储写入失败",
        generatedAt: new Date().toISOString(),
      } satisfies NonNullable<DocumentRecord["spuMaterialExports"]>[number];
      document.spuMaterialExports = [...(document.spuMaterialExports ?? []), failed];
      document.spuMaterialExportSequence = exportSequence;
      await persistBatch(batch);
      return reply.code(502).send({
        error: error instanceof Error ? error.message : "SPU 商品资料写入对象存储失败",
        code: "SPU_MATERIAL_OBJECT_WRITE_FAILED",
      });
    }
    },
  ),
);

app.get<{
  Params: { batchId: string };
  Querystring: { documentId?: string; includeDeleted?: string };
}>("/api/batches/:batchId/objects", async (request, reply) => {
  const batch = await getBatch(request.params.batchId);
  if (!batch) return reply.code(404).send({ error: "批次不存在或已过期" });
  if (!assetObjectStore)
    return reply.code(503).send({ error: "对象存储尚未配置" });
  const objects = await assetObjectStore.list({
    batchId: batch.id,
    ...(request.query.documentId ? { documentId: request.query.documentId } : {}),
    includeDeleted: request.query.includeDeleted === "true",
  });
  return { contractVersion: "1.0", objects };
});

app.get<{
  Params: { batchId: string };
  Querystring: { key?: string };
}>("/api/batches/:batchId/objects/head", async (request, reply) => {
  const batch = await getBatch(request.params.batchId);
  if (!batch) return reply.code(404).send({ error: "批次不存在或已过期" });
  if (!assetObjectStore || typeof request.query.key !== "string")
    return reply.code(400).send({ error: "缺少对象 key" });
  const object = await assetObjectStore.head(request.query.key);
  if (!object || object.batchId !== batch.id)
    return reply.code(404).send({ error: "对象不存在" });
  return { object };
});

if (process.env.NODE_ENV !== "production")
  app.post<{ Body: { pages?: unknown; diagnosticCategory?: unknown; tableScenario?: unknown; imageScenario?: unknown; sourceKind?: unknown } }>("/api/demo", async (request) => {
    const batchId = `demo-${randomUUID()}`;
    const documentId = randomUUID();
    const requestedPages = Number(request.body?.pages);
    const pages = Number.isInteger(requestedPages)
      ? Math.min(200, Math.max(2, requestedPages))
      : 2;
    const blocks = request.body?.tableScenario === "cross-page"
      ? crossPageTableDemoBlocks()
      : demoBlocks(pages, request.body?.imageScenario === "three" ? 3 : 1);
    const sourceIsImage = request.body?.sourceKind === "image";
    const sourcePath = sourceIsImage
      ? resolve("qa/fixtures/demo-source.png")
      : resolve("qa/v21-source-sample.pdf");
    const sourceDocumentVersion = await sourceVersionFromFile(sourcePath);
    const parsedDocumentV21 = buildMineruParsedDocument(
      blocks.map((block) => ({
        id: block.id,
        type: block.type === "table" ? "table" : block.type === "image" ? "image" : block.role === "heading" ? "title" : "text",
        text: block.text,
        page_idx: (block.page ?? 1) - 1,
        ...(block.type === "table"
          ? { table_body: demoTableHtml(block.text) }
          : {}),
      })),
      { sourceDocumentVersion, parserVersion: "mineru-demo-v2.1" },
    );
    const exactDemoBlock: ParsedDocumentBlock = parsedDocumentV21.blocks[0];
    exactDemoBlock.sourceLocation = {
      sourceViewKind: "original_file",
      page: 1,
      bbox: [72, 60, 540, 92],
      locationQuality: "exact",
      bboxEvidence: {
        page: 1,
        pageWidth: 595,
        pageHeight: 842,
        coordinateUnit: "pdf_point",
        coordinateOrigin: "top-left",
        orientation: 0,
        transform: [1, 0, 0, 1, 0, 0],
        mappingVersion: "qa-pdf-points-v1",
        sourceDocumentVersion,
      },
    };
    const imageBlocks = blocks.flatMap((block, index) =>
      block.type === "image" ? [{ block, index }] : []
    );
    imageBlocks.forEach(({ block, index }, imageIndex) => {
      const exactImageBlock = parsedDocumentV21.blocks[index];
      exactImageBlock.sourceLocation = {
        sourceViewKind: "original_file",
        page: 2,
        bbox: imageIndex === 0
          ? [315.35, 589.4, 547.4, 825.16]
          : imageIndex === 1
            ? [48, 590, 280, 705]
            : [48, 710, 280, 825],
        locationQuality: "exact",
        bboxEvidence: {
          page: 2,
          pageWidth: 595,
          pageHeight: 842,
          coordinateUnit: "pdf_point",
          coordinateOrigin: "top-left",
          orientation: 0,
          transform: [1, 0, 0, 1, 0, 0],
          mediaBox: [0, 0, 595, 842],
          cropBox: [0, 0, 595, 842],
          mappingVersion: "qa-pdf-points-v1",
          sourceDocumentVersion,
        },
      };
      block.bbox = [...exactImageBlock.sourceLocation.bbox!];
    });
    const preview = await buildV21Preview(
      parsedDocumentV21,
      parseChunkRequest({}),
      undefined,
      { tableGroupIds: tableGroupIdsFor(parsedDocumentV21, blocks) },
    );
    preview.chunks = markContextCandidates(preview.chunks);
    const document: DocumentRecord = {
      id: documentId,
      name: sourceIsImage
        ? "image-product_4x3.jpg"
        : "A1-智能料理机说明书-demo.pdf",
      state: "done",
      blocks,
      parsedDocumentV21,
      sourceAsset: {
        path: sourcePath,
        mimeType: sourceIsImage ? "image/jpeg" : "application/pdf",
      },
      sourceContract: {
        sourceDocumentVersion,
        parseRoute: "mineru",
        parseState: "done",
        parseJobId: "sanitized-demo",
        sourceViewKind: "original_file",
        visualCopy: { state: "not_requested" },
        downstreamAvailable: true,
      },
      ...(sourceIsImage
        ? {}
        : {
            sourceMapping: {
              mappingVersion: "qa-pdf-points-v1",
              sourceDocumentVersion,
              pages: [1, 2].map((page) => ({
                page,
                pageWidth: 595,
                pageHeight: 842,
                coordinateUnit: "pdf_point" as const,
                coordinateOrigin: "top-left" as const,
                orientation: 0,
                transform: [1, 0, 0, 1, 0, 0],
                mediaBox: [0, 0, 595, 842],
                cropBox: [0, 0, 595, 842],
              })),
            },
          }),
      reviewState: setPreview(createReviewState(), preview, parseChunkRequest({})),
    };
    if (
      request.body?.diagnosticCategory === "parse_failed" ||
      request.body?.diagnosticCategory === "mineru_result_anomaly"
    ) {
      document.state = "failed";
      document.error = request.body.diagnosticCategory === "parse_failed"
        ? "解析失败：上游服务不可用"
        : "MinerU 结果 ZIP 异常：无法读取结构化结果";
      document.diagnosticCategories = [request.body.diagnosticCategory];
      document.rawContentList = [{
        type: "text",
        page_idx: 0,
        text: "诊断夹具 https://signed.demo.invalid/result",
        nested: {
          headers: { Cookie: "session=demo-cookie" },
          api_key: "demo-api-key",
          safeParserField: "preserved",
        },
      }];
    }
    if (request.body?.diagnosticCategory === "bbox_page_anomaly")
      document.rawContentList = [{
        type: "text",
        page_idx: 99,
        bbox: [0, 0, 900, 100],
        text: "坐标异常 https://bbox.demo.invalid/private",
      }];
    if (request.body?.diagnosticCategory === "visual_conversion_failed") {
      document.sourceContract!.visualCopy = {
        state: "failed",
        error: "Visual Copy 失败：https://converter.demo.invalid/private",
        qualityFlag: "visual_copy_unavailable",
      };
      document.rawContentList = [{
        type: "text",
        page_idx: 0,
        text: "Visual Copy 诊断夹具 Cookie: session=visual-secret",
      }];
    }
    const batch: BatchRecord = { id: batchId, documents: [document] };
    batches.set(batchId, batch);
    await persistBatch(batch);
    return { ...publicBatch(batch), demo: true };
  });

app.post("/api/batches", async (request, reply) => {
  const saved = await request.saveRequestFiles();
  const uploads = saved.files;
  if (!uploads.length)
    return reply.code(400).send({ error: "至少上传一个文件" });
  const configField = saved.values.config;
  const rawConfig = fieldValue(configField);
  const config = parseConfig(typeof rawConfig === "string" ? rawConfig : "{}");
  const batch: BatchRecord = {
    id: randomUUID(),
    documents: uploads.map((file) => ({
      id: randomUUID(),
      name: file.filename,
      state: "pending",
      parseConfig: config,
      reviewState: createReviewState(),
    })),
  };
  const mineruFiles: Array<{
    id: string;
    name: string;
    path: string;
    cacheKey: { contentSha256: string; parserConfigFingerprint: string };
  }> = [];
  const visualCopyTasks: Promise<void>[] = [];
  for (const [index, upload] of uploads.entries()) {
    const document = batch.documents[index];
    let classification;
    try {
      classification = classifySource(upload.filename);
    } catch (error) {
      document.state = "failed";
      document.error = error instanceof Error ? error.message : "不支持的文件格式";
      continue;
    }
    if (!assetObjectStore) {
      document.state = "failed";
      document.error = "对象存储尚未配置，原始文件未持久化";
      document.diagnosticCategories = ["parse_failed"];
      continue;
    }
    const uploadBytes = new Uint8Array(await readFile(upload.filepath));
    document.contentSha256 = createHash("sha256").update(uploadBytes).digest("hex");
    const sourceDocumentVersion = await sourceVersionFromFile(upload.filepath);
    try {
      const sourceObject = await assetObjectStore.put({
        assetClass: "source_original",
        bytes: uploadBytes,
        contentType: upload.mimetype || contentTypeForName(upload.filename),
        batchId: batch.id,
        documentId: document.id,
        sourceDocumentVersion,
        assetVersion: "original-v1",
        extension: extensionForName(upload.filename),
      });
      const runtimeSourcePath = assetObjectStore instanceof MemoryAssetObjectStore
        ? await workspaceStore.saveAsset(
            batch.id,
            document.id,
            upload.filename,
            upload.filepath,
          )
        : upload.filepath;
      document.sourceAsset = {
        path: runtimeSourcePath,
        mimeType: upload.mimetype || contentTypeForName(upload.filename),
        objectReference: sourceObject.reference,
      };
    } catch {
      document.state = "failed";
      document.error = "原始文件写入对象存储失败";
      document.diagnosticCategories = ["parse_failed"];
      continue;
    }
    if (upload.mimetype === "application/pdf" || /\.pdf$/i.test(upload.filename))
      document.sourceMapping = await sourceMappingFromPdf(
        upload.filepath,
        sourceDocumentVersion,
        upload.filename,
      );
    document.sourceContract = {
      sourceDocumentVersion,
      parseRoute: classification.parseRoute,
      parseState: classification.parseRoute === "local" ? "done" : "pending",
      parseJobId: null,
      sourceViewKind: classification.preferredSourceViewKind,
      visualCopy: classification.requiresVisualCopy
        ? beginVisualCopy(randomUUID())
        : { state: "not_requested" },
      downstreamAvailable: true,
    };
    if (classification.parseRoute === "local") {
      document.markdown = await readFile(upload.filepath, "utf8");
      document.blocks = markdownBlocks(document.markdown);
      document.parsedDocumentV21 = buildLocalParsedDocument(document.markdown, {
        kind: classification.extension === ".md" ? "markdown" : "txt",
        sourceDocumentVersion,
        parserVersion:
          classification.extension === ".md"
            ? "commonmark-0.31.2"
            : "txt-v2.1",
      });
      document.state = "done";
    } else {
      if (!parseCacheService) throw new Error("Parse cache is unavailable");
      const decision = await parseCacheService.decide(uploadBytes, config);
      document.contentSha256 = decision.contentSha256;
      document.parserConfigFingerprint = decision.parserConfigFingerprint;
      document.parseCacheKey = {
        contentSha256: decision.contentSha256,
        parserConfigFingerprint: decision.parserConfigFingerprint,
      };
      document.parseCacheStatus = decision.record.status;
      if (decision.kind === "succeeded") {
        document.parseCacheReused = true;
        await applySucceededParseCache(document, decision.record);
      } else if (decision.kind === "in_flight") {
        document.sourceContract.parseJobId = decision.record.mineruBatchId;
        document.parseCacheStatus = decision.record.status;
        if (decision.record.mineruBatchId)
          batch.mineruBatchIds = mineruBatchIdsFor(batch, decision.record.mineruBatchId);
      } else {
        mineruFiles.push({
          id: document.id,
          name: upload.filename,
          path: upload.filepath,
          cacheKey: document.parseCacheKey,
        });
      }
      if (classification.requiresVisualCopy)
        visualCopyTasks.push(generateVisualCopy(document, upload.filepath));
    }
  }
  if (mineruFiles.length) {
    try {
      const submission = await submitMineruBatch(
        token,
        mineruFiles,
        config,
        (kind, response) => recordMineruResponse(batch, kind, response),
      );
      if (submission.uploadedDocumentIds.length)
        batch.mineruBatchIds = [submission.batchId];
      const uploadedIds = new Set(submission.uploadedDocumentIds);
      for (const document of batch.documents) {
        const file = mineruFiles.find((candidate) => candidate.id === document.id);
        if (uploadedIds.has(document.id) && document.sourceContract && file) {
          const record = await parseCacheService!.setProcessing(
            file.cacheKey,
            submission.batchId,
            document.id,
          );
          document.parseCacheStatus = record.status;
          document.parseCacheKey = file.cacheKey;
          document.sourceContract.parseJobId = submission.batchId;
          document.parseStartedAt = new Date().toISOString();
          for (const waiting of batch.documents.filter((candidate) =>
            candidate !== document &&
            candidate.parseCacheKey &&
            candidate.parseCacheKey.contentSha256 === file.cacheKey.contentSha256 &&
            candidate.parseCacheKey.parserConfigFingerprint === file.cacheKey.parserConfigFingerprint
          )) {
            waiting.sourceContract!.parseJobId = submission.batchId;
            waiting.parseCacheStatus = "processing";
            waiting.parseStartedAt = document.parseStartedAt;
          }
          continue;
        }
        const failure = submission.failures.find(
          (candidate) => candidate.documentId === document.id,
        );
        if (failure) {
          document.state = "failed";
          document.error = failure.error;
          document.diagnosticCategories = ["parse_failed"];
          if (document.parseCacheKey && parseCacheService) {
            const record = await parseCacheService.fail(document.parseCacheKey, document.error);
            document.parseCacheStatus = record.status;
          }
        }
      }
      } catch {
        app.log.warn({ documentCount: mineruFiles.length }, "MinerU submission failed");
        for (const file of mineruFiles) {
          const document = batch.documents.find((candidate) => candidate.id === file.id);
          if (document) {
          document.state = "failed";
            document.error = "MinerU 提交失败，请重试";
            document.diagnosticCategories = ["parse_failed"];
            if (document.parseCacheKey && parseCacheService) {
              const record = await parseCacheService.fail(document.parseCacheKey, document.error);
              document.parseCacheStatus = record.status;
            }
          }
        }
    }
  }
  await Promise.all(visualCopyTasks);
  batches.set(batch.id, batch);
  await persistBatch(batch);
  return reply.code(202).send(publicBatch(batch));
});

app.get<{ Params: { batchId: string } }>(
  "/api/batches/:batchId",
  async (request, reply) => {
    const batch = await getBatch(request.params.batchId);
    if (!batch) return reply.code(404).send({ error: "批次不存在或已过期" });
    if (parseCacheService) {
      for (const document of batch.documents) {
        if (!document.parseCacheKey) continue;
        const cached = await parseCacheService.get(document.parseCacheKey);
        if (!cached) continue;
        document.parseCacheStatus = cached.status;
        if (cached.status === "succeeded" && document.state !== "done" && !document.parseCacheReused)
          await applySucceededParseCache(document, cached);
        if (cached.mineruBatchId) {
          if (document.sourceContract) document.sourceContract.parseJobId = cached.mineruBatchId;
          batch.mineruBatchIds = mineruBatchIdsFor(batch, cached.mineruBatchId);
        }
      }
    }
    const mineruBatchIds = mineruBatchIdsFor(batch);
    if (mineruBatchIds.length) {
      for (const mineruBatchId of mineruBatchIds) {
        const activeDocuments = batch.documents.filter(
          (document) =>
            document.sourceContract?.parseJobId === mineruBatchId &&
            (document.state === "pending" || document.state === "running"),
        );
        if (!activeDocuments.length) continue;
        try {
          const results = await getMineruBatch(
            token,
            mineruBatchId,
            (kind, response) => recordMineruResponse(batch, kind, response),
          );
          for (const result of results) {
            const targets: DocumentRecord[] = [];
            for (const document of activeDocuments) {
              if (document.id === result.data_id || document.name === result.file_name) {
                targets.push(document);
                continue;
              }
              if (document.parseCacheKey &&
                (await parseCacheService?.get(document.parseCacheKey))?.mineruDocumentId === result.data_id)
                targets.push(document);
            }
            const owner = targets[0];
            if (!owner) continue;
            await applyMineruResults(
              [owner],
              [{ ...result, data_id: owner.id }],
              (url, document) => downloadMineruResult(url, {
                onZip: async (bytes) => {
                  if (!assetObjectStore) throw new Error("object store unavailable");
                  (document as DocumentRecord).mineruZipAsset = (await assetObjectStore.put({
                    assetClass: "mineru_result_zip",
                    bytes,
                    contentType: "application/zip",
                    ...cacheAssetIdentity(document as DocumentRecord),
                    sourceDocumentVersion:
                      (document as DocumentRecord).sourceContract?.sourceDocumentVersion,
                    assetVersion: `mineru-${mineruBatchId}`,
                    extension: "zip",
                  })).reference;
                },
                onTrustedResult: async (trusted) => {
                  if (!assetObjectStore) throw new Error("object store unavailable");
                  const target = document as DocumentRecord;
                  target.trustedResultAsset = (await putJsonAsset(assetObjectStore, {
                    assetClass: "mineru_trusted_result",
                    value: trusted,
                    ...cacheAssetIdentity(target),
                    sourceDocumentVersion: target.sourceContract?.sourceDocumentVersion,
                    assetVersion: "normalized-result-v1",
                  })).reference;
                  target.contentListAsset = target.trustedResultAsset;
                },
              }),
            );
            for (const duplicate of targets.slice(1)) {
              copyParsedResult(owner, duplicate);
            }
            if (owner.parseCacheKey && parseCacheService) {
              if (owner.state === "done") {
                hydrateMineruV21(owner);
                await persistDocumentObjects(batch.id, owner);
                if (owner.parsedDocumentAsset) {
                  const completed = await parseCacheService.succeed(
                    owner.parseCacheKey,
                    owner.parsedDocumentAsset,
                    owner.mineruZipAsset ?? null,
                    owner.trustedResultAsset ?? null,
                  );
                  owner.parseCacheStatus = completed.status;
                }
              } else if (owner.state === "failed") {
                await parseCacheService.fail(owner.parseCacheKey, owner.error ?? "MinerU 解析失败");
              }
            }
          }
        } catch {
          app.log.warn(
            { documentCount: activeDocuments.length },
            "MinerU polling failed",
          );
        }
      }
      await expireTimedOutDocuments(batch);
      for (const document of batch.documents) hydrateMineruV21(document);
      await persistBatch(batch);
    }
    return publicBatch(batch);
  },
);

app.post<{ Params: { batchId: string; documentId: string } }>(
  "/api/batches/:batchId/documents/:documentId/reparse",
  async (request, reply) => {
    const batch = await getBatch(request.params.batchId);
    const document = batch?.documents.find(
      (candidate) => candidate.id === request.params.documentId,
    );
    if (!batch || !document)
      return reply.code(404).send({ error: "文档不存在或已过期" });
    if (!document.sourceAsset)
      return reply.code(409).send({ error: "原始文件不可用，无法重新解析" });
    const materialized = await materializeAsset(document.sourceAsset, document.name);
    try {
    if (/\.(md|txt)$/i.test(document.name)) {
      resetDocumentForReparse(document);
      document.markdown = await readFile(materialized.path, "utf8");
      document.blocks = markdownBlocks(document.markdown);
      document.parsedDocumentV21 = buildLocalParsedDocument(document.markdown, {
        kind: /\.md$/i.test(document.name) ? "markdown" : "txt",
        sourceDocumentVersion:
          document.sourceContract?.sourceDocumentVersion ??
          (await sourceVersionFromFile(materialized.path)),
        parserVersion: /\.md$/i.test(document.name)
          ? "commonmark-0.31.2"
          : "txt-v2.1",
      });
      document.state = "done";
    } else {
      const parseConfig = document.parseConfig ?? parseConfigDefaults();
      resetDocumentForReparse(document);
      try {
        const submission = await submitMineruBatch(
          token,
          [{ id: document.id, name: document.name, path: materialized.path }],
          parseConfig,
          (kind, response) => recordMineruResponse(batch, kind, response),
        );
        if (submission.uploadedDocumentIds.includes(document.id)) {
          batch.mineruBatchIds = mineruBatchIdsFor(batch, submission.batchId);
          if (document.sourceContract)
            document.sourceContract.parseJobId = submission.batchId;
          if (document.parseCacheKey && parseCacheService) {
            const record = await parseCacheService.setProcessing(
              document.parseCacheKey,
              submission.batchId,
              document.id,
            );
            document.parseCacheStatus = record.status;
          }
          document.parseStartedAt = new Date().toISOString();
        } else {
          document.state = "failed";
          document.error = submission.failures[0]?.error ?? "MinerU upload failed";
          document.diagnosticCategories = ["parse_failed"];
        }
      } catch {
        app.log.warn({ documentId: document.id }, "MinerU reparse submission failed");
        document.state = "failed";
        document.error = "MinerU 提交失败，请重试";
        document.diagnosticCategories = ["parse_failed"];
      }
    }
    await persistBatch(batch);
    return reply.code(202).send(publicBatch(batch));
    } finally {
      await materialized.cleanup();
    }
  },
);

app.post<{ Params: { batchId: string; documentId: string } }>(
  "/api/batches/:batchId/documents/:documentId/visual-copy/retry",
  async (request, reply) => {
    const batch = await getBatch(request.params.batchId);
    const document = batch?.documents.find(
      (candidate) => candidate.id === request.params.documentId,
    );
    if (!batch || !document)
      return reply.code(404).send({ error: "文档不存在或已过期" });
    if (!document.sourceAsset || !document.sourceContract)
      return reply.code(409).send({ error: "原始文件不可用" });
    if (!classifySource(document.name).requiresVisualCopy)
      return reply.code(409).send({ error: "该文件不需要 Visual Copy" });
    document.sourceContract.visualCopy = beginVisualCopy(randomUUID());
    await persistBatch(batch);
    await generateVisualCopy(document);
    await persistBatch(batch);
    return reply.code(202).send(publicBatch(batch));
  },
);

app.post<{
  Params: { batchId: string; documentId: string };
  Body: { query?: unknown; relevantChunkIds?: unknown; k?: unknown };
}>(
  "/api/batches/:batchId/documents/:documentId/retrieval-tests",
  async (request, reply) => {
    const batch = await getBatch(request.params.batchId);
    const document = batch?.documents.find((candidate) => candidate.id === request.params.documentId);
    if (!batch || !document?.reviewState.draft)
      return reply.code(404).send({ error: "Draft 文档不存在或已过期" });
    const query = typeof request.body?.query === "string" ? request.body.query.trim() : "";
    const relevantChunkIds = Array.isArray(request.body?.relevantChunkIds)
      ? [...new Set(request.body.relevantChunkIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).map((id) => id.trim()))]
      : [];
    const k = Number(request.body?.k);
    if (!query) return reply.code(400).send({ error: "检索测试查询不能为空" });
    if (!relevantChunkIds.length) return reply.code(400).send({ error: "请至少标注一个相关 Chunk" });
    if (!Number.isSafeInteger(k) || k < 1 || k > 100)
      return reply.code(400).send({ error: "K 必须是 1 到 100 的整数" });
    const databaseJob = document.databaseJobs?.at(-1);
    const embeddingJob = databaseJob
      ? document.embeddingJobs?.find((job) => job.id === databaseJob.embeddingJobId)
      : undefined;
    const profile = embeddingJob
      ? embeddingProfiles.find((candidate) => candidate.id === embeddingJob.profileId)
      : undefined;
    if (!databaseJob || !embeddingJob || !profile)
      return reply.code(409).send({ error: "请先完成 Embedding 和数据库入库" });
    const indexedIds = new Set(databaseJob.items
      .filter((item) => item.status === "written" || item.status === "unchanged")
      .map((item) => item.chunkId));
    const records = embeddingJob.items.flatMap((item) =>
      item.status === "succeeded" && item.vectorRecord && indexedIds.has(item.chunkId)
        ? [{ chunkId: item.chunkId, vector: item.vectorRecord.vector }]
        : []);
    if (!records.length) return reply.code(409).send({ error: "当前入库版本没有可检索向量" });
    try {
      const [queryVector] = await profile.embed([query]);
      if (!queryVector || queryVector.length !== profile.dimensions)
        return reply.code(502).send({ error: "检索查询向量维度不匹配" });
      const evaluation = evaluateRecallAtK({ queryVector, records, relevantChunkIds, k });
      const databaseProfile = databaseProfiles.find((candidate) => candidate.id === databaseJob.profileId)!;
      const stored = await databaseProfile.repository.list(databaseProfile.targetId, document.id);
      const chunks = new Map(stored.map((record) => [record.chunkId, record]));
      return {
        ...evaluation,
        query,
        embeddingProfileId: profile.id,
        embeddingModel: profile.model,
        indexVersion: databaseJob.id,
        databaseProfileId: databaseJob.profileId,
        testedAt: new Date().toISOString(),
        dataScope: {
          batchId: batch.id,
          documentId: document.id,
          indexedRecordCount: records.length,
          draftChunkCount: document.reviewState.draft.chunks.length,
        },
        results: evaluation.results.map((result) => ({
          ...result,
          relevant: relevantChunkIds.includes(result.chunkId),
          text: chunks.get(result.chunkId)?.finalText ?? "",
          parentChunk: chunks.get(result.chunkId)?.contentPayload.parentChunk ?? null,
        })),
      };
    } catch {
      return reply.code(502).send({ error: "检索测试未获得可用查询向量" });
    }
  },
);

app.post<{
  Params: { batchId: string; documentId: string };
  Body: Partial<ChunkRequest>;
}>(
  "/api/batches/:batchId/documents/:documentId/chunk-configuration",
  async (request, reply) => {
    const batch = await getBatch(request.params.batchId);
    const document = batch?.documents.find(
      (candidate) => candidate.id === request.params.documentId,
    );
    if (!batch || !document)
      return reply.code(404).send({ error: "文档不存在或已过期" });
    const configuration = parseChunkRequest(request.body);
    document.previewGateState = updateConfigurationDraft(
      ensurePreviewGate(document, configuration),
      configuration,
    );
    await persistBatch(batch);
    return {
      configurationFingerprint:
        document.previewGateState.configurationDraft.fingerprint,
      previewExpired: document.previewGateState.preview?.expired ?? false,
    };
  },
);

app.post<{
  Params: { batchId: string; documentId: string };
  Body: {
    scope?: "page" | "document";
    page?: number;
    selectedAnnotationIds?: string[];
    effectiveAnnotations?: EffectiveManualAnnotation[];
    suppressedSourceBlockIds?: string[];
    previousChunks?: Chunk[];
    imagePolicy?: "summary" | "reference" | "exclude";
    sourceDocumentVersion?: string;
    parsedDocumentVersion?: string;
  };
}>(
  "/api/batches/:batchId/documents/:documentId/manual-chunks",
  async (request, reply) => {
    const batch = await getBatch(request.params.batchId);
    const document = batch?.documents.find(
      (candidate) => candidate.id === request.params.documentId,
    );
    if (!batch || !document)
      return reply.code(404).send({ error: "文档不存在或已过期" });
    hydrateMineruV21(document);
    if (!document.parsedDocumentV21 || !document.sourceMapping)
      return reply.code(409).send({
        error: "人工 Chunk 生成需要带可信页面映射的 Contract 2.1 Parsed Document",
        code: "TRUSTED_SOURCE_MAPPING_REQUIRED",
      });
    const body = request.body ?? {};
    if (
      body.sourceDocumentVersion !== document.parsedDocumentV21.sourceDocumentVersion ||
      body.parsedDocumentVersion !== document.parsedDocumentV21.parsedDocumentVersion
    ) return reply.code(409).send({
      error: "生成请求引用的 Source Document 或 Parsed Document 版本已过期",
      code: "MANUAL_GENERATION_VERSION_MISMATCH",
    });
    if (body.scope !== "page" && body.scope !== "document")
      return reply.code(400).send({ error: "scope 必须是 page 或 document", code: "MANUAL_SCOPE_INVALID" });
    if (body.scope === "page" && (!Number.isSafeInteger(body.page) || body.page! < 1))
      return reply.code(400).send({ error: "当前页生成需要正整数 page", code: "MANUAL_PAGE_INVALID" });
    if (!Array.isArray(body.effectiveAnnotations) || !Array.isArray(body.suppressedSourceBlockIds))
      return reply.code(400).send({ error: "缺少 T05 有效框或 suppression 输入", code: "MANUAL_ANNOTATIONS_INVALID" });
    if (!body.effectiveAnnotations.every(validEffectiveAnnotation) ||
        !body.suppressedSourceBlockIds.every((id) => typeof id === "string") ||
        (body.selectedAnnotationIds && !body.selectedAnnotationIds.every((id) => typeof id === "string")))
      return reply.code(400).send({ error: "T05 有效框输入格式无效", code: "MANUAL_ANNOTATIONS_INVALID" });
    const imagePolicy = body.imagePolicy === "exclude" || body.imagePolicy === "summary"
      ? body.imagePolicy
      : "reference";
    const previousChunks = preparePreviousChunksForManualGeneration(Array.isArray(body.previousChunks)
      ? body.previousChunks
      : document.reviewState.draft?.chunks ?? document.reviewState.preview?.chunks ?? []);
    const generated = generateManualChunks({
      document: document.parsedDocumentV21,
      sourceMapping: document.sourceMapping,
      scope: body.scope === "document"
        ? { kind: "document" }
        : { kind: "page", page: body.page!, selectedAnnotationIds: body.selectedAnnotationIds },
      effectiveAnnotations: body.effectiveAnnotations,
      suppressedSourceBlockIds: body.suppressedSourceBlockIds,
      previousChunks,
      imagePolicy,
      visualCopyVersion: document.sourceContract?.visualCopy.state === "ready"
        ? document.sourceContract.visualCopy.visualCopyVersion
        : undefined,
    });
    generated.chunks = markContextCandidates(generated.chunks);
    const configuration = {
      strategy: "manual",
      imagePolicy,
    } as unknown as ChunkRequest;
    document.reviewState = {
      ...document.reviewState,
      preview: { ...generated, configuration },
    };
    document.previewGateState = undefined;
    const generation = {
      scope: body.scope,
      page: body.scope === "page" ? body.page : null,
      selectedAnnotationIds: body.selectedAnnotationIds ?? [],
      sourceDocumentVersion: document.parsedDocumentV21.sourceDocumentVersion,
      parsedDocumentVersion: document.parsedDocumentV21.parsedDocumentVersion,
      chunkIds: generated.chunks.map((chunk) => chunk.id),
    };
    document.manualGenerationEvidence = {
      request: structuredClone(body),
      response: structuredClone(generation),
    };
    await persistBatch(batch);
    return {
      reviewState: document.reviewState,
      generation,
    };
  },
);

app.post<{
  Params: { batchId: string; documentId: string };
  Body: Partial<ChunkRequest>;
}>(
  "/api/batches/:batchId/documents/:documentId/chunks",
  async (request, reply) => {
    const batch = await getBatch(request.params.batchId);
    if (!batch) return reply.code(404).send({ error: "批次不存在或已过期" });
    const document = batch.documents.find(
      (item) => item.id === request.params.documentId,
    );
    if (!document) return reply.code(404).send({ error: "文档不存在或已过期" });
    if (!document.parsedDocumentV21)
      return reply.code(409).send({
        error: "Legacy 文档缺少 Contract 2.1 规范模型，请先重新解析",
      });
    hydrateMineruV21(document);
    if (!document.parsedDocumentV21)
      return reply.code(409).send({
        error: "Legacy 文档缺少 Contract 2.1 规范模型，请先重新解析",
      });
    const chunkRequest = parseChunkRequest(request.body);
    let previewGate = ensurePreviewGate(document, chunkRequest);
    previewGate = updateConfigurationDraft(previewGate, chunkRequest);
    const ticket = generationGate.begin(document.id, "preview");
    const started = startPreviewGeneration(previewGate, ticket);
    document.previewGateState = started.state;
    const preview = await buildV21Preview(
      document.parsedDocumentV21,
      started.request.configuration,
      chunkRequest.strategy === "semantic" ? semanticEmbedTexts : undefined,
      { tableGroupIds: tableGroupIdsFor(document.parsedDocumentV21, document.blocks ?? []) },
    );
    preview.chunks = markContextCandidates(preview.chunks);
    const completed = completePreviewGeneration(
      document.previewGateState,
      started.request,
      preview,
    );
    if (!generationGate.isCurrent(ticket) || !completed.ok)
      return reply.code(409).send({
        error: completed.ok ? "该 Preview 结果已过期，请使用最新参数结果" : completed.message,
        code: completed.ok ? "STALE_GENERATION_TICKET" : completed.code,
      });
    document.previewGateState = completed.state;
    document.reviewState = setPreview(
      document.reviewState,
      preview,
      started.request.configuration,
    );
    await persistBatch(batch);
    return {
      ...preview,
      sourceBlocks: document.blocks,
      parsedDocument: document.parsedDocumentV21,
      embeddingModel: chunkRequest.strategy === "semantic" ? "deterministic-fake" : null,
      tokenizer: "cl100k_base",
    };
  },
);

app.get<{ Params: { batchId: string; documentId: string } }>(
  "/api/batches/:batchId/documents/:documentId/review",
  async (request, reply) => {
    const document = await getDocument(
      request.params.batchId,
      request.params.documentId,
    );
    if (!document)
      return reply.code(404).send({ error: "文档不存在或已过期" });
    ensureReviewProgress(document);
    return {
      reviewState: document.reviewState,
      reviewRevision: document.reviewRevision ?? 0,
      reviewProgress: structuredClone(document.reviewProgress),
      sourceBlocks: document.parsedDocumentV21?.blocks ?? document.blocks ?? [],
      parsedDocument: document.parsedDocumentV21
        ? {
            contractVersion: "2.1",
            sourceDocumentVersion:
              document.parsedDocumentV21.sourceDocumentVersion,
            parsedDocumentVersion:
              document.parsedDocumentV21.parsedDocumentVersion,
            normalizedContentVersion:
              document.parsedDocumentV21.normalizedContentVersion,
            parser: document.parsedDocumentV21.parser,
            parserVersion: document.parsedDocumentV21.parserVersion,
            blocks: document.parsedDocumentV21.ordinaryBlocks,
          }
        : null,
      sourceText:
        document.parsedDocumentV21?.parser === "commonmark" ||
        document.parsedDocumentV21?.parser === "txt"
          ? document.markdown ?? null
          : null,
      sourceUrl: document.sourceAsset
        ? `/api/batches/${request.params.batchId}/documents/${document.id}/source`
        : null,
      sourceMimeType: document.sourceAsset?.mimeType ?? null,
      visualCopyUrl: document.visualCopyAsset
        ? `/api/batches/${request.params.batchId}/documents/${document.id}/visual-copy`
        : null,
      sourceContract: document.sourceContract
        ? {
            sourceDocumentVersion: document.sourceContract.sourceDocumentVersion,
            sourceViewKind: document.sourceContract.sourceViewKind,
            visualCopy: document.sourceContract.visualCopy,
          }
        : null,
      previewGate: document.previewGateState
        ? {
            configurationFingerprint:
              document.previewGateState.configurationDraft.fingerprint,
            previewFingerprint:
              document.previewGateState.preview?.configurationFingerprint ?? null,
            previewExpired: document.previewGateState.preview?.expired ?? false,
          }
        : null,
      annotationState: structuredClone(document.annotationState ?? {
        annotations: [],
        suppressedSourceBlockIds: [],
        detectionExclusionOverrides: {},
      }),
      sourceMapping: document.sourceMapping ?? null,
    };
  },
);

app.put<{
  Params: { batchId: string; documentId: string };
  Body: { annotations?: unknown; suppressedSourceBlockIds?: unknown; detectionExclusionOverrides?: unknown };
}>(
  "/api/batches/:batchId/documents/:documentId/review/annotations",
  async (request, reply) => {
    const batch = await getBatch(request.params.batchId);
    const document = batch?.documents.find(
      (candidate) => candidate.id === request.params.documentId,
    );
    if (!batch || !document)
      return reply.code(404).send({ error: "文档不存在或已过期" });
    const annotations = request.body?.annotations;
    const suppressedSourceBlockIds = request.body?.suppressedSourceBlockIds;
    const detectionExclusionOverrides = request.body?.detectionExclusionOverrides;
    if (
      !Array.isArray(annotations) ||
      !annotations.every(validPersistedAnnotation) ||
      !Array.isArray(suppressedSourceBlockIds) ||
      !suppressedSourceBlockIds.every((id) => typeof id === "string") ||
      !validDetectionExclusionOverrides(detectionExclusionOverrides)
    ) return reply.code(400).send({ error: "人工标注数据格式无效" });
    document.annotationState = {
      annotations: structuredClone(annotations),
      suppressedSourceBlockIds: [...new Set(suppressedSourceBlockIds)],
      detectionExclusionOverrides: structuredClone(detectionExclusionOverrides ?? {}),
    };
    await persistBatch(batch);
    return { annotationState: structuredClone(document.annotationState) };
  },
);

app.get<{ Params: { batchId: string; documentId: string } }>(
  "/api/batches/:batchId/documents/:documentId/visual-copy",
  async (request, reply) => {
    const document = await getDocument(
      request.params.batchId,
      request.params.documentId,
    );
    if (!document?.visualCopyAsset)
      return reply.code(404).send({ error: "Visual Copy 不可用" });
    reply.type(document.visualCopyAsset.mimeType);
    return reply.send(await assetBytes(document.visualCopyAsset));
  },
);

app.post<{
  Params: { batchId: string; documentId: string };
  Body: { confirmReplacement?: boolean };
}>(
  "/api/batches/:batchId/documents/:documentId/review/confirm",
  async (request, reply) => {
    const batch = await getBatch(request.params.batchId);
    const document = batch?.documents.find(
      (candidate) => candidate.id === request.params.documentId,
    );
    if (!batch || !document)
      return reply.code(404).send({ error: "文档不存在或已过期" });
    const fallbackConfiguration =
      document.reviewState.preview?.configuration ??
      document.reviewState.draft?.configuration ??
      parseChunkRequest({});
    const adoption = adoptPreview(
      ensurePreviewGate(document, fallbackConfiguration),
      { confirmReplacement: request.body?.confirmReplacement === true },
    );
    if (!adoption.ok)
      return reply.code(adoption.status).send({
        error: adoption.message,
        code: adoption.code,
        impact: adoption.impact,
      });
    document.previewGateState = adoption.state;
    document.reviewState = restoreReviewState({
      preview: null,
      draft: structuredClone(adoption.state.draft!.snapshot),
      undoStack: [],
      redoStack: [],
    });
    await persistBatch(batch);
    return { reviewState: document.reviewState, impact: adoption.impact };
  },
);

app.delete<{ Params: { batchId: string; documentId: string } }>(
  "/api/batches/:batchId/documents/:documentId/review/preview",
  async (request, reply) => {
    const batch = await getBatch(request.params.batchId);
    const document = batch?.documents.find(
      (candidate) => candidate.id === request.params.documentId,
    );
    if (!batch || !document)
      return reply.code(404).send({ error: "文档不存在或已过期" });
    document.reviewState.preview = null;
    if (document.previewGateState) document.previewGateState.preview = null;
    await persistBatch(batch);
    return { reviewState: document.reviewState };
  },
);

app.put<{
  Params: { batchId: string; documentId: string };
  Body: { reviewState?: unknown };
}>(
  "/api/batches/:batchId/documents/:documentId/review",
  async (_request, reply) => reply.code(410).send({
    error: "整份 ReviewState 写入已停用，请使用服务端 review action 或 reviewed-model 接口",
    code: "CLIENT_REVIEW_STATE_REJECTED",
  }),
);

app.post<{
  Params: { batchId: string; documentId: string };
  Body: Record<string, unknown>;
}>(
  "/api/batches/:batchId/documents/:documentId/review/actions",
  async (request, reply) => {
    const batch = await getBatch(request.params.batchId);
    const document = batch?.documents.find(
      (candidate) => candidate.id === request.params.documentId,
    );
    if (!batch || !document)
      return reply.code(404).send({ error: "文档不存在或已过期" });
    if (!document.reviewState.draft || !document.parsedDocumentV21)
      return reply.code(409).send({ error: "需要先采用 Contract 2.1 Preview" });
    try {
      const command = parseReviewAction(
        request.body,
        document,
        new Date().toISOString(),
      );
      const updated = applyReviewAction(
        document.reviewState as unknown as ReviewActionState,
        document.parsedDocumentV21.blocks,
        command,
      );
      document.reviewState = restoreReviewState(updated);
      const changedChunkId = typeof request.body.chunkId === "string" ? request.body.chunkId : null;
      touchReviewProgress(document, changedChunkId ? [changedChunkId] : []);
      if (document.previewGateState?.draft)
        document.previewGateState.draft.snapshot = structuredClone(
          document.reviewState.draft!,
        );
      await persistBatch(batch);
      return { reviewState: document.reviewState };
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "无效的 Review Action",
        code: "INVALID_REVIEW_ACTION",
      });
    }
  },
);

function parseReviewAction(
  body: Record<string, unknown>,
  document: DocumentRecord,
  at: string,
): ReviewActionCommand {
  if (body.reviewState !== undefined || body.derived !== undefined)
    throw new Error("Review Action 不接受客户端派生状态");
  const type = body.type;
  if (type === "undo" || type === "redo") return { type };
  const chunkId = typeof body.chunkId === "string" ? body.chunkId : null;
  if (type === "exclude" || type === "restore") {
    if (!chunkId) throw new Error(`${type} 需要 chunkId`);
    return { type, chunkId, at };
  }
  const structural = {
    documentId: document.id,
    draftVersion: `${document.parsedDocumentV21!.parsedDocumentVersion}:${document.reviewState.draft!.confirmedAt}`,
    at,
  };
  if (type === "split") {
    if (!chunkId) throw new Error("split 需要 chunkId");
    return { type, chunkId, cursor: body.cursor as number, ...structural };
  }
  if (type === "merge-next") {
    if (!chunkId) throw new Error("merge-next 需要 chunkId");
    const chunks = document.reviewState.draft!.chunks;
    const index = chunks.findIndex((chunk) => chunk.id === chunkId);
    if (index >= 0 && chunks[index + 1] && chunks[index].parentChunk?.id !== chunks[index + 1].parentChunk?.id)
      throw new Error("父子分块只能合并同一父块内的子块，请调整父块参数后重新生成");
    return { type, chunkId, ...structural };
  }
  if (type === "source-create" || type === "source-add" || type === "source-remove") {
    if (!Array.isArray(body.blockIds) || body.blockIds.some((id) => typeof id !== "string"))
      throw new Error(`${type} 需要 blockIds`);
    if (type === "source-create") return { type, blockIds: body.blockIds as string[], ...structural };
    if (!chunkId) throw new Error(`${type} 需要 chunkId`);
    return { type, chunkId, blockIds: body.blockIds as string[], ...structural };
  }
  throw new Error("未知的 Review Action");
}

app.put<{
  Params: { batchId: string; documentId: string; chunkId: string };
  Body: Record<string, unknown> & {
    reviewedModel?: unknown;
    expectedRevision?: unknown;
  };
}>(
  "/api/batches/:batchId/documents/:documentId/chunks/:chunkId/reviewed-model",
  async (request, reply) => {
    const batch = await getBatch(request.params.batchId);
    const document = batch?.documents.find(
      (candidate) => candidate.id === request.params.documentId,
    );
    const draft = document?.reviewState.draft;
    const chunk = draft?.chunks.find(
      (candidate) => candidate.id === request.params.chunkId,
    );
    if (!batch || !document || !draft || !chunk)
      return reply.code(404).send({ error: "Draft Chunk 不存在" });
    ensureReviewProgress(document);
    const allowedFields = new Set(["reviewedModel", "expectedRevision"]);
    if (Object.keys(request.body ?? {}).some((field) => !allowedFields.has(field)))
      return reply.code(400).send({ error: "派生字段只能由服务器计算" });
    const firstSegment = chunk.sourceSegments[0] as typeof chunk.sourceSegments[0] & {
      contentBlockId?: string;
      locationQuality?: "exact" | "page_only" | "parsed_only" | "unavailable";
    };
    const contentBlockId = firstSegment?.contentBlockId ?? firstSegment?.blockId;
    const sourceBlock = document.parsedDocumentV21?.blocks.find(
      (candidate) => candidate.contentBlockId === contentBlockId,
    );
    if (!sourceBlock)
      return reply.code(409).send({ error: "Chunk 缺少可验证的 Content Block 来源" });
    const sourceSegments: SourceSegmentV21[] = [];
    for (const segment of chunk.sourceSegments) {
      if (!isSourceSegmentV21(segment))
        return reply.code(409).send({ error: "Chunk 不是 Contract 2.1 Source Segment，需重新生成 Preview" });
      sourceSegments.push(structuredClone(segment));
    }
    const current = chunk as typeof chunk & {
      reviewedModel?: ReviewedModel;
      reviewedModelRevisions?: ReviewableChunk["revisions"];
      embeddingEligible?: boolean;
      embeddingExclusionReasons?: string[];
      embeddingText?: string | null;
      display?: { text: string; html?: string };
      searchText?: string;
      normalizationStatus?: string;
      reviewRevision?: number;
    };
    const incoming = request.body?.reviewedModel as Record<string, unknown> | undefined;
    const isTableSave = incoming?.type === "table";
    const currentRevision = current.reviewRevision ?? 0;
    if (isTableSave && !Number.isSafeInteger(request.body?.expectedRevision))
      return reply.code(400).send({
        error: "保存表格需要当前修订版本。",
        impact: "本次更改未保存，现有表格保持不变。",
        recovery: "请刷新表格后重新编辑并保存。",
      });
    if (isTableSave && request.body.expectedRevision !== currentRevision)
      return reply.code(409).send({
        error: "表格修订版本已过期。",
        impact: "本次更改未覆盖服务器中的较新表格。",
        recovery: "请刷新或重新打开 Chunk，基于最新版本重新编辑。",
      });
    const revisionAt = new Date().toISOString();
    let recomputed: ReturnType<typeof recomputeReviewedChunk>;
    try {
      recomputed = recomputeReviewedChunk(
        {
          chunkId: chunk.id,
          sourceBlock,
          reviewedModel: current.reviewedModel,
          finalText: chunk.finalText,
          automaticText: chunk.automaticText,
          sourceSegments,
          locationQuality: firstSegment.locationQuality ?? "parsed_only",
          qualityFlags: chunk.qualityFlags,
          contextText: chunk.contextText,
          contextReviewState: chunk.contextReviewState,
          contextStaleReason: chunk.contextError,
          revisions: current.reviewedModelRevisions ?? [],
        },
        {
          at: revisionAt,
          reviewedModel: request.body?.reviewedModel,
          imageAssetAvailable: incoming?.type === "image"
            ? Boolean(chunk.imagePath)
            : undefined,
          tokenBudget: {
            minimum: 80,
            maximum:
              draft.configuration.strategy === "semantic"
                ? draft.configuration.semanticMaxChunkSize
                : draft.configuration.chunkSize,
          },
        },
      );
      if (recomputed.reviewedModel.type === "table") {
        const model = recomputed.reviewedModel;
        const existing = current.reviewedModel?.type === "table" ? current.reviewedModel : null;
        if (!model.tableId || (existing?.tableId && model.tableId !== existing.tableId))
          throw new Error("Table identity cannot change");
        if (existing?.rowGroups) {
          if (model.rowGroups?.length !== existing.rowGroups.length)
            throw new Error("Table row-group identity cannot change");
          for (const [index, group] of existing.rowGroups.entries()) {
            const next = model.rowGroups[index];
            if (
              !next ||
              next.rowGroupId !== group.rowGroupId ||
              next.order !== group.order ||
              next.repeatedHeader !== group.repeatedHeader ||
              JSON.stringify(next.sourceSegmentIds) !== JSON.stringify(group.sourceSegmentIds)
            ) throw new Error("Table row-group provenance cannot change");
          }
        }
        const sourceIds = new Set(sourceSegments.map((segment) => segment.contentBlockId));
        const groupSourceIds = new Set(model.rowGroups?.flatMap((group) => group.sourceSegmentIds) ?? []);
        if (
          !model.rowGroups?.length ||
          groupSourceIds.size !== sourceIds.size ||
          [...sourceIds].some((sourceId) => !groupSourceIds.has(sourceId))
        ) throw new Error("Table row groups require authoritative sources");
      }
    } catch (error) {
      if (!isTableSave) throw error;
      return reply.code(422).send({
        error: "表格结构无效，无法保存。",
        impact: "本次更改未保存，现有已保存表格不受影响。",
        recovery: "请检查空表、行列范围和合并单元格，调整后重试。",
      });
    }
    const beforeDraft = structuredClone(draft);
    const before = chunk.finalText;
    const automaticType = current.automaticType ?? sourceBlock.contentType;
    const previousFinalType = current.finalType ?? automaticType;
    const finalType = recomputed.contentType;
    const typeChanged = finalType !== previousFinalType;
    const identity = typeChanged
      ? planRecompute({
          documentId: document.id,
          draftVersion: `${document.parsedDocumentV21!.parsedDocumentVersion}:${draft.confirmedAt}`,
          chunkId: chunk.id,
          change: {
            kind: "type",
            fingerprint: JSON.stringify({ previousFinalType, finalType }),
          },
          affectedChunkIds: [chunk.id],
          affectedContentGroupIds: [],
        }).identity
      : { chunkId: chunk.id, replacedChunkId: null };
    Object.assign(current, {
      id: identity.chunkId ?? chunk.id,
      ...(identity.replacedChunkId
        ? { replacedChunkId: identity.replacedChunkId }
        : {}),
      type: recomputed.contentType === "table"
        ? "table"
        : recomputed.contentType === "image"
          ? "image"
          : "text",
      text: recomputed.finalText,
      finalText: recomputed.finalText,
      automaticType,
      finalType,
      tokenCount: recomputed.metrics.tokenCount,
      qualityFlags: recomputed.qualityFlags,
      contextReviewState: recomputed.contextReviewState,
      contextError: recomputed.contextStaleReason,
      reviewedModel: recomputed.reviewedModel,
      reviewedModelRevisions: recomputed.revisions,
      display: recomputed.display,
      searchText: recomputed.searchText,
      normalizationStatus: recomputed.normalizationStatus,
      embeddingEligible: recomputed.embeddingEligible,
      embeddingExclusionReasons: recomputed.embeddingExclusionReasons,
      embeddingText: recomputed.embeddingText,
      reviewRevision: recomputed.reviewedModel.type === "table"
        ? currentRevision + 1
        : current.reviewRevision,
    });
    if (before !== recomputed.finalText)
      chunk.revisions.push({
        type: "text",
        at: revisionAt,
        before,
        after: recomputed.finalText,
      });
    if (typeChanged)
      chunk.revisions.push({
        type: "type",
        at: revisionAt,
        before: previousFinalType,
        after: finalType,
      });
    document.reviewState = restoreReviewState({
      ...document.reviewState,
      undoStack: [...document.reviewState.undoStack, beforeDraft].slice(-50),
      redoStack: [],
    });
    touchReviewProgress(document, [request.params.chunkId]);
    if (document.previewGateState?.draft)
      document.previewGateState.draft.snapshot = structuredClone(
        document.reviewState.draft!,
      );
    await persistBatch(batch);
    return {
      reviewState: document.reviewState,
      recomputed: { ...recomputed, chunkId: current.id },
    };
  },
);

app.put<{
  Params: { batchId: string; documentId: string; chunkId: string };
  Body: Record<string, unknown>;
}>(
  "/api/batches/:batchId/documents/:documentId/chunks/:chunkId/image-summary",
  async (request, reply) => {
    const batch = await getBatch(request.params.batchId);
    const document = batch?.documents.find(
      (candidate) => candidate.id === request.params.documentId,
    );
    if (!batch || !document?.reviewState.draft)
      return reply.code(404).send({ error: "Draft 文档不存在或已过期" });
    try {
      const savedAt = new Date().toISOString();
      validateImageSummaryInput(
        request.body as ImageSummaryReviewInput,
        savedAt,
      );
      const chunk = document.reviewState.draft.chunks.find(
        (candidate) => candidate.id === request.params.chunkId,
      );
      if (!chunk || chunk.type !== "image")
        return reply.code(404).send({ error: "图片 Draft Chunk 不存在" });
      await ensureStoredImage(document, chunk);
      document.reviewState = saveImageSummaryReview(
        document.reviewState,
        request.params.chunkId,
        request.body as ImageSummaryReviewInput,
        savedAt,
      );
      if (document.previewGateState?.draft)
        document.previewGateState.draft.snapshot = structuredClone(
          document.reviewState.draft!,
        );
      await persistBatch(batch);
      return { reviewState: document.reviewState };
    } catch (error) {
      if (error instanceof ImageObjectStoreUnavailableError)
        return reply.code(503).send({
          error: "图片对象存储尚未配置，当前图片策略和摘要未改变。",
          code: "IMAGE_OBJECT_STORE_UNAVAILABLE",
          recovery: "请联系维护人员配置本地 MinIO 后重试。",
        });
      if (error instanceof ImageObjectStoreWriteError)
        return reply.code(502).send({
          error: "图片对象存储暂时不可用，当前图片策略和摘要未改变。",
          code: "IMAGE_OBJECT_STORE_FAILED",
          recovery: "请确认本地 MinIO 健康后重试。",
        });
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "图片摘要请求无效",
        code: error instanceof Error && /仅引用图片必须关联/.test(error.message)
          ? "IMAGE_REFERENCE_REQUIRED"
          : "INVALID_IMAGE_SUMMARY",
        ...(error instanceof Error && /仅引用图片必须关联/.test(error.message)
          ? {
              impact: "图片策略未保存；图片不会进入文本检索、Context 或 Embedding。",
              recovery: "请搜索并选择同一文档内至少一个有效文字 Chunk 后重试。",
            }
          : {}),
      });
    }
  },
);

app.post<{
  Params: { batchId: string; documentId: string; chunkId: string };
  Body: { profileId?: unknown };
}>(
  "/api/batches/:batchId/documents/:documentId/chunks/:chunkId/vlm-summary",
  async (request, reply) => {
    const batch = await getBatch(request.params.batchId);
    const document = batch?.documents.find(
      (candidate) => candidate.id === request.params.documentId,
    );
    const chunk = document?.reviewState.draft?.chunks.find(
      (candidate) => candidate.id === request.params.chunkId,
    ) as (Chunk & {
      parentSectionId?: string;
      imageReferenceText?: string;
      vlmSummaryGenerated?: string;
      vlmProfileId?: string;
      vlmProfileName?: string;
      vlmModel?: string;
      vlmPromptVersion?: string;
      vlmGeneratedAt?: string;
      vlmStatus?: "unconfigured" | "generating" | "awaiting_review" | "failed";
      vlmError?: string;
      vlmCacheKey?: string;
      vlmCacheHit?: boolean;
      vlmInputObjectReference?: AssetDescriptor;
    }) | undefined;
    if (!batch || !document || !chunk || chunk.type !== "image")
      return reply.code(404).send({ error: "图片 Draft Chunk 不存在" });
    if ((chunk as Chunk & { imagePolicy?: string }).imagePolicy === "reference")
      return reply.code(409).send({
        error: "仅引用策略不生成 VLM 摘要。",
        impact: "未发送图片，也不会产生模型费用。",
        recovery: "请在图片详情中关联至少一个有效文字 Chunk 后保存。",
        code: "VLM_DISABLED_FOR_REFERENCE",
      });
    if ((chunk as Chunk & { imagePolicy?: string }).imagePolicy === "exclude")
      return reply.code(409).send({
        error: "已排除图片不生成 VLM 摘要。",
        impact: "未发送图片，也不会产生模型费用。",
        recovery: "如需摘要，请先将图片策略改为“摘要 + 引用”并保存。",
        code: "VLM_DISABLED_FOR_EXCLUDED_IMAGE",
      });
    if (typeof request.body?.profileId !== "string")
      return reply.code(400).send({ error: "请选择图片理解模型" });
    const profile = modelProfiles.find(
      (candidate) =>
        candidate.id === request.body.profileId &&
        candidate.capabilities.includes("vlm"),
    );
    if (!profile) {
      chunk.vlmStatus = "unconfigured";
      await persistBatch(batch);
      return reply.code(503).send({
        error: "图片理解服务尚未配置，当前图片摘要未改变。",
        code: "VLM_SERVICE_UNAVAILABLE",
        recovery: "请联系维护人员配置图片理解模型，或选择其他可用模型后重试。",
      });
    }
    if (!document.sourceAsset || !document.sourceContract)
      return reply.code(409).send({
        error: "当前图片缺少可信原始资产，无法发送给图片理解模型。",
        code: "TRUSTED_IMAGE_UNAVAILABLE",
        recovery: "请重新导入包含原始图片或可精确裁剪 PDF 的文档。",
      });

    let trustedImage;
    try {
      trustedImage = await ensureStoredImage(document, chunk);
    } catch (error) {
      if (error instanceof ImageObjectStoreUnavailableError)
        return reply.code(503).send({
          error: "图片对象存储尚未配置，未发送模型请求。",
          code: "IMAGE_OBJECT_STORE_UNAVAILABLE",
          recovery: "请联系维护人员配置本地 MinIO 后重试。",
        });
      if (error instanceof ImageObjectStoreWriteError)
        return reply.code(502).send({
          error: "图片对象存储暂时不可用，未发送模型请求。",
          code: "IMAGE_OBJECT_STORE_FAILED",
          recovery: "请确认本地 MinIO 健康后重试。",
        });
      return reply.code(409).send({
        error: "当前图片缺少可信原始资产或精确裁剪范围，未发送模型请求。",
        code: "TRUSTED_IMAGE_UNAVAILABLE",
        recovery: "请重新解析或补齐原始图片资产与精确来源定位后重试。",
      });
    }

    const parsedBlocks = document.parsedDocumentV21?.blocks ?? [];
    const sourceIds = new Set(chunk.sourceSegments.map((segment) =>
      (segment as typeof segment & { contentBlockId?: string }).contentBlockId ??
      segment.blockId
    ));
    const sourceIndexes = parsedBlocks.flatMap((block, index) =>
      sourceIds.has(block.contentBlockId) ? [index] : []
    );
    const center = sourceIndexes[0] ?? 0;
    const nearbyBlocks = parsedBlocks.slice(Math.max(0, center - 2), center + 3);
    const caption = nearbyBlocks.find((block) => block.contentType === "caption")
      ?.searchText ?? chunk.imageReferenceText ?? null;
    const nearbyText = nearbyBlocks
      .filter((block) => block.searchText?.trim())
      .map((block) => block.searchText.trim())
      .join("\n");
    const vlmCacheKey = createHash("sha256").update(JSON.stringify({
      checksumSha256: chunk.imageObjectReference?.checksumSha256,
      profileId: profile.id,
      model: profile.model,
      promptVersion: VLM_PROMPT_VERSION,
      productIdentity: chunk.productIdentity ?? null,
      section: chunk.parentSectionId ?? null,
      caption,
      nearbyText,
    })).digest("hex");
    if (!assetObjectStore)
      return reply.code(503).send({
        error: "对象存储尚未配置，未发送模型请求。",
        code: "IMAGE_OBJECT_STORE_UNAVAILABLE",
      });
    try {
      if (trustedImage.pageRenderBytes && trustedImage.pageRenderPage) {
        chunk.pageRenderObjectReference = (await assetObjectStore.put({
          assetClass: "pdf_page_render",
          bytes: trustedImage.pageRenderBytes,
          contentType: "image/png",
          batchId: batch.id,
          documentId: document.id,
          sourceDocumentVersion: document.sourceContract?.sourceDocumentVersion,
          assetVersion: `page-${trustedImage.pageRenderPage}-v1`,
          extension: "png",
        })).reference;
      }
      chunk.vlmInputObjectReference = (await putJsonAsset(assetObjectStore, {
        assetClass: "model_input",
        value: {
          kind: "vlm_input",
          imageObjectReference: chunk.imageObjectReference,
          pageRenderObjectReference: chunk.pageRenderObjectReference,
          profileId: profile.id,
          model: profile.model,
          promptVersion: VLM_PROMPT_VERSION,
          productIdentity: chunk.productIdentity ?? null,
          section: chunk.parentSectionId ?? null,
          caption,
          nearbyText,
        },
        batchId: batch.id,
        documentId: document.id,
        sourceDocumentVersion: document.sourceContract?.sourceDocumentVersion,
        assetVersion: vlmCacheKey,
      })).reference;
    } catch {
      return reply.code(502).send({
        error: "模型输入对象写入失败，未发送模型请求。",
        code: "MODEL_INPUT_OBJECT_FAILED",
      });
    }
    if (chunk.vlmCacheKey === vlmCacheKey && chunk.vlmSummaryGenerated?.trim()) {
      Object.assign(chunk, {
        vlmProfileId: profile.id,
        vlmProfileName: profile.name,
        vlmModel: profile.model,
        vlmPromptVersion: VLM_PROMPT_VERSION,
        vlmStatus: "awaiting_review",
        vlmError: undefined,
        vlmCacheHit: true,
      });
      await persistBatch(batch);
      return { reviewState: document.reviewState, cacheHit: true };
    }
    const ticket = generationGate.begin(`${document.id}:${chunk.id}`, "vlm");
    Object.assign(chunk, {
      vlmProfileId: profile.id,
      vlmProfileName: profile.name,
      vlmModel: profile.model,
      vlmPromptVersion: VLM_PROMPT_VERSION,
      vlmStatus: "generating",
      vlmError: undefined,
      vlmCacheHit: false,
    });
    await persistBatch(batch);
    try {
      const summary = await createVlmClient(profile)({
        imageDataUrl: trustedImage.dataUrl,
        productIdentity: chunk.productIdentity ?? null,
        section: chunk.parentSectionId ?? null,
        caption,
        nearbyText,
      });
      if (!generationGate.isCurrent(ticket))
        return reply.code(409).send({
          error: "该图片摘要结果已过期，请使用最新生成结果。",
        });
      Object.assign(chunk, {
        vlmSummaryGenerated: summary,
        vlmProfileId: profile.id,
        vlmProfileName: profile.name,
        vlmModel: profile.model,
        vlmPromptVersion: VLM_PROMPT_VERSION,
        vlmGeneratedAt: new Date().toISOString(),
        vlmStatus: "awaiting_review",
        vlmError: undefined,
        vlmCacheKey,
        vlmCacheHit: false,
      });
      await persistBatch(batch);
      return { reviewState: document.reviewState };
    } catch (error) {
      const timeout = error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      Object.assign(chunk, {
        vlmStatus: "failed",
        vlmError: timeout
          ? "图片理解模型响应超时"
          : "图片理解模型未返回可用摘要",
      });
      await persistBatch(batch);
      return reply.code(timeout ? 504 : 502).send({
        error: timeout
          ? "图片理解模型响应超时，已保存的摘要未被覆盖。"
          : "图片理解模型未返回可用摘要，已保存的摘要未被覆盖。",
        code: timeout ? "VLM_TIMEOUT" : "VLM_GENERATION_FAILED",
        recovery: "请稍后重试或选择其他图片理解模型。",
      });
    }
  },
);

function isSourceSegmentV21(value: unknown): value is SourceSegmentV21 {
  if (!value || typeof value !== "object") return false;
  const segment = value as Record<string, unknown>;
  return typeof segment.sourceDocumentVersion === "string" &&
    typeof segment.parsedDocumentVersion === "string" &&
    typeof segment.contentBlockId === "string" &&
    typeof segment.sourceViewKind === "string" &&
    typeof segment.mappingQuality === "string" &&
    typeof segment.locationQuality === "string";
}

app.post<{
  Params: { batchId: string; documentId: string };
  Body: { chunkIds?: unknown; allowHumanContextOverwrite?: unknown; profileId?: unknown };
}>(
  "/api/batches/:batchId/documents/:documentId/context/generate",
  async (request, reply) => {
    const batch = await getBatch(request.params.batchId);
    const document = batch?.documents.find(
      (candidate) => candidate.id === request.params.documentId,
    );
    if (!batch || !document)
      return reply.code(404).send({ error: "文档不存在或已过期" });
    if (!document.parsedDocumentV21)
      return reply.code(409).send({
        error: "Legacy 文档缺少 Contract 2.1 规范模型，请先重新解析",
      });
    const parsedDocument = document.parsedDocumentV21;
    const requestedProfileId = request.body?.profileId;
    if (requestedProfileId !== undefined && typeof requestedProfileId !== "string")
      return reply.code(400).send({ error: "请选择 Context 模型" });
    const profile = typeof requestedProfileId === "string"
      ? modelProfiles.find((candidate) =>
          candidate.id === requestedProfileId &&
          candidate.capabilities.includes("context")
        )
      : undefined;
    const selectedGenerator = profile
      ? createContextClient(profile)
      : requestedProfileId === undefined
        ? generateContext
        : null;
    const selectedModel = profile?.model ?? contextModel;
    if (!selectedGenerator || !selectedModel)
      return reply.code(503).send({
        error: "Context 服务当前未配置，暂时无法生成 Context。",
        code: "CONTEXT_SERVICE_UNAVAILABLE",
        recovery: "请联系维护人员完成服务配置后重试；已保存的 Chunk 不受影响。",
      });
    const chunkIds = parseChunkIds(request.body?.chunkIds);
    if (!chunkIds.length)
      return reply.code(400).send({ error: "至少选择一个 Chunk" });
    if (!assetObjectStore)
      return reply.code(503).send({ error: "对象存储尚未配置，未发送模型请求" });
    try {
      await putJsonAsset(assetObjectStore, {
        assetClass: "model_input",
        value: {
          kind: "context_input",
          profileId: profile?.id ?? null,
          model: selectedModel,
          promptVersion: CONTEXT_PROMPT_VERSION,
          parsedDocumentVersion: parsedDocument.parsedDocumentVersion,
          chunks: document.reviewState.draft?.chunks
            .filter((chunk) => chunkIds.includes(chunk.id))
            .map((chunk) => ({
              chunkId: chunk.id,
              finalText: chunk.finalText,
              sourceBlockIds: chunk.sourceBlockIds,
            })) ?? [],
        },
        batchId: batch.id,
        documentId: document.id,
        sourceDocumentVersion: document.sourceContract?.sourceDocumentVersion,
        assetVersion: createHash("sha256").update(JSON.stringify({
          chunkIds,
          model: selectedModel,
          promptVersion: CONTEXT_PROMPT_VERSION,
        })).digest("hex"),
      });
    } catch {
      return reply.code(502).send({
        error: "Context 输入对象写入失败，未发送模型请求",
        code: "MODEL_INPUT_OBJECT_FAILED",
      });
    }
    const baselineReview = structuredClone(document.reviewState);
    const ticket = generationGate.begin(document.id, "context");
    const generated = await generateDraftContexts(
      baselineReview,
      chunkIds,
      parsedDocument.blocks.map((block) => ({
        contentBlockId: block.contentBlockId,
        searchText: block.searchText,
        contentType: block.contentType,
      })),
      selectedGenerator,
      {
        model: selectedModel,
        promptVersion: CONTEXT_PROMPT_VERSION,
        allowHumanContextOverwrite:
          request.body?.allowHumanContextOverwrite === true,
      },
    );
    if (!generationGate.isCurrent(ticket))
      return reply.code(409).send({ error: "该 Context 结果已过期，请使用最新生成结果" });
    document.reviewState = applyGeneratedContexts(
      document.reviewState,
      generated.baselineChunks,
      generated.review.draft!.chunks,
      chunkIds,
    );
    if (profile)
      for (const chunk of document.reviewState.draft?.chunks ?? []) {
        if (!chunkIds.includes(chunk.id)) continue;
        Object.assign(chunk, {
          contextProfileId: profile.id,
          contextProfileName: profile.name,
        });
      }
    await persistBatch(batch);
    return { reviewState: document.reviewState };
  },
);

app.post<{
  Params: { batchId: string; documentId: string; chunkId: string };
}>(
  "/api/batches/:batchId/documents/:documentId/context/:chunkId/confirm",
  async (request, reply) => {
    const batch = await getBatch(request.params.batchId);
    const document = batch?.documents.find(
      (candidate) => candidate.id === request.params.documentId,
    );
    if (!batch || !document)
      return reply.code(404).send({ error: "文档不存在或已过期" });
    document.reviewState = confirmDraftContext(
      document.reviewState,
      request.params.chunkId,
    );
    await persistBatch(batch);
    return { reviewState: document.reviewState };
  },
);

app.put<{
  Params: { batchId: string; documentId: string; chunkId: string };
  Body: { contextText?: unknown };
}>(
  "/api/batches/:batchId/documents/:documentId/context/:chunkId",
  async (request, reply) => {
    const batch = await getBatch(request.params.batchId);
    const document = batch?.documents.find(
      (candidate) => candidate.id === request.params.documentId,
    );
    if (!batch || !document)
      return reply.code(404).send({ error: "文档不存在或已过期" });
    if (typeof request.body?.contextText !== "string")
      return reply.code(400).send({ error: "contextText 必须是字符串" });
    document.reviewState = editDraftContext(
      document.reviewState,
      request.params.chunkId,
      request.body.contextText,
    );
    await persistBatch(batch);
    return { reviewState: document.reviewState };
  },
);

app.post<{
  Params: { batchId: string; documentId: string };
  Body: { profileId?: unknown };
}>(
  "/api/batches/:batchId/documents/:documentId/embedding-jobs",
  async (request, reply) => {
    const batch = await getBatch(request.params.batchId);
    const document = batch?.documents.find(
      (candidate) => candidate.id === request.params.documentId,
    );
    if (!batch || !document?.reviewState.draft)
      return reply.code(404).send({ error: "Draft 文档不存在或已过期" });
    if (typeof request.body?.profileId !== "string")
      return reply.code(400).send({ error: "请选择 Embedding 模型" });
    const profile = embeddingProfiles.find(
      (candidate) => candidate.id === request.body.profileId,
    );
    if (!profile)
      return reply.code(503).send({
        error: "Embedding 模型目录尚未配置。",
        code: "EMBEDDING_PROFILE_UNAVAILABLE",
        recovery: "请联系维护人员配置 Embedding profile 后重试。",
      });
    const key = embeddingIdempotencyKey(
      document.id,
      profile,
      document.reviewState.draft.chunks,
      {
        spuId: document.spuId,
        targetSpuIds: confirmedSpuIds(document),
        sourceDocumentVersion: document.sourceContract?.sourceDocumentVersion,
        documentType: document.spuDocumentType,
        embeddingRevision: `r${document.reviewRevision ?? 0}`,
      },
    );
    const existing = document.embeddingJobs?.find(
      (candidate) => candidate.idempotencyKey === key,
    );
    if (existing) return { job: publicEmbeddingJobForDocument(document, existing), reused: true };
    if (!assetObjectStore)
      return reply.code(503).send({ error: "对象存储尚未配置，未发送模型请求" });
    try {
      await putJsonAsset(assetObjectStore, {
        assetClass: "model_input",
        value: {
          kind: "embedding_input",
          profileId: profile.id,
          model: profile.model,
          dimensions: profile.dimensions,
          chunks: document.reviewState.draft.chunks.map((chunk) => ({
            chunkId: chunk.id,
            finalTextHash: createHash("sha256").update(chunk.finalText).digest("hex"),
            eligible:
              (chunk as Chunk & { embeddingEligible?: boolean }).embeddingEligible === true &&
              Boolean((chunk as Chunk & { embeddingText?: string }).embeddingText?.trim()) &&
              !chunk.excluded,
            contextState: chunk.contextReviewState,
          })),
        },
        batchId: batch.id,
        documentId: document.id,
        sourceDocumentVersion: document.sourceContract?.sourceDocumentVersion,
        assetVersion: key,
      });
    } catch {
      return reply.code(502).send({
        error: "Embedding 输入对象写入失败，未发送模型请求",
        code: "MODEL_INPUT_OBJECT_FAILED",
      });
    }
    const job = await runEmbeddingJob({
      documentId: document.id,
      chunks: document.reviewState.draft.chunks,
      profile,
      at: new Date().toISOString(),
      metadata: {
        spuId: document.spuId,
        targetSpuIds: confirmedSpuIds(document),
        sourceDocumentVersion: document.sourceContract?.sourceDocumentVersion,
        documentType: document.spuDocumentType,
        embeddingRevision: `r${document.reviewRevision ?? 0}`,
      },
    });
    document.embeddingJobs = [...(document.embeddingJobs ?? []), job].slice(-20);
    await persistBatch(batch);
    return { job: publicEmbeddingJobForDocument(document, job), reused: false };
  },
);

app.get<{
  Params: { batchId: string; documentId: string; jobId: string };
}>(
  "/api/batches/:batchId/documents/:documentId/embedding-jobs/:jobId",
  async (request, reply) => {
    const batch = await getBatch(request.params.batchId);
    const document = batch?.documents.find(
      (candidate) => candidate.id === request.params.documentId,
    );
    const job = document?.embeddingJobs?.find(
      (candidate) => candidate.id === request.params.jobId,
    );
    return batch && document && job
      ? { job: publicEmbeddingJobForDocument(document, job) }
      : reply.code(404).send({ error: "Embedding 任务不存在或已过期" });
  },
);

app.post<{
  Params: { batchId: string; documentId: string; jobId: string };
}>(
  "/api/batches/:batchId/documents/:documentId/embedding-jobs/:jobId/retry",
  async (request, reply) => {
    const batch = await getBatch(request.params.batchId);
    const document = batch?.documents.find(
      (candidate) => candidate.id === request.params.documentId,
    );
    const index = document?.embeddingJobs?.findIndex(
      (candidate) => candidate.id === request.params.jobId,
    ) ?? -1;
    const previous = index >= 0 ? document!.embeddingJobs![index] : undefined;
    const profile = previous
      ? embeddingProfiles.find((candidate) => candidate.id === previous.profileId)
      : undefined;
    if (!batch || !document?.reviewState.draft || !previous || !profile)
      return reply.code(404).send({ error: "Embedding 任务不存在或已过期" });
    if (!previous.summary.failed)
      return { job: publicEmbeddingJobForDocument(document, previous), reused: true };
    const job = await runEmbeddingJob({
      documentId: document.id,
      chunks: document.reviewState.draft.chunks,
      profile,
      previous,
      at: new Date().toISOString(),
      metadata: {
        spuId: document.spuId,
        targetSpuIds: confirmedSpuIds(document),
        sourceDocumentVersion: document.sourceContract?.sourceDocumentVersion,
        documentType: document.spuDocumentType,
        embeddingRevision: `r${document.reviewRevision ?? 0}`,
      },
    });
    document.embeddingJobs![index] = job;
    await persistBatch(batch);
    return { job: publicEmbeddingJobForDocument(document, job), reused: false };
  },
);

app.post<{
  Params: { batchId: string; documentId: string };
  Body: { profileId?: unknown; embeddingJobId?: unknown };
}>(
  "/api/batches/:batchId/documents/:documentId/database-jobs",
  async (request, reply) => {
    const batch = await getBatch(request.params.batchId);
    const document = batch?.documents.find(
      (candidate) => candidate.id === request.params.documentId,
    );
    if (!batch || !document?.reviewState.draft)
      return reply.code(404).send({ error: "Draft 文档不存在或已过期" });
    if (typeof request.body?.profileId !== "string")
      return reply.code(400).send({ error: "请选择目标数据库" });
    const profile = databaseProfiles.find(
      (candidate) => candidate.id === request.body.profileId,
    );
    if (!profile)
      return reply.code(503).send({
        error: "目标数据库目录尚未配置。",
        code: "DATABASE_PROFILE_UNAVAILABLE",
        recovery: "请联系维护人员配置数据库 profile 后重试。",
      });
    const embeddingJob = typeof request.body.embeddingJobId === "string"
      ? document.embeddingJobs?.find(
          (candidate) => candidate.id === request.body.embeddingJobId,
        )
      : document.embeddingJobs?.at(-1);
    if (!embeddingJob)
      return reply.code(409).send({ error: "请先完成 Embedding 任务" });
    if (publicEmbeddingJobForDocument(document, embeddingJob).stale)
      return reply.code(409).send({ error: "文档切分或内容已变化，请重新向量化后入库", code: "EMBEDDING_STALE" });
    const key = databaseIdempotencyKey(
      document.id,
      embeddingJob,
      profile,
      document.reviewState.draft.chunks,
      {
        spuId: document.spuId,
        sourceDocumentVersion: document.sourceContract?.sourceDocumentVersion,
        documentType: document.spuDocumentType,
        embeddingRevision: `r${document.reviewRevision ?? 0}`,
        targetSpuIds: confirmedSpuIds(document),
      },
    );
    const existing = document.databaseJobs?.slice().reverse().find(
      (candidate) => candidate.idempotencyKey === key,
    );
    // Historical success cannot prove rows still exist after another configuration replaced them.
    if (existing && existing.id === document.databaseJobs?.at(-1)?.id)
      return { job: existing, reused: true };
    const job = await runDatabaseJob({
      documentId: document.id,
      chunks: document.reviewState.draft.chunks,
      configuration: document.reviewState.draft.configuration,
      embeddingJob,
      profile,
      at: new Date().toISOString(),
      metadata: {
        spuId: document.spuId,
        sourceDocumentVersion: document.sourceContract?.sourceDocumentVersion,
        documentType: document.spuDocumentType,
        embeddingRevision: `r${document.reviewRevision ?? 0}`,
        targetSpuIds: confirmedSpuIds(document),
      },
    });
    document.databaseJobs = [...(document.databaseJobs ?? []), job].slice(-20);
    await persistBatch(batch);
    return { job, reused: false };
  },
);

app.get<{
  Params: { batchId: string; documentId: string; jobId: string };
}>(
  "/api/batches/:batchId/documents/:documentId/database-jobs/:jobId",
  async (request, reply) => {
    const batch = await getBatch(request.params.batchId);
    const document = batch?.documents.find(
      (candidate) => candidate.id === request.params.documentId,
    );
    const job = document?.databaseJobs?.find(
      (candidate) => candidate.id === request.params.jobId,
    );
    return batch && document && job
      ? { job }
      : reply.code(404).send({ error: "数据库任务不存在或已过期" });
  },
);

app.post<{
  Params: { batchId: string; documentId: string; jobId: string };
}>(
  "/api/batches/:batchId/documents/:documentId/database-jobs/:jobId/retry",
  async (request, reply) => {
    const batch = await getBatch(request.params.batchId);
    const document = batch?.documents.find(
      (candidate) => candidate.id === request.params.documentId,
    );
    const index = document?.databaseJobs?.findIndex(
      (candidate) => candidate.id === request.params.jobId,
    ) ?? -1;
    const previous = index >= 0 ? document!.databaseJobs![index] : undefined;
    const profile = previous
      ? databaseProfiles.find((candidate) => candidate.id === previous.profileId)
      : undefined;
    const embeddingJob = previous
      ? document?.embeddingJobs?.find(
          (candidate) => candidate.id === previous.embeddingJobId,
        )
      : undefined;
    if (!batch || !document?.reviewState.draft || !previous || !profile || !embeddingJob)
      return reply.code(404).send({ error: "数据库任务不存在或已过期" });
    if (publicEmbeddingJobForDocument(document, embeddingJob).stale)
      return reply.code(409).send({ error: "文档切分或内容已变化，请重新向量化后入库", code: "EMBEDDING_STALE" });
    if (previous.id !== document.databaseJobs?.at(-1)?.id)
      return reply.code(409).send({ error: "该任务已被后续入库替代，请重新提交入库", code: "DATABASE_JOB_SUPERSEDED" });
    if (previous.status === "completed") return { job: previous, reused: true };
    const job = await runDatabaseJob({
      documentId: document.id,
      chunks: document.reviewState.draft.chunks,
      configuration: document.reviewState.draft.configuration,
      embeddingJob,
      profile,
      previous,
      at: new Date().toISOString(),
      metadata: {
        spuId: document.spuId,
        sourceDocumentVersion: document.sourceContract?.sourceDocumentVersion,
        documentType: document.spuDocumentType,
        embeddingRevision: `r${document.reviewRevision ?? 0}`,
        targetSpuIds: confirmedSpuIds(document),
      },
    });
    document.databaseJobs![index] = job;
    await persistBatch(batch);
    return { job, reused: false };
  },
);

app.get<{
  Params: { batchId: string; documentId: string };
  Querystring: { profileId?: string };
}>(
  "/api/batches/:batchId/documents/:documentId/database-records",
  async (request, reply) => {
    const batch = await getBatch(request.params.batchId);
    const document = batch?.documents.find(
      (candidate) => candidate.id === request.params.documentId,
    );
    const profile = databaseProfiles.find(
      (candidate) => candidate.id === request.query.profileId,
    );
    if (!batch || !document)
      return reply.code(404).send({ error: "文档不存在或已过期" });
    if (!profile)
      return reply.code(503).send({ error: "目标数据库目录尚未配置" });
    try {
      return { records: await profile.repository.list(profile.targetId, document.id) };
    } catch {
      return reply.code(502).send({
        error: "目标数据库查询失败",
        recovery: "请确认本地 PostgreSQL 健康后重试。",
      });
    }
  },
);

app.post<{
  Params: { batchId: string; documentId: string };
  Body: { profileId?: unknown; confirm?: unknown };
}>(
  "/api/batches/:batchId/documents/:documentId/database-gc",
  async (request, reply) => {
    const batch = await getBatchForLifecycle(request.params.batchId);
    const document = batch?.documents.find(
      (candidate) => candidate.id === request.params.documentId,
    );
    if (!batch || !document)
      return reply.code(404).send({ error: "文档维护元数据不存在" });
    if (request.body?.confirm !== true)
      return reply.code(409).send({
        error: "数据库物理清理需要显式确认",
        code: "DATABASE_GC_CONFIRMATION_REQUIRED",
      });
    if (typeof request.body.profileId !== "string")
      return reply.code(400).send({ error: "缺少数据库 profile" });
    const profile = databaseProfiles.find(
      (candidate) => candidate.id === request.body.profileId,
    );
    if (!profile)
      return reply.code(503).send({ error: "目标数据库目录尚未配置" });
    if (profile.schemaVersion !== "2.0")
      return reply.code(409).send({
        error: "目标数据库不支持延迟物理清理",
        code: "DATABASE_GC_UNSUPPORTED_SCHEMA",
      });
    try {
      const deleted = await profile.repository.garbageCollect(
        profile.targetId,
        document.id,
        new Date().toISOString(),
      );
      return { profileId: profile.id, documentId: document.id, deleted, reused: deleted === 0 };
    } catch {
      return reply.code(502).send({
        error: "目标数据库物理清理失败",
        code: "DATABASE_GC_FAILED",
      });
    }
  },
);

app.get<{
  Params: { batchId: string };
  Querystring: { contractVersion?: string };
}>(
  "/api/batches/:batchId/export",
  async (request, reply) => {
    const batch = await getBatch(request.params.batchId);
    if (!batch) return reply.code(404).send({ error: "批次不存在或已过期" });
    const selected = parseExportContract(request.query.contractVersion);
    try {
      const exportPayload = buildBatchExport(
        projectRuntimeBatchExport(batch, {
          exportedAt: new Date().toISOString(),
          ...(selected ? { selectedContractVersion: selected } : {}),
          embeddingModel,
        }),
      );
      if (!assetObjectStore)
        return reply.code(503).send({ error: "对象存储尚未配置，导出未持久化" });
      const stored = await putJsonAsset(assetObjectStore, {
        assetClass: "export_package",
        value: exportPayload,
        batchId: batch.id,
        assetVersion: `contract-${selected ?? "auto"}-v1`,
      });
      if (!(batch.exportAssets ?? []).some((asset) => asset.key === stored.reference.key)) {
        batch.exportAssets = [...(batch.exportAssets ?? []), stored.reference].slice(-100);
        await persistBatch(batch);
      }
      return exportPayload;
    } catch (error) {
      if (error instanceof ExportContractSelectionError)
        return reply.code(409).send({
          error: "该批次包含多种契约，请选择导出格式",
          code: error.code,
          availableContractVersions: error.availableContractVersions,
        });
      return reply.code(409).send({
        error: error instanceof Error ? error.message : "导出契约无效",
        code: "EXPORT_CONTRACT_INVALID",
      });
    }
  },
);

app.post<{ Params: { batchId: string; documentId: string } }>(
  "/api/batches/:batchId/documents/:documentId/diagnostic-package",
  async (request, reply) => {
    const document = await getDocument(request.params.batchId, request.params.documentId);
    if (!document)
      return reply.code(404).send({ error: "文档不存在或已过期" });
    const issues = diagnosticIssuesFor(document);
    if (!issues.length)
      return reply.code(409).send({
        error: "当前文档没有可用的诊断包",
        code: "DIAGNOSTIC_NOT_AVAILABLE",
      });
    const packageId = randomUUID();
    const diagnostic = buildDiagnosticPackage({
      batchId: request.params.batchId,
      documentId: document.id,
      generatedAt: new Date().toISOString(),
      sourceFingerprint:
        document.sourceContract?.sourceDocumentVersion ?? "unavailable",
      issues,
      versions: {
        parserVersion: document.parsedDocumentV21?.parserVersion,
        normalizerVersion: document.parsedDocumentV21?.normalizerVersion,
        converterVersion:
          document.sourceContract?.visualCopy.state === "ready"
            ? document.sourceContract.visualCopy.converterVersion
            : undefined,
      },
      status: {
        parseState: document.state,
        visualCopyState: document.sourceContract?.visualCopy.state,
      },
      raw: {
        fullMarkdown: document.markdown,
        contentList: document.rawContentList,
      },
    });
    if (!assetObjectStore)
      return reply.code(503).send({ error: "对象存储尚未配置，诊断包未生成" });
    const stored = await putJsonAsset(assetObjectStore, {
      assetClass: "diagnostic_package",
      value: diagnostic,
      batchId: request.params.batchId,
      documentId: document.id,
      sourceDocumentVersion: document.sourceContract?.sourceDocumentVersion,
      assetVersion: packageId,
    });
    document.diagnosticPackageAssets = [
      ...(document.diagnosticPackageAssets ?? []),
      { packageId, reference: stored.reference },
    ].slice(-20);
    const batch = await getBatch(request.params.batchId);
    if (batch) await persistBatch(batch);
    return reply.code(201).send({
      packageId,
      expiresAt: diagnostic.expiresAt,
      downloadUrl: `/api/batches/${request.params.batchId}/documents/${document.id}/diagnostic-packages/${packageId}`,
    });
  },
);

app.get<{ Params: { batchId: string; documentId: string; packageId: string } }>(
  "/api/batches/:batchId/documents/:documentId/diagnostic-packages/:packageId",
  async (request, reply) => {
    const document = await getDocument(request.params.batchId, request.params.documentId);
    const reference = document?.diagnosticPackageAssets?.find(
      (candidate) => candidate.packageId === request.params.packageId,
    )?.reference;
    if (!document || !reference || !assetObjectStore)
      return reply.code(404).send({
        error: "诊断包不存在",
        code: "DIAGNOSTIC_PACKAGE_NOT_FOUND",
      });
    if (reference.expiresAt && Date.parse(reference.expiresAt) <= Date.now())
      return reply.code(410).send({
        error: "诊断包已过期，请重新生成",
        code: "DIAGNOSTIC_PACKAGE_EXPIRED",
      });
    const persisted = await assetObjectStore.head(reference.key);
    if (!persisted)
      return reply.code(404).send({
        error: "诊断包不存在",
        code: "DIAGNOSTIC_PACKAGE_NOT_FOUND",
      });
    const diagnostic = await readJsonAsset<DiagnosticPackage>(persisted);
    if (
      diagnostic.batchId !== request.params.batchId ||
      diagnostic.documentId !== request.params.documentId
    )
      return reply.code(404).send({
        error: "诊断包不存在",
        code: "DIAGNOSTIC_PACKAGE_NOT_FOUND",
      });
    reply.type("application/json");
    return diagnostic;
  },
);

app.get<{ Params: { batchId: string; documentId: string } }>(
  "/api/batches/:batchId/documents/:documentId/source",
  async (request, reply) => {
    const document = await getDocument(
      request.params.batchId,
      request.params.documentId,
    );
    if (!document?.sourceAsset)
      return reply.code(404).send({ error: "原始文件不可用" });
    reply.type(document.sourceAsset.mimeType);
    reply.header("Accept-Ranges", "bytes");
    const total = document.sourceAsset.objectReference?.byteLength
      ?? (document.sourceAsset.path ? (await stat(document.sourceAsset.path)).size : 0);
    const range = parseByteRange(request.headers.range, total);
    if (!range) {
      const bytes = await assetBytes(document.sourceAsset);
      reply.header("Content-Length", String(bytes.byteLength));
      return reply.send(Buffer.from(bytes));
    }
    const bytes = document.sourceAsset.objectReference && assetObjectStore?.getRange
      ? await assetObjectStore.getRange(document.sourceAsset.objectReference.key, range.start, range.end)
      : new Uint8Array(await readFile(document.sourceAsset.path!)).slice(range.start, range.end + 1);
    reply.code(206);
    reply.header("Content-Range", `bytes ${range.start}-${range.end}/${total}`);
    reply.header("Content-Length", String(bytes.byteLength));
    return reply.send(Buffer.from(bytes));
  },
);

app.delete<{
  Params: { batchId: string; documentId: string };
  Body: { confirm?: unknown };
}>("/api/batches/:batchId/documents/:documentId", async (request, reply) => {
  const batch = await getBatch(request.params.batchId);
  const document = batch?.documents.find(
    (candidate) => candidate.id === request.params.documentId,
  );
  if (!batch || !document)
    return reply.code(404).send({ error: "文档不存在或已过期" });
  if (request.body?.confirm !== true)
    return reply.code(409).send({
      error: "删除文档需要显式确认",
      code: "DOCUMENT_DELETE_CONFIRMATION_REQUIRED",
    });
  if (!assetObjectStore)
    return reply.code(503).send({ error: "对象存储尚未配置" });
  const reused = Boolean(document.deletedAt);
  const at = document.deletedAt ?? new Date().toISOString();
  const graceMs = nonNegativeInteger(process.env.OBJECT_DELETE_GRACE_MS, 24 * 60 * 60 * 1000);
  const deleteAfter = document.deleteAfter ?? new Date(Date.parse(at) + graceMs).toISOString();
  const databaseSoftDeleted: Array<{ profileId: string; count: number }> = [];
  const databaseFailures: Array<{ profileId: string; code: "DATABASE_SOFT_DELETE_FAILED" }> = [];
  for (const profile of databaseProfiles.filter((candidate) => candidate.schemaVersion === "2.0")) {
    try {
      databaseSoftDeleted.push({
        profileId: profile.id,
        count: await profile.repository.softDeleteDocument(
          profile.targetId,
          document.id,
          at,
          deleteAfter,
        ),
      });
    } catch {
      databaseFailures.push({ profileId: profile.id, code: "DATABASE_SOFT_DELETE_FAILED" });
    }
  }
  if (databaseFailures.length)
    return reply.code(502).send({
      error: "文档数据库记录软删除失败",
      code: "DOCUMENT_DATABASE_SOFT_DELETE_FAILED",
      failures: databaseFailures,
    });
  if (reused)
    return {
      deletedAt: document.deletedAt,
      deleteAfter: document.deleteAfter,
      databaseSoftDeleted,
      reused: true,
    };
  const objects = await assetObjectStore.list({
    batchId: batch.id,
    documentId: document.id,
    includeDeleted: true,
  });
  for (const object of objects) {
    const activeReferenceCount = countActiveObjectReferences(batch, object.key, document.id);
    await assetObjectStore.softDelete(object.key, {
      at,
      deleteAfter,
      activeReferenceCount,
      reason: "document_delete",
    });
  }
  document.deletedAt = at;
  document.deleteAfter = deleteAfter;
  await persistBatch(batch);
  return {
    deletedAt: at,
    deleteAfter,
    objectCount: objects.length,
    databaseSoftDeleted,
    reused: false,
  };
});

app.post<{
  Params: { batchId: string };
  Body: { prefix?: unknown; confirm?: unknown };
}>("/api/batches/:batchId/object-lifecycle-sweep", async (request, reply) => {
  const batch = await getBatchForLifecycle(request.params.batchId);
  if (!batch) return reply.code(404).send({ error: "批次元数据不存在" });
  if (request.body?.confirm !== true)
    return reply.code(409).send({
      error: "生命周期扫描需要显式确认",
      code: "LIFECYCLE_SWEEP_CONFIRMATION_REQUIRED",
    });
  if (!assetObjectStore || typeof request.body?.prefix !== "string")
    return reply.code(400).send({ error: "缺少专用生命周期 prefix" });
  const prefixParts = request.body.prefix.split("/").filter(Boolean);
  if (
    prefixParts.length < 3 ||
    prefixParts[0] !== "v1" ||
    prefixParts[2] !== batch.id ||
    !request.body.prefix.endsWith("/")
  )
    return reply.code(409).send({
      error: "生命周期 prefix 必须限定到当前专用 batch 和资产类",
      code: "LIFECYCLE_SCOPE_TOO_BROAD",
    });
  return sweepAssetLifecycle(assetObjectStore, {
    now: new Date().toISOString(),
    allowedPrefix: request.body.prefix,
    references: await lifecycleReferencesForBatch(batch, request.body.prefix),
    deleteGraceMs: nonNegativeInteger(
      process.env.OBJECT_DELETE_GRACE_MS,
      24 * 60 * 60 * 1000,
    ),
  });
});

app.post<{
  Params: { batchId: string };
  Body: { prefix?: unknown };
}>("/api/batches/:batchId/object-gc", async (request, reply) => {
  const batch = await getBatch(request.params.batchId);
  if (!batch) return reply.code(404).send({ error: "批次不存在或已过期" });
  if (!assetObjectStore || typeof request.body?.prefix !== "string")
    return reply.code(400).send({ error: "缺少专用 GC prefix" });
  if (!request.body.prefix.includes(`/${batch.id}/`))
    return reply.code(409).send({
      error: "GC prefix 必须限定到当前专用 batch",
      code: "GC_SCOPE_TOO_BROAD",
    });
  return assetObjectStore.collectGarbage({
    now: new Date().toISOString(),
    allowedPrefix: request.body.prefix,
  });
});

app.setErrorHandler((error, _request, reply) => {
  const statusCode =
    typeof error === "object" &&
    error &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
      ? error.statusCode
      : 502;
  app.log.error(
    {
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorCode: typeof error === "object" && error && "code" in error
        ? String(error.code)
        : undefined,
      errorMessage: safeTechnicalErrorMessage(error),
      statusCode: statusCode < 500 ? statusCode : 502,
    },
    "request failed",
  );
  const code = typeof error === "object" && error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
  if (statusCode >= 500)
    return reply.code(502).send({
      error: "服务器处理请求时发生意外错误，当前操作未完成。",
      code: "INTERNAL_SERVER_ERROR",
      recovery: "请稍后重试；若问题持续，请联系维护人员并提供发生时间。",
    });
  const manualDetails = code && [
    "EMPTY_BBOX_INTERSECTION",
    "BBOX_UNTRUSTED",
    "SOURCE_BLOCK_MISSING",
    "ANNOTATION_BBOX_INVALID",
  ].includes(code) && typeof error === "object" && error && "details" in error
    ? error.details
    : undefined;
  reply.code(statusCode).send({
    error: error instanceof Error ? error.message : "请求失败",
    ...(code ? { code } : {}),
    ...(manualDetails ? { details: manualDetails } : {}),
  });
});

function safeTechnicalErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/[^\s'"\r\n]+/gi, "[redacted-url]")
    .replace(/[a-zA-Z]:\\[^'"\r\n]+/g, "[redacted-path]")
    .replace(/(?:\/[^\/\s'"\r\n]+){2,}/g, "[redacted-path]")
    .replace(/(authorization|cookie)\s*[:=]\s*[^\r\n]+/gi, "$1=[redacted]")
    .replace(
      /(api[_-]?key|token)\s*[:=]\s*[^&\s,;]+/gi,
      "$1=[redacted]",
    );
}

function validEffectiveAnnotation(value: unknown): value is EffectiveManualAnnotation {
  if (!value || typeof value !== "object") return false;
  const annotation = value as Partial<EffectiveManualAnnotation>;
  return typeof annotation.id === "string" &&
    Array.isArray(annotation.sourceBlockIds) && annotation.sourceBlockIds.every((id) => typeof id === "string") &&
    Number.isSafeInteger(annotation.page) && annotation.page! > 0 &&
    Array.isArray(annotation.bbox) && annotation.bbox.length === 4 && annotation.bbox.every(Number.isFinite) &&
    typeof annotation.type === "string" && Number.isFinite(annotation.readingOrder) &&
    (annotation.layer === "detection" || annotation.layer === "manual");
}

function validPersistedAnnotation(value: unknown): value is EffectiveManualAnnotation {
  if (!validEffectiveAnnotation(value)) return false;
  const annotation = value as EffectiveManualAnnotation & {
    groupMembers?: unknown[];
    transcriptionSource?: unknown;
    manualText?: unknown;
  };
  if (
    annotation.manualText !== undefined &&
    typeof annotation.manualText !== "string"
  ) return false;
  if (
    annotation.transcriptionSource !== undefined &&
    annotation.transcriptionSource !== "human"
  ) return false;
  return annotation.groupMembers === undefined ||
    (Array.isArray(annotation.groupMembers) &&
      annotation.groupMembers.every(validPersistedAnnotation));
}

function validDetectionExclusionOverrides(value: unknown): value is Record<string, boolean> {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((item) => typeof item === "boolean");
}

function parseConfig(value: string): ParseConfig {
  const input = JSON.parse(value) as Partial<ParseConfig>;
  return {
    modelVersion: input.modelVersion === "pipeline" ? "pipeline" : "vlm",
    language: typeof input.language === "string" ? input.language : "ch",
    enableFormula: input.enableFormula !== false,
    enableTable: input.enableTable !== false,
    isOcr: input.isOcr === true,
  };
}

function parseConfigDefaults(): ParseConfig {
  return {
    modelVersion: "vlm",
    language: "ch",
    enableFormula: true,
    enableTable: true,
    isOcr: false,
  };
}

function fieldValue(input: unknown): string | undefined {
  const field = Array.isArray(input) ? input[0] : input;
  return field &&
    typeof field === "object" &&
    "value" in field &&
    typeof field.value === "string"
    ? field.value
    : undefined;
}

function parseChunkIds(input: unknown): string[] {
  if (!Array.isArray(input) || input.some((id) => typeof id !== "string"))
    throw Object.assign(new Error("chunkIds 必须是字符串数组"), {
      statusCode: 400,
    });
  return [...new Set(input)];
}

function parseExportContract(
  value: string | undefined,
): ExportContractVersion | undefined {
  if (value === undefined) return undefined;
  if (value === "2.1" || value === "legacy") return value;
  throw Object.assign(new Error("不支持的导出契约"), { statusCode: 400 });
}

function diagnosticIssuesFor(document: DocumentRecord) {
  const categories = [
    ...(document.diagnosticCategories ?? []),
    ...(hasBboxPageAnomaly(document.rawContentList, document.sourceMapping)
      ? (["bbox_page_anomaly"] as const)
      : []),
    ...(document.sourceContract?.visualCopy.state === "failed"
      ? (["visual_conversion_failed"] as const)
      : []),
  ];
  return [...new Set(categories)].map((category) => ({
    category,
    message:
      category === "bbox_page_anomaly"
        ? "MinerU bbox 或页码超出可信页面映射"
        : category === "visual_conversion_failed"
          ? document.sourceContract?.visualCopy.state === "failed"
            ? document.sourceContract.visualCopy.error
            : "Visual Copy 转换失败"
          : document.error ?? "文档解析失败",
  }));
}

function parserVersionFor(blocks: ParsedBlock[]): string | null {
  const values = [
    ...new Set(
      blocks
        .map((block) => block.sourceVersion)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  return values.length ? values.join(",") : null;
}

async function expireTimedOutDocuments(batch: BatchRecord): Promise<void> {
  const now = Date.now();
  for (const document of batch.documents) {
    if (
      (document.state !== "pending" && document.state !== "running") ||
      !document.parseStartedAt
    )
      continue;
    const startedAt = Date.parse(document.parseStartedAt);
    if (!Number.isFinite(startedAt) || now - startedAt < parseTimeoutMs) continue;
    document.state = "failed";
    document.error = `MinerU 解析超时（超过 ${parseTimeoutMs}ms）`;
    document.diagnosticCategories = ["parse_failed"];
    if (document.parseCacheKey && parseCacheService) {
      const record = await parseCacheService.fail(document.parseCacheKey, document.error);
      document.parseCacheStatus = record.status;
    }
  }
}

function markdownBlocks(markdown: string): ParsedBlock[] {
  return markdown
    .split(/\n{2,}/)
    .map((text, index) => ({
      id: `b-${index + 1}`,
      type: /^\|/.test(text) ? ("table" as const) : ("text" as const),
      text: text.replace(/^#+\s*/, "").trim(),
      page: null,
      bbox: null,
      readingOrder: index,
      role: /^#+\s/.test(text)
        ? ("heading" as const)
        : /^\|/.test(text)
          ? ("table" as const)
          : ("paragraph" as const),
      sourceBackend: "markdown",
      sourceVersion: "commonmark-basic-v1",
    }))
    .filter((block) => block.text);
}

function publicBatch(batch: BatchRecord) {
  return buildPublicBatch({
    ...batch,
    documents: batch.documents.map((document) =>
      hasBboxPageAnomaly(document.rawContentList, document.sourceMapping)
        ? {
            ...document,
            diagnosticCategories: [
              ...(document.diagnosticCategories ?? []),
              "bbox_page_anomaly" as const,
            ],
          }
        : document,
    ),
  });
}

async function applySucceededParseCache(
  document: DocumentRecord,
  record: ParseCacheRecord,
): Promise<void> {
  if (!assetObjectStore || !record.parsedDocumentAssetRef)
    throw new Error("解析缓存缺少持久化 Parsed Document 资产");
  document.parsedDocumentAsset = record.parsedDocumentAssetRef;
  document.parsedDocumentV21 = await readJsonAsset<V21ParsedDocument & { blocks: ParsedDocumentBlock[] }>(record.parsedDocumentAssetRef);
  const trustedResultRef = record.trustedResultAssetRef ?? record.mineruResultAssetRef;
  if (trustedResultRef) {
    try {
      const trusted = await readJsonAsset<{ markdown: string; blocks: ParsedBlock[]; rawContentList?: unknown[] }>(trustedResultRef);
      document.markdown = trusted.markdown;
      document.blocks = trusted.blocks;
      document.rawContentList = trusted.rawContentList;
      document.trustedResultAsset = trustedResultRef;
      document.contentListAsset = trustedResultRef;
    } catch {
      // Parsed Document remains the authoritative reusable result.
    }
  }
  document.state = "done";
  document.parseCacheStatus = "succeeded";
  document.sourceContract!.parseState = "done";
  document.sourceContract!.parseJobId = record.mineruBatchId;
}

function copyParsedResult(source: DocumentRecord, target: DocumentRecord): void {
  target.state = source.state;
  target.error = source.error;
  target.progress = source.progress;
  target.markdown = source.markdown;
  target.blocks = source.blocks;
  target.rawContentList = source.rawContentList;
  target.parsedDocumentV21 = source.parsedDocumentV21;
  target.parsedDocumentAsset = source.parsedDocumentAsset;
  target.trustedResultAsset = source.trustedResultAsset;
  target.contentListAsset = source.contentListAsset;
  target.mineruZipAsset = source.mineruZipAsset;
  target.parseCacheStatus = source.parseCacheStatus;
  target.parseCacheReused = true;
  target.sourceContract = target.sourceContract
    ? { ...target.sourceContract, parseState: source.state === "done" ? "done" : "pending", parseJobId: source.sourceContract?.parseJobId ?? null }
    : target.sourceContract;
}

function cacheAssetIdentity(document: DocumentRecord, fallbackBatchId = "parse-cache"):
  { batchId: string; documentId?: string } {
  const content = document.contentSha256;
  if (!content) return { batchId: fallbackBatchId, documentId: document.id };
  return { batchId: `parse-cache-${content.slice(0, 32)}` };
}

async function generateVisualCopy(
  document: DocumentRecord,
  availableSourcePath?: string,
): Promise<void> {
  if (!document.sourceAsset || !document.sourceContract) return;
  const current = document.sourceContract.visualCopy;
  if (current.state !== "generating") return;
  const materialized = availableSourcePath
    ? { path: availableSourcePath, cleanup: async () => undefined }
    : await materializeAsset(document.sourceAsset, document.name);
  const outputPath = materialized.path.replace(/\.[^.]+$/, ".visual.pdf");
  try {
    if (process.env.T02_FAKE_VISUAL_COPY_FAILURE === "1")
      throw new Error("deterministic visual copy failure");
    const result = await createOfficeVisualCopy({
      sourcePath: materialized.path,
      outputPath,
    });
    if (!assetObjectStore) throw new Error("object store unavailable");
    const stored = await assetObjectStore.put({
      assetClass: "office_visual_copy",
      bytes: new Uint8Array(await readFile(result.outputPath)),
      contentType: "application/pdf",
      batchId: document.sourceAsset.objectReference?.batchId ?? "runtime-batch",
      documentId: document.id,
      sourceDocumentVersion: document.sourceContract.sourceDocumentVersion,
      assetVersion: `visual-copy-${current.retryTicket}`,
      extension: "pdf",
    });
    document.visualCopyAsset = {
      mimeType: "application/pdf",
      objectReference: stored.reference,
    };
    document.sourceContract.visualCopy = finishVisualCopy(current, {
      converter: result.converter,
      converterVersion: result.converterVersion,
      pageDimensions: [],
      coordinateMapping: null,
      mappingVersion: "unavailable",
    });
    document.sourceContract.sourceViewKind = "visual_copy";
  } catch (error) {
    delete document.visualCopyAsset;
    document.sourceContract.visualCopy = finishVisualCopy(
      current,
      error instanceof Error ? error : new Error("Visual Copy failed"),
    );
    document.sourceContract.sourceViewKind = "parsed_document";
  } finally {
    await rm(outputPath, { force: true });
    await materialized.cleanup();
  }
}

function hydrateMineruV21(document: DocumentRecord): void {
  if (
    document.parsedDocumentV21 ||
    !document.rawContentList ||
    !document.sourceContract
  )
    return;
  document.parsedDocumentV21 = buildMineruParsedDocument(
    document.rawContentList.filter(
      (value): value is Record<string, unknown> =>
        Boolean(value) && typeof value === "object",
    ),
    {
      sourceDocumentVersion: document.sourceContract.sourceDocumentVersion,
      parserVersion: parserVersionFor(document.blocks ?? []) ?? "mineru-unknown",
      sourceViewKind: classifySource(document.name).requiresVisualCopy
        ? "visual_copy"
        : "original_file",
      sourceMapping: document.sourceMapping,
    },
  );
}

const MINERU_CONTENT_LIST_BBOX_SIZE = 1000;
const MINERU_PDF_MAPPING_PREFIX = "mineru-content-list-1000+pdfjs-";

async function sourceMappingFromPdf(
  path: string,
  sourceDocumentVersion: string,
  documentName: string,
): Promise<SourcePageMapping | undefined> {
  try {
    const pdf = await pdfjsLib.getDocument({
      data: new Uint8Array(await readFile(path)),
    }).promise;
    const pages: SourcePageMapping["pages"] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const view = page.view as number[];
      if (view.length !== 4 || view.some((value) => !Number.isFinite(value))) return undefined;
      const [x0, y0, x1, y1] = view;
      const pageWidth = x1 - x0;
      const pageHeight = y1 - y0;
      const rotation = ((page.rotate % 360) + 360) % 360;
      if (![0, 90, 180, 270].includes(rotation)) return undefined;
      pages.push({
        page: pageNumber,
        pageWidth,
        pageHeight,
        bboxPageWidth: MINERU_CONTENT_LIST_BBOX_SIZE,
        bboxPageHeight: MINERU_CONTENT_LIST_BBOX_SIZE,
        coordinateUnit: "mineru_normalized_1000",
        coordinateOrigin: "top-left",
        orientation: rotation as 0 | 90 | 180 | 270,
        transform: [
          pageWidth / MINERU_CONTENT_LIST_BBOX_SIZE,
          0,
          0,
          pageHeight / MINERU_CONTENT_LIST_BBOX_SIZE,
          x0,
          y0,
        ],
        mediaBox: [x0, y0, x1, y1],
        cropBox: [x0, y0, x1, y1],
      });
    }
    return {
      mappingVersion: `${MINERU_PDF_MAPPING_PREFIX}${pdfjsLib.version}`,
      sourceDocumentVersion,
      pages,
    };
  } catch (error) {
    app.log.warn(
      {
        documentName,
        error: error instanceof Error ? error.message : String(error),
      },
      "PDF source mapping failed",
    );
    return undefined;
  }
}

async function recoverMissingPdfMapping(document: DocumentRecord): Promise<boolean> {
  if (
    document.sourceMapping?.mappingVersion.startsWith(MINERU_PDF_MAPPING_PREFIX) ||
    !document.sourceAsset ||
    !document.sourceContract ||
    !document.rawContentList ||
    !/\.pdf$/i.test(document.name) ||
    document.reviewState.preview ||
    document.reviewState.draft
  )
    return false;
  let materialized;
  try {
    materialized = await materializeAsset(document.sourceAsset, document.name);
  } catch {
    app.log.warn({ documentName: document.name }, "PDF source mapping recovery skipped: object unavailable");
    return false;
  }
  const currentSourceVersion = await sourceVersionFromFile(materialized.path);
  if (currentSourceVersion !== document.sourceContract.sourceDocumentVersion) {
    app.log.warn({ documentName: document.name }, "PDF source mapping recovery skipped: source version mismatch");
    await materialized.cleanup();
    return false;
  }
  const sourceMapping = await sourceMappingFromPdf(
    materialized.path,
    currentSourceVersion,
    document.name,
  );
  await materialized.cleanup();
  if (!sourceMapping) return false;
  document.sourceMapping = sourceMapping;
  document.parsedDocumentV21 = buildMineruParsedDocument(
    document.rawContentList.filter(
      (value): value is Record<string, unknown> =>
        Boolean(value) && typeof value === "object",
    ),
    {
      sourceDocumentVersion: currentSourceVersion,
      parserVersion:
        document.parsedDocumentV21?.parserVersion ??
        parserVersionFor(document.blocks ?? []) ??
        "mineru-unknown",
      sourceViewKind: "original_file",
      sourceMapping,
    },
  );
  return true;
}

async function persistBatch(batch: BatchRecord): Promise<void> {
  if (assetObjectStore) {
    for (const document of batch.documents) {
      await persistDocumentObjects(batch.id, document);
    }
  }
  const metadata = structuredClone(batch);
  const referencesAreDurable = assetObjectStore !== null &&
    !(assetObjectStore instanceof MemoryAssetObjectStore);
  for (const document of metadata.documents) {
    if (referencesAreDurable && document.sourceAsset?.objectReference)
      delete document.sourceAsset.path;
    if (referencesAreDurable && document.visualCopyAsset?.objectReference)
      delete document.visualCopyAsset.path;
    if (referencesAreDurable && document.trustedResultAsset) {
      delete document.markdown;
      delete document.blocks;
    }
    if (referencesAreDurable && document.contentListAsset)
      delete document.rawContentList;
    if (referencesAreDurable && document.parsedDocumentAsset)
      delete document.parsedDocumentV21;
  }
  await workspaceStore.writeBatch(batch.id, metadata);
}

async function recordMineruResponse(
  batch: BatchRecord,
  kind: "submission" | "poll",
  response: unknown,
): Promise<void> {
  if (!assetObjectStore) return;
  const stored = await putJsonAsset(assetObjectStore, {
    assetClass: "mineru_raw_response",
    value: sanitizePersistentValue(response),
    batchId: batch.id,
    assetVersion: `${kind}-v1`,
  });
  const existing = batch.mineruRawResponseAssets ?? [];
  if (!existing.some((reference) => reference.key === stored.reference.key))
    batch.mineruRawResponseAssets = [...existing, stored.reference].slice(-100);
}

async function persistDocumentObjects(
  batchId: string,
  document: DocumentRecord,
): Promise<void> {
  if (!assetObjectStore) return;
  const sourceVersion = document.sourceContract?.sourceDocumentVersion ?? null;
  const resultIdentity = cacheAssetIdentity(document, batchId);
  if (document.sourceAsset?.path && !document.sourceAsset.objectReference) {
    document.sourceAsset.objectReference = (await assetObjectStore.put({
      assetClass: "source_original",
      bytes: new Uint8Array(await readFile(document.sourceAsset.path)),
      contentType: document.sourceAsset.mimeType,
      batchId,
      documentId: document.id,
      sourceDocumentVersion: sourceVersion,
      assetVersion: "original-v1",
      extension: extensionForName(document.name),
    })).reference;
  }
  if (document.visualCopyAsset?.path && !document.visualCopyAsset.objectReference) {
    document.visualCopyAsset.objectReference = (await assetObjectStore.put({
      assetClass: "office_visual_copy",
      bytes: new Uint8Array(await readFile(document.visualCopyAsset.path)),
      contentType: "application/pdf",
      batchId,
      documentId: document.id,
      sourceDocumentVersion: sourceVersion,
      assetVersion: document.sourceContract?.visualCopy.state === "ready"
        ? document.sourceContract.visualCopy.visualCopyVersion
        : "visual-copy-v1",
      extension: "pdf",
    })).reference;
  }
  if (document.rawContentList) {
    document.contentListAsset = (await putJsonAsset(assetObjectStore, {
      assetClass: "mineru_trusted_result",
      value: sanitizePersistentValue(document.rawContentList),
      ...resultIdentity,
      sourceDocumentVersion: sourceVersion,
      assetVersion: "content-list-v1",
    })).reference;
  }
  if (document.markdown !== undefined || document.blocks !== undefined) {
    document.trustedResultAsset = (await putJsonAsset(assetObjectStore, {
      assetClass: "mineru_trusted_result",
      value: {
        markdown: document.markdown ?? "",
        blocks: document.blocks ?? [],
      },
      ...resultIdentity,
      sourceDocumentVersion: sourceVersion,
      assetVersion: "normalized-result-v1",
    })).reference;
  }
  if (document.parsedDocumentV21) {
    document.parsedDocumentAsset = (await putJsonAsset(assetObjectStore, {
      assetClass: "parsed_document_snapshot",
      value: document.parsedDocumentV21,
      ...resultIdentity,
      sourceDocumentVersion: sourceVersion,
      assetVersion: document.parsedDocumentV21.parsedDocumentVersion,
    })).reference;
  }
}

async function hydrateDocumentObjects(document: DocumentRecord): Promise<void> {
  if (!assetObjectStore) return;
  if (!document.rawContentList && document.contentListAsset)
    document.rawContentList = await readJsonAsset<unknown[]>(document.contentListAsset);
  if (!document.blocks && document.trustedResultAsset) {
    const trusted = await readJsonAsset<{ markdown: string; blocks: ParsedBlock[] }>(
      document.trustedResultAsset,
    );
    document.markdown = trusted.markdown;
    document.blocks = trusted.blocks;
  }
  if (!document.parsedDocumentV21 && document.parsedDocumentAsset)
    document.parsedDocumentV21 = await readJsonAsset<
      V21ParsedDocument & { blocks: ParsedDocumentBlock[] }
    >(document.parsedDocumentAsset);
}

async function readJsonAsset<T>(reference: AssetDescriptor): Promise<T> {
  if (!assetObjectStore) throw new Error("object store unavailable");
  return JSON.parse(new TextDecoder().decode(await assetObjectStore.get(reference.key))) as T;
}

async function putJsonAsset(
  store: AssetObjectStore,
  input: {
    assetClass: AssetClass;
    value: unknown;
    batchId: string;
    documentId?: string;
    sourceDocumentVersion?: string | null;
    assetVersion: string;
  },
) {
  return store.put({
    assetClass: input.assetClass,
    bytes: new TextEncoder().encode(JSON.stringify(input.value)),
    contentType: "application/json",
    batchId: input.batchId,
    documentId: input.documentId,
    sourceDocumentVersion: input.sourceDocumentVersion,
    assetVersion: input.assetVersion,
    extension: "json",
  });
}

function sanitizePersistentValue(value: unknown): unknown {
  if (typeof value === "string")
    return /^https?:\/\/[^\s]+(?:x-amz-|signature=|token=)/i.test(value)
      ? "[REDACTED_SIGNED_URL]"
      : /^Bearer\s+/i.test(value)
        ? "[REDACTED_CREDENTIAL]"
        : value;
  if (Array.isArray(value)) return value.map(sanitizePersistentValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !/(authorization|cookie|password|secret|api[_-]?key)/i.test(key))
    .map(([key, item]) => [key, sanitizePersistentValue(item)]));
}

function parseByteRange(value: string | undefined, total: number): { start: number; end: number } | null {
  if (!value || !Number.isSafeInteger(total) || total <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : total - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
    end = Math.min(end, total - 1);
  }
  if (start < 0 || start >= total || end < start) return null;
  return { start, end };
}

async function assetBytes(asset: {
  path?: string;
  objectReference?: AssetDescriptor;
}): Promise<Uint8Array> {
  if (asset.objectReference && assetObjectStore)
    return assetObjectStore.get(asset.objectReference.key);
  if (asset.path) return new Uint8Array(await readFile(asset.path));
  throw new Error("persistent object is unavailable");
}

async function materializeAsset(
  asset: { path?: string; objectReference?: AssetDescriptor },
  name: string,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  if (
    asset.path &&
    (!asset.objectReference || assetObjectStore instanceof MemoryAssetObjectStore)
  )
    return { path: asset.path, cleanup: async () => undefined };
  const directory = await mkdtemp(join(tmpdir(), "rag-object-"));
  const path = join(directory, `materialized.${extensionForName(name)}`);
  try {
    await writeFile(path, await assetBytes(asset));
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    path,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function extensionForName(name: string): string {
  const extension = extname(name).toLowerCase().replace(/^\./, "");
  return /^[a-z0-9]{1,12}$/.test(extension) ? extension : "bin";
}

function contentTypeForName(name: string): string {
  const extension = extensionForName(name);
  return ({
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    md: "text/markdown",
    txt: "text/plain",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}

function countActiveObjectReferences(
  batch: BatchRecord,
  key: string,
  deletingDocumentId: string,
): number {
  return batch.documents.filter((document) =>
    document.id !== deletingDocumentId &&
    !document.deletedAt &&
    valueContainsExactString(document, key, new Set<object>())
  ).length;
}

async function lifecycleReferencesForBatch(
  batch: BatchRecord,
  prefix: string,
): Promise<AssetLifecycleReference[]> {
  if (!assetObjectStore) return [];
  const objects = await assetObjectStore.list({ prefix, includeDeleted: true });
  const references: AssetLifecycleReference[] = [];
  const batchValues = [batch.mineruRawResponseAssets, batch.exportAssets];
  const batchState: AssetLifecycleReference["state"] =
    batch.documents.length > 0 && batch.documents.every((document) =>
      document.deletedAt || document.state === "failed"
    )
      ? "failed"
      : "active";
  for (const object of objects) {
    for (const document of batch.documents) {
      if (
        document.deletedAt ||
        !valueContainsExactString(document, object.key, new Set<object>())
      )
        continue;
      references.push({
        key: object.key,
        state: document.state === "failed" ? "failed" : "active",
      });
    }
    if (batchValues.some((value) =>
      valueContainsExactString(value, object.key, new Set<object>())
    ))
      references.push({ key: object.key, state: batchState });
  }
  return references;
}

function valueContainsExactString(
  value: unknown,
  expected: string,
  seen: Set<object>,
): boolean {
  if (typeof value === "string") return value === expected;
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value as Record<string, unknown>).some((item) =>
    valueContainsExactString(item, expected, seen)
  );
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function publicEmbeddingJob(job: EmbeddingJob): EmbeddingJob {
  const projected = structuredClone(job);
  for (const item of projected.items) {
    if (item.vectorRecord)
      delete (item.vectorRecord as Partial<typeof item.vectorRecord>).vector;
  }
  return projected;
}

function publicEmbeddingJobForDocument(document: DocumentRecord, job: EmbeddingJob): EmbeddingJob {
  const profile = embeddingProfiles.find((candidate) => candidate.id === job.profileId);
  if (!profile || !document.reviewState.draft) return publicEmbeddingJob(job);
  const key = embeddingIdempotencyKey(document.id, profile, document.reviewState.draft.chunks, {
    spuId: document.spuId,
    targetSpuIds: confirmedSpuIds(document),
    sourceDocumentVersion: document.sourceContract?.sourceDocumentVersion,
    documentType: document.spuDocumentType,
    embeddingRevision: `r${document.reviewRevision ?? 0}`,
  });
  const projected = publicEmbeddingJob(job);
  const staleReasons = embeddingJobStaleReasons(job, key);
  projected.stale = staleReasons.length > 0;
  projected.staleReasons = staleReasons;
  return projected;
}

async function getBatch(batchId: string): Promise<BatchRecord | undefined> {
  const existing = batches.get(batchId);
  if (existing) return existing;
  const restored = await workspaceStore.readBatch<BatchRecord>(batchId);
  if (restored) {
    for (const document of restored.documents) {
      document.reviewState = restoreReviewState(document.reviewState);
      await hydrateDocumentObjects(document);
    }
    let recovered = false;
    for (const document of restored.documents)
      recovered = (await recoverMissingPdfMapping(document)) || recovered;
    if (recovered) await persistBatch(restored);
    batches.set(batchId, restored);
  }
  return restored ?? undefined;
}

async function getBatchForLifecycle(
  batchId: string,
): Promise<BatchRecord | undefined> {
  return batches.get(batchId) ??
    (await workspaceStore.readBatchForMaintenance<BatchRecord>(batchId)) ??
    undefined;
}

async function getDocument(
  batchId: string,
  documentId: string,
): Promise<DocumentRecord | undefined> {
  return (await getBatch(batchId))?.documents.find(
    (document) => document.id === documentId,
  );
}

function tableGroupIdsFor(
  parsed: V21ParsedDocument,
  blocks: readonly ParsedBlock[],
): Record<string, string> {
  return Object.fromEntries(parsed.blocks.flatMap((block, index) => {
    const groupId = blocks[index]?.type === "table" ? blocks[index].groupId : undefined;
    return groupId ? [[block.contentBlockId, groupId]] : [];
  }));
}

function parseTableArtifact(body: {
  artifact?: unknown;
  reviewedModel?: unknown;
  sourceSegments?: unknown;
}): TableArtifact {
  const value = body.artifact ?? body.reviewedModel;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("需要 reviewedModel 或 artifact");
  const model = value as Record<string, unknown>;
  if (
    model.type !== "table" ||
    typeof model.tableId !== "string" ||
    !Array.isArray(model.columns) ||
    !Array.isArray(model.rows) ||
    !Array.isArray(model.rowGroups)
  ) throw new Error("Table Artifact 结构无效");
  const columns = model.columns.map((column) => {
    if (typeof column !== "string") throw new Error("表格列名无效");
    return column;
  });
  const rows = model.rows.map((row) => {
    if (!Array.isArray(row)) throw new Error("表格行无效");
    return row.map((cell) => {
      if (!cell || typeof cell !== "object" || Array.isArray(cell)) throw new Error("表格单元格无效");
      const value = cell as Record<string, unknown>;
      if (
        typeof value.cellId !== "string" ||
        typeof value.text !== "string" ||
        !Number.isSafeInteger(value.rowSpan) ||
        !Number.isSafeInteger(value.colSpan)
      ) throw new Error("表格单元格关系无效");
      return { cellId: value.cellId, text: value.text, rowSpan: value.rowSpan, colSpan: value.colSpan };
    });
  });
  const rowGroups = model.rowGroups.map((group) => {
    if (!group || typeof group !== "object" || Array.isArray(group)) throw new Error("表格 row group 无效");
    const value = group as Record<string, unknown>;
    if (
      typeof value.rowGroupId !== "string" ||
      typeof value.order !== "number" ||
      typeof value.repeatedHeader !== "boolean" ||
      !Array.isArray(value.sourceSegmentIds) ||
      !value.sourceSegmentIds.every((id) => typeof id === "string") ||
      !Number.isSafeInteger(value.rowStart) ||
      !Number.isSafeInteger(value.rowCount)
    ) throw new Error("表格 row group 关系无效");
    return {
      rowGroupId: value.rowGroupId,
      order: value.order as number,
      repeatedHeader: value.repeatedHeader,
      sourceSegmentIds: [...value.sourceSegmentIds] as string[],
      rowStart: value.rowStart,
      rowCount: value.rowCount,
    };
  });
  const sourceSegments = Array.isArray(body.sourceSegments)
    ? body.sourceSegments.map((segment) => {
        if (!segment || typeof segment !== "object" || Array.isArray(segment)) throw new Error("表格来源定位无效");
        const value = segment as Record<string, unknown>;
        const id = value.id ?? value.blockId ?? value.contentBlockId;
        if (typeof id !== "string") throw new Error("表格来源定位缺少 id");
        return {
          id,
          page: typeof value.page === "number" ? value.page : null,
          bbox: Array.isArray(value.bbox) ? value.bbox.map(Number) : null,
        };
      })
    : [];
  return tableArtifactFromReviewedModel({
    reviewedModel: {
      type: "table",
      tableId: model.tableId,
      ...(typeof model.title === "string" && model.title.trim() ? { title: model.title } : {}),
      columns,
      rows,
      rowGroups,
    } as ReviewedTableModel,
    sourceSegments,
  });
}

function parseTableSourceChunks(input: unknown): TableSourceChunkRelation[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error("sourceChunks 必须是数组");
  return input.map((source) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("sourceChunks 项无效");
    const value = source as Record<string, unknown>;
    if (
      typeof value.sourceChunkId !== "string" ||
      typeof value.sourceChunkVersion !== "string" ||
      !Number.isSafeInteger(value.order) ||
      typeof value.finalText !== "string"
    ) throw new Error("sourceChunks 项字段无效");
    return {
      sourceChunkId: value.sourceChunkId,
      sourceChunkVersion: value.sourceChunkVersion,
      order: value.order as number,
      finalText: value.finalText,
    };
  });
}

function validateScopedTableSources(
  sources: readonly TableSourceChunkRelation[],
  document: DocumentRecord,
): void {
  const chunks = new Map(document.reviewState.draft?.chunks.map((chunk) => [chunk.id, chunk]) ?? []);
  for (const source of sources) {
    const chunk = chunks.get(source.sourceChunkId);
    if (!chunk) throw new Error(`关联文字 Chunk 不属于当前文档：${source.sourceChunkId}`);
    if (chunk.type !== "text" || chunk.excluded)
      throw new Error(`关联来源必须是未排除的文字 Chunk：${source.sourceChunkId}`);
    const searchable = chunk as Chunk & {
      embeddingEligible?: boolean;
      embeddingExclusionReasons?: string[];
    };
    if (searchable.embeddingEligible !== true || (searchable.embeddingExclusionReasons ?? []).length)
      throw new Error(`关联文字 Chunk 当前不可检索：${source.sourceChunkId}`);
    if (source.finalText !== chunk.finalText)
      throw new Error(`关联文字 Chunk 内容已变化：${source.sourceChunkId}`);
    const segment = chunk.sourceSegments[0] as Chunk["sourceSegments"][number] & {
      parsedDocumentVersion?: string;
      sourceDocumentVersion?: string;
    };
    const currentVersion = segment?.parsedDocumentVersion ?? segment?.sourceDocumentVersion ??
      document.parsedDocumentV21?.parsedDocumentVersion ?? document.sourceContract?.sourceDocumentVersion ?? "draft";
    if (source.sourceChunkVersion !== currentVersion)
      throw new Error(`关联文字 Chunk 版本已过期：${source.sourceChunkId}`);
  }
}

function requiredTableString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new Error(`${name} 不能为空`);
  return value.trim();
}

function demoTableHtml(markdown: string): string {
  const lines = markdown.split(/\r?\n/).filter(Boolean);
  const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((value) => value.trim());
  if (lines.length < 3) return "<table></table>";
  const header = cells(lines[0]).map((value) => `<th>${escapeDemoHtml(value)}</th>`).join("");
  const body = lines.slice(2).map((line) =>
    `<tr>${cells(line).map((value) => `<td>${escapeDemoHtml(value)}</td>`).join("")}</tr>`
  ).join("");
  return `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}

function escapeDemoHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

class ImageObjectStoreUnavailableError extends Error {}
class ImageObjectStoreWriteError extends Error {}

async function ensureStoredImage(document: DocumentRecord, chunk: Chunk) {
  if (!document.sourceAsset || !document.sourceContract)
    throw new Error("Trusted source image is unavailable");
  if (!imageObjectStore) throw new ImageObjectStoreUnavailableError();
  const materialized = await materializeAsset(document.sourceAsset, document.name);
  let trustedImage;
  try {
    trustedImage = await resolveTrustedImageInput({
      sourceAsset: { path: materialized.path, mimeType: document.sourceAsset.mimeType },
      sourceDocumentVersion: document.sourceContract.sourceDocumentVersion,
      sourceSegments: trustedImageSegments(document, chunk),
    });
  } finally {
    await materialized.cleanup();
  }
  try {
    const stored = await imageObjectStore.store({
      bytes: trustedImage.bytes,
      contentType: trustedImage.mimeType,
      source: trustedImage.source,
      sourceDocumentVersion: document.sourceContract.sourceDocumentVersion,
      batchId: document.sourceAsset.objectReference?.batchId,
      documentId: document.id,
    });
    chunk.imageObjectReference = stored.reference;
  } catch {
    throw new ImageObjectStoreWriteError();
  }
  return trustedImage;
}

function trustedImageSegments(document: DocumentRecord, chunk: Chunk) {
  return chunk.sourceSegments.map((rawSegment) => {
    const segment = rawSegment as typeof rawSegment & {
      bboxEvidence?: {
        page: number;
        pageWidth: number;
        pageHeight: number;
        coordinateUnit: string;
        orientation: number;
        transform: readonly [number, number, number, number, number, number];
        mappingVersion: string;
        sourceDocumentVersion?: string;
        coordinateOrigin?: "top-left" | "bottom-left";
        mediaBox?: readonly [number, number, number, number];
        cropBox?: readonly [number, number, number, number];
      };
      sourceViewKind?: SourceSegmentV21["sourceViewKind"];
      locationQuality?: SourceSegmentV21["locationQuality"];
      contentBlockId?: string;
    };
    if (
      segment.bboxEvidence ||
      segment.sourceViewKind !== "original_file" ||
      segment.locationQuality !== "exact" ||
      !Number.isSafeInteger(segment.page) ||
      !document.sourceMapping
    ) return segment;
    const mapping = document.sourceMapping.pages.find((page) => page.page === segment.page);
    if (!mapping) return segment;
    const legacyManualImage = (segment.contentBlockId ?? segment.blockId).startsWith("manual-image-region:");
    return {
      ...segment,
      bboxEvidence: {
        ...mapping,
        page: segment.page!,
        pageWidth: legacyManualImage ? mapping.pageWidth : mapping.bboxPageWidth ?? mapping.pageWidth,
        pageHeight: legacyManualImage ? mapping.pageHeight : mapping.bboxPageHeight ?? mapping.pageHeight,
        sourceDocumentVersion: document.sourceContract?.sourceDocumentVersion,
      },
    };
  });
}

function demoBlocks(pageCount = 2, imageCount = 1): ParsedBlock[] {
  return [
    {
      id: "demo-title",
      type: "text",
      role: "heading",
      text: "A1 智能料理机",
      page: 1,
      bbox: [80, 70, 920, 140],
      readingOrder: 0,
      parentId: "section-intro",
      productIdentity: "星澜 A1 智能料理机",
      sourceBackend: "demo",
      sourceVersion: "v2-fixture",
    },
    ...Array.from({ length: 8 }, (_, index) => ({
      id: `demo-intro-${index + 1}`,
      type: "text" as const,
      role: "paragraph" as const,
      text: `使用说明 ${index + 1}：本产品支持研磨、搅拌与加热，请按步骤确认杯体已锁定。`,
      page: index < 4 ? 1 : 2,
      bbox:
        index < 4
          ? [80, 180 + index * 150, 470, 285 + index * 150]
          : [530, 180 + (index - 4) * 150, 920, 285 + (index - 4) * 150],
      readingOrder: index + 1,
      parentId: "section-intro",
      productIdentity: "星澜 A1 智能料理机",
      sourceBackend: "demo",
      sourceVersion: "v2-fixture",
    })),
    {
      id: "demo-warning-title",
      type: "text",
      role: "warning",
      text: "警告",
      page: 2,
      bbox: [80, 700, 470, 745],
      readingOrder: 9,
      groupId: "warning-1",
      productIdentity: "星澜 A1 智能料理机",
      sourceBackend: "demo",
      sourceVersion: "v2-fixture",
    },
    {
      id: "demo-warning-body",
      type: "text",
      role: "paragraph",
      text: "清洁、拆装刀头或触碰杯体内部前，必须拔下电源插头。",
      page: 2,
      bbox: [80, 750, 470, 850],
      readingOrder: 10,
      groupId: "warning-1",
      productIdentity: "星澜 A1 智能料理机",
      sourceBackend: "demo",
      sourceVersion: "v2-fixture",
    },
    {
      id: "demo-image",
      type: "image",
      role: "image",
      text: "",
      page: 2,
      bbox: [530, 700, 920, 980],
      readingOrder: 11,
      groupId: "image-1",
      imagePath: "demo://assembly",
      productIdentity: "星澜 A1 智能料理机",
      sourceBackend: "demo",
      sourceVersion: "v2-fixture",
    },
    {
      id: "demo-caption",
      type: "text",
      role: "caption",
      text: "图 1：杯体与主机的正确锁定方向",
      page: 2,
      bbox: [530, 990, 920, 1040],
      readingOrder: 12,
      groupId: "image-1",
      productIdentity: "星澜 A1 智能料理机",
      sourceBackend: "demo",
      sourceVersion: "v2-fixture",
    },
    ...(imageCount > 1
      ? [2, 3].slice(0, imageCount - 1).flatMap((imageNumber, index) => ([
          {
            id: `demo-image-${imageNumber}`,
            type: "image" as const,
            role: "image" as const,
            text: "",
            page: 2,
            bbox: [80, 880 + index * 170, 470, 990 + index * 170],
            readingOrder: 13 + index * 2,
            groupId: `image-${imageNumber}`,
            imagePath: `demo://assembly-${imageNumber}`,
            productIdentity: "星澜 A1 智能料理机",
            sourceBackend: "demo",
            sourceVersion: "v2-fixture",
          },
          {
            id: `demo-caption-${imageNumber}`,
            type: "text" as const,
            role: "caption" as const,
            text: imageNumber === 2
              ? "图 2：杯盖安全卡扣位置"
              : "图 3：刀头拆卸方向",
            page: 2,
            bbox: [80, 995 + index * 170, 470, 1035 + index * 170],
            readingOrder: 14 + index * 2,
            groupId: `image-${imageNumber}`,
            productIdentity: "星澜 A1 智能料理机",
            sourceBackend: "demo",
            sourceVersion: "v2-fixture",
          },
        ]))
      : []),
    {
      id: "demo-table",
      type: "table",
      role: "table",
      text: "| 型号 | 额定功率 | 容量 |\n| --- | --- | --- |\n| A1 | 1200W | 1.8L |",
      page: 2,
      bbox: [80, 1080, 920, 1320],
      readingOrder: 17,
      groupId: "table-1",
      productIdentity: "星澜 A1 智能料理机",
      sourceBackend: "demo",
      sourceVersion: "v2-fixture",
    },
    ...Array.from({ length: Math.max(0, pageCount - 2) }, (_, index) => ({
      id: `demo-page-${index + 3}`,
      type: "text" as const,
      role: "paragraph" as const,
      text: `第 ${index + 3} 页维护说明：本产品长期存放前应清洁并晾干部件。`,
      page: index + 3,
      bbox: [80, 120, 920, 260],
      readingOrder: index + 14,
      parentId: "section-maintenance",
      productIdentity: "星澜 A1 智能料理机",
      sourceBackend: "demo",
      sourceVersion: "v2-large-fixture",
    })),
  ];
}

function crossPageTableDemoBlocks(): ParsedBlock[] {
  return [
    {
      id: "table-p1",
      type: "table",
      role: "table",
      text: "| 型号 | 额定功率 | 容量 |\n| --- | --- | --- |\n| A1 | 1200W | 1.8L |",
      page: 1,
      bbox: [80, 650, 520, 810],
      readingOrder: 0,
      groupId: "spec-table",
      productIdentity: "星澜料理机",
      sourceBackend: "demo",
      sourceVersion: "v2-cross-page-fixture",
    },
    {
      id: "table-p2",
      type: "table",
      role: "table",
      text: "| 型号 | 额定功率 | 容量 |\n| --- | --- | --- |\n| A2 | 900W | 1.5L |",
      page: 2,
      bbox: [80, 40, 520, 200],
      readingOrder: 1,
      groupId: "spec-table",
      productIdentity: "星澜料理机",
      sourceBackend: "demo",
      sourceVersion: "v2-cross-page-fixture",
    },
  ];
}

const port = Number(process.env.PORT) || 4180;
const host = process.env.HOST?.trim() || "0.0.0.0";
await app.listen({ host, port });
