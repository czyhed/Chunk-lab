import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { Chunk, ChunkRequest } from "./chunking.js";
import type { EmbeddingJob } from "./embedding-job.js";
import type { ImageObjectReference } from "./image-object-store.js";
import { parentContextFor } from "./parent-context.js";
import {
  DATABASE_SCHEMA_VERSION,
  migrationStatements,
  vectorTableName,
} from "./database-schema.js";

export type VectorDatabaseRecord = {
  schemaVersion: "1.0" | "2.0";
  targetId: string;
  documentId: string;
  chunkId: string;
  chunkType: Chunk["type"];
  contentPayload: Record<string, unknown>;
  finalText: string;
  embeddingTextHash: string;
  embeddingProfileId: string;
  embeddingModel: string;
  vectorDimensions: number;
  vector: number[];
  sourceSegments: Chunk["sourceSegments"];
  imageObjectReference?: ImageObjectReference;
  imagePolicy?: "summary" | "reference" | "exclude";
  strategyVersion: string;
  contextVersion: Record<string, unknown>;
  contentHash: string;
  updatedAt: string;
  /** Optional V1 SPU/document provenance. Legacy callers may omit these fields. */
  spuId?: string;
  targetSpuId?: string;
  targetSpuIds?: string[];
  scope?: "spu-specific" | "assigned" | "common";
  sourceDocumentVersion?: string;
  documentType?: string;
  chunkRevision?: string;
  embeddingRevision?: string;
};

export type PublicVectorDatabaseRecord = Omit<VectorDatabaseRecord, "vector">;

export interface VectorRepository {
  upsert(record: VectorDatabaseRecord): Promise<"inserted" | "updated" | "unchanged">;
  delete(targetId: string, documentId: string, chunkId: string): Promise<boolean>;
  softDeleteDocument(
    targetId: string,
    documentId: string,
    at: string,
    deleteAfter: string,
  ): Promise<number>;
  garbageCollect(targetId: string, documentId: string, at: string): Promise<number>;
  list(targetId: string, documentId: string): Promise<PublicVectorDatabaseRecord[]>;
}

export type DatabaseProfile = {
  id: string;
  targetId: string;
  name: string;
  kind: "pgvector";
  schemaVersion: "1.0" | "2.0";
  repository: VectorRepository;
  fakeFailureMode?: "second-once";
  fakeFailureConsumed?: boolean;
};

export type PublicDatabaseProfile = Pick<
  DatabaseProfile,
  "id" | "name" | "kind" | "schemaVersion"
>;

export type DatabaseJobItem = {
  chunkId: string;
  status: "written" | "unchanged" | "deleted" | "failed" | "skipped";
  attempts: number;
  reason?: string;
};

export type DatabaseJob = {
  id: string;
  idempotencyKey: string;
  documentId: string;
  embeddingJobId: string;
  profileId: string;
  profileName: string;
  kind: "pgvector";
  schemaVersion: "1.0" | "2.0";
  status: "completed" | "partial_failure" | "failed";
  createdAt: string;
  updatedAt: string;
  items: DatabaseJobItem[];
  summary: {
    total: number;
    written: number;
    unchanged: number;
    deleted: number;
    failed: number;
    skipped: number;
  };
  spuId?: string;
  targetSpuIds?: string[];
  sourceDocumentVersion?: string;
  documentType?: string;
  embeddingRevision?: string;
  stale?: boolean;
  staleReasons?: string[];
};

export function databaseJobStaleReasons(
  job: DatabaseJob,
  currentIdempotencyKey: string,
): string[] {
  return job.idempotencyKey === currentIdempotencyKey
    ? []
    : ["database_input_changed"];
}

type DatabaseProfileConfig = {
  id?: unknown;
  targetId?: unknown;
  dimensions?: unknown;
  name?: unknown;
  kind?: unknown;
  host?: unknown;
  port?: unknown;
  databaseEnv?: unknown;
  userEnv?: unknown;
  passwordEnv?: unknown;
  fakeFailureMode?: unknown;
  schemaVersion?: unknown;
};

class MemoryVectorRepository implements VectorRepository {
  private readonly records = new Map<string, VectorDatabaseRecord>();

  async upsert(record: VectorDatabaseRecord): Promise<"inserted" | "updated" | "unchanged"> {
    const key = `${record.targetId}:${record.documentId}:${record.targetSpuId ?? "_"}:${record.chunkId}`;
    const previous = this.records.get(key);
    if (previous?.contentHash === record.contentHash) return "unchanged";
    this.records.set(key, structuredClone(record));
    return previous ? "updated" : "inserted";
  }

  async delete(targetId: string, documentId: string, chunkId: string): Promise<boolean> {
    const keys = [...this.records.keys()].filter((key) => key.startsWith(`${targetId}:${documentId}:`) && key.endsWith(`:${chunkId}`));
    return keys.reduce((deleted, key) => this.records.delete(key) || deleted, false);
  }

  async softDeleteDocument(targetId: string, documentId: string): Promise<number> {
    let deleted = 0;
    for (const key of this.records.keys()) {
      if (key.startsWith(`${targetId}:${documentId}:`) && this.records.delete(key)) deleted++;
    }
    return deleted;
  }

  async garbageCollect(): Promise<number> {
    return 0;
  }

  async list(targetId: string, documentId: string): Promise<PublicVectorDatabaseRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.targetId === targetId && record.documentId === documentId)
      .map(({ vector: _vector, ...record }) => structuredClone(record));
  }
}

