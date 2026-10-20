import assert from "node:assert/strict";
import { beginPdfRender, cancelPdfRender } from "../pdf-render-coordinator.js";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

const root = {};
const pending = deferred();
let cancelCalls = 0;
const first = beginPdfRender(root);
first.track({ promise: pending.promise, cancel: () => { cancelCalls += 1; } });
const second = beginPdfRender(root);
assert.equal(cancelCalls, 1);
assert.equal(first.cancelled, true);
assert.equal(second.cancelled, false);
assert.equal(await Promise.race([second.waitForPrevious.then(() => "settled"), Promise.resolve("pending")]), "pending");
pending.resolve();
await second.waitForPrevious;
assert.equal(second.cancelled, false);

const active = deferred();
second.track({ promise: active.promise, cancel: () => { cancelCalls += 1; } });
const cancelled = cancelPdfRender(root);
assert.equal(cancelCalls, 2);
assert.equal(second.cancelled, true);
active.resolve();
await cancelled;

console.log("PDF render coordinator tests passed");
