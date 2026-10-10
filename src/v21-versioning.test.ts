import assert from "node:assert/strict";
import { deriveNormalizedVersion } from "./v21-eligibility.js";

const source = {
  sourceDocumentVersion: "source-v1",
  parsedDocumentVersion: "parsed-v1",
  normalizerVersion: "normalizer-v1",
  normalizedModelVersion: "model-v1",
  normalizedModelInput: {
    blocks: [
      { contentBlockId: "block-1", normalized: { type: "paragraph", text: "A1 参数" } },
    ],
    metadata: { parser: "mineru", language: "zh-CN" },
  },
};
const before = structuredClone(source);
const first = deriveNormalizedVersion(source);
const repeated = deriveNormalizedVersion(source);

assert.deepEqual(first, repeated, "the same version input is deterministic");
assert.equal(first.fingerprint.length, 64);
assert.match(first.normalizedContentVersion, /^normalized-[a-f0-9]{16}$/);
assert.deepEqual(source, before, "deriving a version cannot mutate its source input");
assert.equal(Object.isFrozen(first), true, "the returned version record is immutable");

const reordered = deriveNormalizedVersion({
  normalizedModelInput: {
    metadata: { language: "zh-CN", parser: "mineru" },
    blocks: [
      { normalized: { text: "A1 参数", type: "paragraph" }, contentBlockId: "block-1" },
    ],
  },
  normalizedModelVersion: "model-v1",
  normalizerVersion: "normalizer-v1",
  parsedDocumentVersion: "parsed-v1",
  sourceDocumentVersion: "source-v1",
});
assert.deepEqual(reordered, first, "object key insertion order is not semantic version input");

const newNormalizer = deriveNormalizedVersion({ ...source, normalizerVersion: "normalizer-v2" });
assert.notEqual(newNormalizer.fingerprint, first.fingerprint);
assert.notEqual(newNormalizer.normalizedContentVersion, first.normalizedContentVersion);

const newModelInput = deriveNormalizedVersion({
  ...source,
  normalizedModelInput: {
    ...source.normalizedModelInput,
    blocks: [
      { contentBlockId: "block-1", normalized: { type: "paragraph", text: "A1 参数已修复" } },
    ],
  },
});
assert.notEqual(newModelInput.fingerprint, first.fingerprint);
assert.notEqual(newModelInput.normalizedContentVersion, first.normalizedContentVersion);

console.log("V2.1 versioning tests passed");
