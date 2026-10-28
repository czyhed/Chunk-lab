# Follow-up: Image Chunk Relations And Listener

- Date: 2026-08-17
- Scope: independent follow-up evidence for image Chunk relation semantics and local listener configuration
- Historical Issues 01-13, T9.5, prior evidence, and user data were not modified.

## Result

The image contract is authoritative on the server. `summary` keeps the confirmed human summary as `finalText` and accepts optional, deduplicated same-document text relations. `reference` requires at least one valid text relation, keeps image `finalText` and `embeddingText` empty, excludes the image from Context/Embedding, and leaves downstream work to the related text Chunk. `exclude` remains outside valid downstream retrieval. Related IDs are revalidated and recomputed after review changes, and invalid targets fail closed.

The browser flow at 1440x1000 verified two optional summary relations through save and reload, then verified that reference without a relation is blocked with Chinese reason/impact/next-step text. Adding one valid text relation saved successfully, restored after reload, hid VLM controls, and left no console error or warning and no horizontal overflow. Contract selection was 2.1 and the public export projection preserved the relation, empty image text, and reference exclusion reason.

The server listens on `0.0.0.0:4180` by default while retaining `HOST`/`PORT` configuration. Localhost and four local interface health checks returned 200. One non-local diagnostic address timed out; no firewall, router, or remote infrastructure setting was changed.

## Verification

`npm test`, `npm run typecheck`, `npm run build`, focused image/UI tests, and affected JavaScript `node --check` all passed. The only known non-blocking output is the existing PDF standard-font warning. No VLM, Context, Embedding, or database action was clicked in browser QA; real supplier calls recorded for this run: 0.

Evidence files:

- `output/evidence/image-chunk-relations-listener-2026-08-17/public-response-summary.json`
- `output/evidence/image-chunk-relations-listener-2026-08-17/verification.json`
- `output/evidence/image-chunk-relations-listener-2026-08-17/01-summary-two-relations-1440x1000.jpg`
- `output/evidence/image-chunk-relations-listener-2026-08-17/02-reference-missing-relation-1440x1000.jpg`
- `output/evidence/image-chunk-relations-listener-2026-08-17/03-reference-saved-1440x1000.jpg`

After the final process restart, reloading the transient demo fixture produced a local object-store 502 `UnknownError`; it was recorded as a diagnostic and not retried. No credentials, object URI, presigned URL, data URL, authorization header, or vector value is recorded in this follow-up.
