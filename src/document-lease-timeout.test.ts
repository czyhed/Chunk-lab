import assert from "node:assert/strict";
import { createRedisDocumentLeaseStore } from "./document-lease.js";

const client = {
  isOpen: false,
  connect: () => new Promise<void>(() => {}),
} as never;
const store = createRedisDocumentLeaseStore({ client, connectionTimeoutMs: 20 });

const startedAt = Date.now();
await assert.rejects(store.get("timeout-test"), /Redis connection timed out/);
assert.ok(Date.now() - startedAt < 500, "Redis connection failure should be bounded");
console.log("Document lease timeout test passed");
