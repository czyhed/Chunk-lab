export const DATABASE_SCHEMA_VERSION = "2.0" as const;
export const TABLE_RETRIEVAL_SCHEMA_VERSION = "2.1" as const;

export function vectorTableName(dimensions: number): string {
  assertDimensions(dimensions);
  return `vector_records_v2_d${dimensions}`;
}

export function vectorIndexName(dimensions: number): string {
  assertDimensions(dimensions);
  return `vector_records_v2_d${dimensions}_embedding_cosine_idx`;
}

export function tableBundleTableName(dimensions: number): string {
  assertDimensions(dimensions);
  return `table_retrieval_bundles_v1_d${dimensions}`;
}

export function tableBundleIndexName(dimensions: number): string {
  assertDimensions(dimensions);
  return `table_retrieval_bundles_v1_d${dimensions}_embedding_cosine_idx`;
}

export function migrationStatements(dimensions: number): string[] {
  const table = vectorTableName(dimensions);
  const index = vectorIndexName(dimensions);
  return [
    "CREATE EXTENSION IF NOT EXISTS vector",
    "CREATE SCHEMA IF NOT EXISTS rag",
    `CREATE TABLE IF NOT EXISTS rag.schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS rag.documents (
      target_id text NOT NULL,
      document_id text NOT NULL,
      source_document_version text,
      deleted_at timestamptz,
      delete_after timestamptz,
      PRIMARY KEY (target_id, document_id)
    )`,
    `CREATE TABLE IF NOT EXISTS rag.object_references (
      uri text PRIMARY KEY,
      bucket text NOT NULL,
      object_key text NOT NULL,
      checksum_sha256 text NOT NULL,
      asset_class text NOT NULL,
      deleted_at timestamptz,
      delete_after timestamptz
    )`,
    `CREATE TABLE IF NOT EXISTS rag.parse_cache (
      content_sha256 text NOT NULL,
      parser_config_fingerprint text NOT NULL,
      status text NOT NULL CHECK (status IN ('pending','processing','succeeded','failed')),
      mineru_batch_id text,
      mineru_document_id text,
      parsed_document_asset_ref jsonb,
      mineru_result_asset_ref jsonb,
      trusted_result_asset_ref jsonb,
      error_message text,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      completed_at timestamptz,
      PRIMARY KEY (content_sha256, parser_config_fingerprint)
    )`,
    "ALTER TABLE rag.parse_cache ADD COLUMN IF NOT EXISTS trusted_result_asset_ref jsonb",
    `CREATE TABLE IF NOT EXISTS rag.vector_dimensions (
      target_id text PRIMARY KEY,
      dimensions integer NOT NULL CHECK (dimensions > 0),
      embedding_profile_id text NOT NULL,
      embedding_model text NOT NULL,
      observed_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS rag.deletion_audit (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      target_id text NOT NULL,
      document_id text NOT NULL,
      chunk_id text NOT NULL,
      action text NOT NULL CHECK (action IN ('soft_delete', 'physical_delete')),
      action_at timestamptz NOT NULL,
      details jsonb NOT NULL DEFAULT '{}'::jsonb
    )`,
    `CREATE INDEX IF NOT EXISTS deletion_audit_target_document_idx
      ON rag.deletion_audit(target_id, document_id, action_at)`,
    `CREATE TABLE IF NOT EXISTS rag.${table} (
      retrieval_key text NOT NULL UNIQUE,
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
      schema_version text NOT NULL CHECK (schema_version = '2.0'),
      chunk_type text NOT NULL,
      content_payload jsonb NOT NULL,
      final_text text NOT NULL,
      embedding_text_hash text NOT NULL,
      embedding_profile_id text NOT NULL,
      embedding_model text NOT NULL,
      vector_dimensions integer NOT NULL CHECK (vector_dimensions = ${dimensions}),
      embedding vector(${dimensions}) NOT NULL,
      source_segments jsonb NOT NULL,
      image_object_uri text REFERENCES rag.object_references(uri),
      image_object_reference jsonb,
      image_policy text,
      strategy_version text NOT NULL,
      context_version jsonb NOT NULL,
      content_hash text NOT NULL,
      updated_at timestamptz NOT NULL,
      deleted_at timestamptz,
      delete_after timestamptz,
      PRIMARY KEY (target_id, document_id, target_spu_id, chunk_id),
      FOREIGN KEY (target_id, document_id) REFERENCES rag.documents(target_id, document_id)
    )`,
    `ALTER TABLE rag.${table} ADD COLUMN IF NOT EXISTS target_spu_id text NOT NULL DEFAULT ''`,
    `ALTER TABLE rag.${table} ADD COLUMN IF NOT EXISTS retrieval_key text`,
    `UPDATE rag.${table} SET retrieval_key = concat(target_id, ':', document_id, ':', target_spu_id, ':', chunk_id) WHERE retrieval_key IS NULL`,
    `ALTER TABLE rag.${table} ALTER COLUMN retrieval_key SET NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${table}_retrieval_key_key ON rag.${table}(retrieval_key)`,
    `ALTER TABLE rag.${table} ADD COLUMN IF NOT EXISTS spu_id text`,
    `ALTER TABLE rag.${table} ADD COLUMN IF NOT EXISTS target_spu_ids jsonb`,
    `ALTER TABLE rag.${table} ADD COLUMN IF NOT EXISTS scope text`,
    `ALTER TABLE rag.${table} ADD COLUMN IF NOT EXISTS source_document_version text`,
    `ALTER TABLE rag.${table} ADD COLUMN IF NOT EXISTS document_type text`,
    `ALTER TABLE rag.${table} ADD COLUMN IF NOT EXISTS chunk_revision text`,
    `ALTER TABLE rag.${table} ADD COLUMN IF NOT EXISTS embedding_revision text`,
    `ALTER TABLE rag.${table} DROP CONSTRAINT IF EXISTS ${table}_pkey`,
    `ALTER TABLE rag.${table} ADD CONSTRAINT ${table}_pkey PRIMARY KEY (target_id, document_id, target_spu_id, chunk_id)`,
    `CREATE INDEX IF NOT EXISTS ${index}
      ON rag.${table} USING hnsw (embedding vector_cosine_ops)
      WHERE deleted_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS ${table}_bm25_idx
      ON rag.${table} USING bm25 (retrieval_key, final_text)
      WITH (key_field = 'retrieval_key')`,
    `INSERT INTO rag.schema_migrations(version) VALUES ('2.0-d${dimensions}')
      ON CONFLICT (version) DO NOTHING`,
    `INSERT INTO rag.schema_migrations(version) VALUES ('2.0-gc-audit-v1')
      ON CONFLICT (version) DO NOTHING`,
  ];
}

