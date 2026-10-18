import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No test port"));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitFor(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("server did not become ready");
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise<void>((resolveStop) => child.once("exit", () => resolveStop()));
}

const port = await freePort();
const child = spawn(
  process.execPath,
  ["node_modules/tsx/dist/cli.mjs", "src/server.ts"],
  {
    cwd: resolve("."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      WORKSPACE_ROOT: resolve(".workspace", `object-api-${process.pid}`),
      MINERU_API_TOKEN: "object-api-fixture-token",
      EMBEDDING_BASE_URL: "http://127.0.0.1:9/v1",
      EMBEDDING_API_KEY: "object-api-fixture-key",
      EMBEDDING_MODEL: "fixture-model",
      MINIO_ENDPOINT: "",
      MINIO_BUCKET: "",
      MINIO_ACCESS_KEY: "",
      MINIO_SECRET_KEY: "",
      OBJECT_DELETE_GRACE_MS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

try {
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(`${baseUrl}/api/health`, child);
  const demoResponse = await fetch(`${baseUrl}/api/demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(demoResponse.status, 200);
  const demo = await demoResponse.json() as { id: string; documents: Array<{ id: string }> };
  const documentId = demo.documents[0].id;

  const sourceResponse = await fetch(
    `${baseUrl}/api/batches/${demo.id}/documents/${documentId}/source`,
  );
  assert.equal(sourceResponse.status, 200);
  const sourceBytes = new Uint8Array(await sourceResponse.arrayBuffer());
  assert.equal(sourceResponse.headers.get("content-type"), "application/pdf");
  assert.equal(sourceResponse.headers.get("content-length"), String(sourceBytes.byteLength));
  assert.ok(sourceBytes.byteLength > 0);

  const listResponse = await fetch(`${baseUrl}/api/batches/${demo.id}/objects?documentId=${documentId}`);
  assert.equal(listResponse.status, 200);
  const listed = await listResponse.json() as {
    contractVersion: string;
    objects: Array<{ key: string; assetClass: string; checksumSha256: string; deletedAt: string | null }>;
  };
  assert.equal(listed.contractVersion, "1.0");
  assert.equal(listed.objects.some((object) => object.assetClass === "source_original"), true);
  assert.equal(listed.objects.some((object) => object.assetClass === "parsed_document_snapshot"), true);
  assert.equal(listed.objects.every((object) => /^[a-f0-9]{64}$/.test(object.checksumSha256)), true);

  const source = listed.objects.find((object) => object.assetClass === "source_original")!;
  const headResponse = await fetch(
    `${baseUrl}/api/batches/${demo.id}/objects/head?key=${encodeURIComponent(source.key)}`,
  );
  assert.equal(headResponse.status, 200);
  assert.equal(((await headResponse.json()) as { object: { key: string } }).object.key, source.key);

  const unconfirmedSweep = await fetch(
    `${baseUrl}/api/batches/${demo.id}/object-lifecycle-sweep`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefix: `v1/source-original/${demo.id}/` }),
    },
  );
  assert.equal(unconfirmedSweep.status, 409);
  const broadSweep = await fetch(
    `${baseUrl}/api/batches/${demo.id}/object-lifecycle-sweep`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefix: "v1/", confirm: true }),
    },
  );
  assert.equal(broadSweep.status, 409);
  const protectedSweep = await fetch(
    `${baseUrl}/api/batches/${demo.id}/object-lifecycle-sweep`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prefix: `v1/source-original/${demo.id}/`,
        confirm: true,
      }),
    },
  );
  assert.equal(protectedSweep.status, 200);
  assert.deepEqual(await protectedSweep.json(), {
    examined: 1,
    softDeleted: 0,
    retained: 1,
    alreadyDeleted: 0,
    failed: 0,
    reasons: { expired: 0, orphan: 0 },
    failures: [],
  });

  const unconfirmedDatabaseGc = await fetch(
    `${baseUrl}/api/batches/${demo.id}/documents/${documentId}/database-gc`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: "missing" }),
    },
  );
  assert.equal(unconfirmedDatabaseGc.status, 409);
  const unavailableDatabaseGc = await fetch(
    `${baseUrl}/api/batches/${demo.id}/documents/${documentId}/database-gc`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: "missing", confirm: true }),
    },
  );
  assert.equal(unavailableDatabaseGc.status, 503);

  const unconfirmed = await fetch(`${baseUrl}/api/batches/${demo.id}/documents/${documentId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(unconfirmed.status, 409);
  const deleted = await fetch(`${baseUrl}/api/batches/${demo.id}/documents/${documentId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: true }),
  });
  assert.equal(deleted.status, 200);

  const deletedList = await (
    await fetch(`${baseUrl}/api/batches/${demo.id}/objects?documentId=${documentId}&includeDeleted=true`)
  ).json() as typeof listed;
  assert.equal(deletedList.objects.every((object) => Boolean(object.deletedAt)), true);

  const gcResponse = await fetch(`${baseUrl}/api/batches/${demo.id}/object-gc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefix: `v1/source-original/${demo.id}/` }),
  });
  assert.equal(gcResponse.status, 200);
  assert.equal(((await gcResponse.json()) as { deleted: number }).deleted, 1);
  const repeatedGc = await fetch(`${baseUrl}/api/batches/${demo.id}/object-gc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefix: `v1/source-original/${demo.id}/` }),
  });
  assert.deepEqual(await repeatedGc.json(), { examined: 0, deleted: 0, retained: 0 });
} finally {
  await stop(child);
}

console.log("Object manifest and lifecycle HTTP integration tests passed");
