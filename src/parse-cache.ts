import { createHash } from "node:crypto";
import { Pool } from "pg";
import type { AssetDescriptor } from "./asset-contract.js";
import type { ParseConfig } from "./mineru.js";

export type ParseCacheStatus = "pending" | "processing" | "succeeded" | "failed";

export type ParseCacheRecord = {
  contentSha256: string;
  parserConfigFingerprint: string;
  status: ParseCacheStatus;
  mineruBatchId: string | null;
  mineruDocumentId: string | null;
  parsedDocumentAssetRef: AssetDescriptor | null;
  mineruResultAssetRef: AssetDescriptor | null;
  trustedResultAssetRef: AssetDescriptor | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type ParseCacheClaim =
  | { kind: "owner"; record: ParseCacheRecord }
  | { kind: "succeeded"; record: ParseCacheRecord }
  | { kind: "in_flight"; record: ParseCacheRecord }
  | { kind: "retry"; record: ParseCacheRecord };

export interface ParseCacheRepository {
  claim(contentSha256: string, parserConfigFingerprint: string, at?: string): Promise<ParseCacheClaim>;
  setProcessing(key: ParseCacheKey, mineruBatchId: string, mineruDocumentId: string, at?: string): Promise<ParseCacheRecord>;
  succeed(key: ParseCacheKey, parsedDocumentAssetRef: AssetDescriptor, mineruResultAssetRef: AssetDescriptor | null, trustedResultAssetRef?: AssetDescriptor | null, at?: string): Promise<ParseCacheRecord>;
  fail(key: ParseCacheKey, errorMessage: string, at?: string): Promise<ParseCacheRecord>;
  get(key: ParseCacheKey): Promise<ParseCacheRecord | null>;
  close?(): Promise<void>;
}

export type ParseCacheKey = Pick<ParseCacheRecord, "contentSha256" | "parserConfigFingerprint">;

export type ParseCacheDecision = ParseCacheClaim & {
  contentSha256: string;
  parserConfigFingerprint: string;
};

export function contentSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parserConfigFingerprint(config: ParseConfig): string {
  return createHash("sha256").update(JSON.stringify({
    parser_version: "mineru-api-v4",
    model_version: config.modelVersion,
    language: config.language,
    enable_table: config.enableTable,
    enable_formula: config.enableFormula,
    is_ocr: config.isOcr,
  })).digest("hex");
}

export class ParseCacheService {
  constructor(private readonly repository: ParseCacheRepository) {}

  async decide(bytes: Uint8Array, config: ParseConfig): Promise<ParseCacheDecision> {
    const content = contentSha256(bytes);
    const fingerprint = parserConfigFingerprint(config);
    const claim = await this.repository.claim(content, fingerprint);
    return { ...claim, contentSha256: content, parserConfigFingerprint: fingerprint };
  }

  async get(key: ParseCacheKey): Promise<ParseCacheRecord | null> {
    return this.repository.get(key);
  }

  async setProcessing(key: ParseCacheKey, batchId: string, documentId: string): Promise<ParseCacheRecord> {
    return this.repository.setProcessing(key, batchId, documentId);
  }

  async succeed(key: ParseCacheKey, parsed: AssetDescriptor, result: AssetDescriptor | null, trusted: AssetDescriptor | null = null): Promise<ParseCacheRecord> {
    return this.repository.succeed(key, parsed, result, trusted);
  }

  async fail(key: ParseCacheKey, message: string): Promise<ParseCacheRecord> {
    return this.repository.fail(key, message);
  }
}

export class MemoryParseCacheRepository implements ParseCacheRepository {
  private readonly records = new Map<string, ParseCacheRecord>();
  private readonly lock = new Map<string, Promise<void>>();

  async claim(content: string, config: string, at = new Date().toISOString()): Promise<ParseCacheClaim> {
    return this.serial(content, config, async () => {
      const key = cacheKey(content, config);
      const existing = this.records.get(key);
      if (existing?.status === "succeeded") return { kind: "succeeded", record: structuredClone(existing) };
      if (existing?.status === "processing" || existing?.status === "pending") return { kind: "in_flight", record: structuredClone(existing) };
      if (existing?.status === "failed") {
        const retry = { ...existing, status: "processing" as const, errorMessage: null, updatedAt: at, completedAt: null };
        this.records.set(key, retry);
        return { kind: "retry", record: structuredClone(retry) };
      }
      const record = emptyRecord(content, config, at);
      this.records.set(key, record);
      return { kind: "owner", record: structuredClone(record) };
    });
  }

  async setProcessing(key: ParseCacheKey, batchId: string, documentId: string, at = new Date().toISOString()): Promise<ParseCacheRecord> {
    return this.serial(key.contentSha256, key.parserConfigFingerprint, async () => {
      const current = this.required(key);
      const next = { ...current, status: "processing" as const, mineruBatchId: batchId, mineruDocumentId: documentId, updatedAt: at };
      this.records.set(cacheKey(key.contentSha256, key.parserConfigFingerprint), next);
      return structuredClone(next);
    });
  }

  async succeed(key: ParseCacheKey, parsed: AssetDescriptor, result: AssetDescriptor | null, trusted: AssetDescriptor | null = null, at = new Date().toISOString()): Promise<ParseCacheRecord> {
    return this.serial(key.contentSha256, key.parserConfigFingerprint, async () => {
      const current = this.required(key);
      const next = { ...current, status: "succeeded" as const, parsedDocumentAssetRef: parsed, mineruResultAssetRef: result, trustedResultAssetRef: trusted, errorMessage: null, updatedAt: at, completedAt: at };
      this.records.set(cacheKey(key.contentSha256, key.parserConfigFingerprint), next);
      return structuredClone(next);
    });
  }

  async fail(key: ParseCacheKey, message: string, at = new Date().toISOString()): Promise<ParseCacheRecord> {
    return this.serial(key.contentSha256, key.parserConfigFingerprint, async () => {
      const current = this.required(key);
      if (current.status === "succeeded") return structuredClone(current);
      const next = { ...current, status: "failed" as const, errorMessage: message, updatedAt: at, completedAt: at };
      this.records.set(cacheKey(key.contentSha256, key.parserConfigFingerprint), next);
      return structuredClone(next);
    });
  }

  async get(key: ParseCacheKey): Promise<ParseCacheRecord | null> {
    const record = this.records.get(cacheKey(key.contentSha256, key.parserConfigFingerprint));
    return record ? structuredClone(record) : null;
  }

  private required(key: ParseCacheKey): ParseCacheRecord {
    const record = this.records.get(cacheKey(key.contentSha256, key.parserConfigFingerprint));
    if (!record) throw new Error("parse cache record does not exist");
    return record;
  }

  private async serial<T>(content: string, config: string, operation: () => Promise<T>): Promise<T> {
    const key = cacheKey(content, config);
    const previous = this.lock.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.lock.set(key, previous.then(() => current));
    await previous;
    try { return await operation(); } finally { release(); if (this.lock.get(key) === current) this.lock.delete(key); }
  }
}

export type PgParseCacheConfig = { host: string; port: number; database: string; user: string; password: string };

export function createConfiguredParseCacheRepository(environment: NodeJS.ProcessEnv): ParseCacheRepository | null {
  const raw = environment.DATABASE_PROFILES_JSON?.trim();
  if (!raw) return null;
  const profiles = JSON.parse(raw) as unknown;
  if (!Array.isArray(profiles) || profiles.length !== 1) throw new Error("Parse cache requires exactly one database profile");
  const profile = profiles[0] as Record<string, unknown>;
  if (!profile || profile.kind !== "pgvector") throw new Error("Parse cache database must use pgvector");
  const envValue = (key: unknown, label: string): string => {
    if (typeof key !== "string" || !key.trim() || !environment[key]) throw new Error(`${label} is required`);
    return environment[key]!.trim();
  };
  const host = typeof profile.host === "string" && profile.host.trim() ? profile.host.trim() : "127.0.0.1";
  const port = Number(profile.port);
  if (!Number.isInteger(port) || port <= 0) throw new Error("Parse cache database port is invalid");
  return new PgParseCacheRepository({ host, port, database: envValue(profile.databaseEnv, "database"), user: envValue(profile.userEnv, "database user"), password: envValue(profile.passwordEnv, "database password") });
}

export class PgParseCacheRepository implements ParseCacheRepository {
  private readonly pool: Pool;
  private initialized?: Promise<void>;

  constructor(config: PgParseCacheConfig) {
    this.pool = new Pool({ ...config, max: 4, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 10_000 });
  }

  async claim(content: string, config: string, at = new Date().toISOString()): Promise<ParseCacheClaim> {
    await this.initialize();
    const inserted = await this.pool.query(
      `INSERT INTO rag.parse_cache(content_sha256, parser_config_fingerprint, status, created_at, updated_at)
       VALUES ($1,$2,'pending',$3,$3) ON CONFLICT (content_sha256, parser_config_fingerprint) DO NOTHING`,
      [content, config, at],
    );
    const record = await this.required({ contentSha256: content, parserConfigFingerprint: config });
    if (inserted.rowCount === 1) return { kind: "owner", record };
    if (record.status === "succeeded") return { kind: "succeeded", record };
    if (record.status === "pending" || record.status === "processing") return { kind: "in_flight", record };
    const retry = await this.pool.query(
      `UPDATE rag.parse_cache SET status='processing', error_message=NULL, updated_at=$3, completed_at=NULL
       WHERE content_sha256=$1 AND parser_config_fingerprint=$2 AND status='failed' RETURNING *`,
      [content, config, at],
    );
    return retry.rowCount ? { kind: "retry", record: fromRow(retry.rows[0]) } : { kind: "in_flight", record: await this.required({ contentSha256: content, parserConfigFingerprint: config }) };
  }

  async setProcessing(key: ParseCacheKey, batchId: string, documentId: string, at = new Date().toISOString()): Promise<ParseCacheRecord> {
    await this.initialize();
    const result = await this.pool.query(
      `UPDATE rag.parse_cache SET status='processing', mineru_batch_id=$3, mineru_document_id=$4, updated_at=$5
       WHERE content_sha256=$1 AND parser_config_fingerprint=$2 RETURNING *`,
      [key.contentSha256, key.parserConfigFingerprint, batchId, documentId, at],
    );
    return result.rowCount ? fromRow(result.rows[0]) : this.required(key);
  }

  async succeed(key: ParseCacheKey, parsed: AssetDescriptor, result: AssetDescriptor | null, trusted: AssetDescriptor | null = null, at = new Date().toISOString()): Promise<ParseCacheRecord> {
    await this.initialize();
    const query = await this.pool.query(
      `UPDATE rag.parse_cache SET status='succeeded', parsed_document_asset_ref=$3::jsonb, mineru_result_asset_ref=$4::jsonb, trusted_result_asset_ref=$5::jsonb,
       error_message=NULL, updated_at=$6, completed_at=$6 WHERE content_sha256=$1 AND parser_config_fingerprint=$2 AND status <> 'succeeded' RETURNING *`,
      [key.contentSha256, key.parserConfigFingerprint, JSON.stringify(parsed), result ? JSON.stringify(result) : null, trusted ? JSON.stringify(trusted) : null, at],
    );
    return query.rowCount ? fromRow(query.rows[0]) : this.required(key);
  }

  async fail(key: ParseCacheKey, message: string, at = new Date().toISOString()): Promise<ParseCacheRecord> {
    await this.initialize();
    const query = await this.pool.query(
      `UPDATE rag.parse_cache SET status='failed', error_message=$3, updated_at=$4, completed_at=$4
       WHERE content_sha256=$1 AND parser_config_fingerprint=$2 AND status <> 'succeeded' RETURNING *`,
      [key.contentSha256, key.parserConfigFingerprint, message, at],
    );
    return query.rowCount ? fromRow(query.rows[0]) : this.required(key);
  }

  async get(key: ParseCacheKey): Promise<ParseCacheRecord | null> {
    await this.initialize();
    const result = await this.pool.query(`SELECT * FROM rag.parse_cache WHERE content_sha256=$1 AND parser_config_fingerprint=$2`, [key.contentSha256, key.parserConfigFingerprint]);
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  async close(): Promise<void> { await this.pool.end(); }

  private async required(key: ParseCacheKey): Promise<ParseCacheRecord> {
    const record = await this.get(key);
    if (!record) throw new Error("parse cache record does not exist");
    return record;
  }

  private async initialize(): Promise<void> {
    this.initialized ??= (async () => {
      await this.pool.query("CREATE SCHEMA IF NOT EXISTS rag");
      await this.pool.query(`CREATE TABLE IF NOT EXISTS rag.parse_cache (
        content_sha256 text NOT NULL, parser_config_fingerprint text NOT NULL,
        status text NOT NULL CHECK (status IN ('pending','processing','succeeded','failed')),
        mineru_batch_id text, mineru_document_id text,
        parsed_document_asset_ref jsonb, mineru_result_asset_ref jsonb, trusted_result_asset_ref jsonb,
        error_message text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
        completed_at timestamptz, PRIMARY KEY (content_sha256, parser_config_fingerprint)
      )`);
      await this.pool.query("ALTER TABLE rag.parse_cache ADD COLUMN IF NOT EXISTS trusted_result_asset_ref jsonb");
    })();
    await this.initialized;
  }
}

function emptyRecord(content: string, config: string, at: string): ParseCacheRecord {
  return { contentSha256: content, parserConfigFingerprint: config, status: "pending", mineruBatchId: null, mineruDocumentId: null, parsedDocumentAssetRef: null, mineruResultAssetRef: null, trustedResultAssetRef: null, errorMessage: null, createdAt: at, updatedAt: at, completedAt: null };
}

function cacheKey(content: string, config: string): string { return `${content}:${config}`; }

function fromRow(row: Record<string, unknown>): ParseCacheRecord {
  return {
    contentSha256: String(row.content_sha256), parserConfigFingerprint: String(row.parser_config_fingerprint), status: row.status as ParseCacheStatus,
    mineruBatchId: row.mineru_batch_id ? String(row.mineru_batch_id) : null, mineruDocumentId: row.mineru_document_id ? String(row.mineru_document_id) : null,
    parsedDocumentAssetRef: (row.parsed_document_asset_ref ?? null) as AssetDescriptor | null,
    mineruResultAssetRef: (row.mineru_result_asset_ref ?? null) as AssetDescriptor | null,
    trustedResultAssetRef: (row.trusted_result_asset_ref ?? null) as AssetDescriptor | null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(), completedAt: row.completed_at ? new Date(String(row.completed_at)).toISOString() : null,
  };
}
