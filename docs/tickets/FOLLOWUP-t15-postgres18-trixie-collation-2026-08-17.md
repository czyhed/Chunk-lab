# Follow-up: PostgreSQL 18.4 Trixie Collation Alignment

- Date: 2026-08-17
- Scope: preserve PostgreSQL 18.4, align the pgvector image with the trixie base, and verify natural collation recovery
- Historical T15 migration evidence was not modified.

## Change

The previous `pgvector/pgvector:0.8.1-pg18-bookworm` runtime was replaced by a server-built `rag-postgres:18.4-pgvector-trixie` image based on `postgres:18.4-trixie`. The image installs the PGDG `postgresql-18-pgvector` package without changing the existing PostgreSQL bind mount or restart policy. The container was recreated without copying, deleting, or rewriting database data.

## Collation verification

Before the change, the target database recorded collation `2.41` while bookworm provided `2.36`. After the trixie switch, PostgreSQL reported 18.4, trixie/glibc 2.41, and both recorded and actual target-database collation `2.41`. All connectable databases had zero collation inconsistencies, and recent PostgreSQL logs had zero warning/mismatch matches.

No `ALTER DATABASE ... REFRESH COLLATION VERSION` or object rebuild was executed. The consistency returned from the base-image alignment itself.

ADR 0007 now records PostgreSQL 18.4 on Debian trixie as the baseline and explicitly prohibits refreshing collation metadata merely to suppress a mismatch warning.

## Regression

The existing schema 2.0 migration rows and HNSW index remained present, the application health endpoint stayed true, and the root page returned HTTP 200. No supplier calls were made.

Evidence: `output/evidence/t15-postgres18-trixie-collation-2026-08-17/verification-summary.json`.

No credentials, connection strings, authorization values, presigned URLs, or vector values were printed or recorded.
