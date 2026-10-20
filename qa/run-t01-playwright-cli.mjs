import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const mode = process.argv[2] ?? "snapshot";
const evidenceLabel = mode === "retry-regression" ? "retry-regression" : "acceptance";
const session = mode === "retry-regression" ? "t01-retry-regression-v2" : "t01-final-v6";
const root = resolve(".");
const cliDirectory = resolve("output/playwright/t01-upload-mineru");
await mkdir(cliDirectory, { recursive: true });

function start(command, args, env = {}) {
  return spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

process.env.FAKE_MINERU_PORT = "4191";
process.env.FAKE_MINERU_LOG = `output/t01-upload-mineru/fake-calls-browser-${evidenceLabel}-v6.jsonl`;
const { server: fakeServer } = await import("./fake-mineru-server.mjs");
const app = start(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/server.ts"], {
  PORT: "4181",
  WORKSPACE_ROOT: resolve(`.workspace/t01-browser-${evidenceLabel}-v6`),
  MINERU_API_TOKEN: "fake-browser-token-not-a-secret",
  MINERU_BASE_URL: "http://127.0.0.1:4191/api/v4",
  MINERU_PARSE_TIMEOUT_MS: "120000",
  EMBEDDING_BASE_URL: "http://127.0.0.1:9/v1",
  EMBEDDING_API_KEY: "fake-embedding-key",
  EMBEDDING_MODEL: "fake-embedding-model",
});
let serviceLog = "";
let browserLog = "";

for (const [name, child] of [["app", app]]) {
  child.stdout.setEncoding("utf8").on("data", (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    serviceLog += `[${name}] ${chunk}`;
    process.stderr.write(`[${name}] ${chunk}`);
  });
  child.once("exit", (code, signal) => {
    process.stderr.write(`[${name}] exit code=${code} signal=${signal}\n`);
  });
}

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

async function cli(...args) {
  const cliArgs = [
    "--yes",
    "--package",
    "@playwright/cli",
    "playwright-cli",
    "--session",
    session,
    ...args,
  ];
  const executable = process.platform === "win32" ? process.env.ComSpec : "npx";
  const spawnArgs = process.platform === "win32"
    ? ["/d", "/s", "/c", "npx", ...cliArgs]
    : cliArgs;
  const child = spawn(
    executable,
    spawnArgs,
    { cwd: cliDirectory, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
    process.stderr.write(chunk);
  });
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  if (exitCode !== 0) throw new Error(`playwright-cli ${args[0]} exited with ${exitCode}`);
  browserLog += `\n$ playwright-cli ${args.join(" ")}\n${output}`;
  return output;
}

function refFor(snapshot, text) {
  const line = snapshot.split("\n").find(
    (candidate) => candidate.includes(text) && candidate.includes("[ref="),
  );
  const ref = line?.match(/\[ref=(e\d+)\]/)?.[1];
  if (!ref) throw new Error(`No snapshot ref for ${text}`);
  return ref;
}

const fixture = (name) => resolve("output/t01-upload-mineru/fixtures", name);
const screenshot = (name) => cli("screenshot", "--filename", name);

try {
  await Promise.all([
    waitFor("http://127.0.0.1:4191/health"),
    waitFor("http://127.0.0.1:4181/api/health"),
  ]);
  if (mode === "snapshot") {
    await cli("open", "http://127.0.0.1:4181", "--headed");
    await cli("resize", "1440", "1000");
    await cli("snapshot");
  } else if (mode === "acceptance") {
    await cli("open", "http://127.0.0.1:4181", "--headed");
    await cli("resize", "1440", "1000");
    const initial = await cli("snapshot");
    await cli("click", refFor(initial, 'button "添加文档"'));
    await cli(
      "upload",
      fixture("browser-slow.pdf"),
      fixture("office.docx"),
      fixture("local.md"),
      fixture("unsupported.xyz"),
      fixture("retry-once.pdf"),
    );
    const staged = await cli("snapshot");
    assert.match(staged, /browser-slow\.pdf/);
    assert.match(staged, /待解析/);
    await screenshot("01-staged.png");
    await cli("click", refFor(staged, 'button "开始解析"'));
    await screenshot("02-upload-or-waiting.png");
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_100));
    const parsing = await cli("snapshot");
    assert.match(parsing, /解析中|排队|上传中/);
    await screenshot("03-independent-parsing.png");
    await new Promise((resolveWait) => setTimeout(resolveWait, 10_000));
    const terminal = await cli("snapshot");
    assert.match(terminal, /browser-slow\.pdf 已就绪/);
    assert.match(terminal, /office\.docx 已就绪/);
    assert.match(terminal, /local\.md 已就绪/);
    assert.match(terminal, /unsupported\.xyz 失败/);
    assert.match(terminal, /retry-once\.pdf 失败/);
    await screenshot("04-independent-terminal-states.png");

    await cli("click", refFor(terminal, 'button "重试"'));
    await cli("dialog-accept");
    await screenshot("05-retry-pending.png");
    await new Promise((resolveWait) => setTimeout(resolveWait, 4_500));
    const retried = await cli("snapshot");
    assert.match(retried, /retry-once\.pdf 已就绪 2 BLOCKS/);
    assert.doesNotMatch(retried, /fake first attempt failure/);
    await screenshot("06-retry-success.png");

    await cli("click", refFor(retried, 'button "unsupported.xyz'));
    const failedSelected = await cli("snapshot");
    assert.match(failedSelected, /heading "unsupported\.xyz"/);
    assert.match(failedSelected, /不支持的文件格式/);
    await screenshot("07-failed-document-selected.png");

    await cli("click", refFor(failedSelected, 'button "local.md'));
    const localSelected = await cli("snapshot");
    assert.match(localSelected, /heading "local\.md"/);
    await screenshot("08-document-switch-local.png");

    await cli("reload");
    await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
    const restored = await cli("snapshot");
    assert.match(restored, /retry-once\.pdf 已就绪/);
    assert.match(restored, /unsupported\.xyz 失败/);
    await screenshot("09-refresh-restored.png");
    await cli("console", "warning");
    await cli("requests");
  } else if (mode === "retry-regression") {
    await cli("open", "http://127.0.0.1:4181", "--headed");
    await cli("resize", "1440", "1000");
    const initial = await cli("snapshot");
    await cli("click", refFor(initial, 'button "添加文档"'));
    await cli("upload", fixture("retry-once.pdf"));
    const staged = await cli("snapshot");
    await cli("click", refFor(staged, 'button "开始解析"'));
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    const failed = await cli("snapshot");
    assert.match(failed, /retry-once\.pdf 失败/);
    await cli("click", refFor(failed, 'button "重试"'));
    await cli("dialog-accept");
    await new Promise((resolveWait) => setTimeout(resolveWait, 4_500));
    const retried = await cli("snapshot");
    assert.match(retried, /retry-once\.pdf 已就绪 2 BLOCKS/);
    assert.doesNotMatch(retried, /fake first attempt failure/);
    await screenshot("10-retry-clears-error.png");
  } else {
    throw new Error(`Unknown mode: ${mode}`);
  }
} finally {
  await writeFile(
    resolve(cliDirectory, `browser-${evidenceLabel}.log`),
    browserLog,
    "utf8",
  );
  await writeFile(
    resolve(`output/t01-upload-mineru/app-service-browser-${evidenceLabel}.log`),
    serviceLog,
    "utf8",
  );
  if (app.exitCode === null) app.kill("SIGTERM");
  fakeServer.close();
}
