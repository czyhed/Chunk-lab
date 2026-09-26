import assert from "node:assert/strict";
import { createRedisDocumentLeaseStore } from "./document-lease.js";

const store = createRedisDocumentLeaseStore({
  url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  ttlSeconds: 2,
});
const fingerprint = `lease-test-${Date.now()}`;
const first = { userId: "user-a", sessionId: "session-a" };
const second = { userId: "user-b", sessionId: "session-b" };

try {
  const acquired = await store.acquire(fingerprint, first);
  assert.equal(acquired.ok, true);
  if (!acquired.ok) throw new Error("first lease was not acquired");
  const denied = await store.acquire(fingerprint, second);
  assert.equal(denied.ok, false);
  assert.equal(denied.lease?.userId, first.userId);
  assert.equal((await store.renew(fingerprint, acquired.lease.leaseId)).ok, true);
  assert.equal(await store.release(fingerprint, "wrong-lease"), false);
  assert.equal(await store.release(fingerprint, acquired.lease.leaseId), true);
  assert.equal((await store.acquire(fingerprint, second)).ok, true);
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  assert.equal((await store.get(fingerprint)).lease, null);
  console.log("Document lease tests passed");
} finally {
  await store.close?.();
}