export function tableRetrievalMigrationStatements(dimensions: number): string[] {
  const table = tableBundleTableName(dimensions);
  const index = tableBundleIndexName(dimensions);
  return [
    "CREATE EXTENSION IF NOT EXISTS vector",
    "CREATE SCHEMA IF NOT EXISTS rag",
    `CREATE TABLE IF NOT EXISTS rag.schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS rag.table_artifacts (
      logical_table_id text NOT NULL,
      table_version_id text PRIMARY KEY,
      artifact jsonb NOT NULL,
      final_summary text NOT NULL,
      query_ready boolean NOT NULL DEFAULT false,
      query_ready_at timestamptz,
      state text NOT NULL CHECK (state IN ('staged', 'active', 'soft_deleted')),
      created_at timestamptz NOT NULL,
      deleted_at timestamptz
    )`,
    `CREATE INDEX IF NOT EXISTS table_artifacts_active_idx
      ON rag.table_artifacts(logical_table_id)
      WHERE state = 'active' AND deleted_at IS NULL`,
    `CREATE TABLE IF NOT EXISTS rag.table_version_source_chunks (
      table_version_id text NOT NULL REFERENCES rag.table_artifacts(table_version_id),
      source_chunk_id text NOT NULL,
      source_chunk_version text NOT NULL,
      ordinal integer NOT NULL CHECK (ordinal >= 0),
      final_text text NOT NULL,
      PRIMARY KEY (table_version_id, source_chunk_id),
      UNIQUE (table_version_id, ordinal)
    )`,
    `CREATE TABLE IF NOT EXISTS rag.${table} (
      bundle_id text PRIMARY KEY,
      table_version_id text NOT NULL UNIQUE REFERENCES rag.table_artifacts(table_version_id),
      source_chunk_ids jsonb NOT NULL,
      embedding_input_text text NOT NULL,
      embedding_input_hash text NOT NULL,
      embedding_profile_id text NOT NULL,
      embedding_model text NOT NULL,
      vector_dimensions integer NOT NULL CHECK (vector_dimensions = ${dimensions}),
      embedding vector(${dimensions}) NOT NULL,
      vector_ready boolean NOT NULL,
      created_at timestamptz NOT NULL,
      deleted_at timestamptz
    )`,
    `CREATE INDEX IF NOT EXISTS ${index}
      ON rag.${table} USING hnsw (embedding vector_cosine_ops)
      WHERE deleted_at IS NULL AND vector_ready = true`,
    `INSERT INTO rag.schema_migrations(version) VALUES ('${TABLE_RETRIEVAL_SCHEMA_VERSION}-table-retrieval-v1-d${dimensions}')
      ON CONFLICT (version) DO NOTHING`,
  ];
}

export function assertDimensions(value: number): asserts value is number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 8192)
    throw new Error("Embedding dimension must be a positive integer <= 8192");
}
