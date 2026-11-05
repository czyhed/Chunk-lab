# Storage production runbook

## Scope and prerequisites

This runbook deploys PostgreSQL/pgvector and MinIO for the RAG workbench. Local Docker validation is not a production deployment. Before any remote change, record the target host, authorized operator account, DNS name, TLS termination, backup destination, restore owner, monitoring destination and maintenance/rollback window.

## Security and network contract

- Expose application HTTP only through TLS termination. Do not expose PostgreSQL, MinIO API or MinIO Console to the public Internet.
- Restrict PostgreSQL and MinIO to the application network and operator management network.
- Create distinct application service accounts. MinIO permissions are limited to the configured bucket/prefix and required object/version/tag operations. PostgreSQL permissions are limited to the `rag` schema and migrations explicitly assigned to the migration role.
- Store credentials only in the deployment environment or secret manager. Browser code, source, ordinary logs, screenshots and evidence must not receive them.
- Keep request logging disabled or sanitized. Alert on repeated 5xx responses without logging request headers or bodies.

## MinIO

1. Provision durable storage with capacity for original uploads, 30-day intermediate peaks, retained referenced assets, object versions and backup overhead.
2. Create the private bucket and enable versioning. Confirm anonymous policies are absent.
3. Configure prefixes and retention from ADR 0006. Protect lifecycle and GC routes as operator-only application endpoints; do not expose them directly to browsers or the public Internet.
4. On the retention schedule, enumerate the intended batch and asset-class prefixes. For each exact `v1/<asset-class>/<batch-id>/` prefix, call `POST /api/batches/<batch-id>/object-lifecycle-sweep` with `{"prefix":"<exact-prefix>","confirm":true}`. The sweep may read expired workspace reference metadata for maintenance but never reopens the editing session or returns object bodies.
5. Require `failed: 0`, review `softDeleted`, `retained`, `alreadyDeleted` and the `expired`/`orphan` reason counts, then verify tombstones through the metadata-only object API and `v1/_audit/<batch-id>/`. A failed object is isolated; diagnose it and rerun the same prefix without widening scope.
6. Only after `deleteAfter` has passed, call `POST /api/batches/<batch-id>/object-gc` with the same exact prefix. Repeating both calls must be harmless. Never use a bucket-wide delete command, and never run acceptance deletion against an existing user batch.
7. Monitor capacity, object count, failed PUT/HEAD/GET, lifecycle failure counts, version growth, replication/backup status and GC audit failures.
8. Back up the bucket including versions and `v1/_audit`. Restore into a new bucket first, validate checksum metadata and application HEAD/list behavior, then schedule cutover.

The local non-destructive rehearsal is executable with `node --env-file=.env qa/verify-minio-backup-restore.mjs` after deployment secrets are present in the process environment. It creates a dedicated source batch and restore bucket, verifies version/checksum/length plus restored application list/HEAD, performs explicit soft delete and narrow-prefix GC, and removes the dedicated restore bucket. It never copies or deletes an existing user batch.

## PostgreSQL

1. Provision PostgreSQL 16 and the approved pgvector extension version on durable storage.
2. Back up the target database before migration. Run versioned migrations with the migration role; repeat the command to prove idempotency.
3. Bind the vector table only to the dimension returned by the configured real Embedding model. Create the cosine HNSW index and inspect validity after data load.
4. Monitor connections, transaction failures, table/index size, dead tuples, autovacuum, WAL, replication and backup age.
5. Take logical backups with schema, data and migration history. Restore into a new database, run checksums/counts and public record API validation, then discard only the dedicated restore database after approval.
6. Document deletion first invokes schema `2.0` repository soft deletion and must report no `DATABASE_SOFT_DELETE_FAILED` items before object tombstones are accepted. Verify matching `soft_delete` rows in `rag.deletion_audit`.
7. After `delete_after` has elapsed, call `POST /api/batches/<batch-id>/documents/<document-id>/database-gc` with `{"profileId":"<approved-profile>","confirm":true}`. Require the first result to match the expected matured tombstones and the repeated result to return `deleted: 0`; verify matching `physical_delete` audit rows. Never backdate production records or run this acceptance shortcut outside a dedicated test document.

## Failure recovery and rollback

- MinIO unavailable: reject new persistent object writes per document; do not submit VLM if its controlled input object was not stored. Existing metadata stays unchanged.
- PostgreSQL unavailable: retain the completed Embedding job and mark only the affected database items failed. Retry failed items after health recovery.
- Application restart: recover batch metadata, then hydrate required assets through object references. Never fall back to an unrelated local file path.
- Migration failure: stop writes, retain the pre-migration backup and previous application image, diagnose in a restored database, and roll back the application. Do not drop or rewrite existing tables as an automatic rollback.
- Upgrade: verify focused tests, empty initialization, repeat migration, backup restore, restart recovery and secret scan before traffic is enabled.

## Deletion

Document deletion is soft and audited. Schema `2.0` vector soft deletion completes before object tombstones are accepted; failures are returned by profile ID without connection details. Production physical cleanup occurs only after the configured delay and requires separate, document-scoped confirmation for both database and object cleanup. Acceptance deletion uses a new dedicated batch/prefix and database record; it never targets existing user data.

The lifecycle sweep applies the seven-day orphan override only when an object has no exact key reference or only failed-document references. A mixed live/failed reference stays protected from the override. Retained source/Parsed Document/formally referenced image assets remain until explicit document deletion; regenerable and package classes still follow their 24-hour or 30-day expiry. If persisted reference metadata is missing, stop and investigate rather than treating retained assets as unreferenced.
