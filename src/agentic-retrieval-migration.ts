import { vectorIndexName, vectorTableName } from "./database-schema.js";

export const AGENTIC_RETRIEVAL_TARGET_ID = "chunk-lab";

export function agenticRetrievalMigrationStatements(dimensions: number): string[] {
  if (!Number.isSafeInteger(dimensions) || dimensions <= 0) throw new Error("Embedding dimension must be a positive integer");
  const table = vectorTableName(dimensions);
  const vectorIndex = vectorIndexName(dimensions);
  const bm25Index = `${table}_bm25_idx`;
  return [
    "CREATE EXTENSION IF NOT EXISTS vector",
    "CREATE SCHEMA IF NOT EXISTS rag",
    `CREATE TABLE IF NOT EXISTS rag.schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS rag.documents (
      target_id text NOT NULL,
      document_id text NOT NULL,
      source_document_version text,
      deleted_at timestamptz,
      delete_after timestamptz,
      PRIMARY KEY (target_id, document_id)
    )`,
    `CREATE TABLE IF NOT EXISTS rag.${table} (
      retrieval_key text NOT NULL UNIQUE,
      target_id text NOT NULL,
      document_id text NOT NULL,
      target_spu_id text NOT NULL,
      spu_id text,
      source_document_version text,
      document_type text,
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
      source_segments jsonb NOT NULL DEFAULT '[]'::jsonb,
      image_object_uri text,
      image_object_reference jsonb,
      image_policy text,
      strategy_version text NOT NULL DEFAULT 'chunk-lab-migration-v1',
      context_version jsonb NOT NULL DEFAULT '{}'::jsonb,
      content_hash text NOT NULL,
      updated_at timestamptz NOT NULL,
      deleted_at timestamptz,
      delete_after timestamptz,
      PRIMARY KEY (target_id, document_id, target_spu_id, chunk_id),
      FOREIGN KEY (target_id, document_id) REFERENCES rag.documents(target_id, document_id)
    )`,
    `ALTER TABLE rag.${table} ADD COLUMN IF NOT EXISTS image_object_uri text`,
    `ALTER TABLE rag.${table} ADD COLUMN IF NOT EXISTS image_object_reference jsonb`,
    `ALTER TABLE rag.${table} ADD COLUMN IF NOT EXISTS image_policy text`,
    `ALTER TABLE rag.${table} ADD COLUMN IF NOT EXISTS strategy_version text NOT NULL DEFAULT 'chunk-lab-migration-v1'`,
    `ALTER TABLE rag.${table} ADD COLUMN IF NOT EXISTS context_version jsonb NOT NULL DEFAULT '{}'::jsonb`,
    `CREATE INDEX IF NOT EXISTS ${vectorIndex} ON rag.${table} USING hnsw (embedding vector_cosine_ops) WHERE deleted_at IS NULL`,
    `INSERT INTO rag.documents(target_id, document_id, source_document_version, deleted_at)
     SELECT '${AGENTIC_RETRIEVAL_TARGET_ID}', d.id, d.index_version::text,
       CASE WHEN d.status = 'active' THEN NULL ELSE now() END
     FROM public.rag_index_documents d
     ON CONFLICT (target_id, document_id) DO UPDATE SET
       source_document_version = EXCLUDED.source_document_version,
       deleted_at = EXCLUDED.deleted_at`,
    `INSERT INTO rag.${table}(
       retrieval_key, target_id, document_id, target_spu_id, spu_id,
       source_document_version, document_type, chunk_id, schema_version, chunk_type,
       content_payload, final_text, embedding_text_hash, embedding_profile_id,
       embedding_model, vector_dimensions, embedding, source_segments, content_hash,
       updated_at, deleted_at
     )
     SELECT c.id, '${AGENTIC_RETRIEVAL_TARGET_ID}', c.document_id,
       COALESCE(NULLIF((c.metadata_json::jsonb ->> 'sku'), ''), NULLIF(d.sku, ''), ''),
       NULLIF(d.sku, ''), d.index_version::text, NULL, c.id, '2.0', c.chunk_type,
       jsonb_build_object('text', c.content), c.content,
       md5(c.content), COALESCE(NULLIF(d.embedding_model, ''), 'unknown'),
       COALESCE(NULLIF(d.embedding_model, ''), 'unknown'), c.embedding_dimension,
       c.embedding, '[]'::jsonb, md5(c.content || ':' || c.id), c.created_at,
       CASE WHEN d.status = 'active' AND c.status = 'active' THEN NULL ELSE now() END
     FROM public.rag_chunks c
     JOIN public.rag_index_documents d ON d.id = c.document_id
     ON CONFLICT (target_id, document_id, target_spu_id, chunk_id) DO UPDATE SET
       retrieval_key = EXCLUDED.retrieval_key, spu_id = EXCLUDED.spu_id,
       source_document_version = EXCLUDED.source_document_version,
       chunk_type = EXCLUDED.chunk_type, content_payload = EXCLUDED.content_payload,
       final_text = EXCLUDED.final_text, embedding_profile_id = EXCLUDED.embedding_profile_id,
       embedding_model = EXCLUDED.embedding_model, vector_dimensions = EXCLUDED.vector_dimensions,
       embedding = EXCLUDED.embedding, content_hash = EXCLUDED.content_hash,
       updated_at = EXCLUDED.updated_at, deleted_at = EXCLUDED.deleted_at`,
    `CREATE INDEX IF NOT EXISTS ${bm25Index}
       ON rag.${table} USING bm25 (retrieval_key, final_text)
       WITH (key_field = 'retrieval_key')`,
    `INSERT INTO rag.schema_migrations(version) VALUES ('agentic-retrieval-${dimensions}-v1') ON CONFLICT (version) DO NOTHING`,
  ];
}
