import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(".");
const output = resolve("output/playwright/t05-cross-page-annotation-reopened");
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
  env: { ...process.env, FAKE_MINERU_PORT: String(fakePort), FAKE_MINERU_LOG: resolve(output, "fake-mineru.jsonl") },
  stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
const app = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/server.ts"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(appPort),
    WORKSPACE_ROOT: resolve(`.workspace/t05-cross-page-annotation-reopened-${process.pid}`),
    MINERU_API_TOKEN: "fake-t05-token",
    MINERU_BASE_URL: `http://127.0.0.1:${fakePort}/api/v4`,
    MINERU_PARSE_TIMEOUT_MS: "30000",
    EMBEDDING_BASE_URL: "http://127.0.0.1:9/v1",
    EMBEDDING_API_KEY: "fake-embedding-key",
    EMBEDDING_MODEL: "fake-embedding-model",
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
  await context.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
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
  await page.waitForFunction(() => document.body.innerText.includes("MinerU 257") && document.querySelectorAll(".detection-block").length === 257, undefined, { timeout: 35_000 });
  await page.waitForFunction(() => document.querySelector("#page-1 .pdf-page-canvas")?.dataset.rendered === "true", undefined, { timeout: 15_000 });
  await wait(250);

  async function uiState() {
    return await page.evaluate(() => ({
      selectionText: document.querySelector("#selectionCount")?.textContent,
      selectedCanvasIds: [...document.querySelectorAll(".source-block.selected-source")].map((item) => item.dataset.blockId),
      selectedRowKeys: [...document.querySelectorAll(".annotation-source-row.selected-source")].map((item) => item.dataset.sourceInfoKey),
      lockedCanvasIds: [...document.querySelectorAll(".source-block.locked-linked")].map((item) => item.dataset.blockId),
      lockedRowKeys: [...document.querySelectorAll(".annotation-source-row.locked-linked")].map((item) => item.dataset.sourceInfoKey),
      detail: document.querySelector("#detailPanel")?.textContent?.trim(),
      detections: [...document.querySelectorAll(".detection-block")].map((item) => item.dataset.blockId),
      replacements: [...document.querySelectorAll(".manual-annotation-block")].map((item) => ({
        id: item.dataset.blockId,
        page: Number(item.closest("[data-page]")?.dataset.page),
        sourceBlockIds: String(item.dataset.sourceBlockIds ?? "").split(",").filter(Boolean),
        regionMemberIds: String(item.dataset.regionMemberIds ?? "").split(",").filter(Boolean),
        logicalGroupId: item.dataset.logicalGroupId,
        logicalGroupNumber: Number(item.dataset.logicalGroupNumber),
        groupMemberIndex: Number(item.dataset.groupMemberIndex),
        groupMemberCount: Number(item.dataset.groupMemberCount),
        groupPages: String(item.dataset.groupPages ?? "").split(",").filter(Boolean).map(Number),
        title: item.title,
      })),
    }));
  }

  const initialState = await uiState();
  assert.equal(initialState.replacements.length, 0);
  acceptance.initial = { detections: initialState.detections.length, replacements: 0, parsedDocumentCaptured: Boolean(reviewSnapshot?.parsedDocument) };

  const pageOneText = page.locator("#page-1 .detection-block.annotation-text");
  assert.ok(await pageOneText.count() >= 3, "fixture exposes three page-one text boxes");
  const firstId = await pageOneText.nth(0).getAttribute("data-block-id");
  const middleId = await pageOneText.nth(1).getAttribute("data-block-id");
  const thirdId = await pageOneText.nth(2).getAttribute("data-block-id");
  assert.ok(firstId && middleId && thirdId);

  await pageOneText.nth(0).click();
  await pageOneText.nth(0).click({ modifiers: ["Control"] });
  const canvasToggle = await uiState();
  assert.equal(canvasToggle.selectionText, "MinerU 257 · 人工 0");
  assert.deepEqual(canvasToggle.selectedCanvasIds, []);
  assert.deepEqual(canvasToggle.lockedCanvasIds, []);
  assert.match(canvasToggle.detail ?? "", /未选择来源框/);

  const firstRow = page.locator(`[data-source-info-key="detection:${firstId}"]`);
  await firstRow.click();
  await firstRow.click({ modifiers: ["Control"] });
  const rowToggle = await uiState();
  assert.equal(rowToggle.selectionText, "MinerU 257 · 人工 0");
  assert.deepEqual(rowToggle.selectedRowKeys, []);
  assert.deepEqual(rowToggle.lockedRowKeys, []);
  assert.match(rowToggle.detail ?? "", /未选择来源框/);
  await page.screenshot({ path: resolve(output, "01-toggle-clears-lock.png"), fullPage: false });
  acceptance.toggle = { canvas: canvasToggle, sourceList: rowToggle };

  await page.locator(`#page-1 [data-block-id="${firstId}"]`).click();
  await page.locator(`#page-1 [data-block-id="${middleId}"]`).click({ modifiers: ["Control"] });
  await page.getByRole("button", { name: "合并同页" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".manual-annotation-block").length === 1);
  const consecutiveSamePage = await uiState();
  assert.deepEqual(consecutiveSamePage.replacements[0]?.sourceBlockIds, [firstId, middleId]);
  assert.equal(consecutiveSamePage.detections.includes(firstId) || consecutiveSamePage.detections.includes(middleId), false, "continuous originals disappear after replacement");
  assert.equal(consecutiveSamePage.replacements.length, 1, "continuous same-page members collapse to one replacement");
  await page.locator(".annotation-logical-group-header").click();
  await page.getByRole("button", { name: "拆分" }).click();
  await page.waitForFunction((restored) => restored.every((id) => document.querySelector(`[data-source-key="detection:${id}"]`)), [firstId, middleId]);
  acceptance.consecutiveSamePage = { selected: [firstId, middleId], replacement: consecutiveSamePage.replacements[0], originalsAbsent: true, splitRestored: true };

  await page.locator(`#page-1 [data-block-id="${firstId}"]`).click();
  await page.locator(`#page-1 [data-block-id="${thirdId}"]`).click({ modifiers: ["Control"] });
  const beforeSamePageMerge = await uiState();
  assert.equal(beforeSamePageMerge.selectionText, "已选择 2 个框");
  await page.getByRole("button", { name: "合并同页" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".manual-annotation-block").length === 2);
  const afterSamePageMerge = await uiState();
  assert.equal(afterSamePageMerge.replacements.length, 2, "non-contiguous same-page selection remains two regions");
  assert.equal(new Set(afterSamePageMerge.replacements.map((item) => item.logicalGroupId)).size, 1);
  assert.deepEqual(afterSamePageMerge.replacements.flatMap((item) => item.sourceBlockIds), [firstId, thirdId]);
  assert.equal(afterSamePageMerge.detections.includes(middleId), true);
  assert.equal(afterSamePageMerge.detections.includes(firstId) || afterSamePageMerge.detections.includes(thirdId), false);
  const middleHit = await page.locator(`#page-1 [data-block-id="${middleId}"]`).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest("[data-block-id]");
    return { expected: element.dataset.blockId, actual: hit?.dataset.blockId, pointerEvents: getComputedStyle(element).pointerEvents };
  });
  assert.deepEqual(middleHit, { expected: middleId, actual: middleId, pointerEvents: "auto" });
  await page.locator(`#page-1 [data-block-id="${middleId}"]`).click();
  assert.equal((await uiState()).selectedCanvasIds.includes(middleId), true, "unselected middle detection remains independently clickable");
  await page.screenshot({ path: resolve(output, "02-noncontiguous-same-page.png"), fullPage: false });
  await writeFile(resolve(output, "pre-merge-state.json"), `${JSON.stringify(beforeSamePageMerge, null, 2)}\n`);
  await writeFile(resolve(output, "post-merge-state.json"), `${JSON.stringify(afterSamePageMerge, null, 2)}\n`);
  acceptance.samePage = { selected: [firstId, thirdId], unselectedMiddle: middleId, hit: middleHit, replacementCount: 2 };

  await page.locator(".annotation-logical-group-header").click();
  await page.getByRole("button", { name: "拆分" }).click();
  await page.waitForFunction((restored) => restored.every((id) => document.querySelector(`[data-source-key="detection:${id}"]`)), [firstId, middleId, thirdId]);

  const pageIds = {};
  for (const pageNumber of [1, 3, 7]) {
    pageIds[pageNumber] = await page.locator(`#page-${pageNumber} .detection-block.annotation-text`).first().getAttribute("data-block-id");
    assert.ok(pageIds[pageNumber]);
  }
  await page.locator(`[data-source-info-key="detection:${pageIds[1]}"]`).click();
  await page.locator(`[data-source-info-key="detection:${pageIds[3]}"]`).click({ modifiers: ["Control"] });
  await page.locator(`[data-source-info-key="detection:${pageIds[7]}"]`).click({ modifiers: ["Control"] });
  assert.equal((await uiState()).selectionText, "已选择 3 个框");
  await page.getByRole("button", { name: "合并跨页" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".manual-annotation-block").length === 3);
  const crossPageMerged = await uiState();
  assert.deepEqual(crossPageMerged.replacements.map((item) => item.page), [1, 3, 7]);
  assert.equal(new Set(crossPageMerged.replacements.map((item) => item.logicalGroupId)).size, 1);
  assert.equal(new Set(crossPageMerged.replacements.map((item) => item.logicalGroupNumber)).size, 1);
  assert.deepEqual(crossPageMerged.replacements.map((item) => item.groupMemberIndex), [1, 2, 3]);
  assert.equal(crossPageMerged.replacements.every((item) => item.groupMemberCount === 3), true);
  assert.equal(crossPageMerged.replacements.every((item) => JSON.stringify(item.groupPages) === JSON.stringify([1, 3, 7])), true);
  assert.equal(crossPageMerged.replacements.every((item) => /组 02|组 01/.test(item.title) && /成员 [123]\/3/.test(item.title)), true);
  const groupPresentation = await page.evaluate(() => ({
    headers: [...document.querySelectorAll(".annotation-logical-group-header")].map((item) => ({ text: item.textContent?.trim(), color: getComputedStyle(item).getPropertyValue("--group-color").trim(), title: item.title })),
    badges: [...document.querySelectorAll(".annotation-group-badge")].map((item) => ({ text: item.textContent, color: getComputedStyle(item).backgroundColor, pointerEvents: getComputedStyle(item).pointerEvents })),
    rows: [...document.querySelectorAll(".annotation-source-row[data-logical-group-id]")].map((item) => ({ text: item.textContent?.trim(), group: item.dataset.logicalGroupId, number: item.dataset.logicalGroupNumber, index: item.dataset.groupMemberIndex, pages: item.dataset.groupPages, color: getComputedStyle(item).getPropertyValue("--group-color").trim() })),
  }));
  assert.equal(groupPresentation.headers.length, 1);
  assert.equal(new Set(groupPresentation.badges.map((item) => item.color)).size, 1);
  assert.equal(groupPresentation.badges.every((item) => item.pointerEvents === "none"), true);
  assert.equal(new Set(groupPresentation.rows.map((item) => item.color)).size, 1);
  assert.equal(groupPresentation.rows.every((item) => item.pages === "1,3,7"), true);
  await page.locator("#clearSelection").click();
  await page.locator(".annotation-logical-group-header").click();
  assert.equal((await uiState()).selectionText, "已选择 3 个框", "group title selects every group region");
  await page.screenshot({ path: resolve(output, "03-p1-p3-p7-group.png"), fullPage: false });
  acceptance.crossPage = { pageIds, merged: crossPageMerged.replacements, presentation: groupPresentation, groupHeaderSelectAll: true };

  await page.locator('.manual-annotation-block[data-group-member-index="2"]').click();
  await page.getByRole("button", { name: "删除框" }).click();
  const afterMemberDelete = await uiState();
  assert.deepEqual(afterMemberDelete.replacements.map((item) => item.page), [1, 7]);
  assert.deepEqual(afterMemberDelete.replacements.map((item) => item.groupMemberIndex), [1, 2]);
  assert.equal(afterMemberDelete.replacements.every((item) => item.groupMemberCount === 2), true);
  assert.equal(afterMemberDelete.replacements.every((item) => JSON.stringify(item.groupPages) === JSON.stringify([1, 7])), true);
  await page.screenshot({ path: resolve(output, "04-group-member-deleted.png"), fullPage: false });
  await page.getByRole("button", { name: "撤销" }).click();
  assert.equal((await uiState()).replacements.length, 3);
  await page.getByRole("button", { name: "重做" }).click();
  assert.equal((await uiState()).replacements.length, 2);
  await page.getByRole("button", { name: "撤销" }).click();
  assert.equal((await uiState()).replacements.length, 3);

  await page.locator(".annotation-logical-group-header").click();
  await page.getByRole("button", { name: "拆分" }).click();
  const crossPageSplit = await uiState();
  assert.equal(crossPageSplit.replacements.length, 0);
  assert.deepEqual([pageIds[1], pageIds[3], pageIds[7]].map((id) => crossPageSplit.detections.includes(id)), [true, true, true]);
  await page.getByRole("button", { name: "撤销" }).click();
  assert.deepEqual((await uiState()).replacements.map((item) => item.page), [1, 3, 7]);
  await page.getByRole("button", { name: "重做" }).click();
  assert.equal((await uiState()).replacements.length, 0);
  await page.screenshot({ path: resolve(output, "05-split-restores-order.png"), fullPage: false });
  acceptance.history = { memberDelete: afterMemberDelete.replacements, splitRestoredOrder: [pageIds[1], pageIds[3], pageIds[7]], undoRedo: true };

  const geometry = async () => await page.locator(`#page-7 [data-block-id="${pageIds[7]}"]`).evaluate((element) => {
    const pageBox = element.closest("[data-page]").getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return [(box.left - pageBox.left) / pageBox.width, (box.top - pageBox.top) / pageBox.height, box.width / pageBox.width, box.height / pageBox.height].map((value) => value.toFixed(4));
  });
  const beforeZoom = await geometry();
  await page.locator('[data-page-target="7"]').click();
  await page.getByRole("button", { name: "放大" }).click();
  await wait(300);
  const afterZoom = await geometry();
  assert.deepEqual(afterZoom, beforeZoom, "page jump and zoom keep normalized source geometry stable");
  acceptance.geometry = { beforeZoom, afterZoom, page: 7 };

  const tooltipEvidence = await page.evaluate(() => ({
    samePageMerge: document.querySelector('[data-annotation-action="merge"]')?.title,
    crossPageSelect: document.querySelector('[data-annotation-action="cross-page-select"]')?.title,
    crossPageMerge: document.querySelector('[data-annotation-action="merge-cross-page"]')?.title,
  }));
  assert.equal(Object.values(tooltipEvidence).every((value) => value?.includes("来源框") && !value.includes("人工框")), true);
  acceptance.tooltips = tooltipEvidence;

  const parsedAfter = reviewUrl ? await page.evaluate(async (url) => (await fetch(url)).json(), reviewUrl) : null;
  assert.deepEqual(parsedAfter?.parsedDocument, reviewSnapshot?.parsedDocument, "annotation revisions do not mutate Parsed Document");
  const provenanceEvidence = {
    samePage: {
      selectedSourceBlockIds: [firstId, thirdId], unselectedMiddleSourceBlockId: middleId,
      replacementSourceBlockIds: afterSamePageMerge.replacements.map((item) => item.sourceBlockIds),
      inferredSuppressed: [firstId, thirdId].filter((id) => !afterSamePageMerge.detections.includes(id)),
      middleStillEffective: afterSamePageMerge.detections.includes(middleId),
    },
    crossPage: {
      selectedSourceBlockIds: [pageIds[1], pageIds[3], pageIds[7]],
      replacementSourceBlockIds: crossPageMerged.replacements.map((item) => item.sourceBlockIds),
      inferredSuppressed: [pageIds[1], pageIds[3], pageIds[7]].filter((id) => !crossPageMerged.detections.includes(id)),
    },
    parsedDocumentUnchanged: true,
  };
  assert.deepEqual(provenanceEvidence.samePage.inferredSuppressed, [firstId, thirdId]);
  assert.deepEqual(provenanceEvidence.crossPage.inferredSuppressed, [pageIds[1], pageIds[3], pageIds[7]]);
  await writeFile(resolve(output, "source-block-ids-and-suppression.json"), `${JSON.stringify(provenanceEvidence, null, 2)}\n`);

  const appProblems = browserLog.filter((entry) => ["error", "warning", "pageerror"].includes(entry.type) && (!entry.location?.url || entry.location.url.startsWith(`http://127.0.0.1:${appPort}`)));
  assert.equal(appProblems.length, 0, "browser has zero application errors or warnings");
  acceptance.browser = { browser: `Microsoft Edge ${browser.version()}`, applicationErrorsOrWarnings: appProblems.length };
  await writeFile(resolve(output, "acceptance-summary.json"), `${JSON.stringify(acceptance, null, 2)}\n`);
  await writeFile(resolve(output, "browser-console.json"), `${JSON.stringify(browserLog, null, 2)}\n`);
  await writeFile(resolve(output, "parsed-document-immutability.json"), `${JSON.stringify({ unchanged: true, parsedDocument: reviewSnapshot?.parsedDocument ?? null }, null, 2)}\n`);
} finally {
  if (browser) await browser.close();
  await writeFile(resolve(output, "app-service.log"), serviceLog);
  if (app.exitCode === null) app.kill("SIGKILL");
  if (fake.exitCode === null) fake.kill("SIGKILL");
  app.stdout.destroy(); app.stderr.destroy(); fake.stdout.destroy(); fake.stderr.destroy();
}
