import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(".");
const fakePort = process.env.T02_FAKE_PORT ?? "4194";
const appPort = process.env.T02_APP_PORT ?? "4184";
function start(args, environment) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...environment },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

const fakePid = start(["qa/fake-mineru-server.mjs"], {
  FAKE_MINERU_PORT: fakePort,
  FAKE_MINERU_LOG: "output/t02-source-view/fake-mineru-live.jsonl",
});
const appPid = start(["node_modules/tsx/dist/cli.mjs", "src/server.ts"], {
  PORT: appPort,
  WORKSPACE_ROOT: process.env.T02_WORKSPACE_ROOT ?? resolve(".workspace/t02-live"),
  MINERU_API_TOKEN: "fake-live-token",
  MINERU_BASE_URL: `http://127.0.0.1:${fakePort}/api/v4`,
  MINERU_PARSE_TIMEOUT_MS: "60000",
  EMBEDDING_BASE_URL: "http://127.0.0.1:9/v1",
  EMBEDDING_API_KEY: "fake-embedding-key",
  EMBEDDING_MODEL: "fake-embedding-model",
  T02_FAKE_VISUAL_COPY_FAILURE: process.env.T02_FAKE_VISUAL_COPY_FAILURE ?? "0",
});

const deadline = Date.now() + 20_000;
while (Date.now() < deadline) {
  try {
    if ((await fetch(`http://127.0.0.1:${appPort}/api/health`)).ok) {
      console.log(JSON.stringify({ url: `http://127.0.0.1:${appPort}`, appPid, fakePid }));
      process.exit(0);
    }
  } catch {}
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
}
throw new Error("T02 live server did not become ready");
