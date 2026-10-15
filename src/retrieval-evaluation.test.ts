import assert from "node:assert/strict";
import { evaluateRecallAtK } from "./retrieval-evaluation.js";

const result = evaluateRecallAtK({
  queryVector: [1, 0],
  records: [
    { chunkId: "a", vector: [1, 0] },
    { chunkId: "b", vector: [0.8, 0.2] },
    { chunkId: "c", vector: [0, 1] },
  ],
  relevantChunkIds: ["a", "c"],
  k: 2,
});

assert.deepEqual(result.results.map((item) => item.chunkId), ["a", "b"]);
assert.deepEqual(result.hitChunkIds, ["a"]);
assert.equal(result.recallAtK, 0.5);
assert.throws(() => evaluateRecallAtK({ queryVector: [], records: [], relevantChunkIds: ["a"], k: 1 }));
assert.throws(() => evaluateRecallAtK({ queryVector: [1], records: [], relevantChunkIds: [], k: 1 }));

console.log("Retrieval Recall@K tests passed");
