# Follow-up: Real DashScope VLM Closure

- Status: local-production-like-real-vlm-completed
- Date: 2026-08-16
- Evidence: `output/evidence/dashscope-vlm-real-acceptance/`
- Scope: reuse the existing real MinerU batch; no upload or MinerU resubmission
- Browser scope: desktop web only; mobile was not evaluated or claimed
- Historical boundary: Issues 01-13, T9.5, and prior evidence were not modified

## Result

The restarted server publicly exposed the configured default profiles and completed a real image workflow on the existing `多图片PDF.pdf` batch:

`source object -> Draft/Preview -> real DashScope VLM -> human image review -> real Context -> Context stale -> regenerated/confirmed Context -> real Embedding -> PostgreSQL/pgvector -> restart recovery -> Contract 2.1 export`.

The default profiles remained in use. The newly added profiles were visible as alternatives only and were not called.

## Sanitized call ledger

| Provider | Profile | Model | Calls | Retries | Result |
|---|---|---|---:|---:|---|
| VLM | `dashscope-vlm` | `qwen3.8-max` | 1 | 0 | Chinese summary, awaiting human review |
| Context | `dashscope-context` | `qwen3.7-flash-2026-07-15` | 2 | 0 | generated, confirmed; stale transition reproduced |
| Embedding | `real-embedding-1024` | `qwen3.7-text-embedding` | 1 job | 0 | 38 succeeded, 16 skipped, 0 failed; observed 1024 dimensions |

No API key, password, Authorization header, connection string, presigned URL, or vector values were written to this ticket or its evidence.

## Final verification

- Restart recovery passed through public HTTP APIs for the selected image Chunk, 38 public database records, 11 document objects, per-object metadata HEAD, and Contract 2.1 export.
- The restarted server exposes all six configured model profiles. The default `dashscope-vlm` and `dashscope-context` profiles remain selected; the four new alternatives were not called.
- Desktop web acceptance passed at 1440x1000 with no horizontal overflow and 0 Console errors / 0 Console warnings.
- `npm test` passed 12/12; `npm run typecheck`, `npm run build`, and affected JavaScript `node --check` checks passed.
- A value-aware scan covered the new ticket/evidence/screenshots/logs and eight public API responses with zero credential, Authorization, connection-string, presigned-URL, data-URL, or configured-secret matches.

## Remaining boundary

This is a local Docker production-like acceptance. No remote production target, authorized account, DNS/TLS, backup destination, or maintenance window was supplied; remote deployment is not claimed.
