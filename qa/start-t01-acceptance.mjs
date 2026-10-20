import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(".");
const output = resolve("output/t01-upload-mineru");
await mkdir(output, { recursive: true });

function start(command, args, env, logName) {
  const stdout = createWriteStream(resolve(output, `${logName}.stdout.log`), { flags: "a" });
  const stderr = createWriteStream(resolve(output, `${logName}.stderr.log`), { flags: "a" });
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  child.once("exit", (code) => {
    if (code && !stopping) {
      console.error(`${logName} exited with ${code}`);
      process.exitCode = 1;
    }
  });
  return child;
}

let stopping = false;
const fake = start(
  process.execPath,
  ["qa/fake-mineru-server.mjs"],
  {
    FAKE_MINERU_PORT: "4191",
    FAKE_MINERU_LOG: "output/t01-upload-mineru/fake-calls-browser-final.jsonl",
  },
  "fake-service",
);
const app = start(
  process.execPath,
  ["node_modules/tsx/dist/cli.mjs", "src/server.ts"],
  {
    PORT: "4181",
    WORKSPACE_ROOT: resolve(".workspace/t01-browser-final"),
    MINERU_API_TOKEN: "fake-browser-token-not-a-secret",
    MINERU_BASE_URL: "http://127.0.0.1:4191/api/v4",
    MINERU_PARSE_TIMEOUT_MS: "10000",
    EMBEDDING_BASE_URL: "http://127.0.0.1:9/v1",
    EMBEDDING_API_KEY: "fake-embedding-key",
    EMBEDDING_MODEL: "fake-embedding-model",
  },
  "app-service",
);

async function waitFor(url) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

await Promise.all([
  waitFor("http://127.0.0.1:4191/health"),
  waitFor("http://127.0.0.1:4181/api/health"),
]);
console.log("T01_ACCEPTANCE_READY http://127.0.0.1:4181");

function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of [app, fake]) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise(() => {});
