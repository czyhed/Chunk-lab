import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(".");
const output = resolve("output/playwright/table-merge-preserves-other-chunks");
const playwrightEntry = "C:/Users/25758/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(playwrightEntry).href);
await mkdir(output, { recursive: true });

async function freePort() {
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

const fakePort = await freePort();
const appPort = await freePort();
const serviceWorkspace = resolve(`.workspace/table-merge-preserves-other-chunks-${process.pid}`);
const fake = spawn(process.execPath, ["qa/fake-mineru-server.mjs"], {
  cwd: root,
  env: { ...process.env, FAKE_MINERU_PORT: String(fakePort), FAKE_MINERU_LOG: resolve(output, "fake-mineru.jsonl") },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
const app = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/server.ts"], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(appPort),
    WORKSPACE_ROOT: serviceWorkspace,
    MINERU_API_TOKEN: "fake-token-not-a-secret",
    MINERU_BASE_URL: `http://127.0.0.1:${fakePort}/api/v4`,
    MINERU_PARSE_TIMEOUT_MS: "30000",
    EMBEDDING_BASE_URL: "http://127.0.0.1:9/v1",
    EMBEDDING_API_KEY: "fake-embedding-key",
    EMBEDDING_MODEL: "fake-embedding-model",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let serviceLog = "";
for (const child of [fake, app]) {
  child.stdout.setEncoding("utf8").on("data", (chunk) => { serviceLog += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { serviceLog += chunk; });
}
const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
async function waitFor(url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

let browser;
const browserLog = [];
const acceptance = { viewport: { width: 1440, height: 1000 } };
try {
  await Promise.all([waitFor(`http://127.0.0.1:${fakePort}/health`), waitFor(`http://127.0.0.1:${appPort}/api/health`)]);
  browser = await chromium.launch({ channel: "msedge", headless: false });
  const context = await browser.newContext({ viewport: acceptance.viewport, deviceScaleFactor: 1 });
  await context.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
  const page = await context.newPage();
  page.on("console", (message) => browserLog.push({ type: message.type(), text: message.text(), location: message.location() }));
  page.on("pageerror", (error) => browserLog.push({ type: "pageerror", text: error.message }));

  await page.goto(`http://127.0.0.1:${appPort}`);
  await page.locator("#fileInput").setInputFiles(resolve(root, "materials/pdf/多图片PDF.pdf"));
  await page.getByRole("button", { name: "开始解析" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".detection-block").length === 257, undefined, { timeout: 35_000 });
  await page.waitForFunction(() => document.querySelector("#page-1 .pdf-page-canvas")?.dataset.rendered === "true", undefined, { timeout: 15_000 });

  const tableBlocks = await page.evaluate(() => [...document.querySelectorAll(".detection-block.annotation-table")].map((element) => ({
    id: element.dataset.blockId,
    page: Number(element.closest("[data-page]")?.dataset.page),
  })).filter((item) => item.id && Number.isSafeInteger(item.page)));
  const firstTable = tableBlocks[0];
  const secondTable = tableBlocks.find((item) => item.page !== firstTable?.page);
  assert.ok(firstTable?.id && secondTable?.id, "two table blocks on different pages are required");
  acceptance.tables = { first: firstTable, second: secondTable };

  await page.getByRole("button", { name: "生成整文档 Chunk" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".chunk-card").length > 5 && document.querySelector("#configState")?.textContent?.includes("完整 Preview"), undefined, { timeout: 20_000 });
  const before = await page.evaluate(() => ({
    count: document.querySelectorAll(".chunk-card").length,
    tableCount: document.querySelectorAll(".chunk-card.table").length,
    metrics: document.querySelector("#metricsDigest")?.textContent,
    state: document.querySelector("#configState")?.textContent,
  }));
  assert.ok(before.count > before.tableCount + 1, "before merge has multiple ordinary Chunks");

  await page.locator(`#page-${firstTable.page} [data-block-id="${firstTable.id}"]`).click();
  await page.locator(`#page-${secondTable.page} [data-block-id="${secondTable.id}"]`).click({ modifiers: ["Control"] });
  assert.equal(await page.locator("#selectionCount").textContent(), "已选择 2 个框");
  await page.screenshot({ path: resolve(output, "01-before-merge.png"), fullPage: false });

  await page.getByRole("button", { name: "合并跨页" }).click();
  await page.waitForFunction(() => document.querySelector("#configState")?.textContent?.includes("部分 Preview"), undefined, { timeout: 20_000 });
  await page.waitForFunction(() => document.querySelectorAll(".chunk-card").length > 5, undefined, { timeout: 10_000 });
  const after = await page.evaluate(() => ({
    count: document.querySelectorAll(".chunk-card").length,
    tableCount: document.querySelectorAll(".chunk-card.table").length,
    tableCards: [...document.querySelectorAll(".chunk-card.table")].map((item) => item.textContent?.trim()),
    metrics: document.querySelector("#metricsDigest")?.textContent,
    state: document.querySelector("#configState")?.textContent,
    fileStats: document.querySelector(".file-stats")?.textContent,
  }));
  assert.equal(after.count, before.count - 1, "two table Chunks are replaced by one merged Chunk");
  assert.equal(after.tableCount, before.tableCount - 1, "table count decreases by one");
  const mergedTableCards = after.tableCards.filter((text) => text?.includes(`P${firstTable.page}`) && text.includes(`P${secondTable.page}`));
  assert.equal(mergedTableCards.length, 1, "exactly one table Chunk spans both selected pages");
  assert.match(after.state ?? "", /部分 Preview/);
  await page.screenshot({ path: resolve(output, "02-after-merge.png"), fullPage: false });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll(".chunk-card").length > 5 && Boolean(document.querySelector("#configState")?.textContent?.match(/Preview/)), undefined, { timeout: 20_000 });
  const refreshed = await page.evaluate(() => ({
    count: document.querySelectorAll(".chunk-card").length,
    tableCount: document.querySelectorAll(".chunk-card.table").length,
    metrics: document.querySelector("#metricsDigest")?.textContent,
    state: document.querySelector("#configState")?.textContent,
    fileStats: document.querySelector(".file-stats")?.textContent,
  }));
  assert.deepEqual({ count: refreshed.count, tableCount: refreshed.tableCount, metrics: refreshed.metrics, fileStats: refreshed.fileStats }, {
    count: after.count,
    tableCount: after.tableCount,
    metrics: after.metrics,
    fileStats: after.fileStats,
  }, "refresh restores the persisted merged Preview and ordinary Chunks");
  await page.screenshot({ path: resolve(output, "03-after-refresh.png"), fullPage: false });

  const appProblems = browserLog.filter((entry) => ["error", "warning", "pageerror"].includes(entry.type) && (!entry.location?.url || entry.location.url.startsWith(`http://127.0.0.1:${appPort}`)));
  assert.equal(appProblems.length, 0, "browser has zero application errors or warnings");
  acceptance.before = before;
  acceptance.after = after;
  acceptance.afterRefresh = refreshed;
  acceptance.browser = { browser: `Microsoft Edge ${browser.version()}`, applicationErrorsOrWarnings: appProblems.length };
  await writeFile(resolve(output, "acceptance-summary.json"), `${JSON.stringify(acceptance, null, 2)}\n`);
  await writeFile(resolve(output, "browser-console.json"), `${JSON.stringify(browserLog, null, 2)}\n`);
} finally {
  if (browser) await browser.close();
  await writeFile(resolve(output, "app-service.log"), serviceLog);
  if (app.exitCode === null) app.kill("SIGKILL");
  if (fake.exitCode === null) fake.kill("SIGKILL");
  app.stdout.destroy(); app.stderr.destroy(); fake.stdout.destroy(); fake.stderr.destroy();
}

console.log(`table merge browser acceptance passed: ${output}`);
