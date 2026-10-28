# Follow-up: T15 Remote PostgreSQL Schema 2.0

- Date: 2026-08-17
- Scope: remote PostgreSQL provisioning, pgvector runtime completion, and schema 2.0 migration
- T15 and historical evidence were not modified.

## Provisioning

The configured target database and application role already existed, the application role owned the database, and it had permission to create the `rag` schema. A pre-migration custom-format logical backup was created and passed `pg_restore --list` validation before any schema write.

The remote service was running `postgres:18.4` without the `vector` extension. The Compose image was atomically changed to `pgvector/pgvector:0.8.1-pg18-bookworm`, the existing PostgreSQL bind mount was preserved, and the container was recreated with its `always` restart policy. No database rows were migrated, deleted, or overwritten.

## Migration and verification

The existing `qa/migrate-storage-schema.ts --dimension=1024` entry point was run twice. Both runs succeeded and reported schema `2.0`, `vector_records_v2_d1024`, and a valid HNSW index. Final read-only checks found the `vector` extension, six `rag` tables, two vector-table foreign keys, `vector(1024)`, a valid cosine HNSW index, exactly one row for each migration version, and no legacy `public.rag_vector_records_v1` table.

The PostgreSQL container restart recovered successfully. The existing RAG process remained healthy on `0.0.0.0:4180`; root returned HTTP 200. No real MinerU, VLM, Context, or Embedding supplier call was made.

## Risks and evidence

The runtime is PostgreSQL 18.4 while ADR 0007 names PostgreSQL 16 as the accepted production-like baseline. The existing `postgres` database also reports a collation version mismatch; no collation refresh or object rebuild was attempted because it is outside this schema-only request.

Evidence: `output/evidence/t15-remote-postgres-schema2-2026-08-17/verification-summary.json`.

No credentials, connection strings, authorization values, presigned URLs, or vector values were printed or recorded.
