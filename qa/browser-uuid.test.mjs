import assert from "node:assert/strict";
import { browserUuid } from "../manual-annotations.js";

let randomUuidCalls = 0;
let randomValuesCalls = 0;
const preferred = browserUuid({
  randomUUID() {
    randomUuidCalls += 1;
    return "preferred-uuid";
  },
  getRandomValues() {
    randomValuesCalls += 1;
    throw new Error("fallback should not run when randomUUID exists");
  },
});
assert.equal(preferred, "preferred-uuid");
assert.equal(randomUuidCalls, 1);
assert.equal(randomValuesCalls, 0);

const fallback = browserUuid({
  getRandomValues(bytes) {
    bytes.fill(0xff);
  },
});
assert.match(fallback, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

assert.throws(() => browserUuid({}), /不支持安全随机 UUID/);
console.log("Browser UUID compatibility tests passed");
