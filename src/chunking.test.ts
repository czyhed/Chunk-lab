import assert from "node:assert/strict";
import {
  analyzeSemanticText,
  buildChunkPreview,
  chunkBlocks,
  type ChunkRequest,
  type ParsedBlock,
} from "./chunking.js";

const shortBlocks: ParsedBlock[] = Array.from({ length: 10 }, (_, index) => ({
  id: `b${index + 1}`,
  type: "text",
  text: `商品说明第${index + 1}句包含安装步骤和安全提示。`,
  page: index < 5 ? 1 : 2,
  bbox: [10, 20 + index * 12, 190, 30 + index * 12],
  readingOrder: index,
  role: "paragraph",
}));

const base: ChunkRequest = {
  strategy: "sentence",
  chunkSize: 48,
  chunkOverlap: 0,
  bufferSize: 1,
  breakpointPercentile: 90,
  semanticMaxChunkSize: 64,
  imagePolicy: "summary",
};

const small = chunkBlocks(shortBlocks, { ...base, chunkSize: 24 });
const large = chunkBlocks(shortBlocks, { ...base, chunkSize: 80 });
assert.ok(small.length > large.length, "chunkSize must change cross-Block structure");
assert.ok(
  large.some((chunk) => new Set(chunk.sourceSegments.map((segment) => segment.blockId)).size > 1),
  "eligible adjacent Blocks must aggregate into one Chunk",
);

const withoutOverlap = chunkBlocks(shortBlocks, {
  ...base,
  chunkSize: 32,
  chunkOverlap: 0,
});
assert.equal(
  withoutOverlap.flatMap((chunk) => chunk.sourceSegments).some((segment) => segment.isOverlap),
  false,
);

const withOverlap = chunkBlocks(shortBlocks, {
  ...base,
  chunkSize: 48,
  chunkOverlap: 20,
});
assert.ok(
  withOverlap.flatMap((chunk) => chunk.sourceSegments).some((segment) => segment.isOverlap),
  "nonzero overlap must be represented in provenance",
);
const overlappingSegments = withOverlap
  .flatMap((chunk) => chunk.sourceSegments)
  .filter((segment) => segment.isOverlap);
assert.ok(
  overlappingSegments.every((overlap) =>
    withOverlap.some((chunk) =>
      chunk.sourceSegments.some(
        (source) =>
          !source.isOverlap &&
          source.blockId === overlap.blockId &&
          source.sourceStart < overlap.sourceEnd &&
          source.sourceEnd > overlap.sourceStart,
      ),
    ),
  ),
  "overlap ranges must refer to source text already present in another Chunk",
);

const tokenOverlap = chunkBlocks(shortBlocks, {
  ...base,
  strategy: "token",
  chunkSize: 48,
  chunkOverlap: 20,
});
assert.ok(
  tokenOverlap.flatMap((chunk) => chunk.sourceSegments).some((segment) => segment.isOverlap),
  "TokenTextSplitter strategy must not expose the installed library's broken overlap behavior",
);

const repeatedBlocks: ParsedBlock[] = [
  {
    id: "repeat-1",
    type: "text",
    text: "请关闭电源后再安装。",
    page: 1,
    bbox: [0, 0, 10, 10],
    readingOrder: 0,
    role: "paragraph",
  },
  {
    id: "repeat-2",
    type: "text",
    text: "请关闭电源后再安装。",
    page: 2,
    bbox: [0, 0, 10, 10],
    readingOrder: 1,
    role: "paragraph",
  },
];
const repeatedChunks = chunkBlocks(repeatedBlocks, {
  ...base,
  chunkSize: 16,
});
assert.deepEqual(
  repeatedChunks.flatMap((chunk) => chunk.sourceSegments.map((segment) => segment.blockId)),
  ["repeat-1", "repeat-2"],
  "repeated text must map monotonically to its actual source Blocks",
);

