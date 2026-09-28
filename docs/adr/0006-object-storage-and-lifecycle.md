# ADR 0006: Version all persistent file assets in private object storage

## Status

Accepted for the local production-like implementation on 2026-08-16. This ADR does not authorize a remote production deployment.

## Context

The current application persists Source Documents, Office Visual Copies, batch JSON and diagnostic packages under `.workspace`; only reviewed image assets use MinIO. MinerU result ZIP bytes and normalized Parsed Document snapshots are not first-class objects. A container restart can recover the local workspace, but the persistence boundary is split and there is no versioned classification, reference-aware deletion or auditable garbage collection.

ADR 0001 requires raw parser output to remain available for diagnosis. ADR 0002 requires assets to remain independent from vector records. Both decisions remain in force.

## Decision

All persistent file-like assets use object contract `1.0` in one private, versioned S3-compatible bucket. Application state, workspace metadata, Chunk records and vector records store only the object reference and necessary metadata. They must not store binary values, base64, data URLs, Authorization values, credentials or presigned URLs.

| Asset class | Prefix | Content type | Default retention | Public projection |
| --- | --- | --- | --- | --- |
| `source_original` | `v1/source-original` | uploaded MIME type | until explicit document deletion | metadata; body only through authenticated source route |
| `mineru_raw_response` | `v1/mineru-raw-response` | `application/json` | 30 days | metadata only |
| `mineru_result_zip` | `v1/mineru-result-zip` | `application/zip` | 30 days | metadata only |
| `mineru_trusted_result` | `v1/mineru-trusted-result` | `application/json` or `text/markdown` | 30 days | metadata only |
| `parsed_document_snapshot` | `v1/parsed-document` | `application/json` | until explicit document deletion | metadata; normalized public review projection remains unchanged |
| `office_visual_copy` | `v1/office-visual-copy` | `application/pdf` | 30 days | metadata; body only through visual-copy route |
| `pdf_page_render` | `v1/pdf-page-render` | `image/png` | 30 days | metadata/body through controlled source rendering |
| `pdf_image_crop` | `v1/pdf-image-crop` | image MIME type | until explicit document deletion while referenced | metadata only |
| `extracted_image` | `v1/extracted-image` | image MIME type | until explicit document deletion while referenced | metadata only |
| `model_input` | `v1/model-input` | controlled image or JSON MIME type | 30 days | metadata only |
| `export_package` | `v1/export-package` | `application/json` or archive MIME type | 30 days | metadata; body through export route |
| `diagnostic_package` | `v1/diagnostic-package` | `application/json` | 24 hours, preserving the existing contract | metadata; allowlisted body through diagnostic route |

When a trusted PDF crop is prepared for VLM input, the controlled full-page PNG is stored once as `pdf_page_render`, the exact crop as `pdf_image_crop`, and the sanitized request provenance as `model_input`. A direct source image creates `extracted_image` only when the model workflow actually needs that controlled input; ordinary parsing does not duplicate every image. Both paths use the same `AssetObjectStore`, checksum key, metadata-only public list and deletion audit contract as every other asset class.

Failed uploads and unreferenced objects override the class default with a 7-day expiry. A formally referenced crop or extracted image is retained with its document. Existing Temporary Workspace state keeps its formal 24-hour expiry; object expiry does not extend the workbench editing session.

Reference state is determined by an exact object key in persisted batch/document metadata, not merely by matching `documentId`. An object with no exact reference, or references only from failed Source Documents, becomes an orphan after seven days from `createdAt`. Any live reference prevents that seven-day override, including a key shared by live and failed documents. `document_delete` assets with a live reference remain protected; regenerable classes with a live reference still expire at their class-specific 24-hour or 30-day deadline.

Keys are immutable checksum keys:

`<prefix>/<batchId>/<documentId|batch>/<sourceVersion|no-source-version>/<assetVersion>/<sha256>.<extension>`

The SHA-256 checksum, MIME type, byte length, batch/document/source/version associations, creation/expiry times and private visibility are stored as object metadata. Repeating the same write is a cache hit. Changed bytes create a new key and never overwrite an older version.

MinIO bucket versioning is enabled. Anonymous/public access is disabled. Public APIs return `s3://` references and metadata only, never MinIO endpoints, credentials, connection details, object bodies from list/HEAD routes, or presigned URLs.

Document deletion is soft first. The application verifies active references, records `deletedAt` and `deleteAfter`, and appends an audit record. Physical GC is idempotent and requires a narrow prefix containing both asset class and batch. Production GC uses a delay; zero-delay deletion is allowed only in a newly created acceptance prefix. Existing user prefixes are never used for deletion tests.

The operator lifecycle endpoint requires explicit confirmation and a prefix shaped as `v1/<asset-class>/<batch-id>/`. It reads only persisted reference/state metadata for maintenance, including after the 24-hour editing session has expired; it does not reopen the workbench or hydrate object bodies. Each object is isolated: one tombstone failure is returned as `SOFT_DELETE_FAILED` while other eligible objects continue. A repeated sweep is idempotent. GC remains a separate delayed operation and every soft/physical deletion is written to the versioned audit prefix.

## Consequences

- Normal Chunk, pgvector and Contract 2.1 semantics remain unchanged.
- Local file materialization is temporary process input only and is removed after use; it is not a second persistent copy.
- Per-document/object write failures remain isolated. An object failure cannot make another document fail.
- Bucket lifecycle is enforced by the application because retention varies by reference state. MinIO versioning protects accidental overwrite; backup policy must include object versions and audit objects.
- Existing objects and PostgreSQL rows are not migrated or deleted by this change.