export function parseDatabaseProfiles(
  environment: NodeJS.ProcessEnv,
): DatabaseProfile[] {
  const value = environment.DATABASE_PROFILES_JSON?.trim();
  if (!value) return [];
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("DATABASE_PROFILES_JSON 必须是数组");
  const ids = new Set<string>();
  const useMemoryRepository = environment.RAG_LOCAL_MEMORY_DATABASE === "1";
  if (useMemoryRepository && environment.NODE_ENV === "production")
    throw new Error("生产环境不允许使用本地内存数据库");
  return parsed.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Database profile 必须是对象");
    const config = item as DatabaseProfileConfig;
    const id = requiredId(config.id, "Database profile id");
    const targetId = config.targetId === undefined
      ? id
      : requiredId(config.targetId, "Database targetId");
    if (ids.has(id)) throw new Error("Database profile id 重复");
    ids.add(id);
    if (config.kind !== "pgvector") throw new Error("Database profile kind 必须是 pgvector");
    const fakeFailureMode = config.fakeFailureMode === undefined
      ? undefined
      : config.fakeFailureMode === "second-once"
        ? "second-once" as const
        : invalid("Database fakeFailureMode 无效");
    const schemaVersion = config.schemaVersion === undefined
      ? "1.0" as const
      : config.schemaVersion === DATABASE_SCHEMA_VERSION
        ? DATABASE_SCHEMA_VERSION
        : invalid("Database schemaVersion 无效");
    const repository = useMemoryRepository
      ? new MemoryVectorRepository()
      : new PgVectorRepository({
          targetId,
          dimensions: config.dimensions === undefined
            ? undefined
            : positiveInteger(config.dimensions, "Database dimensions"),
          schemaVersion,
          host: requiredString(config.host, "Database host"),
          port: positiveInteger(config.port, "Database port"),
          database: environmentValue(config.databaseEnv, environment, "Database databaseEnv"),
          user: environmentValue(config.userEnv, environment, "Database userEnv"),
          password: environmentValue(config.passwordEnv, environment, "Database passwordEnv"),
        });
    return {
      id,
      targetId,
      name: requiredString(config.name, "Database profile name"),
      kind: "pgvector" as const,
      schemaVersion,
      repository,
      ...(fakeFailureMode ? { fakeFailureMode } : {}),
    };
  });
}

export function publicDatabaseProfiles(
  profiles: readonly DatabaseProfile[],
): PublicDatabaseProfile[] {
  return profiles.map(({ id, name, kind, schemaVersion }) => ({
    id,
    name,
    kind,
    schemaVersion,
  }));
}

export function databaseIdempotencyKey(
  documentId: string,
  embeddingJob: EmbeddingJob,
  profile: DatabaseProfile,
  chunks: readonly Chunk[] = [],
  metadata?: { spuId?: string; sourceDocumentVersion?: string; documentType?: string; embeddingRevision?: string; targetSpuIds?: readonly string[] },
): string {
  const normalizedMetadata = metadata
    ? {
        ...metadata,
        ...(metadata.targetSpuIds
          ? { targetSpuIds: [...new Set(metadata.targetSpuIds.map((id) => id.trim()).filter(Boolean))].sort() }
          : {}),
      }
    : null;
  return createHash("sha256").update(JSON.stringify({
    documentId,
    embeddingIdempotencyKey: embeddingJob.idempotencyKey,
    profileId: profile.id,
    targetId: profile.targetId,
    schemaVersion: profile.schemaVersion,
    metadata: normalizedMetadata,
    chunkMetadata: chunks.map((chunk) => ({
      chunkId: chunk.id,
      parentChunk: parentContextFor(chunk, chunks) ?? null,
      finalText: chunk.finalText,
      excluded: chunk.excluded,
      targetSpuIds: [...new Set(((chunk as Chunk & { targetSpuIds?: string[] }).targetSpuIds ?? [])
        .map((id) => id.trim()).filter(Boolean))].sort(),
      imagePolicy: (chunk as Chunk & { imagePolicy?: string }).imagePolicy ?? null,
      relatedChunkIds: [...chunk.relatedChunkIds],
      contextReviewState: chunk.contextReviewState,
      scope: (chunk as Chunk & { scope?: string }).scope ?? null,
    })),
  })).digest("hex");
}