const sectionBlocks: ParsedBlock[] = [
  { ...shortBlocks[0], id: "heading-1", role: "heading", text: "安装" },
  { ...shortBlocks[1], id: "body-1", role: "paragraph" },
  { ...shortBlocks[2], id: "heading-2", role: "heading", text: "维护" },
  { ...shortBlocks[3], id: "body-2", role: "paragraph" },
];
const sectionChunks = chunkBlocks(sectionBlocks, {
  ...base,
  strategy: "structure",
  chunkSize: 256,
  chunkOverlap: 64,
});
assert.equal(sectionChunks.length, 2, "headings must start separate structure-aware flows");
assert.deepEqual(sectionChunks[0].sourceBlockIds, ["heading-1", "body-1"]);
assert.deepEqual(sectionChunks[1].sourceBlockIds, ["heading-2", "body-2"]);
assert.equal(
  sectionChunks.flatMap((chunk) => chunk.sourceSegments).some((segment) => segment.isOverlap),
  false,
  "overlap must not cross section boundaries",
);

const identityChunks = chunkBlocks(
  [
    { ...shortBlocks[0], id: "product-a", productIdentity: "A1" },
    { ...shortBlocks[1], id: "product-b", productIdentity: "B2" },
  ],
  { ...base, strategy: "structure", chunkSize: 512 },
);
assert.equal(identityChunks.length, 2, "Product Identity changes must start a new structure-aware flow");

const pageLocalOrderBlocks: ParsedBlock[] = [
  { ...shortBlocks[3], id: "p2-o1", page: 2, readingOrder: 1, text: "第二页第二段。" },
  { ...shortBlocks[0], id: "p1-o0", page: 1, readingOrder: 0, text: "第一页第一段。" },
  { ...shortBlocks[2], id: "p2-o0", page: 2, readingOrder: 0, text: "第二页第一段。" },
  { ...shortBlocks[1], id: "p1-o1", page: 1, readingOrder: 1, text: "第一页第二段。" },
];
const pageOrdered = chunkBlocks(pageLocalOrderBlocks, {
  ...base,
  strategy: "structure",
  chunkSize: 512,
});
assert.deepEqual(pageOrdered[0].sourceBlockIds, ["p1-o0", "p1-o1", "p2-o0", "p2-o1"]);

const protectedBlocks: ParsedBlock[] = [
  shortBlocks[0],
  {
    id: "table-1",
    type: "table",
    text: "| 型号 | 功率 |\n| A1 | 1200W |",
    page: 1,
    bbox: [10, 180, 190, 260],
    readingOrder: 10,
    role: "table",
  },
];
const protectedChunks = chunkBlocks(protectedBlocks, base);
assert.equal(protectedChunks.at(-1)?.type, "table");
assert.deepEqual(
  protectedChunks.at(-1)?.sourceSegments.map((segment) => segment.blockId),
  ["table-1"],
);

const fakeEmbed = async (texts: string[]) =>
  texts.map((_, index) => [index === 1 ? 1 : 0, index === 1 ? 0 : 1]);
const semanticSignals = await analyzeSemanticText(
  "第一句话。第二句话。第三句话。",
  1,
  90,
  fakeEmbed,
);
assert.equal(semanticSignals.length, 3);
const peakSignals = await analyzeSemanticText(
  "安装前断电。确认杯体。开始运行。清洁后晾干。",
  0,
  90,
  async (texts) =>
    texts.map((_, index) =>
      index < 2 ? [1, 0] : index === 2 ? [0, 1] : [0, 1],
    ),
);
assert.deepEqual(
  peakSignals.map((signal) => signal.isBreakpoint),
  [false, true, false, false],
  "the unique maximum semantic distance must remain a breakpoint at percentile 90",
);

