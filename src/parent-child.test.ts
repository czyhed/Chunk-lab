import assert from "node:assert/strict";
import { buildChunkPreview, countTokens, type ChunkRequest } from "./chunking.js";
import { parseChunkRequest } from "./chunk-request.js";
import { buildVectorRecord } from "./database-job.js";
import { parentContextFor } from "./parent-context.js";

const request = { strategy: "parent-child", chunkSize: 32, chunkOverlap: 4, parentChunkSize: 96,
  bufferSize: 1, breakpointPercentile: 90, semanticMaxChunkSize: 768, imagePolicy: "summary" } as unknown as ChunkRequest;
const text = Array.from({ length: 80 }, (_, index) => `Product ${index} holds water.`).join(" ");
const preview = await buildChunkPreview([{ id: "source", type: "text", text, page: 1, bbox: null }], request);
assert.ok(preview.chunks.length > 4, "long documents produce smaller searchable children");
const children = preview.chunks as Array<typeof preview.chunks[number] & { parentChunk?: { id: string; text: string; sourceSegments: typeof preview.chunks[number]["sourceSegments"] } }>;
assert.ok(children.every((chunk) => chunk.parentChunk), "every child retains a complete parent context");
const parents = new Map(children.map((chunk) => [chunk.parentChunk!.id, chunk.parentChunk!]));
assert.ok(parents.size > 1 && parents.size < children.length, "several children share each bounded parent");
for (const chunk of children) {
  assert.ok(chunk.parentChunk!.text.includes(chunk.text));
  assert.ok(countTokens(chunk.text) <= 32 && countTokens(chunk.parentChunk!.text) <= 96, "text parents and children respect separate token budgets");
  assert.equal(parents.get(chunk.parentChunk!.id)!.text, chunk.parentChunk!.text, "siblings have the same parent context");
  for (const segment of chunk.sourceSegments)
    assert.equal(text.slice(segment.sourceStart, segment.sourceEnd), chunk.text.slice(segment.chunkStart, segment.chunkEnd));
}
assert.equal(parseChunkRequest(request).strategy, "parent-child");
assert.equal(parseChunkRequest({ ...request, chunkOverlap: 0 }).chunkOverlap, 0);
for (const invalid of [{ parentChunkSize: 32 }, { parentChunkSize: 8193 }, { chunkSize: 0 }, { chunkSize: 32.5 }, { chunkOverlap: -1 }, { chunkOverlap: 32 }])
  assert.throws(() => parseChunkRequest({ ...request, ...invalid }));
const record = buildVectorRecord({ targetId: "test", documentId: "doc", chunk: preview.chunks[0], configuration: request,
  vectorRecord: { schemaVersion: "1.0", chunkId: preview.chunks[0].id, profileId: "test", model: "test", dimensions: 2, embeddingTextHash: "a".repeat(64), vector: [1, 0] }, at: new Date().toISOString() });
assert.equal((record.contentPayload.parentChunk as { text: string } | undefined)?.text, children[0].parentChunk!.text,
  "the database payload retains parent text alongside the child vector");
const reviewed = structuredClone(preview.chunks);
reviewed[0].excluded = true;
reviewed[1].finalText = "Manually corrected capacity.";
const edited = buildVectorRecord({ targetId: "test", documentId: "doc", chunk: reviewed[1], siblings: reviewed, configuration: request,
  vectorRecord: { schemaVersion: "1.0", chunkId: reviewed[1].id, profileId: "test", model: "test", dimensions: 2, embeddingTextHash: "b".repeat(64), vector: [1, 0] }, at: new Date().toISOString() } as Parameters<typeof buildVectorRecord>[0]);
const parentText = (edited.contentPayload.parentChunk as { text: string }).text;
assert.ok(parentText.includes("Manually corrected capacity."), "retrieval context uses reviewed child text");
assert.ok(!parentText.includes("Product 0 holds water."), "excluded content is not leaked through parent context");
const distinct = structuredClone(preview.chunks.slice(0, 2));
distinct.forEach((chunk, index) => {
  chunk.finalText = chunk.automaticText = "Wash.";
  chunk.parentChunk = { id: "repeat", text: "Wash. Wash.", childCount: 2, sourceSegments: [] };
  chunk.sourceSegments = [{ blockId: "source", page: 1, bbox: null, sourceStart: index * 6, sourceEnd: index * 6 + 5, chunkStart: 0, chunkEnd: 5, isOverlap: false }];
});
distinct[0].revisions.push({ type: "text", at: "2026-11-01" });
assert.equal(parentContextFor(distinct[0], distinct)?.text, "Wash.\n\nWash.", "distinct repeated source text must be preserved after editing");
assert.equal(parentContextFor(distinct[0], distinct)?.sourceSegments[1].chunkStart, 7);
const blockOnly = structuredClone(distinct[0]);
Object.assign(blockOnly.sourceSegments[0], { sourceStart: null, sourceEnd: null, chunkStart: null, chunkEnd: null, mappingQuality: "block-only" });
assert.equal(parentContextFor(blockOnly, [blockOnly])?.sourceSegments[0]?.blockId, "source", "source edits preserve block-only provenance");
console.log("Parent-child chunk tests passed");
