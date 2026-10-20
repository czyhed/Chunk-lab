import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(".");
const output = resolve("output/playwright/t04-manual-annotation-reopened");
const playwrightEntry = process.env.PLAYWRIGHT_ENTRY;
const { chromium } = playwrightEntry
  ? await import(pathToFileURL(playwrightEntry).href)
  : await import("playwright");
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
const fake = spawn(process.execPath, ["qa/fake-mineru-server.mjs"], {
  cwd: root,
  env: { ...process.env, FAKE_MINERU_PORT: String(fakePort), FAKE_MINERU_LOG: resolve(`${output}/fake-mineru.jsonl`) },
  stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
const app = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/server.ts"], {
  cwd: root,
  env: {
    ...process.env, PORT: String(appPort), WORKSPACE_ROOT: resolve(".workspace/t04-manual-annotation-reopened"),
    MINERU_API_TOKEN: "fake-t04-token", MINERU_BASE_URL: `http://127.0.0.1:${fakePort}/api/v4`,
    MINERU_PARSE_TIMEOUT_MS: "30000", EMBEDDING_BASE_URL: "http://127.0.0.1:9/v1",
    EMBEDDING_API_KEY: "fake-embedding-key", EMBEDDING_MODEL: "fake-embedding-model",
  },
  stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
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
const acceptance = {};
try {
  await Promise.all([waitFor(`http://127.0.0.1:${fakePort}/health`), waitFor(`http://127.0.0.1:${appPort}/api/health`)]);
  browser = await chromium.launch({ channel: "msedge", headless: false });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("console", (message) => browserLog.push({ type: message.type(), text: message.text(), location: message.location() }));
  page.on("pageerror", (error) => browserLog.push({ type: "pageerror", text: error.message }));
  let reviewSnapshot;
  let reviewUrl;
  page.on("response", async (response) => {
    if (!response.url().includes("/review") || response.request().method() !== "GET") return;
    reviewUrl = response.url();
    try { reviewSnapshot = await response.json(); } catch {}
  });
  await page.goto(`http://127.0.0.1:${appPort}`);
  await page.locator("#fileInput").setInputFiles(resolve(root, "materials/pdf/多图片PDF.pdf"));
  await page.getByRole("button", { name: "开始解析" }).click();
  await page.waitForFunction(() => document.body.innerText.includes("MinerU 257") && document.querySelectorAll(".detection-block").length > 0, undefined, { timeout: 35_000 });
  await page.waitForFunction(() => [...document.querySelectorAll(".pdf-page-canvas")].every((canvas) => canvas.dataset.rendered === "true"), undefined, { timeout: 15_000 });
  await wait(300);

  const initial = await page.evaluate(() => ({
    detections: document.querySelectorAll(".detection-block").length,
    manual: document.querySelectorAll(".manual-annotation-block").length,
    chunks: document.querySelectorAll(".chunk-card").length,
    emptyManual: document.body.innerText.includes("尚无人工标注"),
    pageNumber: [...document.querySelectorAll('.detection-block[data-annotation-type="page_number"]')].map((box) => ({
      label: box.querySelector(".annotation-label")?.textContent,
      title: box.title,
      mode: box.querySelector(".annotation-label")?.dataset.labelMode,
    })),
    labelModes: [...document.querySelectorAll(".detection-block .annotation-label")].map((label) => label.dataset.labelMode),
  }));
  assert.equal(initial.manual, 0);
  assert.equal(initial.chunks, 0);
  assert.equal(initial.emptyManual, true);
  assert.ok(initial.pageNumber.some((item) => item.label === "#" && item.title.includes("页码")), "page_number uses icon plus full tooltip");
  assert.ok(initial.labelModes.includes("full") && initial.labelModes.includes("short") && initial.labelModes.includes("icon"), "all three label modes render");
  await page.screenshot({ path: resolve(output, "01-real-pdf-label-modes.png"), fullPage: false });
  acceptance.initial = initial;

  const firstDetection = page.locator("#page-1 .detection-block").first();
  const firstId = await firstDetection.getAttribute("data-block-id");
  const firstType = await firstDetection.getAttribute("data-annotation-type");
  assert.ok(firstId && firstType === "text");
  const sourceRow = page.locator(`[data-source-info-key="detection:${firstId}"]`);
  await firstDetection.hover();
  assert.equal(await sourceRow.evaluate((element) => element.classList.contains("hover-linked")), true);
  await sourceRow.hover();
  assert.equal(await firstDetection.evaluate((element) => element.classList.contains("hover-linked")), true);
  await firstDetection.click();
  assert.equal(await sourceRow.evaluate((element) => element.classList.contains("locked-linked") && element.classList.contains("selected-source")), true);
  assert.equal(await firstDetection.evaluate((element) => element.classList.contains("locked-linked") && element.classList.contains("selected-source")), true);
  await page.mouse.move(40, 80);
  assert.equal(await sourceRow.evaluate((element) => element.classList.contains("hover-linked")), false);
  assert.equal(await firstDetection.evaluate((element) => element.classList.contains("hover-linked")), false);

  await page.locator("#annotationType").selectOption("image");
  await page.waitForFunction((id) => !document.querySelector(`[data-source-key="detection:${id}"]`) && document.querySelector(`.manual-annotation-block[data-source-key^="manual:"]`), firstId);
  const revised = await page.evaluate((id) => {
    const block = [...document.querySelectorAll(".manual-annotation-block")].find((element) => element.dataset.annotationType === "image");
    const row = [...document.querySelectorAll('[data-source-info-key^="manual:"]')].find((element) => element.textContent?.includes("图片"));
    return {
      type: block?.dataset.annotationType,
      sourceIds: document.querySelector("#detailPanel")?.textContent?.includes(id),
      rowType: row?.textContent,
      rowColor: row ? getComputedStyle(row).getPropertyValue("--block-color").trim() : null,
      blockColor: block ? getComputedStyle(block).getPropertyValue("--block-color").trim() : null,
    };
  }, firstId);
  assert.equal(revised.type, "image");
  assert.equal(revised.sourceIds, true, "revision detail retains the original Source Block ID");
  assert.match(revised.rowType ?? "", /图片/);
  assert.equal(revised.rowColor, revised.blockColor, "source row and canvas share the revised type color");
  await page.screenshot({ path: resolve(output, "02-mineru-text-revised-to-image.png"), fullPage: false });

  await page.getByRole("button", { name: "撤销" }).click();
  await page.waitForFunction((id) => document.querySelector(`[data-source-key="detection:${id}"]`)?.dataset.annotationType === "text" && ![...document.querySelectorAll(".manual-annotation-block")].some((element) => element.dataset.annotationType === "image"), firstId);
  await page.getByRole("button", { name: "重做" }).click();
  await page.waitForFunction((id) => !document.querySelector(`[data-source-key="detection:${id}"]`) && [...document.querySelectorAll(".manual-annotation-block")].some((element) => element.dataset.annotationType === "image"), firstId);
  const parsedAfterRevision = reviewUrl ? await page.evaluate(async (url) => (await fetch(url)).json(), reviewUrl) : null;
  assert.deepEqual(parsedAfterRevision?.parsedDocument, reviewSnapshot?.parsedDocument, "MinerU Parsed Document remains unchanged after a type revision");
  acceptance.revision = { originalId: firstId, originalType: firstType, revisedType: revised.type, sourceBlockTracked: revised.sourceIds, undoRedo: true };

  async function draw(left, top, right, bottom, type) {
    const pageBox = await page.locator("#page-1").boundingBox();
    assert.ok(pageBox);
    await page.getByRole("button", { name: "新建文本框" }).click();
    await page.mouse.move(pageBox.x + pageBox.width * left, pageBox.y + pageBox.height * top);
    await page.mouse.down();
    await page.mouse.move(pageBox.x + pageBox.width * right, pageBox.y + pageBox.height * bottom, { steps: 3 });
    await page.mouse.up();
    await page.locator("#annotationType").selectOption(type);
    await wait(100);
  }
  await draw(.08, .08, .4, .15, "heading");
  await draw(.12, .2, .55, .29, "table");
  await draw(.25, .35, .68, .48, "image");
  const drawn = await page.evaluate(() => ({
    contentNodes: document.querySelectorAll(".manual-annotation-block .annotation-content").length,
    types: [...document.querySelectorAll(".manual-annotation-block")].map((element) => element.dataset.annotationType),
    chunks: document.querySelectorAll(".chunk-card").length,
  }));
  assert.deepEqual(drawn.types.filter((type) => ["heading", "table", "image"].includes(type)).sort(), ["heading", "image", "image", "table"]);
  assert.equal(drawn.contentNodes, 0);
  assert.equal(drawn.chunks, 0);
  const beforeZoom = await page.evaluate(() => {
    const pageBox = document.querySelector("#page-1").getBoundingClientRect();
    const box = document.querySelector(".manual-annotation-block").getBoundingClientRect();
    return [(box.left - pageBox.left) / pageBox.width, (box.top - pageBox.top) / pageBox.height, box.width / pageBox.width, box.height / pageBox.height].map((value) => value.toFixed(4));
  });
  await page.getByRole("button", { name: "放大" }).click();
  await wait(250);
  const afterZoom = await page.evaluate(() => {
    const pageBox = document.querySelector("#page-1").getBoundingClientRect();
    const box = document.querySelector(".manual-annotation-block").getBoundingClientRect();
    return [(box.left - pageBox.left) / pageBox.width, (box.top - pageBox.top) / pageBox.height, box.width / pageBox.width, box.height / pageBox.height].map((value) => value.toFixed(4));
  });
  assert.deepEqual(afterZoom, beforeZoom, "normalized annotation coordinates do not drift after zoom");
  acceptance.zoom = { before: beforeZoom, after: afterZoom };
  await page.screenshot({ path: resolve(output, "03-manual-draw-types.png"), fullPage: false });

  await writeFile(resolve(output, "state.json"), `${JSON.stringify({ initial, revised, drawn }, null, 2)}\n`);
  await writeFile(resolve(output, "parsed-document-evidence.json"), `${JSON.stringify({ unchanged: Boolean(reviewSnapshot?.parsedDocument), parsedDocument: reviewSnapshot?.parsedDocument ?? null }, null, 2)}\n`);
  const appErrors = browserLog.filter((entry) => (entry.type === "error" || entry.type === "pageerror") && (!entry.location?.url || entry.location.url.startsWith(`http://127.0.0.1:${appPort}`)));
  assert.equal(appErrors.length, 0);
  acceptance.browser = { browser: `Microsoft Edge ${browser.version()}`, applicationConsoleErrors: appErrors.length };
  await writeFile(resolve(output, "acceptance-summary.json"), `${JSON.stringify(acceptance, null, 2)}\n`);
  await writeFile(resolve(output, "browser-console.json"), `${JSON.stringify(browserLog, null, 2)}\n`);
} finally {
  if (browser) await browser.close();
  await writeFile(resolve(output, "app-service.log"), serviceLog);
  if (app.exitCode === null) app.kill("SIGKILL");
  if (fake.exitCode === null) fake.kill("SIGKILL");
  app.stdout.destroy(); app.stderr.destroy(); fake.stdout.destroy(); fake.stderr.destroy();
}
