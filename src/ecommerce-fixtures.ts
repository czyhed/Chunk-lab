import type { ParsedBlock } from "./chunking.js";

export type EcommerceFixture = {
  sampleClass:
    | "single-product-manual"
    | "multi-model-manual"
    | "illustrated-installation"
    | "large-parameter-table"
    | "cross-page-table"
    | "two-column-manual"
    | "scanned-manual"
    | "mixed-safety-page";
  blocks: ParsedBlock[];
  expectedReadingOrder: string[];
  expectedChunkBoundaries: string[][];
};

function block(
  id: string,
  text: string,
  readingOrder: number,
  overrides: Partial<ParsedBlock> = {},
): ParsedBlock {
  return {
    id,
    type: "text",
    text,
    page: 1,
    bbox: [80, 80 + readingOrder * 80, 920, 140 + readingOrder * 80],
    readingOrder,
    role: "paragraph",
    productIdentity: "星澜 A1",
    sourceBackend: "deterministic-fixture",
    sourceVersion: "ecommerce-v2-fixture-1",
    ...overrides,
  };
}

const largeParameterRows = Array.from(
  { length: 80 },
  (_, index) =>
    `| A${String(index + 1).padStart(2, "0")} | ${1200 + index * 5}W | ${(1.5 + index / 100).toFixed(2)}L |`,
);
const largeParameterTable = [
  "| 型号 | 功率 | 容量 |",
  "| --- | --- | --- |",
  ...largeParameterRows,
].join("\n");

export const ecommerceFixtures: EcommerceFixture[] = [
  {
    sampleClass: "single-product-manual",
    blocks: [
      block("single-title", "星澜 A1 智能料理机", 0, { role: "heading" }),
      block("single-install", "安装前确认杯体已锁定。", 1, { parentId: "single-title" }),
      block("single-use", "选择模式后按启动键。", 2, { parentId: "single-title" }),
    ],
    expectedReadingOrder: ["single-title", "single-install", "single-use"],
    expectedChunkBoundaries: [["single-title", "single-install", "single-use"]],
  },
  {
    sampleClass: "multi-model-manual",
    blocks: [
      block("models-title", "A1 / A2 共用说明", 0, { role: "heading", productIdentity: undefined }),
      block("model-a1", "A1 适用：额定容量 1.8L。", 1, { parentId: "models-title", productIdentity: "星澜 A1" }),
      block("model-a2", "A2 适用：额定容量 2.0L。", 2, { parentId: "models-title", productIdentity: "星澜 A2" }),
    ],
    expectedReadingOrder: ["models-title", "model-a1", "model-a2"],
    expectedChunkBoundaries: [["models-title", "model-a1"], ["model-a2"]],
  },
  {
    sampleClass: "illustrated-installation",
    blocks: [
      block("install-title", "安装步骤", 0, { role: "heading" }),
      block("install-step", "将杯体顺时针旋转至锁定位置。", 1, { groupId: "install-figure", parentId: "install-title" }),
      block("install-image", "", 2, { type: "image", role: "image", groupId: "install-figure", imagePath: "fixture://install" }),
      block("install-caption", "图 1：杯体锁定方向", 3, { role: "caption", groupId: "install-figure" }),
    ],
    expectedReadingOrder: ["install-title", "install-step", "install-image", "install-caption"],
    expectedChunkBoundaries: [["install-title"], ["install-step", "install-image", "install-caption"]],
  },
  {
    sampleClass: "large-parameter-table",
    blocks: [
      block("table-title", "产品参数", 0, { role: "heading" }),
      block("large-table", largeParameterTable, 1, { type: "table", role: "table", groupId: "large-table" }),
    ],
    expectedReadingOrder: ["table-title", "large-table"],
    expectedChunkBoundaries: [
      ["table-title"],
      ["large-table"],
      ["large-table"],
      ["large-table"],
    ],
  },
  {
    sampleClass: "cross-page-table",
    blocks: [
      block("table-p1", "| 型号 | 功率 |\n| --- | --- |\n| A1 | 1200W |", 0, { type: "table", role: "table", groupId: "spec-table", page: 1 }),
      block("table-p2", "| 型号 | 容量 |\n| --- | --- |\n| A1 | 1.8L |", 1, { type: "table", role: "table", groupId: "spec-table", page: 2 }),
    ],
    expectedReadingOrder: ["table-p1", "table-p2"],
    expectedChunkBoundaries: [["table-p1", "table-p2"]],
  },
  {
    sampleClass: "two-column-manual",
    blocks: [
      block("left-1", "左栏：安装准备。", 0, { bbox: [60, 100, 460, 180] }),
      block("left-2", "左栏：锁定杯体。", 1, { bbox: [60, 220, 460, 300] }),
      block("right-1", "右栏：选择模式。", 2, { bbox: [540, 100, 940, 180] }),
      block("right-2", "右栏：启动设备。", 3, { bbox: [540, 220, 940, 300] }),
    ],
    expectedReadingOrder: ["left-1", "left-2", "right-1", "right-2"],
    expectedChunkBoundaries: [["left-1", "left-2", "right-1", "right-2"]],
  },
  {
    sampleClass: "scanned-manual",
    blocks: [
      block("scan-title", "扫描说明书：星澜 A1", 0, { role: "heading", sourceBackend: "mineru-ocr", sourceVersion: "fixture-ocr-v1" }),
      block("scan-body", "OCR 正文：使用前检查电源线。", 1, { sourceBackend: "mineru-ocr", sourceVersion: "fixture-ocr-v1" }),
    ],
    expectedReadingOrder: ["scan-title", "scan-body"],
    expectedChunkBoundaries: [["scan-title", "scan-body"]],
  },
  {
    sampleClass: "mixed-safety-page",
    blocks: [
      block("warning-title", "警告", 0, { role: "warning", groupId: "warning-group" }),
      block("warning-body", "清洁前必须拔下电源插头。", 1, { groupId: "warning-group" }),
      block("warning-image", "", 2, { type: "image", role: "image", groupId: "safety-image", imagePath: "fixture://safety" }),
      block("warning-caption", "图 2：断电位置", 3, { role: "caption", groupId: "safety-image" }),
      block("warning-next", "确认干燥后再接通电源。", 4),
    ],
    expectedReadingOrder: ["warning-title", "warning-body", "warning-image", "warning-caption", "warning-next"],
    expectedChunkBoundaries: [["warning-title", "warning-body"], ["warning-image", "warning-caption"], ["warning-next"]],
  },
];
