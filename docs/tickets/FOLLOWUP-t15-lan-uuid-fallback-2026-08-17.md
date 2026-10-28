# Follow-up: LAN HTTP UUID Compatibility

- Date: 2026-08-17
- Scope: prevent non-secure LAN HTTP browsers from failing before the upload queue is created

## Fix

`app.js` no longer calls `crypto.randomUUID()` directly. The shared `browserUuid` helper prefers `crypto.randomUUID()` and falls back to `crypto.getRandomValues()` with RFC 4122 v4 and variant bits. Upload queue IDs, manual annotation IDs, merge group IDs, and table-cell IDs use the helper.

The helper lives in the existing `manual-annotations.js` static route, so no new server asset allowlist or route was required. The app import uses a cache-busting module version.

## Verification

The fallback unit test, JavaScript syntax checks, direct-call scan, health check, root HTTP check, and static resource fetch passed. The app continues listening on `0.0.0.0:4180`. HTTPS was not configured in this local code fix; it remains a separate certificate/deployment task.

Evidence: `output/evidence/t15-lan-uuid-fallback-2026-08-17/verification-summary.json`.

No credentials, connection strings, authorization values, presigned URLs, or vector values were recorded.
