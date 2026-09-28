# ADR 0007: Manage pgvector records with versioned migrations and dimension-specific tables

## Status

Accepted for local production-like validation. A real configured Embedding response observed on 2026-08-16 returned 1024 dimensions; schema `2.0` is therefore bound to the dimension-specific `vector(1024)` contract. A different production model must create a separately reviewed dimension contract rather than reusing this typmod.

## Decision

The production contract uses PostgreSQL 18.4 on the Debian trixie base with pgvector and an application-owned schema `rag`. Migrations are recorded in `rag.schema_migrations` and are safe to execute repeatedly on an empty or initialized database. Existing `public.rag_vector_records_v1` data is not altered or deleted. The trixie base is required to keep the PostgreSQL 18.4 collation runtime aligned with the recorded database collation version; collation metadata must not be refreshed merely to suppress a mismatch warning.

The new record identity is `(target_id, document_id, chunk_id)`. Documents and object references have explicit parent rows and foreign keys. JSONB stores structured table payload, Source Segments, Context provenance and image object metadata; binary image data, base64, data URLs, vectors in public responses, credentials and connection details are forbidden.

The observed real Embedding response dimension creates `rag.vector_records_v2_d1024` with a `vector(1024)` typmod. Records enforce the profile/model/dimension contract, cosine distance is used, and a cosine HNSW index is created after the table is bound to the observed dimension. The application rejects mixed dimensions instead of guessing or silently coercing them. The migration, empty-database initialization, repeat execution, restart recovery and dedicated backup restore are recorded in the current follow-up evidence.

Upsert is idempotent by content hash. One changed Chunk updates only its row. Excluded Chunks and explicitly deleted documents are soft-deleted with `deleted_at` and `delete_after`. Every soft deletion writes `rag.deletion_audit`; the independent migration `2.0-gc-audit-v1` adds this audit contract without changing the dimension-specific table.

Delayed physical cleanup is exposed only through the document-scoped `POST /api/batches/:batchId/documents/:documentId/database-gc` maintenance route. It requires explicit confirmation and a configured schema `2.0` profile, deletes only records whose `delete_after` has elapsed, writes one `physical_delete` audit row per record, and is idempotent. The parent document row is removed only after all of its vector rows are eligible for physical cleanup. Public record and GC responses omit vector values, audit bodies and connection information.

## Operational boundary

Local Docker is production-like acceptance only. Remote deployment requires a named server, authorized account, domain/TLS termination, backup destination and maintenance window. The deployment operator owns root/admin credentials; the application receives separate least-privilege MinIO and PostgreSQL service accounts through a deployment environment or secret manager.
