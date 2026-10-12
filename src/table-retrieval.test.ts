import assert from "node:assert/strict";
import {
  buildEmbeddingInputText,
  MemoryTableRetrievalRepository,
  TableRetrievalService,
  validateTableQueryReadiness,
  type TableArtifact,
  type TableCell,
} from "./table-retrieval.js";
import { createConfiguredTableRetrievalTarget } from "./table-retrieval-persistence.js";

const cell = (id: string, text: string, rowSpan = 1, colSpan = 1): TableCell => ({
  cellId: id,
  text,
  rowSpan,
  colSpan,
});

function artifact(overrides: Partial<TableArtifact> = {}): TableArtifact {
  return {
    type: "table",
    tableId: "table-1",
    title: "产品参数表",
    columns: ["型号", "价格"],
    rows: [[cell("r1c1", "A1"), cell("r1c2", "¥100")]],
    rowGroups: [{
      rowGroupId: "group-1",
      order: 0,
      repeatedHeader: false,
      sourceSegmentIds: ["source-1"],
      rowStart: 0,
      rowCount: 1,
    }],
    sourceSegments: [{ id: "source-1", page: 1, bbox: null }],
    ...overrides,
  };
}

const embed = async (texts: string[]) => texts.map((text) => [text.length, 1]);

const first = await buildService().createVersion({
  logicalTableId: "logical-1",
  artifact: artifact(),
  finalSummary: "A1 的价格为 100 元。",
  sourceChunks: [
    { sourceChunkId: "chunk-b", sourceChunkVersion: "v1", order: 2, finalText: "后文" },
    { sourceChunkId: "chunk-a", sourceChunkVersion: "v1", order: 1, finalText: "前文" },
  ],
  rawTableHtml: "<table>private diagnostic</table>",
  markdown: "| A1 | ¥100 |",
  renderedHtml: "<table>derived</table>",
  at: "2026-08-19T00:00:00.000Z",
});
assert.ok(first.bundle?.vectorReady);
assert.deepEqual(first.bundle?.sourceChunkIds, ["chunk-a", "chunk-b"]);
assert.equal(first.bundle?.embeddingInputText.includes("A1 | ¥100"), false);
assert.equal(first.bundle?.embeddingInputText.includes("<table>"), false);
assert.equal(first.bundle?.embeddingInputText, buildEmbeddingInputText({
  artifact: artifact(),
  finalSummary: "A1 的价格为 100 元。",
  sourceChunks: [
    { sourceChunkId: "chunk-b", sourceChunkVersion: "v1", order: 2, finalText: "后文" },
    { sourceChunkId: "chunk-a", sourceChunkVersion: "v1", order: 1, finalText: "前文" },
  ],
}));

const linkedOnly = await buildService().createVersion({
  logicalTableId: "logical-linked-only",
  artifact: artifact(),
  finalSummary: "",
  sourceChunks: [{ sourceChunkId: "chunk-a", sourceChunkVersion: "v1", order: 0, finalText: "关联文字足以支持表格检索。" }],
});
assert.ok(linkedOnly.bundle?.vectorReady, "关联文字 Chunk 足够生成表格检索 Bundle");
assert.equal(linkedOnly.version.finalSummary, "");

const diagnosticsRepository = new MemoryTableRetrievalRepository();
const diagnosticsService = new TableRetrievalService({
  repository: diagnosticsRepository,
  embedTexts: embed,
  profile: { id: "fake", model: "fake-v1", dimensions: 2 },
});
await diagnosticsService.createVersion({
  logicalTableId: "logical-diagnostics",
  tableVersionId: "diagnostics-version",
  artifact: { ...artifact(), rawTableHtml: "must not persist" } as TableArtifact,
  finalSummary: "摘要",
});
assert.equal(JSON.stringify(await diagnosticsRepository.getVersion("diagnostics-version")).includes("must not persist"), false);

const repository = new MemoryTableRetrievalRepository();
const service = new TableRetrievalService({
  repository,
  embedTexts: embed,
  profile: { id: "fake", model: "fake-v1", dimensions: 2 },
});
const created = await service.createVersion({
  logicalTableId: "logical-2",
  tableVersionId: "version-1",
  artifact: artifact(),
  finalSummary: "摘要",
  at: "2026-08-19T00:00:00.000Z",
});
assert.deepEqual(repository.events.slice(0, 2), ["save-version:version-1", "save-bundle:version-1"]);
assert.equal(repository.bundles.size, 1, "one Table Bundle has one vector record");
assert.equal(repository.versions.size, 1, "linked text does not create an independent vector record");
await service.confirmQueryReady("version-1", "2026-08-19T00:01:00.000Z");
assert.equal((await repository.getVersion("version-1"))?.queryReady, true);

const replacement = await service.createVersion({
  logicalTableId: "logical-2",
  tableVersionId: "version-2",
  artifact: artifact({ title: "更新后的产品参数表" }),
  finalSummary: "新摘要",
  at: "2026-08-19T00:02:00.000Z",
});
assert.ok(replacement.bundle);
assert.deepEqual(repository.events.slice(-3), [
  "save-bundle:version-2",
  "soft-delete:version-1",
  "activate:version-2",
]);
assert.equal((await repository.getVersion("version-1"))?.state, "soft_deleted");
assert.equal((await repository.search([1, 1], "fake")).length, 1);

const failing = new TableRetrievalService({
  repository,
  embedTexts: async () => { throw new Error("fake embedding failure"); },
  profile: { id: "fake", model: "fake-v1", dimensions: 2 },
});
await assert.rejects(
  failing.createVersion({
    logicalTableId: "logical-2",
    tableVersionId: "version-failed",
    artifact: artifact(),
    finalSummary: "失败更新",
  }),
  /fake embedding failure/,
);
assert.equal((await repository.findActive("logical-2"))?.tableVersionId, "version-2");

for (const invalid of [
  artifact({ columns: [] }),
  artifact({ rows: [] }),
  artifact({ columns: ["型号", "型号"] }),
  artifact({ rowGroups: [{ ...artifact().rowGroups[0], sourceSegmentIds: [] }] }),
  artifact({ rows: [[cell("bad", "A1", 1, 3)]] }),
]) assert.equal(validateTableQueryReadiness(invalid).valid, false);
assert.equal(validateTableQueryReadiness(artifact()).valid, true);

const configuredTarget = createConfiguredTableRetrievalTarget({
  DATABASE_PROFILES_JSON: JSON.stringify([{
    id: "remote-pgvector",
    kind: "pgvector",
    host: "203.0.113.10",
    port: 5432,
    databaseEnv: "ISSUE14_TEST_DB",
    userEnv: "ISSUE14_TEST_USER",
    passwordEnv: "ISSUE14_TEST_PASSWORD",
  }]),
  ISSUE14_TEST_DB: "rag",
  ISSUE14_TEST_USER: "rag_app",
  ISSUE14_TEST_PASSWORD: "test-only",
}, 2);
assert.equal(configuredTarget?.profileId, "remote-pgvector");
await configuredTarget?.repository.close();

console.log("Table retrieval domain and persistence seam tests passed");

function buildService(): TableRetrievalService {
  return new TableRetrievalService({
    repository: new MemoryTableRetrievalRepository(),
    embedTexts: embed,
    profile: { id: "fake", model: "fake-v1", dimensions: 2 },
  });
}
