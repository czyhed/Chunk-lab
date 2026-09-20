import assert from "node:assert/strict";
import {
  beginVisualCopy,
  classifySource,
  finishVisualCopy,
  createSourceDocument,
  retryVisualCopy,
} from "./v21-input.js";

const officeBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
let mineruBytes: Uint8Array | undefined;

const document = await createSourceDocument(
  {
    id: "doc-office-1",
    name: "product-manual.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytes: officeBytes,
  },
  {
    submitMineru: async (source) => {
      mineruBytes = source.bytes;
      return { jobId: "mineru-job-1" };
    },
    createVisualCopy: async () => {
      throw new Error("converter unavailable");
    },
  },
);

assert.deepEqual(mineruBytes, officeBytes, "Office original bytes go directly to MinerU");
assert.equal(document.parseJobId, "mineru-job-1");
assert.equal(document.parseState, "pending");
assert.equal(document.sourceViewKind, "parsed_document");
assert.equal(document.visualCopy.state, "failed");
assert.equal(document.visualCopy.error, "converter unavailable");
assert.equal(document.visualCopy.qualityFlag, "visual_copy_unavailable");
assert.equal(document.downstreamAvailable, true);
assert.match(document.sourceDocumentVersion, /^src-/);

const supported = [
  ["manual.pdf", "mineru", "original_file"],
  ["front.png", "mineru", "original_file"],
  ["front.jpg", "mineru", "original_file"],
  ["front.jpeg", "mineru", "original_file"],
  ["manual.docx", "mineru", "visual_copy"],
  ["slides.pptx", "mineru", "visual_copy"],
  ["parameters.xlsx", "mineru", "visual_copy"],
  ["readme.md", "local", "markdown_source"],
  ["notes.txt", "local", "txt_source"],
] as const;
for (const [name, parseRoute, sourceViewKind] of supported) {
  const classification = classifySource(name);
  assert.equal(classification.parseRoute, parseRoute, name);
  assert.equal(classification.preferredSourceViewKind, sourceViewKind, name);
}
assert.throws(() => classifySource("legacy.doc"), /不支持的文件格式: \.doc/);

const generating = beginVisualCopy("ticket-1");
assert.deepEqual(generating, { state: "generating", retryTicket: "ticket-1" });
const stateReady = finishVisualCopy(generating, {
  converter: "fake-office-renderer",
  converterVersion: "1.0.0",
  pageDimensions: [{ width: 1000, height: 700 }],
  coordinateMapping: { kind: "page_identity" },
  mappingVersion: "map-1",
});
assert.equal(stateReady.state, "ready");
const stateFailed = finishVisualCopy(generating, new Error("conversion failed"));
assert.deepEqual(stateFailed, {
  state: "failed",
  retryTicket: "ticket-1",
  error: "conversion failed",
  qualityFlag: "visual_copy_unavailable",
});

let localAdapterCalls = 0;
const markdown = await createSourceDocument(
  {
    id: "doc-md-1",
    name: "readme.md",
    mimeType: "text/markdown",
    bytes: new TextEncoder().encode("# Product"),
  },
  {
    submitMineru: async () => {
      localAdapterCalls += 1;
      return { jobId: "unexpected" };
    },
    createVisualCopy: async () => {
      localAdapterCalls += 1;
      throw new Error("unexpected");
    },
  },
);
assert.equal(localAdapterCalls, 0, "Markdown stays local");
assert.equal(markdown.parseRoute, "local");
assert.equal(markdown.sourceViewKind, "markdown_source");
assert.equal(markdown.visualCopy.state, "not_requested");

const readyOffice = await createSourceDocument(
  {
    id: "doc-office-2",
    name: "parameters.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    bytes: officeBytes,
  },
  {
    submitMineru: async () => ({ jobId: "mineru-job-2" }),
    createVisualCopy: async () => ({
      converter: "fake-office-renderer",
      converterVersion: "1.0.0",
      pageDimensions: [{ width: 1000, height: 700 }],
      coordinateMapping: { kind: "page_identity" },
      mappingVersion: "map-1",
    }),
  },
);
assert.equal(readyOffice.visualCopy.state, "ready");
assert.equal(readyOffice.sourceViewKind, "visual_copy");
if (readyOffice.visualCopy.state === "ready") {
  assert.equal(readyOffice.visualCopy.pageCount, 1);
  assert.equal(readyOffice.visualCopy.converter, "fake-office-renderer");
  assert.match(readyOffice.visualCopy.visualCopyVersion, /^visual-/);
}

const retried = await retryVisualCopy(document, {
  id: "doc-office-1",
  name: "product-manual.docx",
  mimeType:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  bytes: officeBytes,
}, async () => ({
  converter: "fake-office-renderer",
  converterVersion: "1.0.0",
  pageDimensions: [{ width: 800, height: 1200 }],
  coordinateMapping: { kind: "verified" },
  mappingVersion: "map-2",
}));
assert.equal(retried.sourceDocumentVersion, document.sourceDocumentVersion);
assert.equal(retried.visualCopy.state, "ready");
assert.equal(retried.parseJobId, document.parseJobId);

const failedRetry = await retryVisualCopy(document, {
  id: "doc-office-1",
  name: "product-manual.docx",
  mimeType:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  bytes: officeBytes,
}, async () => {
  throw new Error("converter still unavailable");
});
assert.equal(failedRetry.visualCopy.state, "failed");
assert.equal(failedRetry.sourceViewKind, "parsed_document");

console.log("V2.1 input contract tests passed");
