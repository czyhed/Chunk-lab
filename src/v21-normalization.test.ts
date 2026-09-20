import assert from "node:assert/strict";
import {
  normalizeContentBlock,
  parseMarkdownContent,
  parseTxtContent,
} from "./v21-normalization.js";

const base = {
  parser: "mineru" as const,
  parserVersion: "2.1-test",
  parsedDocumentVersion: "parsed-v1",
};

const fixtures = [
  { type: "heading", text: "安装说明", level: 2 },
  { type: "paragraph", text: "适用于 A1 型号。" },
  { type: "list", ordered: true, items: ["断开电源", "取下杯体"] },
  {
    type: "table",
    title: "规格",
    table: { columns: ["型号", "功率"], rows: [["A1", "1200 W"]] },
    table_body: "<table><tr><td>A1</td><td>1200 W</td></tr></table>",
  },
  {
    type: "image",
    imageId: "image-1",
    imagePath: "private/install.png",
    caption: "杯体安装方向",
    productIdentity: "A1",
    summary: "箭头朝向锁定标记",
  },
  { type: "formula", latex: "P=UI", context: "额定功率" },
  { type: "code", language: "json", title: "配置", source: "{\"mode\":\"safe\"}" },
  { type: "warning", warningLevel: "danger", title: "高温", body: "请勿触摸。" },
  { type: "caption", text: "图 1 安装示意", targetId: "image-1" },
  { type: "footnote", marker: "1", text: "数据以实验室条件为准。" },
] as const;

const normalized = fixtures.map((fixture, index) =>
  normalizeContentBlock({
    ...base,
    ...fixture,
    rawBlockId: `raw-${index + 1}`,
    raw: {
      type: fixture.type,
      text: "text" in fixture ? fixture.text : undefined,
      table_body: "table_body" in fixture ? fixture.table_body : undefined,
      runtimeSecret: "must-not-survive",
    },
  }),
);

assert.deepEqual(
  normalized.map((block) => block.contentType),
  fixtures.map((fixture) => fixture.type),
  "all ten first-class content types stay typed",
);
assert.ok(normalized.every((block) => block.contractVersion === "2.1"));
assert.ok(normalized.every((block) => block.normalizationStatus === "normalized"));
assert.ok(normalized.every((block) => block.finalText === block.automaticText));
assert.ok(normalized.every((block) => block.automaticText === block.searchText));
assert.ok(normalized.every((block) => block.display.text.length > 0));

const table = normalized[3];
assert.equal(table.searchText, "规格\n型号 | 功率\nA1 | 1200 W");
assert.equal(table.searchText.includes("<tr>"), false);
assert.equal(table.automaticText.includes("<td>"), false);
assert.match(table.display.html ?? "", /<table>/);
assert.equal(JSON.stringify(table.raw).includes("must-not-survive"), false);
assert.match(JSON.stringify(table.raw), /rawTableHtml/);
assert.equal(
  table.raw.rawTableHtml,
  "<table><tr><td>A1</td><td>1200 W</td></tr></table>",
  "diagnostic HTML stays intact only in the raw layer",
);

const image = normalized[4];
assert.equal(image.searchText.includes("private/install.png"), false);
assert.equal(image.searchText, "Caption: 杯体安装方向\nProduct: A1\nSummary: 箭头朝向锁定标记");

const partialImage = normalizeContentBlock({
  ...base,
  type: "image",
  imageId: "image-only",
});
assert.equal(partialImage.normalizationStatus, "partial");

const failedFormula = normalizeContentBlock({
  ...base,
  type: "formula",
});
assert.equal(failedFormula.normalizationStatus, "failed");

const htmlCode = normalizeContentBlock({
  ...base,
  type: "code",
  language: "html",
  source: "<button>Save</button>",
});
assert.equal(
  htmlCode.normalized?.type === "code" ? htmlCode.normalized.source : null,
  "<button>Save</button>",
  "code source is content, not display markup, and must not be rewritten",
);

const unknown = normalizeContentBlock({
  ...base,
  type: "page-decoration",
  text: "do not treat this as a paragraph",
  rawBlockId: "raw-unknown",
});
assert.equal(unknown.contentType, "unsupported");
assert.equal(unknown.normalizationStatus, "unsupported");
assert.equal(unknown.normalized, null);
assert.equal(unknown.searchText, "");
assert.equal(unknown.excludedFromContentFlow, true);

const markdownSource = "# A😀\r\n\r\n1. 第一步\r\n2. 第二步\r\n\r\n```json\r\n{\"ok\":true}\r\n```\r\n";
const markdown = parseMarkdownContent(markdownSource, {
  parsedDocumentVersion: "md-v1",
  parserVersion: "commonmark-test",
});
assert.deepEqual(markdown.blocks.map((block) => block.contentType), [
  "heading",
  "list",
  "code",
]);
assert.deepEqual(markdown.ast.map((node) => node.type), ["heading", "list", "code"]);
for (const block of markdown.blocks) {
  const range = block.sourceRange;
  assert.ok(range, "Markdown blocks retain source ranges");
  assert.equal(
    markdownSource.slice(range.sourceStart, range.sourceEnd),
    block.raw.source,
    "Markdown offsets are UTF-16 half-open offsets into the immutable source",
  );
}
assert.equal(markdown.blocks[0].sourceRange?.sourceEnd, 5, "emoji occupies two UTF-16 code units");
assert.deepEqual(markdown.blocks[0].sourceRange, {
  sourceStart: 0,
  sourceEnd: 5,
  startLine: 1,
  endLine: 1,
});
assert.equal(
  markdown.blocks[2].normalized?.type === "code" ? markdown.blocks[2].normalized.source : null,
  "{\"ok\":true}\r\n",
  "Markdown fenced code preserves its source line endings",
);

const commonMark = parseMarkdownContent("> **警告**：请勿触摸。", {
  parsedDocumentVersion: "md-v2",
  parserVersion: "commonmark-0.31.2",
});
assert.equal(commonMark.blocks.length, 1);
assert.equal(commonMark.blocks[0].contentType, "paragraph");
assert.equal(commonMark.blocks[0].searchText, "警告：请勿触摸。");
assert.deepEqual(commonMark.blocks[0].sourceRange, {
  sourceStart: 0,
  sourceEnd: 14,
  startLine: 1,
  endLine: 1,
});

const txtSource = "A😀 参数\r\n继续说明\r\n\r\n第二段";
const txt = parseTxtContent(txtSource, {
  parsedDocumentVersion: "txt-v1",
  parserVersion: "txt-test",
});
assert.equal(txt.blocks.length, 2);
assert.deepEqual(txt.blocks.map((block) => block.contentType), ["paragraph", "paragraph"]);
for (const block of txt.blocks) {
  const range = block.sourceRange;
  assert.ok(range, "TXT blocks retain source ranges");
  assert.equal(txtSource.slice(range.sourceStart, range.sourceEnd), block.raw.source);
}
assert.deepEqual(txt.blocks[1].sourceRange, {
  sourceStart: 16,
  sourceEnd: 19,
  startLine: 4,
  endLine: 4,
});

console.log("V2.1 normalization tests passed");
