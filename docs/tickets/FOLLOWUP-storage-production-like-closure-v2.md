# Follow-up: Storage production-like closure v2

- Status: local-production-like-complete-remote-deployment-paused
- Date: 2026-08-17
- Evidence: `output/evidence/storage-production-like-closure-v2/`
- Browser scope: desktop web only
- Historical boundary: Issues 01-13, T9.5, earlier Tickets and earlier evidence were not modified

## Result

The local Docker closure now covers all 12 persistent asset classes, seven one-time real MinerU submissions, the default real DashScope VLM/Context profiles, the observed 1024-dimensional Embedding contract, PostgreSQL/pgvector schema 2.0, MinIO and PostgreSQL restart recovery, Contract 2.1 export, and desktop browser recovery.

The final missing local data-contract behavior was PostgreSQL delayed physical cleanup. Schema migration `2.0-gc-audit-v1` now adds `rag.deletion_audit`; document deletion soft-deletes configured schema 2.0 records before object tombstones, and the confirmed document-scoped `database-gc` route deletes only matured records, writes physical-delete audit rows and is idempotent. A dedicated acceptance batch verified soft delete 1, physical delete 1, repeated delete 0, with unrelated vector counts unchanged and zero model calls.

## Sanitized call ledger

| Provider | Calls | Retries | Result |
| --- | ---: | ---: | --- |
| MinerU | 7 submissions | 0 | Seven specified files completed independently |
| VLM | 1 | 0 | Default `dashscope-vlm`; Chinese image summary and provenance recovered |
| Context | 4 | 0 | Default `dashscope-context`; human modification, stale and final confirmation covered |
| Embedding | 4 batches/jobs | 0 | Default observed 1024-dimensional contract; image Chunk included |

Newly added model profiles remained alternatives and were not called.

## Verification

- All seven real batches recovered after MinIO, PostgreSQL and application restart; 60 public object HEAD checks and 60 MinIO S3 HEAD checks passed.
- The selected real image Chunk recovered with VLM model/prompt provenance, confirmed Chinese Context, 1024-dimensional Embedding eligibility, 38 public pgvector records and Contract 2.1 export with 609-character embedding text.
- A new empty PostgreSQL database passed two migrations with exactly two migration rows, `vector(1024)`, valid cosine HNSW, two foreign keys and the deletion-audit table.
- A new restore database recovered two migrations, 53 vector records, the valid index and deletion audit state without overwriting the source database or an existing backup.
- Desktop web 1440x1000 passed with the real image visible, the default VLM and Context selected, five rendered PDF canvases, no root/body horizontal overflow and 0 Console errors / 0 Console warnings.
- `npm test`, `npm run typecheck`, `npm run build`, 39 QA JavaScript syntax checks, eight root JavaScript syntax checks and affected PowerShell AST checks passed.
- The final value-aware scan covered 221 source/QA/document/evidence files, 21 new evidence/log files, four screenshots and nine public HTTP responses; configured-secret, credential, connection-string, presigned-URL, data-URL and vector-payload findings were all zero.

## Deployment boundary

This is local Docker production-like acceptance, not remote production deployment. No authorized production host/account, DNS/TLS target, backup destination/owner, monitoring destination, maintenance window or rollback owner is configured in the workspace, so remote changes remain paused under the runbook.
