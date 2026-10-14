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
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("server did not become ready");
}

const port = await freePort();
const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/server.ts"], {
  cwd: resolve("."),
  env: {
    ...process.env,
    NODE_ENV: "test",
    REDIS_DISABLED: "1",
    PORT: String(port),
    WORKSPACE_ROOT: resolve(".workspace", `spu-catalog-http-${process.pid}`),
    MINERU_API_TOKEN: "spu-catalog-fixture-token",
    EMBEDDING_BASE_URL: "http://127.0.0.1:9/v1",
    EMBEDDING_API_KEY: "spu-catalog-fixture-key",
    EMBEDDING_MODEL: "fixture-model",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/health`, child);
  const categoryResponse = await fetch(`${base}/api/spu-categories`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "鼠标", code: "MOUSE" }),
  });
  assert.equal(categoryResponse.status, 201);
  const category = (await categoryResponse.json() as { category: { id: string } }).category;

  const preview = await (await fetch(`${base}/api/spus/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ productName: "毒蝰 V3 Pro", categoryId: category.id, brand: "Razer" }),
  })).json() as { candidateSpuId: string; matches: unknown[] };
  assert.match(preview.candidateSpuId, /^SPU-MOUSE-[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.deepEqual(preview.matches, []);

  const createBody = { productName: "毒蝰 V3 Pro", categoryId: category.id, brand: "Razer", candidateSpuId: preview.candidateSpuId, creationRequestId: "http-request-1" };
  const createdResponse = await fetch(`${base}/api/spus`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(createBody) });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as { spu: { spuId: string }; reused: boolean };
  assert.equal(created.spu.spuId, preview.candidateSpuId);
  assert.equal(created.reused, false);

  const retryResponse = await fetch(`${base}/api/spus`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(createBody) });
  assert.equal(retryResponse.status, 200);
  assert.equal((await retryResponse.json() as { reused: boolean }).reused, true);

  const search = await (await fetch(`${base}/api/spus?query=${encodeURIComponent("毒蝰")}&categoryId=${category.id}&limit=3`)).json() as { spus: Array<{ spuId: string }> };
  assert.deepEqual(search.spus.map((spu) => spu.spuId), [created.spu.spuId]);
} finally {
  if (child.exitCode === null) {
    child.kill();
    await new Promise<void>((resolveStop) => child.once("exit", () => resolveStop()));
  }
}

console.log("SPU catalog HTTP tests passed");