export async function runDatabaseJob(input: {
  documentId: string;
  chunks: readonly Chunk[];
  configuration: ChunkRequest;
  embeddingJob: EmbeddingJob;
  profile: DatabaseProfile;
  previous?: DatabaseJob;
  at: string;
  metadata?: {
    spuId?: string;
    sourceDocumentVersion?: string;
    documentType?: string;
    embeddingRevision?: string;
    targetSpuIds?: readonly string[];
  };
}): Promise<DatabaseJob> {
  const currentIdempotencyKey = databaseIdempotencyKey(
    input.documentId,
    input.embeddingJob,
    input.profile,
    input.chunks,
    input.metadata,
  );
  const sameInput = input.previous?.idempotencyKey === currentIdempotencyKey;
  const previousItems = new Map(
    (sameInput ? input.previous?.items : undefined)?.map((item) => [item.chunkId, item]) ?? [],
  );
  const chunks = new Map(input.chunks.map((chunk) => [chunk.id, chunk]));
  const items: DatabaseJobItem[] = [];
  let persistedRecordCount = 0;
  let writableIndex = 0;
  for (const embeddingItem of input.embeddingJob.items) {
    const previous = previousItems.get(embeddingItem.chunkId);
    const chunk = chunks.get(embeddingItem.chunkId);
    const attempts = (previous?.attempts ?? 0) + 1;
    if (!chunk) {
      items.push({ chunkId: embeddingItem.chunkId, status: "failed", attempts, reason: "Chunk 不存在" });
      continue;
    }
    if (embeddingItem.status !== "succeeded" || !embeddingItem.vectorRecord) {
      if (chunk.excluded) {
        try {
          const deleted = await input.profile.repository.delete(
            input.profile.targetId,
            input.documentId,
            chunk.id,
          );
          items.push({
            chunkId: chunk.id,
            status: deleted ? "deleted" : "skipped",
            attempts,
            ...(!deleted ? { reason: "排除项没有已保存记录" } : {}),
          });
        } catch {
          items.push({ chunkId: chunk.id, status: "failed", attempts, reason: "数据库删除失败" });
        }
      } else {
        items.push({
          chunkId: chunk.id,
          status: "skipped",
          attempts: previous?.attempts ?? 0,
          reason: embeddingItem.status === "failed"
            ? "Embedding 未成功，未写入数据库"
            : "Chunk 不具备数据库写入资格",
        });
      }
      continue;
    }
    const currentWritableIndex = writableIndex++;
    try {
      if (
        input.profile.fakeFailureMode === "second-once" &&
        !input.profile.fakeFailureConsumed &&
        currentWritableIndex === 1 &&
        attempts === 1
      ) {
        input.profile.fakeFailureConsumed = true;
        throw new Error("deterministic database failure");
      }
      const targetSpuIds = resolveTargetSpuIds(chunk, input.metadata);
      const scope = resolveVectorRecordScope(chunk, input.metadata);
      const records = targetSpuIds.map((targetSpuId) => buildVectorRecord({
        targetId: input.profile.targetId,
        documentId: input.documentId,
        chunk,
        siblings: input.chunks,
        configuration: input.configuration,
        vectorRecord: embeddingItem.vectorRecord!,
        at: input.at,
        schemaVersion: input.profile.schemaVersion,
        metadata: {
          ...input.metadata,
          targetSpuId,
          scope,
        },
      }));
      const results: Array<"inserted" | "updated" | "unchanged"> = [];
      for (const record of records) {
        results.push(await input.profile.repository.upsert(record));
        persistedRecordCount++;
      }
      const result = results.every((value) => value === "unchanged")
        ? "unchanged"
        : results.some((value) => value === "inserted")
          ? "inserted"
          : "updated";
      items.push({
        chunkId: chunk.id,
        status: result === "unchanged" ? "unchanged" : "written",
        attempts,
        reason: result,
      });
    } catch {
      items.push({ chunkId: chunk.id, status: "failed", attempts, reason: "数据库写入失败" });
    }
  }
  // Only retire obsolete derived records after the replacement writes succeed.
  if (!input.embeddingJob.summary.failed && !items.some((item) => item.status === "failed") &&
      items.some((item) => item.status === "written" || item.status === "unchanged")) {
    try {
      const existing = await input.profile.repository.list(input.profile.targetId, input.documentId);
      for (const chunkId of new Set(existing.filter((record) => !chunks.has(record.chunkId)).map((record) => record.chunkId))) {
        const deleted = await input.profile.repository.delete(input.profile.targetId, input.documentId, chunkId);
        if (deleted) items.push({ chunkId, status: "deleted", attempts: 1, reason: "已替换旧切分记录" });
      }
    } catch {
      items.push({ chunkId: "obsolete-records", status: "failed", attempts: 1, reason: "旧切分记录清理失败，请重试入库" });
    }
  }
  const summary = {
    total: items.length,
    written: items.filter((item) => item.status === "written").length,
    unchanged: items.filter((item) => item.status === "unchanged").length,
    deleted: items.filter((item) => item.status === "deleted").length,
    failed: items.filter((item) => item.status === "failed").length,
    skipped: items.filter((item) => item.status === "skipped").length,
  };
  const metadata = input.metadata;
  const incompleteEmbedding = input.embeddingJob.items.some((item) => {
    if (item.status === "succeeded" && item.vectorRecord) return false;
    const chunk = chunks.get(item.chunkId);
    return !chunk || !chunk.excluded;
  });
  return {
    id: sameInput ? input.previous!.id : randomUUID(),
    idempotencyKey: currentIdempotencyKey,
    documentId: input.documentId,
    embeddingJobId: input.embeddingJob.id,
    profileId: input.profile.id,
    profileName: input.profile.name,
    kind: input.profile.kind,
    schemaVersion: input.profile.schemaVersion,
      status: summary.failed === 0 && !incompleteEmbedding
      ? "completed"
      : summary.written + summary.unchanged + summary.deleted + summary.skipped > 0 || persistedRecordCount > 0
        ? "partial_failure"
        : "failed",
    createdAt: sameInput ? input.previous!.createdAt : input.at,
    updatedAt: input.at,
    items,
    summary,
    ...(metadata?.spuId ? { spuId: metadata.spuId } : {}),
    ...(metadata?.targetSpuIds ? { targetSpuIds: [...new Set(metadata.targetSpuIds)] } : {}),
    ...(metadata?.sourceDocumentVersion ? { sourceDocumentVersion: metadata.sourceDocumentVersion } : {}),
    ...(metadata?.documentType ? { documentType: metadata.documentType } : {}),
    ...(metadata?.embeddingRevision ? { embeddingRevision: metadata.embeddingRevision } : {}),
  };
}

export function buildVectorRecord(input: {
  targetId: string;
  documentId: string;
  chunk: Chunk;
  siblings?: readonly Chunk[];
  configuration: ChunkRequest;
  vectorRecord: NonNullable<EmbeddingJob["items"][number]["vectorRecord"]>;
  at: string;
  schemaVersion?: "1.0" | "2.0";
  metadata?: {
    spuId?: string;
    targetSpuId?: string;
    targetSpuIds?: readonly string[];
    scope?: "spu-specific" | "assigned" | "common";
    sourceDocumentVersion?: string;
    documentType?: string;
    chunkRevision?: string;
    embeddingRevision?: string;
  };
}): VectorDatabaseRecord {
  const chunk = input.chunk as Chunk & {
    reviewedModel?: Record<string, unknown>;
    imagePolicy?: "summary" | "reference" | "exclude";
  };
  const imageObjectReference = chunk.imageObjectReference
    ? structuredClone(chunk.imageObjectReference)
    : undefined;
  const record = {
    schemaVersion: input.schemaVersion ?? "1.0",
    targetId: input.targetId,
    documentId: input.documentId,
    chunkId: chunk.id,
    chunkType: chunk.type,
    contentPayload: chunk.type === "table"
      ? { table: structuredClone(chunk.reviewedModel ?? {}), text: chunk.finalText }
      : chunk.type === "image"
        ? {
            text: chunk.finalText,
            relatedChunkIds: [...chunk.relatedChunkIds],
            ...(imageObjectReference ? { imageObjectReference } : {}),
          }
        : { text: chunk.finalText },
    finalText: chunk.finalText,
    embeddingTextHash: input.vectorRecord.embeddingTextHash,
    embeddingProfileId: input.vectorRecord.profileId,
    embeddingModel: input.vectorRecord.model,
    vectorDimensions: input.vectorRecord.dimensions,
    vector: [...input.vectorRecord.vector],
    sourceSegments: structuredClone(chunk.sourceSegments),
    ...(imageObjectReference ? { imageObjectReference } : {}),
    ...(chunk.imagePolicy ? { imagePolicy: chunk.imagePolicy } : {}),
    strategyVersion: createHash("sha256")
      .update(JSON.stringify(input.configuration)).digest("hex"),
    contextVersion: {
      state: chunk.contextReviewState,
      ...(chunk.contextProfileId ? { profileId: chunk.contextProfileId } : {}),
      ...(chunk.contextModel ? { model: chunk.contextModel } : {}),
      ...(chunk.contextPromptVersion ? { promptVersion: chunk.contextPromptVersion } : {}),
      ...(chunk.contextGeneratedAt ? { generatedAt: chunk.contextGeneratedAt } : {}),
    },
    contentHash: "",
    updatedAt: input.at,
    ...(input.metadata?.spuId ? { spuId: input.metadata.spuId } : {}),
    ...(input.metadata?.targetSpuId ? { targetSpuId: input.metadata.targetSpuId } : {}),
    ...(input.metadata?.targetSpuIds ? { targetSpuIds: [...input.metadata.targetSpuIds] } : {}),
    ...(input.metadata?.scope ? { scope: input.metadata.scope } : {}),
    ...(input.metadata?.sourceDocumentVersion ? { sourceDocumentVersion: input.metadata.sourceDocumentVersion } : {}),
    ...(input.metadata?.documentType ? { documentType: input.metadata.documentType } : {}),
    ...(input.metadata?.chunkRevision ? { chunkRevision: input.metadata.chunkRevision } : {}),
    ...(input.metadata?.embeddingRevision ? { embeddingRevision: input.metadata.embeddingRevision } : {}),
  };
  if (chunk.parentChunk) Object.assign(record.contentPayload, { parentChunk: parentContextFor(chunk, input.siblings) });
  record.contentHash = createHash("sha256").update(JSON.stringify({
    ...record,
    contentHash: undefined,
    updatedAt: undefined,
  })).digest("hex");
  validateVectorDatabaseRecord(record);
  return record;
}

