# T15: Remote storage configuration

- Status: configured; remote connectivity and initialization pending
- Date: 2026-08-17
- Scope: server-backed MinIO and PostgreSQL/pgvector for all subsequent application persistence

## Completed configuration

- `.env` now selects the server MinIO API endpoint and the dedicated `rag-assets` bucket.
- Duplicate local MinIO overrides were removed, so later environment entries no longer redirect writes to localhost.
- MinIO keeps the existing `us-east-1` region contract and uses environment-owned access credentials.
- `DATABASE_PROFILES_JSON` now exposes `server-pgvector-v2-1024` with schema version `2.0` and the observed 1024-dimensional vector contract.
- The database profile references `PG_DATABASE`, `PG_USER`, and `PG_PASSWORD`; credentials are not duplicated inside the profile JSON.
- Existing Context, VLM, and Embedding profiles remain unchanged.
- Configuration parsing passed with one MinIO configuration, one database profile, six model profiles, and one Embedding profile.

## Persistence decision

All subsequent application object and vector persistence must use the configured server MinIO and PostgreSQL targets. Production-like launch scripts or environment overlays must not silently replace these targets with localhost services.

Existing local MinIO and PostgreSQL data is not automatically migrated or deleted. Any later migration requires a separately approved, non-destructive backup and restore procedure.

## PostgreSQL initialization

The deployment procedure must provision the configured PostgreSQL database when it does not exist. Database creation is an explicit administrative deployment step because an application connection cannot create the database it is trying to connect to.

After the database exists, run the existing idempotent schema 2.0 migrations. They must:

- install or verify the `vector` extension;
- create the `rag` schema and migration ledger;
- create document, object-reference, vector-dimension, deletion-audit, and `vector(1024)` record tables;
- create foreign keys and the cosine HNSW index;
- remain safe when executed repeatedly.

The application service account should own the target database or have only the permissions required to connect and manage the `rag` schema. It must not use a PostgreSQL superuser for normal runtime operations.

## First remote startup acceptance

- Confirm the target database and `vector` extension exist, creating them only when absent.
- Run migrations twice and verify each migration version is recorded once.
- Verify MinIO bucket access, versioning, metadata-only HEAD behavior, and a dedicated test-prefix write.
- Verify one dedicated test record can be written to and read from PostgreSQL through the public application API.
- Restart the application and confirm the same object and database record recover.
- Do not overwrite, migrate, or delete any existing server data during initialization.
- Keep credentials, connection strings, Authorization headers, presigned URLs, and vector values out of logs and evidence.

## Current boundary

The environment configuration is complete, but remote connectivity, database provisioning, migrations, and restart recovery have not yet been executed or claimed as passed.
