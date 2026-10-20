import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(".");
const output = resolve("output/playwright/t02-edge-real-pdf");
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
  env: {
    ...process.env,
    FAKE_MINERU_PORT: String(fakePort),
    FAKE_MINERU_LOG: resolve("output/t02-source-view/fake-calls-real-pdf.jsonl"),
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
const app = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/server.ts"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(appPort),
    WORKSPACE_ROOT: resolve(".workspace/t02-real-pdf"),
    MINERU_API_TOKEN: "fake-t02-real-pdf-token",
    MINERU_BASE_URL: `http://127.0.0.1:${fakePort}/api/v4`,
    MINERU_PARSE_TIMEOUT_MS: "30000",
    EMBEDDING_BASE_URL: "http://127.0.0.1:9/v1",
    EMBEDDING_API_KEY: "fake-embedding-key",
    EMBEDDING_MODEL: "fake-embedding-model",
    T02_FAKE_VISUAL_COPY_FAILURE: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let serviceLog = "";
const browserLog = [];
const requests = [];
let applicationErrors = [];
for (const child of [fake, app]) {
  child.stdout.setEncoding("utf8").on("data", (chunk) => { serviceLog += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { serviceLog += chunk; });
}

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
async function waitFor(url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

let browser;
const acceptance = {};
try {
  await Promise.all([
    waitFor(`http://127.0.0.1:${fakePort}/health`),
    waitFor(`http://127.0.0.1:${appPort}/api/health`),
  ]);
  browser = await chromium.launch({ channel: "msedge", headless: false });
  acceptance.browser = `Microsoft Edge ${browser.version()}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("console", (message) => browserLog.push({ type: message.type(), text: message.text(), location: message.location() }));
  page.on("pageerror", (error) => browserLog.push({ type: "pageerror", text: error.message }));
  page.on("response", (response) => {
    if (response.url().includes("/api/") || response.status() >= 400) requests.push({ method: response.request().method(), url: response.url(), status: response.status() });
  });

  await page.goto(`http://127.0.0.1:${appPort}`);
  await page.locator("#fileInput").setInputFiles(resolve(root, "materials/pdf/多图片PDF.pdf"));
  await page.getByRole("button", { name: "开始解析" }).click();
  await page.waitForFunction(
    () => document.body.innerText.includes("P.23") && document.body.innerText.includes("MinerU 257"),
    undefined,
    { timeout: 35_000 },
  );
  await page.waitForFunction(
    () => [...document.querySelectorAll(".pdf-page-canvas")].every((canvas) => canvas.dataset.rendered === "true"),
    undefined,
    { timeout: 15_000 },
  );

  const fitMetrics = await page.evaluate(() => {
    const pageBox = document.querySelector("#page-1").getBoundingClientRect();
    const overlay = document.querySelector(".exact-source-block").getBoundingClientRect();
    const canvases = [...document.querySelectorAll(".pdf-page-canvas")];
    return {
      page: pageBox.toJSON(),
      overlay: overlay.toJSON(),
      pageOverlayCount: document.querySelectorAll("#page-1 .exact-source-block").length,
      pageCount: document.querySelectorAll("[data-page]").length,
      canvasCount: canvases.length,
      rendered: canvases.map((canvas) => canvas.dataset.rendered),
    };
  });
  assert.equal(fitMetrics.pageCount, 23);
  assert.equal(fitMetrics.pageOverlayCount, 9);
  assert.ok(fitMetrics.canvasCount > 0 && fitMetrics.canvasCount <= 5);
  assert.ok(fitMetrics.rendered.every((value) => value === "true"));
  const pixelComparison = {
    fixtureBbox: [380, 258, 614, 297],
    expected: {
      x: fitMetrics.page.x + fitMetrics.page.width * 380 / 1000,
      y: fitMetrics.page.y + fitMetrics.page.height * 258 / 1000,
    },
    actual: { x: fitMetrics.overlay.x, y: fitMetrics.overlay.y },
  };
  pixelComparison.absoluteError = {
    x: Math.abs(pixelComparison.actual.x - pixelComparison.expected.x),
    y: Math.abs(pixelComparison.actual.y - pixelComparison.expected.y),
  };
  assert.ok(pixelComparison.absoluteError.x < 2);
  assert.ok(pixelComparison.absoluteError.y < 2);
  await writeFile(resolve(output, "fit-bbox-metrics.json"), JSON.stringify(fitMetrics, null, 2));
  await writeFile(resolve(output, "bbox-pixel-comparison-257.json"), JSON.stringify(pixelComparison, null, 2));
  await page.screenshot({ path: resolve(output, "01-real-pdf-fit-bbox.png") });
  acceptance.fitWidth = { mineruCount: 257, pageCount: 23, pageOneOverlayCount: 9, pixelError: pixelComparison.absoluteError };

  await page.locator("#zoomActual").click();
  await wait(800);
  const actualMetrics = await page.evaluate(() => ({
    page: document.querySelector("#page-1").getBoundingClientRect().toJSON(),
    overlay: document.querySelector("#page-1 .exact-source-block").getBoundingClientRect().toJSON(),
  }));
  assert.ok(actualMetrics.page.width > fitMetrics.page.width);
  await writeFile(resolve(output, "actual-size-metrics.json"), JSON.stringify(actualMetrics, null, 2));
  await page.screenshot({ path: resolve(output, "02-real-pdf-actual-size.png") });

  await page.locator("#zoomIn").click();
  await page.locator("#zoomIn").click();
  await wait(800);
  const zoomMetrics = await page.evaluate(() => ({
    page: document.querySelector("#page-1").getBoundingClientRect().toJSON(),
    overlay: document.querySelector("#page-1 .exact-source-block").getBoundingClientRect().toJSON(),
  }));
  assert.ok(zoomMetrics.page.width > actualMetrics.page.width);
  await writeFile(resolve(output, "multi-zoom-metrics.json"), JSON.stringify(zoomMetrics, null, 2));
  await page.screenshot({ path: resolve(output, "03-real-pdf-multi-zoom.png") });
  acceptance.zoom = { fitWidth: fitMetrics.page.width, actualSize: actualMetrics.page.width, custom: zoomMetrics.page.width };

  await page.locator("#zoomFit").click();
  await page.locator('[data-page-target="12"]').click();
  await page.waitForFunction(
    () => {
      const target = document.querySelector("#page-12").getBoundingClientRect();
      const host = document.querySelector("#pageScroll").getBoundingClientRect();
      return document.querySelector("#pageInput").value === "12"
        && target.top >= host.top - 5 && target.top < host.bottom
        && document.querySelectorAll("#page-12 .exact-source-block").length === 20
        && document.querySelector('#page-12 .pdf-page-canvas')?.dataset.rendered === "true";
    },
    undefined,
    { timeout: 15_000 },
  );
  const pageTwelveMetrics = await page.evaluate(() => ({
    overlayCount: document.querySelectorAll("#page-12 .exact-source-block").length,
    canvasPage: document.querySelector("#page-12 .pdf-page-canvas")?.dataset.pdfPage,
    rendered: document.querySelector("#page-12 .pdf-page-canvas")?.dataset.rendered,
    currentPage: document.querySelector("#pageInput").value,
    targetTop: document.querySelector("#page-12").getBoundingClientRect().top,
    hostTop: document.querySelector("#pageScroll").getBoundingClientRect().top,
    scrollTop: document.querySelector("#pageScroll").scrollTop,
  }));
  await writeFile(resolve(output, "page-12-metrics.json"), JSON.stringify(pageTwelveMetrics, null, 2));
  await page.screenshot({ path: resolve(output, "04-real-pdf-page-12.png") });
  acceptance.multiPage = { pageOne: 9, pageTwelve: pageTwelveMetrics.overlayCount };

  await page.getByRole("tab", { name: "解析结果" }).click();
  await page.locator(".parsed-source").waitFor();
  await page.getByRole("tab", { name: "原始文件" }).click();
  await page.locator('[data-page-target="1"]').click();
  await page.waitForFunction(
    () => document.querySelector('#page-1 .pdf-page-canvas')?.dataset.rendered === "true",
    undefined,
    { timeout: 15_000 },
  );
  acceptance.sourceTabs = ["parsed_document", "original_file"];

  const pageOneBoxes = page.locator("#page-1 .detection-block");
  await pageOneBoxes.nth(0).click({ modifiers: ["Control"] });
  await pageOneBoxes.nth(1).click({ modifiers: ["Control"] });
  await page.waitForFunction(() => document.querySelector("#selectionCount")?.textContent === "已选择 2 个框");
  await page.screenshot({ path: resolve(output, "05-real-pdf-ctrl-selection.png") });
  acceptance.ctrlSelection = 2;

  const divider = page.locator("#workspaceResizer");
  const dividerBox = await divider.boundingBox();
  assert.ok(dividerBox);
  const sourceWidthBefore = await page.locator(".document-stage").evaluate((element) => element.getBoundingClientRect().width);
  await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(dividerBox.x - 90, dividerBox.y + 50, { steps: 5 });
  await page.mouse.up();
  const sourceWidthAfter = await page.locator(".document-stage").evaluate((element) => element.getBoundingClientRect().width);
  assert.ok(Math.abs(sourceWidthAfter - sourceWidthBefore) > 50);
  await writeFile(resolve(output, "divider-metrics.json"), JSON.stringify({ sourceWidthBefore, sourceWidthAfter }, null, 2));
  await page.screenshot({ path: resolve(output, "06-real-pdf-divider.png") });
  acceptance.divider = { sourceWidthBefore, sourceWidthAfter };

  await page.evaluate(() => {
    const scroll = document.querySelector("#pageScroll");
    for (let index = 0; index < 18; index += 1) {
      document.querySelector(index % 2 ? "#zoomIn" : "#zoomOut").click();
      scroll.scrollTop = index % 3 === 0 ? scroll.scrollHeight : 0;
      document.querySelector(index % 2 ? '[data-page-target="23"]' : '[data-page-target="1"]').click();
    }
  });
  await wait(600);
  await page.locator('[data-page-target="23"]').click();
  await page.waitForFunction(
    () => {
      const canvases = [...document.querySelectorAll(".pdf-page-canvas")];
      const target = document.querySelector("#page-23").getBoundingClientRect();
      const host = document.querySelector("#pageScroll").getBoundingClientRect();
      return document.querySelector("#pageInput").value === "23"
        && target.top >= host.top - 5 && target.top < host.bottom
        && canvases.length > 0
        && canvases.every((canvas) => canvas.dataset.rendered === "true");
    },
    undefined,
    { timeout: 15_000 },
  );
  const stressMetrics = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll(".pdf-page-canvas")];
    return {
      canvasCount: canvases.length,
      rendered: canvases.map((canvas) => canvas.dataset.rendered ?? null),
      pages: canvases.map((canvas) => canvas.dataset.pdfPage),
      currentPage: document.querySelector("#pageInput").value,
      activePage: document.querySelector("[data-page-target].active")?.dataset.pageTarget,
      targetTop: document.querySelector("#page-23").getBoundingClientRect().top,
      hostTop: document.querySelector("#pageScroll").getBoundingClientRect().top,
    };
  });
  await writeFile(resolve(output, "stress-render-metrics.json"), JSON.stringify(stressMetrics, null, 2));
  assert.ok(stressMetrics.canvasCount > 0);
  assert.ok(stressMetrics.rendered.every((value) => value === "true"));
  assert.equal(new Set(stressMetrics.pages).size, stressMetrics.pages.length);
  applicationErrors = browserLog.filter((entry) => {
    if (entry.type !== "error" && entry.type !== "pageerror") return false;
    return !entry.location?.url || entry.location.url.startsWith(`http://127.0.0.1:${appPort}`);
  });
  assert.equal(applicationErrors.length, 0);
  assert.equal(browserLog.some((entry) => entry.text.includes("Cannot use the same canvas")), false);
  await page.screenshot({ path: resolve(output, "07-real-pdf-page-23-stress.png") });
  acceptance.stress = {
    ...stressMetrics,
    applicationConsoleErrors: applicationErrors.length,
    externalConsoleErrors: browserLog.filter((entry) => entry.type === "error" || entry.type === "pageerror").length - applicationErrors.length,
  };
} finally {
  if (browser) await browser.close();
  await writeFile(resolve(output, "acceptance-summary-257.json"), JSON.stringify(acceptance, null, 2));
  await writeFile(resolve(output, "browser-console.json"), JSON.stringify(browserLog, null, 2));
  await writeFile(resolve(output, "browser-console-app.json"), JSON.stringify(applicationErrors, null, 2));
  await writeFile(resolve(output, "browser-requests.json"), JSON.stringify(requests, null, 2));
  await writeFile(resolve("output/t02-source-view/app-service-real-pdf.log"), serviceLog);
  for (const child of [app, fake]) if (child.exitCode === null) child.kill("SIGKILL");
  for (const child of [app, fake]) {
    child.stdout.destroy();
    child.stderr.destroy();
  }
}