type SpuChunkScope = "assigned" | "common" | "unassigned" | "conflicted";

function normalizeSpuIds(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function resolveVectorRecordScope(
  chunk: Chunk,
  metadata?: { spuId?: string; targetSpuIds?: readonly string[] },
): "assigned" | "common" | undefined {
  if (!metadata || (!metadata.spuId && !metadata.targetSpuIds?.length)) return undefined;
  const scope = (chunk as Chunk & { scope?: unknown }).scope;
  if (scope === "assigned" || scope === "common") return scope;
  if (scope === "unassigned") throw new Error("Chunk SPU 范围尚未分配");
  if (scope === "conflicted") throw new Error("Chunk SPU 范围存在冲突");
  throw new Error("Chunk SPU 范围尚未确认");
}

function resolveTargetSpuIds(
  chunk: Chunk,
  metadata?: { spuId?: string; targetSpuIds?: readonly string[] },
): string[] {
  const candidate = (chunk as Chunk & { targetSpuIds?: unknown }).targetSpuIds;
  const ids = Array.isArray(candidate)
    ? normalizeSpuIds(candidate.filter((value): value is string => typeof value === "string"))
    : [];
  if (!metadata || (!metadata.spuId && !metadata.targetSpuIds?.length))
    return ids.length ? ids : [""]; // Ordinary documents have no SPU dimension.
  const scope = (chunk as Chunk & { scope?: unknown }).scope as SpuChunkScope | undefined;
  const allowed = normalizeSpuIds(metadata.targetSpuIds?.length ? metadata.targetSpuIds : [metadata.spuId ?? ""]);
  if (scope !== "assigned" && scope !== "common")
    throw new Error(scope === "conflicted" ? "Chunk SPU 范围存在冲突" : "Chunk SPU 范围尚未分配");
  const resolved = ids.length ? ids : scope === "common" ? allowed : [];
  if (resolved.some((spuId) => !allowed.includes(spuId)))
    throw new Error("Chunk 目标 SPU 不属于文档确认范围");
  if (!resolved.length) {
    throw new Error("向量任务缺少目标 SPU");
  }
  return resolved;
}

export function validateVectorDatabaseRecord(record: VectorDatabaseRecord): void {
  if (record.schemaVersion !== "1.0" && record.schemaVersion !== "2.0")
    throw new Error("不支持的数据库 schema 版本");
  if (record.vector.length !== record.vectorDimensions || !record.vector.length)
    throw new Error("数据库记录向量维度不匹配");
  const serialized = JSON.stringify(record);
  if (/data:image|;base64,/i.test(serialized)) throw new Error("数据库记录不得包含图片二进制");
  if (record.imageObjectReference && !record.imageObjectReference.uri.startsWith("s3://"))
    throw new Error("图片记录必须使用 s3:// 对象引用");
}

class PgVectorRepository implements VectorRepository {
  private readonly pool: Pool;
  private readonly targetId: string;
  private readonly schemaVersion: "1.0" | "2.0";
  private initialized?: Promise<void>;
  private dimension?: number;

  constructor(config: {
    targetId: string;
    dimensions?: number;
    schemaVersion: "1.0" | "2.0";
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  }) {
    this.targetId = config.targetId;
    this.dimension = config.dimensions;
    this.schemaVersion = config.schemaVersion;
    this.pool = new Pool({
      ...config,
      max: 4,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 10_000,
    });
  }

  private async initialize(dimension?: number): Promise<boolean> {
    if (this.schemaVersion === "2.0") return this.initializeV2(dimension);
    this.initialized ??= (async () => {
      await this.pool.query("CREATE EXTENSION IF NOT EXISTS vector");
      await this.pool.query(`CREATE TABLE IF NOT EXISTS rag_vector_records_v1 (
        target_id text NOT NULL,
        document_id text NOT NULL,
        target_spu_id text NOT NULL DEFAULT '',
        spu_id text,
        target_spu_ids jsonb,
        scope text,
        source_document_version text,
        document_type text,
        chunk_revision text,
        embedding_revision text,
        chunk_id text NOT NULL,
        schema_version text NOT NULL CHECK (schema_version = '1.0'),
        chunk_type text NOT NULL,
        content_payload jsonb NOT NULL,
        final_text text NOT NULL,
        embedding_text_hash text NOT NULL,
        embedding_profile_id text NOT NULL,
        embedding_model text NOT NULL,
        vector_dimensions integer NOT NULL,
        embedding vector NOT NULL,
        source_segments jsonb NOT NULL,
        image_object_reference jsonb,
        image_policy text,
        strategy_version text NOT NULL,
        context_version jsonb NOT NULL,
        content_hash text NOT NULL,
        updated_at timestamptz NOT NULL,
        PRIMARY KEY (target_id, document_id, target_spu_id, chunk_id)
      )`);
      await this.pool.query(`ALTER TABLE rag_vector_records_v1 ADD COLUMN IF NOT EXISTS target_spu_id text NOT NULL DEFAULT ''`);
      await this.pool.query(`ALTER TABLE rag_vector_records_v1 ADD COLUMN IF NOT EXISTS spu_id text`);
      await this.pool.query(`ALTER TABLE rag_vector_records_v1 ADD COLUMN IF NOT EXISTS target_spu_ids jsonb`);
      await this.pool.query(`ALTER TABLE rag_vector_records_v1 ADD COLUMN IF NOT EXISTS scope text`);
      await this.pool.query(`ALTER TABLE rag_vector_records_v1 ADD COLUMN IF NOT EXISTS source_document_version text`);
      await this.pool.query(`ALTER TABLE rag_vector_records_v1 ADD COLUMN IF NOT EXISTS document_type text`);
      await this.pool.query(`ALTER TABLE rag_vector_records_v1 ADD COLUMN IF NOT EXISTS chunk_revision text`);
      await this.pool.query(`ALTER TABLE rag_vector_records_v1 ADD COLUMN IF NOT EXISTS embedding_revision text`);
      await this.pool.query(`ALTER TABLE rag_vector_records_v1 DROP CONSTRAINT IF EXISTS rag_vector_records_v1_pkey`);
      await this.pool.query(`ALTER TABLE rag_vector_records_v1 ADD CONSTRAINT rag_vector_records_v1_pkey PRIMARY KEY (target_id, document_id, target_spu_id, chunk_id)`);
    })();
    await this.initialized;
    return true;
  }

  private async initializeV2(dimension?: number): Promise<boolean> {
    await this.pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await this.pool.query("CREATE SCHEMA IF NOT EXISTS rag");
    if (!dimension && !this.dimension) {
      await this.pool.query(`CREATE TABLE IF NOT EXISTS rag.vector_dimensions (
        target_id text PRIMARY KEY,
        dimensions integer NOT NULL CHECK (dimensions > 0),
        embedding_profile_id text NOT NULL,
        embedding_model text NOT NULL,
        observed_at timestamptz NOT NULL DEFAULT now()
      )`);
      const result = await this.pool.query<{ dimensions: number }>(
        "SELECT dimensions FROM rag.vector_dimensions WHERE target_id=$1",
        [this.targetId],
      );
      if (result.rows[0]) this.dimension = Number(result.rows[0].dimensions);
    }
    if (dimension !== undefined) {
      if (this.dimension !== undefined && this.dimension !== dimension)
        throw new Error("Embedding dimension changed for this database target");
      this.dimension = dimension;
    }
    if (!this.dimension) return false;
    if (!this.initialized) {
      this.initialized = (async () => {
        for (const statement of migrationStatements(this.dimension!))
          await this.pool.query(statement);
        const table = vectorTableName(this.dimension!);
        await this.pool.query(
          `INSERT INTO rag.vector_dimensions(
             target_id, dimensions, embedding_profile_id, embedding_model
           )
           SELECT $1, $2, min(embedding_profile_id), min(embedding_model)
           FROM rag.${table}
           WHERE target_id=$1 AND deleted_at IS NULL
           HAVING count(*) > 0
             AND count(DISTINCT vector_dimensions)=1
             AND min(vector_dimensions)=$2
             AND count(DISTINCT embedding_profile_id)=1
             AND count(DISTINCT embedding_model)=1
           ON CONFLICT (target_id) DO NOTHING`,
          [this.targetId, this.dimension],
        );
        const registration = await this.pool.query<{ dimensions: number }>(
          "SELECT dimensions FROM rag.vector_dimensions WHERE target_id=$1",
          [this.targetId],
        );
        const active = await this.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM rag.${table}
           WHERE target_id=$1 AND deleted_at IS NULL`,
          [this.targetId],
        );
        if (Number(active.rows[0]?.count ?? 0) > 0 && !registration.rows[0])
          throw new Error("Existing active vector records have inconsistent dimension metadata");
        if (registration.rows[0] && Number(registration.rows[0].dimensions) !== this.dimension)
          throw new Error("Embedding dimension changed for this database target");
        await this.pool.query(
          `INSERT INTO rag.schema_migrations(version)
           VALUES ('2.0-vector-dimensions-backfill-v1')
           ON CONFLICT (version) DO NOTHING`,
        );
      })();
    }
    await this.initialized;
    return true;
  }

  async upsert(record: VectorDatabaseRecord): Promise<"inserted" | "updated" | "unchanged"> {
    validateVectorDatabaseRecord(record);
    await this.initialize(record.vectorDimensions);
    if (this.schemaVersion === "2.0") return this.upsertV2(record);
    const result = await this.pool.query<{ inserted: boolean }>(`INSERT INTO rag_vector_records_v1 (
      target_id, document_id, target_spu_id, spu_id, target_spu_ids, scope,
      source_document_version, document_type, chunk_revision, embedding_revision,
      chunk_id, schema_version, chunk_type,
      content_payload, final_text, embedding_text_hash, embedding_profile_id,
      embedding_model, vector_dimensions, embedding, source_segments,
      image_object_reference, image_policy, strategy_version, context_version,
      content_hash, updated_at
    ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19,$20,$21,$22::vector,$23::jsonb,$24::jsonb,$25,$26,$27::jsonb,$28,$29)
    ON CONFLICT (target_id, document_id, target_spu_id, chunk_id) DO UPDATE SET
      spu_id = EXCLUDED.spu_id, target_spu_ids = EXCLUDED.target_spu_ids, scope = EXCLUDED.scope,
      source_document_version = EXCLUDED.source_document_version, document_type = EXCLUDED.document_type,
      chunk_revision = EXCLUDED.chunk_revision, embedding_revision = EXCLUDED.embedding_revision,
      schema_version = EXCLUDED.schema_version,
      chunk_type = EXCLUDED.chunk_type,
      content_payload = EXCLUDED.content_payload,
      final_text = EXCLUDED.final_text,
      embedding_text_hash = EXCLUDED.embedding_text_hash,
      embedding_profile_id = EXCLUDED.embedding_profile_id,
      embedding_model = EXCLUDED.embedding_model,
      vector_dimensions = EXCLUDED.vector_dimensions,
      embedding = EXCLUDED.embedding,
      source_segments = EXCLUDED.source_segments,
      image_object_reference = EXCLUDED.image_object_reference,
      image_policy = EXCLUDED.image_policy,
      strategy_version = EXCLUDED.strategy_version,
      context_version = EXCLUDED.context_version,
      content_hash = EXCLUDED.content_hash,
      updated_at = EXCLUDED.updated_at
    WHERE rag_vector_records_v1.content_hash IS DISTINCT FROM EXCLUDED.content_hash
    RETURNING (xmax = 0) AS inserted`, [
      record.targetId, record.documentId, record.targetSpuId ?? "", record.spuId ?? null,
      record.targetSpuIds ? JSON.stringify(record.targetSpuIds) : null, record.scope ?? null,
      record.sourceDocumentVersion ?? null, record.documentType ?? null, record.chunkRevision ?? null,
      record.embeddingRevision ?? null, record.chunkId, record.schemaVersion,
      record.chunkType, JSON.stringify(record.contentPayload), record.finalText,
      record.embeddingTextHash, record.embeddingProfileId, record.embeddingModel,
      record.vectorDimensions, `[${record.vector.join(",")}]`,
      JSON.stringify(record.sourceSegments),
      record.imageObjectReference ? JSON.stringify(record.imageObjectReference) : null,
      record.imagePolicy ?? null, record.strategyVersion,
      JSON.stringify(record.contextVersion), record.contentHash, record.updatedAt,
    ]);
    return result.rowCount === 0 ? "unchanged" : result.rows[0].inserted ? "inserted" : "updated";
  }

  private async upsertV2(
    record: VectorDatabaseRecord,
    executor: Pick<Pool, "query"> | PoolClient = this.pool,
  ): Promise<"inserted" | "updated" | "unchanged"> {
    const table = vectorTableName(record.vectorDimensions);
    const dimension = await executor.query<{ dimensions: number }>(
      "SELECT dimensions FROM rag.vector_dimensions WHERE target_id=$1",
      [record.targetId],
    );
    if (dimension.rows[0] && Number(dimension.rows[0].dimensions) !== record.vectorDimensions)
      throw new Error("Embedding dimension changed for this database target");
    await executor.query(`INSERT INTO rag.vector_dimensions(
      target_id, dimensions, embedding_profile_id, embedding_model
    ) VALUES ($1,$2,$3,$4)
    ON CONFLICT (target_id) DO UPDATE SET
      embedding_profile_id=EXCLUDED.embedding_profile_id,
      embedding_model=EXCLUDED.embedding_model`, [
      record.targetId,
      record.vectorDimensions,
      record.embeddingProfileId,
      record.embeddingModel,
    ]);
    await executor.query(
      `INSERT INTO rag.documents(target_id, document_id) VALUES ($1,$2)
       ON CONFLICT (target_id, document_id) DO UPDATE SET deleted_at=NULL, delete_after=NULL`,
      [record.targetId, record.documentId],
    );
    if (record.imageObjectReference) {
      const reference = record.imageObjectReference;
      await executor.query(`INSERT INTO rag.object_references(
        uri, bucket, object_key, checksum_sha256, asset_class
      ) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (uri) DO UPDATE SET
        deleted_at=NULL, delete_after=NULL`, [
        reference.uri,
        reference.bucket,
        reference.key,
        reference.checksumSha256,
        reference.assetClass,
      ]);
    }
    const result = await executor.query<{ inserted: boolean }>(`INSERT INTO rag.${table} (
      retrieval_key, target_id, document_id, target_spu_id, spu_id, target_spu_ids, scope,
      source_document_version, document_type, chunk_revision, embedding_revision,
      chunk_id, schema_version, chunk_type,
      content_payload, final_text, embedding_text_hash, embedding_profile_id,
      embedding_model, vector_dimensions, embedding, source_segments,
      image_object_uri, image_object_reference, image_policy, strategy_version,
      context_version, content_hash, updated_at, deleted_at, delete_after
    ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19,$20,$21::vector,$22::jsonb,
      $23,$24::jsonb,$25,$26,$27::jsonb,$28,$29,NULL,NULL)
    ON CONFLICT (target_id, document_id, target_spu_id, chunk_id) DO UPDATE SET
      spu_id=EXCLUDED.spu_id, target_spu_ids=EXCLUDED.target_spu_ids, scope=EXCLUDED.scope,
      source_document_version=EXCLUDED.source_document_version, document_type=EXCLUDED.document_type,
      chunk_revision=EXCLUDED.chunk_revision, embedding_revision=EXCLUDED.embedding_revision,
      schema_version=EXCLUDED.schema_version, chunk_type=EXCLUDED.chunk_type,
      content_payload=EXCLUDED.content_payload, final_text=EXCLUDED.final_text,
      embedding_text_hash=EXCLUDED.embedding_text_hash, embedding_profile_id=EXCLUDED.embedding_profile_id,
      embedding_model=EXCLUDED.embedding_model, vector_dimensions=EXCLUDED.vector_dimensions,
      embedding=EXCLUDED.embedding, source_segments=EXCLUDED.source_segments,
      image_object_uri=EXCLUDED.image_object_uri, image_object_reference=EXCLUDED.image_object_reference,
      image_policy=EXCLUDED.image_policy, strategy_version=EXCLUDED.strategy_version,
      context_version=EXCLUDED.context_version, content_hash=EXCLUDED.content_hash,
      updated_at=EXCLUDED.updated_at, deleted_at=NULL, delete_after=NULL
    WHERE rag.${table}.content_hash IS DISTINCT FROM EXCLUDED.content_hash
       OR rag.${table}.deleted_at IS NOT NULL
    RETURNING (xmax = 0) AS inserted`, [
      `${record.targetId}:${record.documentId}:${record.targetSpuId ?? ""}:${record.chunkId}`,
      record.targetId, record.documentId, record.targetSpuId ?? "", record.spuId ?? null,
      record.targetSpuIds ? JSON.stringify(record.targetSpuIds) : null, record.scope ?? null,
      record.sourceDocumentVersion ?? null, record.documentType ?? null, record.chunkRevision ?? null,
      record.embeddingRevision ?? null, record.chunkId, record.schemaVersion,
      record.chunkType, JSON.stringify(record.contentPayload), record.finalText,
      record.embeddingTextHash, record.embeddingProfileId, record.embeddingModel,
      record.vectorDimensions, `[${record.vector.join(",")}]`,
      JSON.stringify(record.sourceSegments), record.imageObjectReference?.uri ?? null,
      record.imageObjectReference ? JSON.stringify(record.imageObjectReference) : null,
      record.imagePolicy ?? null, record.strategyVersion,
      JSON.stringify(record.contextVersion), record.contentHash, record.updatedAt,
    ]);
    return result.rowCount === 0 ? "unchanged" : result.rows[0].inserted ? "inserted" : "updated";
  }

  async delete(targetId: string, documentId: string, chunkId: string): Promise<boolean> {
    const initialized = await this.initialize();
    if (this.schemaVersion === "2.0") {
      if (!initialized || !this.dimension) return false;
      const table = vectorTableName(this.dimension);
      const result = await this.pool.query(
        `WITH updated AS (
           UPDATE rag.${table}
           SET deleted_at=now(), delete_after=now() + interval '24 hours'
           WHERE target_id=$1 AND document_id=$2 AND chunk_id=$3 AND deleted_at IS NULL
           RETURNING chunk_id, deleted_at, delete_after
         )
         INSERT INTO rag.deletion_audit(
           target_id, document_id, chunk_id, action, action_at, details
         )
         SELECT $1, $2, chunk_id, 'soft_delete', deleted_at,
           jsonb_build_object('deleteAfter', delete_after, 'scope', 'chunk')
         FROM updated
         RETURNING chunk_id`,
        [targetId, documentId, chunkId],
      );
      return (result.rowCount ?? 0) > 0;
    }
    const result = await this.pool.query(
      "DELETE FROM rag_vector_records_v1 WHERE target_id=$1 AND document_id=$2 AND chunk_id=$3",
      [targetId, documentId, chunkId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async softDeleteDocument(
    targetId: string,
    documentId: string,
    at: string,
    deleteAfter: string,
  ): Promise<number> {
    assertIsoTimestamp(at, "at");
    assertIsoTimestamp(deleteAfter, "deleteAfter");
    if (Date.parse(deleteAfter) < Date.parse(at))
      throw new Error("deleteAfter must not be before at");
    const initialized = await this.initialize();
    if (this.schemaVersion !== "2.0" || !initialized || !this.dimension) return 0;
    const table = vectorTableName(this.dimension);
    const result = await this.pool.query<{ deleted_count: string }>(
      `WITH document_update AS (
         UPDATE rag.documents
         SET deleted_at=COALESCE(deleted_at, $3::timestamptz),
             delete_after=COALESCE(delete_after, $4::timestamptz)
         WHERE target_id=$1 AND document_id=$2
       ), updated AS (
         UPDATE rag.${table}
         SET deleted_at=$3::timestamptz, delete_after=$4::timestamptz
         WHERE target_id=$1 AND document_id=$2 AND deleted_at IS NULL
         RETURNING chunk_id
       ), audited AS (
         INSERT INTO rag.deletion_audit(
           target_id, document_id, chunk_id, action, action_at, details
         )
         SELECT $1, $2, chunk_id, 'soft_delete', $3::timestamptz,
           jsonb_build_object('deleteAfter', $4::timestamptz, 'scope', 'document')
         FROM updated
         RETURNING 1
       )
       SELECT count(*)::text AS deleted_count FROM audited`,
      [targetId, documentId, at, deleteAfter],
    );
    return Number(result.rows[0]?.deleted_count ?? 0);
  }

  async garbageCollect(targetId: string, documentId: string, at: string): Promise<number> {
    assertIsoTimestamp(at, "at");
    const initialized = await this.initialize();
    if (this.schemaVersion !== "2.0" || !initialized || !this.dimension) return 0;
    const table = vectorTableName(this.dimension);
    const result = await this.pool.query<{ deleted_count: string }>(
      `WITH deleted AS (
         DELETE FROM rag.${table}
         WHERE target_id=$1 AND document_id=$2
           AND deleted_at IS NOT NULL AND delete_after <= $3::timestamptz
         RETURNING chunk_id
       ), audited AS (
         INSERT INTO rag.deletion_audit(
           target_id, document_id, chunk_id, action, action_at, details
         )
         SELECT $1, $2, chunk_id, 'physical_delete', $3::timestamptz,
           jsonb_build_object('reason', 'delete_after_elapsed')
         FROM deleted
         RETURNING 1
       ), deleted_document AS (
         DELETE FROM rag.documents
         WHERE target_id=$1 AND document_id=$2
           AND deleted_at IS NOT NULL AND delete_after <= $3::timestamptz
           AND NOT EXISTS (
             SELECT 1 FROM rag.${table}
             WHERE target_id=$1 AND document_id=$2
               AND NOT (deleted_at IS NOT NULL AND delete_after <= $3::timestamptz)
           )
         RETURNING 1
       )
       SELECT count(*)::text AS deleted_count FROM audited`,
      [targetId, documentId, at],
    );
    return Number(result.rows[0]?.deleted_count ?? 0);
  }

  async list(targetId: string, documentId: string): Promise<PublicVectorDatabaseRecord[]> {
    const initialized = await this.initialize();
    if (this.schemaVersion === "2.0") {
      if (!initialized || !this.dimension) return [];
      return this.listV2(targetId, documentId);
    }
    const result = await this.pool.query<Record<string, unknown>>(`SELECT
      records.schema_version, records.target_id, records.document_id, records.target_spu_id,
      records.spu_id, records.target_spu_ids, records.scope,
      records.source_document_version, records.document_type, records.chunk_revision,
      records.embedding_revision, records.chunk_id, records.chunk_type,
      records.content_payload, records.final_text, records.embedding_text_hash,
      records.embedding_profile_id, records.embedding_model, records.vector_dimensions,
      records.source_segments, records.image_object_reference, records.image_policy,
      records.strategy_version, records.context_version, records.content_hash, records.updated_at
      FROM rag_vector_records_v1
      WHERE target_id=$1 AND document_id=$2 ORDER BY chunk_id`, [targetId, documentId]);
    return result.rows.map((row) => ({
      schemaVersion: row.schema_version as "1.0",
      targetId: String(row.target_id),
      documentId: String(row.document_id),
      ...(row.target_spu_id ? { targetSpuId: String(row.target_spu_id) } : {}),
      ...(row.spu_id ? { spuId: String(row.spu_id) } : {}),
      ...(row.target_spu_ids ? { targetSpuIds: row.target_spu_ids as string[] } : {}),
      ...(row.scope ? { scope: row.scope as VectorDatabaseRecord["scope"] } : {}),
      ...(row.source_document_version ? { sourceDocumentVersion: String(row.source_document_version) } : {}),
      ...(row.document_type ? { documentType: String(row.document_type) } : {}),
      ...(row.chunk_revision ? { chunkRevision: String(row.chunk_revision) } : {}),
      ...(row.embedding_revision ? { embeddingRevision: String(row.embedding_revision) } : {}),
      chunkId: String(row.chunk_id),
      chunkType: row.chunk_type as Chunk["type"],
      contentPayload: row.content_payload as Record<string, unknown>,
      finalText: String(row.final_text),
      embeddingTextHash: String(row.embedding_text_hash),
      embeddingProfileId: String(row.embedding_profile_id),
      embeddingModel: String(row.embedding_model),
      vectorDimensions: Number(row.vector_dimensions),
      sourceSegments: row.source_segments as Chunk["sourceSegments"],
      ...(row.image_object_reference
        ? { imageObjectReference: row.image_object_reference as VectorDatabaseRecord["imageObjectReference"] }
        : {}),
      ...(row.image_policy ? { imagePolicy: row.image_policy as VectorDatabaseRecord["imagePolicy"] } : {}),
      strategyVersion: String(row.strategy_version),
      contextVersion: row.context_version as Record<string, unknown>,
      contentHash: String(row.content_hash),
      updatedAt: new Date(String(row.updated_at)).toISOString(),
    }));
  }

  private async listV2(targetId: string, documentId: string): Promise<PublicVectorDatabaseRecord[]> {
    const table = vectorTableName(this.dimension!);
    const result = await this.pool.query<Record<string, unknown>>(`SELECT
      records.schema_version, records.target_id, records.document_id, records.target_spu_id,
      records.spu_id, records.target_spu_ids, records.scope,
      records.source_document_version, records.document_type, records.chunk_revision,
      records.embedding_revision, records.chunk_id, records.chunk_type,
      records.content_payload, records.final_text, records.embedding_text_hash,
      records.embedding_profile_id, records.embedding_model, records.vector_dimensions,
      records.source_segments, records.image_object_reference, records.image_policy,
      records.strategy_version, records.context_version, records.content_hash, records.updated_at
      FROM rag.${table} records
      JOIN rag.documents d
        ON d.target_id=records.target_id AND d.document_id=records.document_id
      WHERE records.target_id=$1 AND records.document_id=$2 AND records.deleted_at IS NULL
        AND d.deleted_at IS NULL
      ORDER BY records.target_spu_id, records.chunk_id`,
      [targetId, documentId],
    );
    return result.rows.map((row) => ({
      schemaVersion: "2.0" as const,
      targetId: String(row.target_id),
      documentId: String(row.document_id),
      ...(row.target_spu_id ? { targetSpuId: String(row.target_spu_id) } : {}),
      ...(row.spu_id ? { spuId: String(row.spu_id) } : {}),
      ...(row.target_spu_ids ? { targetSpuIds: row.target_spu_ids as string[] } : {}),
      ...(row.scope ? { scope: row.scope as VectorDatabaseRecord["scope"] } : {}),
      ...(row.source_document_version ? { sourceDocumentVersion: String(row.source_document_version) } : {}),
      ...(row.document_type ? { documentType: String(row.document_type) } : {}),
      ...(row.chunk_revision ? { chunkRevision: String(row.chunk_revision) } : {}),
      ...(row.embedding_revision ? { embeddingRevision: String(row.embedding_revision) } : {}),
      chunkId: String(row.chunk_id),
      chunkType: row.chunk_type as Chunk["type"],
      contentPayload: row.content_payload as Record<string, unknown>,
      finalText: String(row.final_text),
      embeddingTextHash: String(row.embedding_text_hash),
      embeddingProfileId: String(row.embedding_profile_id),
      embeddingModel: String(row.embedding_model),
      vectorDimensions: Number(row.vector_dimensions),
      sourceSegments: row.source_segments as Chunk["sourceSegments"],
      ...(row.image_object_reference
        ? { imageObjectReference: row.image_object_reference as VectorDatabaseRecord["imageObjectReference"] }
        : {}),
      ...(row.image_policy ? { imagePolicy: row.image_policy as VectorDatabaseRecord["imagePolicy"] } : {}),
      strategyVersion: String(row.strategy_version),
      contextVersion: row.context_version as Record<string, unknown>,
      contentHash: String(row.content_hash),
      updatedAt: new Date(String(row.updated_at)).toISOString(),
    }));
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 不能为空`);
  return value.trim();
}

function requiredId(value: unknown, name: string): string {
  const id = requiredString(value, name);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`${name} 无效`);
  return id;
}

function positiveInteger(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} 无效`);
  return number;
}

function environmentValue(
  name: unknown,
  environment: NodeJS.ProcessEnv,
  label: string,
): string {
  const key = requiredString(name, label);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`${label} 无效`);
  return requiredString(environment[key], `${label} 环境变量`);
}

function invalid(message: string): never {
  throw new Error(message);
}

function assertIsoTimestamp(value: string, label: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value)
    throw new Error(`${label} must be an ISO timestamp`);
}
