import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Chunk, ChunkRequest } from "./chunking.js";
import {
  buildVectorRecord,
  databaseIdempotencyKey,
  parseDatabaseProfiles,
  publicDatabaseProfiles,
  runDatabaseJob,
  validateVectorDatabaseRecord,
  type DatabaseProfile,
  type PublicVectorDatabaseRecord,
  type VectorDatabaseRecord,
  type VectorRepository,
} from "./database-job.js";
import type { EmbeddingJob } from "./embedding-job.js";

const databaseJobSource = await readFile(new URL("./database-job.ts", import.meta.url), "utf8");
const serverSource = await readFile(new URL("./server.ts", import.meta.url), "utf8");
assert.doesNotMatch(
  databaseJobSource,
  /\$29,\$30,NULL,NULL\)/,
  "schema 2.0 upsert must not bind a non-existent $30 parameter",
);
assert.match(databaseJobSource, /\$15::jsonb,\$16,\$17,\$18,\$19,\$20,\$21::vector,\$22::jsonb,\s*\$23,\$24::jsonb/);
assert.match(
  databaseJobSource,
  /content_hash IS DISTINCT FROM EXCLUDED\.content_hash\s+OR rag\.\$\{table\}\.deleted_at IS NOT NULL/,
  "schema 2.0 upsert must restore an unchanged soft-deleted record",
);
assert.doesNotMatch(databaseJobSource, /targetId: input\.profile\.id/);
assert.doesNotMatch(databaseJobSource, /repository\.delete\(\s*input\.profile\.id/);
assert.match(databaseJobSource, /private async listV2[\s\S]*?SELECT\s+\n?\s*records\.schema_version, records\.target_id, records\.document_id/);
assert.match(databaseJobSource, /INSERT INTO rag\.vector_dimensions/);
assert.match(databaseJobSource, /2\.0-vector-dimensions-backfill-v1/);
assert.match(databaseJobSource, /!metadata\.spuId && !metadata\.targetSpuIds\?\.length/);
assert.match(serverSource, /repository\.list\(profile\.targetId, document\.id\)/);
assert.match(serverSource, /repository\.garbageCollect\(\s*profile\.targetId/);
assert.match(serverSource, /repository\.softDeleteDocument\(\s*profile\.targetId/);

class FakeRepository implements VectorRepository {
  records = new Map<string, PublicVectorDatabaseRecord & { vector: number[] }>();
  async upsert(record: VectorDatabaseRecord) {
    const previous = this.records.get(record.chunkId);
    if (previous?.contentHash === record.contentHash) return "unchanged" as const;
    this.records.set(record.chunkId, structuredClone(record));
    return previous ? "updated" as const : "inserted" as const;
  }
  async delete(_targetId: string, _documentId: string, chunkId: string) {
    return this.records.delete(chunkId);
  }
  async softDeleteDocument() {
    const count = this.records.size;
    this.records.clear();
    return count;
  }
  async garbageCollect() {
    return 0;
  }
  async list(_targetId: string, _documentId: string) {
    return [...this.records.values()].map(({ vector: _vector, ...record }) => structuredClone(record));
  }
}

function chunk(id: string, type: Chunk["type"], text: string): Chunk {
  return {
    id, type, text, automaticText: text, finalText: text, page: 1, bbox: null,
    sourceSegments: [{ blockId: `${id}-block`, page: 1, bbox: null, sourceStart: 0, sourceEnd: text.length, chunkStart: 0, chunkEnd: text.length, isOverlap: false }],
    sourceBlockIds: [`${id}-block`], tokenCount: 4, qualityFlags: [], relatedChunkIds: [],
    excluded: false, contextText: "", contextCandidateReasons: [], contextReviewState: "not_generated", revisions: [],
  };
}

const configuration: ChunkRequest = {
  strategy: "structure", chunkSize: 512, chunkOverlap: 64,
  bufferSize: 2, breakpointPercentile: 95, semanticMaxChunkSize: 512,
  imagePolicy: "summary",
};
const chunks = [chunk("text", "text", "文本记录"), chunk("table", "table", "型号 A1")];
const image = chunk("image", "image", "杯体锁定方向");
image.relatedChunkIds = ["text"];
Object.assign(image, {
  imagePolicy: "summary",
  imageObjectReference: {
    scheme: "s3", bucket: "rag-images", key: "image.png",
    uri: "s3://rag-images/image.png", contentType: "image/png",
    checksumSha256: "a".repeat(64), etag: null, versionId: null,
    source: "pdf_crop",
  },
});
chunks.push(image);
const excluded = chunk("excluded", "text", "排除项");
excluded.excluded = true;
chunks.push(excluded);

const embeddingJob: EmbeddingJob = {
  id: "embedding-job", idempotencyKey: "embedding-key", documentId: "doc",
  profileId: "embedding", profileName: "Embedding", model: "fake", dimensions: 2,
  status: "completed", createdAt: "2026-08-16T07:00:00.000Z", updatedAt: "2026-08-16T07:00:00.000Z",
  items: chunks.map((candidate, index) => index === 3
    ? { chunkId: candidate.id, status: "skipped", attempts: 0, reason: "excluded" }
    : { chunkId: candidate.id, status: "succeeded", attempts: 1, vectorRecord: {
      schemaVersion: "1.0", chunkId: candidate.id, profileId: "embedding", model: "fake",
      dimensions: 2, embeddingTextHash: `${candidate.id}-hash`, vector: [index + 1, 0],
    } }),
  summary: { total: 4, succeeded: 3, failed: 0, skipped: 1 },
};

const repository = new FakeRepository();
const profile: DatabaseProfile = {
  id: "local-pg", targetId: "local-pg", name: "Local PG", kind: "pgvector", schemaVersion: "1.0",
  repository, fakeFailureMode: "second-once",
};
assert.deepEqual(publicDatabaseProfiles([profile]), [{
  id: "local-pg", name: "Local PG", kind: "pgvector", schemaVersion: "1.0",
}]);
const localMemoryProfiles = parseDatabaseProfiles({
  RAG_LOCAL_MEMORY_DATABASE: "1",
  DATABASE_PROFILES_JSON: JSON.stringify([{
    id: "acceptance-memory",
    targetId: "chunk-lab",
    dimensions: 1024,
    name: "Local acceptance memory",
    kind: "pgvector",
    schemaVersion: "2.0",
  }]),
});
assert.equal(localMemoryProfiles.length, 1);
assert.equal(localMemoryProfiles[0].schemaVersion, "2.0");
assert.equal(localMemoryProfiles[0].targetId, "chunk-lab");
assert.deepEqual(publicDatabaseProfiles(localMemoryProfiles), [{
  id: "acceptance-memory",
  name: "Local acceptance memory",
  kind: "pgvector",
  schemaVersion: "2.0",
}]);
assert.throws(() => parseDatabaseProfiles({
  NODE_ENV: "production",
  RAG_LOCAL_MEMORY_DATABASE: "1",
  DATABASE_PROFILES_JSON: JSON.stringify([{
    id: "forbidden-memory",
    name: "Forbidden memory",
    kind: "pgvector",
  }]),
}), /生产环境不允许使用本地内存数据库/);
assert.throws(() => parseDatabaseProfiles({
  DATABASE_PROFILES_JSON: JSON.stringify([{
    id: "invalid-dimensions",
    targetId: "chunk-lab",
    dimensions: 0,
    name: "Invalid dimensions",
    kind: "pgvector",
    schemaVersion: "2.0",
    host: "127.0.0.1",
    port: 5432,
    databaseEnv: "PG_DATABASE",
    userEnv: "PG_USER",
    passwordEnv: "PG_PASSWORD",
  }]),
  PG_DATABASE: "rag",
  PG_USER: "rag",
  PG_PASSWORD: "test",
}), /Database dimensions/);
assert.equal(databaseIdempotencyKey("doc", embeddingJob, profile), databaseIdempotencyKey("doc", structuredClone(embeddingJob), profile));
assert.notEqual(
  databaseIdempotencyKey("doc", embeddingJob, profile),
  databaseIdempotencyKey("doc", embeddingJob, { ...profile, targetId: "other-target" }),
  "changing the database target must invalidate an existing database job",
);
const imageMetadataChanged = structuredClone(chunks);
imageMetadataChanged[2].relatedChunkIds = ["table"];
assert.notEqual(
  databaseIdempotencyKey("doc", embeddingJob, profile, chunks),
  databaseIdempotencyKey("doc", embeddingJob, profile, imageMetadataChanged),
  "image relationship changes invalidate database metadata idempotency",
);

const initial = await runDatabaseJob({
  documentId: "doc", chunks, configuration, embeddingJob, profile,
  at: "2026-08-16T07:01:00.000Z",
});
assert.equal(initial.status, "partial_failure");
assert.deepEqual(initial.summary, { total: 4, written: 2, unchanged: 0, deleted: 0, failed: 1, skipped: 1 });
assert.equal(repository.records.size, 2);
assert.equal(repository.records.get("image")?.imageObjectReference?.uri, "s3://rag-images/image.png");
assert.deepEqual(repository.records.get("image")?.contentPayload.relatedChunkIds, ["text"]);
assert.equal("vector" in (await repository.list("local-pg", "doc"))[0], false);

const retried = await runDatabaseJob({
  documentId: "doc", chunks, configuration, embeddingJob, profile, previous: initial,
  at: "2026-08-16T07:02:00.000Z",
});
assert.equal(retried.status, "completed");
assert.equal(retried.items.find((item) => item.chunkId === "table")?.attempts, 2);
assert.equal(repository.records.size, 3);

const unchanged = await runDatabaseJob({
  documentId: "doc", chunks, configuration, embeddingJob,
  profile: { ...profile, fakeFailureMode: undefined },
  at: "2026-08-16T07:03:00.000Z",
});
assert.equal(unchanged.summary.unchanged, 3);

const changedChunks = structuredClone(chunks);
changedChunks[0].finalText = "仅修改这一条文本";
const changedEmbedding = structuredClone(embeddingJob);
changedEmbedding.id = "embedding-job-2";
changedEmbedding.idempotencyKey = "embedding-key-2";
changedEmbedding.items[0].vectorRecord!.embeddingTextHash = "changed-hash";
const changed = await runDatabaseJob({
  documentId: "doc", chunks: changedChunks, configuration, embeddingJob: changedEmbedding,
  profile: { ...profile, fakeFailureMode: undefined },
  at: "2026-08-16T07:04:00.000Z",
});
assert.equal(changed.summary.written, 1);
assert.equal(changed.summary.unchanged, 2);

const excludedAfterWrite = structuredClone(changedChunks);
excludedAfterWrite[0].excluded = true;
const deleteEmbedding = structuredClone(changedEmbedding);
deleteEmbedding.id = "embedding-job-3";
deleteEmbedding.idempotencyKey = "embedding-key-3";
deleteEmbedding.items[0] = { chunkId: "text", status: "skipped", attempts: 0, reason: "excluded" };
const deleted = await runDatabaseJob({
  documentId: "doc", chunks: excludedAfterWrite, configuration, embeddingJob: deleteEmbedding,
  profile: { ...profile, fakeFailureMode: undefined },
  at: "2026-08-16T07:05:00.000Z",
});
assert.equal(deleted.items[0].status, "deleted");
assert.equal(repository.records.has("text"), false);

const validRecord = buildVectorRecord({
  targetId: "local-pg", documentId: "doc", chunk: chunks[0], configuration,
  vectorRecord: embeddingJob.items[0].vectorRecord!, at: "2026-08-16T07:06:00.000Z",
});
assert.throws(
  () => validateVectorDatabaseRecord({ ...validRecord, schemaVersion: "3.0" as "1.0" }),
  /schema 版本/,
);
assert.throws(
  () => validateVectorDatabaseRecord({ ...validRecord, contentPayload: { image: "data:image/png;base64,AA==" } }),
  /图片二进制/,
);

console.log("Issue 13 database job tests passed");

const scopedChunks = [
  Object.assign(chunk("assigned", "text", "SPU-1 only"), { scope: "assigned", targetSpuIds: ["SPU-1"] }),
  Object.assign(chunk("common", "text", "shared by SPU-2 only"), { scope: "common", targetSpuIds: ["SPU-2"] }),
  Object.assign(chunk("unassigned", "text", "not resolved"), { scope: "unassigned", targetSpuIds: [] }),
  Object.assign(chunk("conflicted", "text", "requires review"), { scope: "conflicted", targetSpuIds: ["SPU-1"] }),
];
const scopedEmbeddingJob: EmbeddingJob = {
  ...embeddingJob,
  id: "scoped-embedding-job",
  idempotencyKey: "scoped-embedding-key",
  items: scopedChunks.map((candidate, index) => ({
    chunkId: candidate.id,
    status: "succeeded" as const,
    attempts: 1,
    vectorRecord: {
      schemaVersion: "1.0" as const,
      chunkId: candidate.id,
      profileId: "embedding",
      model: "fake",
      dimensions: 2,
      embeddingTextHash: `${candidate.id}-hash`,
      vector: [index + 1, 0],
    },
  })),
  summary: { total: 4, succeeded: 4, failed: 0, skipped: 0 },
};
const scopedRepository = new FakeRepository();
const scopedJob = await runDatabaseJob({
  documentId: "scoped-doc",
  chunks: scopedChunks,
  configuration,
  embeddingJob: scopedEmbeddingJob,
  profile: { ...profile, repository: scopedRepository, fakeFailureMode: undefined },
  at: "2026-08-26T01:00:00.000Z",
  metadata: { spuId: "SPU-1", targetSpuIds: ["SPU-1", "SPU-2"] },
});
assert.equal(scopedJob.status, "partial_failure");
assert.deepEqual(
  [...scopedRepository.records.values()].map((record) => ({
    chunkId: record.chunkId,
    targetSpuId: record.targetSpuId,
    scope: record.scope,
  })),
  [
    { chunkId: "assigned", targetSpuId: "SPU-1", scope: "assigned" },
    { chunkId: "common", targetSpuId: "SPU-2", scope: "common" },
  ],
  "only assigned/common chunks reach their explicitly scoped target SPUs",
);
assert.equal(scopedJob.items.find((item) => item.chunkId === "unassigned")?.status, "failed");
assert.equal(scopedJob.items.find((item) => item.chunkId === "conflicted")?.status, "failed");

console.log("Issue 26 vector scope routing tests passed");

class CleanupRetryRepository extends FakeRepository {
  failOnce = true;
  override async delete(targetId: string, documentId: string, chunkId: string) {
    if (chunkId === "obsolete" && this.failOnce) {
      this.failOnce = false;
      throw new Error("temporary delete failure");
    }
    return super.delete(targetId, documentId, chunkId);
  }
}
const cleanupRepository = new CleanupRetryRepository();
await cleanupRepository.upsert({ ...validRecord, chunkId: "obsolete", documentId: "cleanup-doc" });
const cleanupChunk = chunk("current", "text", "Current source text");
const cleanupEmbedding: EmbeddingJob = { ...embeddingJob, id: "cleanup-embedding", idempotencyKey: "cleanup-key",
  items: [{ ...embeddingJob.items[0], chunkId: "current", vectorRecord: { ...embeddingJob.items[0].vectorRecord!, chunkId: "current" } }],
  summary: { total: 1, succeeded: 1, failed: 0, skipped: 0 } };
const cleanupInput = { documentId: "cleanup-doc", chunks: [cleanupChunk], configuration, embeddingJob: cleanupEmbedding,
  profile: { ...profile, repository: cleanupRepository, fakeFailureMode: undefined }, at: "2026-11-01T10:00:00Z" };
const cleanupFailed = await runDatabaseJob(cleanupInput);
assert.equal(cleanupFailed.status, "partial_failure", "cleanup failure cannot be reported as completed");
assert.equal(cleanupFailed.summary.failed, 1);
assert.deepEqual((await cleanupRepository.list("local-pg", "cleanup-doc")).map(item => item.chunkId).sort(), ["current", "obsolete"]);
const cleanupRetried = await runDatabaseJob({ ...cleanupInput, previous: cleanupFailed });
assert.equal(cleanupRetried.status, "completed");
assert.deepEqual((await cleanupRepository.list("local-pg", "cleanup-doc")).map(item => item.chunkId), ["current"], "retry retires the old record without losing the current one");
console.log("Replacement cleanup failure/retry tests passed");
