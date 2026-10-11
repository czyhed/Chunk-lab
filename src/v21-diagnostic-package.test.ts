import assert from "node:assert/strict";
import {
  buildDiagnosticPackage,
  hasBboxPageAnomaly,
} from "./v21-diagnostic-package.js";

const generatedAt = "2026-08-13T12:00:00.000Z";
const diagnostic = buildDiagnosticPackage({
  batchId: "batch-1",
  documentId: "doc-1",
  generatedAt,
  sourceFingerprint: "sha256:sanitized-fixture",
  issues: [{
    category: "visual_conversion_failed",
    message: "converter failed at https://converter.invalid Authorization: Bearer issue-secret",
  }],
  versions: {
    parserVersion: "mineru-fixture-v1",
    normalizerVersion: "v21-normalizer-1",
    converterVersion: "office-fixture-v1",
    apiKey: "synthetic-version-secret",
  },
  status: {
    parseState: "done",
    visualCopyState: "failed",
    requestUrl: "https://status.invalid/private",
  },
  raw: {
    fullMarkdown: "# A1\n\n安全使用说明 https://signed.invalid/private Authorization: Bearer inline-secret",
    rawTableHtml: "<table data-source='https://table.invalid/private'><tr><td>功率</td><td>1200 W</td></tr></table>",
    contentList: [
      {
        type: "table",
        table_body: "<table><tr><td>功率</td><td>1200 W</td></tr></table>",
        nested: {
          Authorization: "Bearer synthetic-secret",
          requestUrl: "https://service.invalid/private?id=1",
          full_zip_url: "https://download.invalid/signed-result",
          access_token: "synthetic-access-token",
          headers: { Cookie: "session=synthetic" },
          clientSecret: "synthetic-client-secret",
          private_key: "synthetic-private-key",
          upstreamRequestHeaders: { "X-Internal": "synthetic-header" },
          safeParserField: "preserved",
          notes: ["Cookie: session=inline-cookie", "api_key=inline-api-key"],
        },
      },
    ],
  },
  // Ordinary Chunk/export fields are intentionally outside the diagnostic allowlist.
  finalText: "must-not-enter",
  embeddingText: "must-not-enter",
  chunks: [{ chunkId: "must-not-enter" }],
} as Parameters<typeof buildDiagnosticPackage>[0] & Record<string, unknown>);

assert.equal(diagnostic.packageKind, "v21-diagnostic");
assert.equal(diagnostic.contractVersion, "2.1");
assert.equal(diagnostic.batchId, "batch-1");
assert.deepEqual(diagnostic.issues.map((issue) => issue.category), [
  "visual_conversion_failed",
]);
assert.equal(diagnostic.generatedAt, generatedAt);
assert.equal(diagnostic.expiresAt, "2026-08-14T12:00:00.000Z");
assert.match(diagnostic.raw.fullMarkdown ?? "", /安全使用说明/);
assert.match(diagnostic.raw.rawTableHtml ?? "", /<table/);
assert.equal(
  (diagnostic.raw.contentList?.[0] as Record<string, unknown>).type,
  "table",
);
assert.equal(
  ((diagnostic.raw.contentList?.[0] as Record<string, unknown>).nested as Record<string, unknown>)
    .safeParserField,
  "preserved",
);

const serialized = JSON.stringify(diagnostic);
for (const forbidden of [
  "synthetic-secret",
  "service.invalid",
  "session=synthetic",
  "Authorization",
  "requestUrl",
  "headers",
  "finalText",
  "embeddingText",
  "chunks",
  "must-not-enter",
  "synthetic-version-secret",
  "status.invalid",
  "download.invalid",
  "synthetic-access-token",
  "synthetic-client-secret",
  "synthetic-private-key",
  "synthetic-header",
  "signed.invalid",
  "table.invalid",
  "inline-secret",
  "inline-cookie",
  "inline-api-key",
  "converter.invalid",
  "issue-secret",
]) assert.equal(serialized.includes(forbidden), false, `${forbidden} must not enter diagnostics`);

assert.throws(
  () => buildDiagnosticPackage({
    batchId: "batch-1",
    documentId: "doc-1",
    generatedAt: "not-a-date",
    sourceFingerprint: "sha256:test",
    issues: [{ category: "parse_failed", message: "fixture" }],
    versions: { parserVersion: "fixture" },
    raw: {},
  }),
  /generatedAt/,
);

const pageMapping = {
  pages: [{ page: 1, pageWidth: 595, pageHeight: 842 }],
};
assert.equal(
  hasBboxPageAnomaly([{ page_idx: 0, text: "无 bbox 仍是正常降级" }], pageMapping),
  false,
);
assert.equal(
  hasBboxPageAnomaly([{ page_idx: 4, bbox: [0, 0, 100, 100] }], pageMapping),
  true,
);
assert.equal(
  hasBboxPageAnomaly([{ page_idx: 0, bbox: [0, 0, 900, 100] }], pageMapping),
  true,
);
assert.equal(
  hasBboxPageAnomaly(
    [{ page_idx: 0, bbox: [100, 200, 900, 800] }],
    { pages: [{ page: 1, pageWidth: 612, pageHeight: 792, bboxPageWidth: 1000, bboxPageHeight: 1000 }] },
  ),
  false,
  "MinerU normalized bbox bounds are independent from PDF point dimensions",
);
assert.equal(
  hasBboxPageAnomaly([{ page_idx: -1, bbox: [0, 0, 100, 100] }], pageMapping),
  true,
);

console.log("V2.1 diagnostic package tests passed");