const crossPagePreview = await buildChunkPreview(
  shortBlocks,
  { ...base, chunkSize: 80 },
);
assert.equal(crossPagePreview.metrics.chunkCount, crossPagePreview.chunks.length);
assert.ok(crossPagePreview.metrics.token.maximum >= crossPagePreview.metrics.token.minimum);
assert.ok(crossPagePreview.metrics.crossPageCount > 0);
assert.equal(
  crossPagePreview.metrics.typeCounts.text +
    crossPagePreview.metrics.typeCounts.image +
    crossPagePreview.metrics.typeCounts.table,
  crossPagePreview.chunks.length,
);

const longSentence = "本产品安装前必须断开电源并确认额定电压。".repeat(30);
const semanticPreview = await buildChunkPreview(
  [
    {
      id: "semantic-1",
      type: "text",
      text: longSentence,
      page: 1,
      bbox: [0, 0, 100, 200],
      readingOrder: 0,
      role: "paragraph",
    },
  ],
  {
    ...base,
    strategy: "semantic",
    semanticMaxChunkSize: 48,
  },
  async (texts) => texts.map(() => [1, 0]),
);
assert.ok(semanticPreview.chunks.length > 1);
assert.ok(
  semanticPreview.chunks.every((chunk) => chunk.tokenCount <= 48),
  "semantic fallback must enforce the configured maximum token budget",
);
const embeddingFailure = new Error("embedding fixture failed");
await assert.rejects(
  () =>
    buildChunkPreview(
      shortBlocks,
      { ...base, strategy: "semantic" },
      async () => {
        throw embeddingFailure;
      },
    ),
  (error: unknown) => error === embeddingFailure,
);
let protectedEmbeddingCalls = 0;
await buildChunkPreview(
  [protectedBlocks[1]],
  { ...base, strategy: "semantic" },
  async (texts) => {
    protectedEmbeddingCalls += texts.length;
    return texts.map(() => [1, 0]);
  },
);
assert.equal(protectedEmbeddingCalls, 0);
assert.ok(
  semanticPreview.chunks.some((chunk) =>
    chunk.qualityFlags.includes("semantic_budget_boundary"),
  ),
);

const emptyImagePreview = await buildChunkPreview(
  [
    {
      id: "image-empty",
      type: "image",
      text: "",
      page: 3,
      bbox: [20, 30, 320, 480],
      readingOrder: 0,
      role: "image",
      imagePath: "images/product.png",
    },
  ],
  base,
);
assert.equal(emptyImagePreview.chunks[0].finalText, "");
assert.equal(emptyImagePreview.chunks[0].sourceSegments.length, 1);
assert.deepEqual(emptyImagePreview.chunks[0].sourceSegments[0].bbox, [20, 30, 320, 480]);

const oversizedTableText = `| 型号 | 功率 |\n| --- | --- |\n${Array.from(
  { length: 30 },
  (_, index) => `| A${index + 1} | ${1000 + index}W |`,
).join("\n")}`;
const tablePreview = await buildChunkPreview(
  [
    {
      id: "table-large",
      type: "table",
      text: oversizedTableText,
      page: 4,
      bbox: [20, 20, 500, 760],
      readingOrder: 0,
      role: "table",
      groupId: "spec-table",
    },
  ],
  { ...base, chunkSize: 40 },
);
assert.equal(
  tablePreview.chunks.map((chunk) => chunk.finalText).join("\n").includes("A30"),
  true,
  "oversized protected content must never be silently truncated",
);

