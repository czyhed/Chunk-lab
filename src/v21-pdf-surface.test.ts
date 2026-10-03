import assert from "node:assert/strict";
import { pdfPagePlan } from "./v21-pdf-surface.js";

assert.deepEqual(pdfPagePlan([1, 2, 3, 4], 1), [1, 2]);
assert.deepEqual(pdfPagePlan([1, 2, 3, 4], 3), [2, 3, 4]);
assert.deepEqual(pdfPagePlan([1, 2, 3, 4], 4), [3, 4]);
assert.deepEqual(pdfPagePlan([1], 9), [1]);

console.log("V2.1 PDF surface tests passed");
