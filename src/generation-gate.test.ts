import assert from "node:assert/strict";
import { GenerationGate } from "./generation-gate.js";

const gate = new GenerationGate();
const first = gate.begin("doc-1", "preview");
const second = gate.begin("doc-1", "preview");
assert.equal(gate.isCurrent(first), false, "older Preview results must be stale");
assert.equal(gate.isCurrent(second), true);

const context = gate.begin("doc-1", "context");
assert.equal(gate.isCurrent(second), true, "Context work must not cancel Preview work");
assert.equal(gate.isCurrent(context), true);

const otherDocument = gate.begin("doc-2", "preview");
assert.equal(gate.isCurrent(second), true, "another document must not cancel this document");
assert.equal(gate.isCurrent(otherDocument), true);

console.log("Generation gate tests passed");
