import assert from "node:assert/strict";
import test from "node:test";
import { shouldLoadSelectedFile } from "../batch-refresh.js";

test("loads review when the selected document changes", () => {
  assert.equal(
    shouldLoadSelectedFile({
      previousSelectedFileId: null,
      nextSelectedFileId: "doc-1",
      previousSelectedState: null,
      nextSelectedState: "done",
    }),
    true,
  );
});

test("does not reload review for the same ready document during batch polling", () => {
  assert.equal(
    shouldLoadSelectedFile({
      previousSelectedFileId: "doc-1",
      nextSelectedFileId: "doc-1",
      previousSelectedState: "done",
      nextSelectedState: "done",
    }),
    false,
  );
});

test("loads review when the selected document becomes ready", () => {
  assert.equal(
    shouldLoadSelectedFile({
      previousSelectedFileId: "doc-1",
      nextSelectedFileId: "doc-1",
      previousSelectedState: "running",
      nextSelectedState: "done",
    }),
    true,
  );
});

test("refreshes the selected file view when reparsing starts", () => {
  assert.equal(
    shouldLoadSelectedFile({
      previousSelectedFileId: "doc-1",
      nextSelectedFileId: "doc-1",
      previousSelectedState: "done",
      nextSelectedState: "pending",
    }),
    true,
  );
});

console.log("Batch refresh regression tests passed");
