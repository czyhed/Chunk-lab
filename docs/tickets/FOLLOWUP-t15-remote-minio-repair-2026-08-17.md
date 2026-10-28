# Follow-up: T15 Remote MinIO Repair

- Date: 2026-08-17
- Scope: repair the remote MinIO application identity and close the original-file upload failure
- T15 and historical evidence were not modified.

## Root cause

The remote MinIO endpoint was reachable, but authenticated requests returned `InvalidAccessKeyId`. Read-only remote inspection showed that `rag-assets` did not exist and the instance had no ordinary users. The local process and user environment also retained stale MinIO identity values that took precedence over the corrected `.env` references.

The MinIO container already exposed API and console ports, used a persistent host mount for `/data`, and had an `always` restart policy. The single-drive availability warning and release-age warning were unrelated to the upload failure.

## Repair

The deployment now has a `rag-assets` bucket with versioning enabled and one application identity attached to a bucket-scoped policy. The policy permits the bucket metadata/versioning and object operations required by the existing application contract. It does not grant access to other buckets.

The application identity references were updated atomically in `.env` and synchronized to the user environment. No credential, connection string, authorization value, presigned URL, or vector value was printed or stored in this evidence. No existing MinIO object, existing user, or local/server dataset was migrated, overwritten, or deleted.

## Acceptance

`HeadBucket` and `GetBucketVersioning` passed with the application identity. One versioned test object passed PUT, HEAD, and GET and remained readable after the local RAG application restarted. The first probe used the application's reserved `v1/` contract namespace; after it proved restart recovery, only that newly created probe received a delete marker because it lacked AssetDescriptor metadata and interfered with public object listing. Existing objects were not affected.

The real `materials/pdf/多图片PDF.pdf` file then passed the public upload path. A deterministic local MinerU fixture prevented supplier calls while the real PDF bytes and all application objects were persisted to the remote MinIO. The final document was `done` with 234 blocks, no storage error, five public object records, and a successful metadata-only HEAD for `source_original`.

After stopping the fixture, the normal application restarted on `0.0.0.0:4180`. A normal application-level demo smoke test returned `done`, a 200 object list, three contract objects, and no storage error.

PostgreSQL database creation and schema 2.0 migration were not executed because they were not necessary to repair or verify the MinIO upload path.

## Final audit

The final read-only audit confirmed that `rag-assets` exists, versioning remains enabled, exactly one ordinary application user exists, and the bucket-scoped policy has exactly one user binding. Local and remote credential handoff files and temporary `mc` audit directories are absent.

Both evidence JSON files parse successfully. The root page returned 200, health remained true, and the final server logs contained no HTTP 5xx or fatal event. One unrelated Fastify deprecation warning remains and was not changed under this MinIO-only scope. A value-level scan of the 12 new Ticket, JSON, and log files found no credential assignment, authorization value, connection string, presigned URL, data URL, private key, or vector value.

## Evidence

- `output/evidence/t15-remote-minio-repair-2026-08-17/verification-summary.json`
- `output/evidence/t15-remote-minio-repair-2026-08-17/public-http-summary.json`
- `output/evidence/t15-remote-minio-repair-2026-08-17/server-final.stdout.log`
- `output/evidence/t15-remote-minio-repair-2026-08-17/server-final.stderr.log`
- `output/evidence/t15-remote-minio-repair-2026-08-17/fake-mineru-calls.jsonl`
