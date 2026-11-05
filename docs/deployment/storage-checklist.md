# Storage deployment checklist

- [ ] Target server and authorized operator account recorded
- [ ] DNS name and TLS certificate/termination recorded
- [ ] Application, PostgreSQL and MinIO network boundaries approved
- [ ] Durable data volumes and capacity forecast approved
- [ ] MinIO private bucket, versioning and least-privilege service account created
- [ ] Operator-only lifecycle sweep and delayed GC schedule configured per exact batch/class prefix
- [ ] Lifecycle alerts cover per-object failures and audit-write failures
- [ ] PostgreSQL 16, pgvector extension and least-privilege roles created
- [x] Real Embedding dimension observed locally and dimension-specific migration generated
- [ ] Backup destination, schedule, retention and restore owner recorded
- [x] Local empty initialization and repeated migration pass
- [x] Local schema 2.0 soft deletion, deletion audit and delayed/idempotent database GC pass on a dedicated record
- [x] Local dedicated MinIO versioned backup restore and PostgreSQL restore rehearsals pass
- [ ] Monitoring and alert destinations configured
- [ ] Maintenance window, rollback owner and previous application image recorded
- [x] Local secret scan and public API projection checks pass
- [x] Local desktop web 1440x1000 browser acceptance passes; mobile is outside the current acceptance scope