const emptyPreview = await buildChunkPreview([], base);
assert.deepEqual(emptyPreview.metrics.token, { minimum: 0, average: 0, maximum: 0 });
assert.equal(emptyPreview.metrics.chunkCount, 0);
assert.equal(JSON.stringify(emptyPreview.metrics).includes("NaN"), false);
assert.ok(
  tablePreview.chunks.length > 1 ||
    tablePreview.chunks[0].qualityFlags.includes("oversized"),
);
assert.ok(tablePreview.chunks.length > 1, "oversized tables must split by consecutive row groups");
assert.ok(tablePreview.chunks.every((chunk) => chunk.tableId === "spec-table"));
assert.ok(
  tablePreview.chunks.every((chunk) =>
    chunk.finalText.startsWith("| 型号 | 功率 |\n| --- | --- |"),
  ),
  "every table row group must repeat the header",
);
const exportedTableRows = tablePreview.chunks.flatMap((chunk) =>
  chunk.finalText.split("\n").filter((line) => /^\| A\d+ /.test(line)),
);
assert.deepEqual(
  exportedTableRows,
  Array.from({ length: 30 }, (_, index) => `| A${index + 1} | ${1000 + index}W |`),
);

const groupedPreview = await buildChunkPreview(
  [
    {
      id: "warning-title",
      type: "text",
      text: "警告",
      page: 1,
      bbox: [0, 0, 100, 30],
      readingOrder: 0,
      role: "warning",
      groupId: "warning-1",
    },
    {
      id: "warning-body",
      type: "text",
      text: "清洁产品前必须拔下电源插头。",
      page: 1,
      bbox: [0, 32, 100, 80],
      readingOrder: 1,
      role: "paragraph",
      groupId: "warning-1",
    },
    {
      id: "product-image",
      type: "image",
      text: "",
      page: 1,
      bbox: [0, 90, 100, 190],
      readingOrder: 2,
      role: "image",
      groupId: "image-1",
      imagePath: "images/a1.png",
    },
    {
      id: "image-caption",
      type: "text",
      text: "图 1：A1 安装方向",
      page: 1,
      bbox: [0, 192, 100, 220],
      readingOrder: 3,
      role: "caption",
      groupId: "image-1",
    },
  ],
  { ...base, strategy: "structure", chunkSize: 512, chunkOverlap: 64 },
);
assert.equal(groupedPreview.chunks.length, 2);
assert.deepEqual(groupedPreview.chunks[0].sourceBlockIds, ["warning-title", "warning-body"]);
assert.deepEqual(groupedPreview.chunks[1].sourceBlockIds, ["product-image", "image-caption"]);
assert.equal(groupedPreview.chunks[1].type, "image");

const longWarningPreview = await buildChunkPreview(
  [
    {
      id: "warning-heading-long",
      type: "text",
      text: "危险：触电风险",
      page: 1,
      bbox: [0, 0, 100, 30],
      readingOrder: 0,
      role: "warning",
      groupId: "warning-long",
    },
    {
      id: "warning-copy-long",
      type: "text",
      text: Array.from(
        { length: 12 },
        (_, index) => `安全要求 ${index + 1}：清洁或拆装前必须断开电源。`,
      ).join(""),
      page: 1,
      bbox: [0, 32, 100, 400],
      readingOrder: 1,
      role: "paragraph",
      groupId: "warning-long",
    },
  ],
  { ...base, chunkSize: 64 },
);
assert.ok(longWarningPreview.chunks.length > 1);
assert.ok(
  longWarningPreview.chunks.every((chunk) =>
    chunk.finalText.startsWith("危险：触电风险"),
  ),
);
assert.ok(longWarningPreview.chunks.every((chunk) => chunk.type === "text"));

