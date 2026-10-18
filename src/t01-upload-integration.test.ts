import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";

const root = resolve(".");

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
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Child exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
  ]);
}

const fakePort = await freePort();
const appPort = await freePort();
const fakeLog = `output/t01-upload-mineru/fake-calls-test-${process.pid}.jsonl`;
const workspaceRoot = resolve(".workspace", `t01-integration-${process.pid}`);
const fake = spawn(process.execPath, ["qa/fake-mineru-server.mjs"], {
  cwd: root,
  env: {
    ...process.env,
    FAKE_MINERU_PORT: String(fakePort),
    FAKE_MINERU_LOG: fakeLog,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
function spawnApp(): ChildProcess {
  return spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(appPort),
      WORKSPACE_ROOT: workspaceRoot,
      MINERU_API_TOKEN: "fake-token-not-a-secret",
      MINERU_BASE_URL: `http://127.0.0.1:${fakePort}/api/v4`,
      MINERU_PARSE_TIMEOUT_MS: "500",
      EMBEDDING_BASE_URL: "http://127.0.0.1:9/v1",
      EMBEDDING_API_KEY: "fake-embedding-key",
      EMBEDDING_MODEL: "fake-embedding-model",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
let app = spawnApp();

try {
  await waitFor(`http://127.0.0.1:${fakePort}/health`, fake);
  await waitFor(`http://127.0.0.1:${appPort}/api/health`, app);
  const form = new FormData();
  form.append("config", JSON.stringify({ modelVersion: "vlm", language: "ch" }));
  form.append(
    "files",
    new Blob(["%PDF fake duplicate"], { type: "application/pdf" }),
    "duplicate.pdf",
  );
  form.append(
    "files",
    new Blob(["%PDF fake upload failure"], { type: "application/pdf" }),
    "upload-fail.pdf",
  );
  form.append("files", new Blob(["# Local route"], { type: "text/markdown" }), "local.md");
  form.append("files", new Blob(["unsupported"]), "unsupported.exe");
  const response = await fetch(`http://127.0.0.1:${appPort}/api/batches`, {
    method: "POST",
    body: form,
  });
  assert.equal(response.status, 202);
  const batch = await response.json() as {
    id: string;
    documents: Array<{ name: string; state: string; error?: string }>;
  };
  const byName = new Map(batch.documents.map((document) => [document.name, document]));
  assert.equal(byName.get("duplicate.pdf")?.state, "pending");
  assert.equal(byName.get("upload-fail.pdf")?.state, "failed");
  assert.match(byName.get("upload-fail.pdf")?.error ?? "", /upload failed.*503/i);
  assert.equal(byName.get("local.md")?.state, "done");
  assert.equal(byName.get("unsupported.exe")?.state, "failed");
  assert.match(byName.get("unsupported.exe")?.error ?? "", /不支持的文件格式/);

  let polled = batch;
  for (let index = 0; index < 3; index += 1) {
    const pollResponse = await fetch(
      `http://127.0.0.1:${appPort}/api/batches/${batch.id}`,
    );
    assert.equal(pollResponse.status, 200);
    polled = await pollResponse.json() as typeof batch;
  }
  const afterPoll = new Map(
    polled.documents.map((document) => [document.name, document]),
  );
  assert.equal(afterPoll.get("duplicate.pdf")?.state, "done");
  assert.equal(afterPoll.get("upload-fail.pdf")?.state, "failed");
  assert.equal(afterPoll.get("local.md")?.state, "done");
  assert.equal(afterPoll.get("unsupported.exe")?.state, "failed");
  const calls = (await readFile(fakeLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(
    calls.filter(
      (call) => call.event === "download-result" && call.name === "duplicate.pdf",
    ).length,
    1,
    "duplicate done results download one ZIP",
  );
  assert.equal(
    calls
      .filter((call) => call.event === "signed-upload")
      .every((call) => call.authorizationPresent === false),
    true,
    "signed uploads do not receive the MinerU token",
  );

  const failuresForm = new FormData();
  failuresForm.append("config", "{}");
  failuresForm.append("files", new Blob(["remote failure"]), "remote-fail.pdf");
  failuresForm.append("files", new Blob(["corrupt result"]), "corrupt.pdf");
  failuresForm.append("files", new Blob(["retry result"]), "retry-once.pdf");
  const failuresCreated = await fetch(`http://127.0.0.1:${appPort}/api/batches`, {
    method: "POST",
    body: failuresForm,
  });
  assert.equal(failuresCreated.status, 202);
  const failuresBatch = await failuresCreated.json() as typeof batch;
  const failuresPolled = await fetch(
    `http://127.0.0.1:${appPort}/api/batches/${failuresBatch.id}`,
  );
  const failedBatch = await failuresPolled.json() as typeof batch;
  const failedByName = new Map(
    failedBatch.documents.map((document) => [document.name, document]),
  );
  assert.match(failedByName.get("remote-fail.pdf")?.error ?? "", /parse failure/);
  assert.match(failedByName.get("corrupt.pdf")?.error ?? "", /zip/i);
  assert.match(failedByName.get("retry-once.pdf")?.error ?? "", /first attempt/);

  const retryDocument = failedByName.get("retry-once.pdf") as
    | { id: string; name: string; state: string; error?: string }
    | undefined;
  assert.ok(retryDocument?.id);
  const retryCreated = await fetch(
    `http://127.0.0.1:${appPort}/api/batches/${failuresBatch.id}/documents/${retryDocument.id}/reparse`,
    { method: "POST" },
  );
  assert.equal(retryCreated.status, 202);
  const retryPending = await retryCreated.json() as typeof batch;
  assert.equal(
    retryPending.documents.find((document) => document.name === "retry-once.pdf")?.state,
    "pending",
  );
  let retryPolled = retryPending;
  for (let index = 0; index < 3; index += 1) {
    retryPolled = await (
      await fetch(`http://127.0.0.1:${appPort}/api/batches/${failuresBatch.id}`)
    ).json() as typeof batch;
  }
  assert.equal(
    retryPolled.documents.find((document) => document.name === "retry-once.pdf")?.state,
    "done",
  );

  const timeoutForm = new FormData();
  timeoutForm.append("config", "{}");
  timeoutForm.append(
    "files",
    new Blob(["%PDF fake timeout"], { type: "application/pdf" }),
    "timeout.pdf",
  );
  const timeoutCreated = await fetch(`http://127.0.0.1:${appPort}/api/batches`, {
    method: "POST",
    body: timeoutForm,
  });
  assert.equal(timeoutCreated.status, 202);
  const timeoutBatch = await timeoutCreated.json() as typeof batch;
  await new Promise((resolveWait) => setTimeout(resolveWait, 550));
  const timeoutResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/batches/${timeoutBatch.id}`,
  );
  assert.equal(timeoutResponse.status, 200);
  const timedOut = await timeoutResponse.json() as typeof batch;
  assert.equal(timedOut.documents[0].state, "failed");
  assert.match(timedOut.documents[0].error ?? "", /超时/);

  const rejectedForm = new FormData();
  rejectedForm.append("config", "{}");
  rejectedForm.append("files", new Blob(["remote"]), "submit-fail.pdf");
  rejectedForm.append("files", new Blob(["# survives"]), "survives.md");
  const rejectedResponse = await fetch(`http://127.0.0.1:${appPort}/api/batches`, {
    method: "POST",
    body: rejectedForm,
  });
  assert.equal(rejectedResponse.status, 202);
  const rejectedBatch = await rejectedResponse.json() as typeof batch;
  assert.equal(
    rejectedBatch.documents.find((document) => document.name === "survives.md")?.state,
    "done",
  );
  const rejectedRemote = rejectedBatch.documents.find(
    (document) => document.name === "submit-fail.pdf",
  );
  assert.equal(rejectedRemote?.state, "failed");
  assert.match(rejectedRemote?.error ?? "", /提交失败/);

  const transientForm = new FormData();
  transientForm.append("config", "{}");
  transientForm.append("files", new Blob(["transient poll"]), "poll-error-once.pdf");
  const transientCreated = await fetch(`http://127.0.0.1:${appPort}/api/batches`, {
    method: "POST",
    body: transientForm,
  });
  const transientBatch = await transientCreated.json() as typeof batch;
  const transientFirst = await fetch(
    `http://127.0.0.1:${appPort}/api/batches/${transientBatch.id}`,
  );
  assert.equal(transientFirst.status, 200);
  assert.equal(
    ((await transientFirst.json()) as typeof batch).documents[0].state,
    "pending",
  );
  let transientPolled = transientBatch;
  for (let index = 0; index < 2; index += 1) {
    transientPolled = await (
      await fetch(`http://127.0.0.1:${appPort}/api/batches/${transientBatch.id}`)
    ).json() as typeof batch;
  }
  assert.equal(transientPolled.documents[0].state, "done");

  await stop(app);
  app = spawnApp();
  await waitFor(`http://127.0.0.1:${appPort}/api/health`, app);
  const restoredResponse = await fetch(
    `http://127.0.0.1:${appPort}/api/batches/${failuresBatch.id}`,
  );
  assert.equal(restoredResponse.status, 200);
  const restored = await restoredResponse.json() as typeof batch;
  assert.equal(
    restored.documents.find((document) => document.name === "retry-once.pdf")?.state,
    "done",
  );
} finally {
  await Promise.all([stop(app), stop(fake)]);
}

console.log("T01 upload integration tests passed");
