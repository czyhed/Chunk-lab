import assert from "node:assert/strict";
import { planUpload } from "./v21-upload.js";

assert.deepEqual(planUpload("manual.docx"), {
  parseRoute: "mineru",
  createVisualCopy: true,
  preferredSourceViewKind: "visual_copy",
});
assert.deepEqual(planUpload("manual.pdf"), {
  parseRoute: "mineru",
  createVisualCopy: false,
  preferredSourceViewKind: "original_file",
});
assert.deepEqual(planUpload("manual.md"), {
  parseRoute: "local",
  createVisualCopy: false,
  preferredSourceViewKind: "markdown_source",
});
assert.throws(() => planUpload("manual.doc"), /不支持的文件格式/);

console.log("V2.1 upload planning tests passed");