const longImagePreview = await buildChunkPreview(
  [
    {
      id: "image-asset-long",
      type: "image",
      text: "",
      page: 2,
      bbox: [0, 0, 500, 500],
      readingOrder: 0,
      role: "image",
      groupId: "image-long",
      imagePath: "images/assembly.png",
    },
    {
      id: "image-caption-long",
      type: "text",
      text: Array.from(
        { length: 12 },
        (_, index) => `安装图说明 ${index + 1}：箭头指向杯体锁定位置。`,
      ).join(""),
      page: 2,
      bbox: [0, 510, 500, 900],
      readingOrder: 1,
      role: "caption",
      groupId: "image-long",
    },
  ],
  { ...base, chunkSize: 64 },
);
assert.ok(longImagePreview.chunks.length > 1);
assert.ok(longImagePreview.chunks.every((chunk) => chunk.type === "image"));
assert.ok(longImagePreview.chunks.every((chunk) => chunk.imageId === "image-long"));
assert.ok(
  longImagePreview.chunks.every((chunk) =>
    chunk.sourceSegments.some((segment) => segment.blockId === "image-asset-long"),
  ),
  "each caption group must retain the unsplit image asset reference",
);
const excludedImageGroup = await buildChunkPreview(
  [
    {
      id: "product-image",
      type: "image",
      text: "",
      page: 1,
      bbox: [0, 90, 100, 190],
      readingOrder: 0,
      role: "image",
      groupId: "image-1",
      imagePath: "images/a1.png",
    },
    {
      id: "image-caption",
      type: "text",
      text: "图 1：A1 安装方向",
      page: 1,
      bbox: [0, 192, 100, 220],
      readingOrder: 1,
      role: "caption",
      groupId: "image-1",
    },
  ],
  { ...base, imagePolicy: "exclude" },
);
assert.equal(excludedImageGroup.chunks.length, 0);

const uncertainPreview = await buildChunkPreview(
  [
    { ...shortBlocks[0], id: "uncertain-a", page: 1, readingOrder: 0 },
    { ...shortBlocks[1], id: "uncertain-b", page: 1, readingOrder: 0 },
  ],
  base,
);
assert.ok(
  uncertainPreview.chunks.some((chunk) =>
    chunk.qualityFlags.includes("reading_order_uncertain"),
  ),
);

assert.deepEqual(Object.keys(crossPagePreview.metrics.tokenDistribution), [
  "under80",
  "80to255",
  "256to511",
  "512to1023",
  "1024plus",
]);
assert.equal(
  Object.values(crossPagePreview.metrics.tokenDistribution).reduce(
    (sum, count) => sum + count,
    0,
  ),
  crossPagePreview.chunks.length,
);

for (const chunk of [...withOverlap, ...tokenOverlap, ...repeatedChunks]) {
  for (const segment of chunk.sourceSegments) {
    const block = [...shortBlocks, ...repeatedBlocks].find(
      (candidate) => candidate.id === segment.blockId,
    );
    assert.ok(block);
    assert.equal(
      chunk.automaticText.slice(segment.chunkStart, segment.chunkEnd),
      block.text.slice(segment.sourceStart, segment.sourceEnd),
      "Source Segment ranges must replay exact source text",
    );
  }
}

for (const chunk of [
  ...small,
  ...large,
  ...withOverlap,
  ...tokenOverlap,
  ...sectionChunks,
  ...pageOrdered,
]) {
  let previousChunkEnd = -1;
  for (const segment of chunk.sourceSegments) {
    assert.ok(segment.sourceStart >= 0 && segment.sourceEnd >= segment.sourceStart);
    assert.ok(segment.chunkStart >= 0 && segment.chunkEnd >= segment.chunkStart);
    assert.ok(segment.chunkEnd <= chunk.automaticText.length);
    assert.ok(segment.chunkStart >= previousChunkEnd, "Source Segments must be ordered in Chunk coordinates");
    previousChunkEnd = segment.chunkEnd;
  }
  assert.deepEqual(
    chunk.sourceBlockIds,
    [...new Set(chunk.sourceSegments.map((segment) => segment.blockId))],
  );
}

await assert.rejects(
  () => buildChunkPreview(shortBlocks, { ...base, strategy: "semantic" }),
  /requires an embedding model/i,
);

assert.throws(
  () =>
    chunkBlocks(shortBlocks, {
      ...base,
      chunkSize: 32,
      chunkOverlap: 32,
    }),
  /overlap.*less than.*size/i,
);

console.log("chunking V2 core tests passed");
