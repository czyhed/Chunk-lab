import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { after, before, test } from "node:test";

type TableCell = {
  cellId: string;
  text: string;
  rowSpan: number;
  colSpan: number;
};

type TableRowGroup = {
  rowGroupId: string;
  order: number;
  repeatedHeader: boolean;
  sourceSegmentIds: string[];
  rowStart: number;
  rowCount: number;
};

type TableModel = {
  type: "table";
  tableId: string;
  title?: string;
  columns: string[];
  rows: TableCell[][];
  rowGroups: TableRowGroup[];
};

type ReviewChunk = {
  id: string;
  type: string;
  finalType?: string;
  finalText: string;
  tokenCount: number;
  qualityFlags: string[];
  embeddingEligible?: boolean;
  embeddingExclusionReasons?: string[];
  embeddingText?: string | null;
  contextReviewState: string;
  contextText: string;
  contextError?: string;
  sourceSegments: Array<{ contentBlockId: string; page: number | null }>;
  reviewedModel?: TableModel;
  reviewRevision?: number;
  revisions: unknown[];
  reviewedModelRevisions?: unknown[];
};

type ReviewPayload = {
  reviewState: {
    preview: { chunks: ReviewChunk[] } | null;
    draft: { chunks: ReviewChunk[] } | null;
  };
  sourceBlocks?: unknown[];
  parsedDocument?: unknown;
};

let app: ChildProcess;
let baseUrl: string;

before(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/server.ts"], {
    cwd: resolve("."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      WORKSPACE_ROOT: resolve(".workspace", `t09-integration-${process.pid}`),
      MINERU_API_TOKEN: "test-mineru-token",
      EMBEDDING_BASE_URL: "http://127.0.0.1:9/v1",
      EMBEDDING_API_KEY: "test-embedding-key",
      EMBEDDING_MODEL: "test-embedding-model",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitFor(`${baseUrl}/api/health`, app);
});

after(async () => {
  if (app.exitCode !== null) return;
  app.kill();
  await once(app, "close");
  await new Promise((resolveDrain) => setTimeout(resolveDrain, 250));
});

test("ordinary Table Chunk saves a cell through the authoritative API and recomputes derived fields", async () => {
  const fixture = await confirmedDemo();
  const before = tableChunk(fixture.review.reviewState.draft!.chunks);
  assertCanonicalTable(before);
  const originalSources = structuredClone(fixture.review.sourceBlocks);
  const originalParsedDocument = structuredClone(fixture.review.parsedDocument);

  const model = structuredClone(before.reviewedModel!);
  model.title = "A1 核验参数";
  model.rows[0][1].text = "额定功率 1500W（人工核验）";
  const response = await saveTable(fixture, before, model);
  assert.equal(response.status, 200);
  const payload = await response.json() as ReviewPayload & { recomputed: Record<string, unknown> };
  const saved = tableChunk(payload.reviewState.draft!.chunks);

  assert.equal(saved.reviewRevision, 1);
  assert.deepEqual(saved.reviewedModel, model);
  assert.equal(
    saved.finalText,
    "A1 核验参数\n型号 | 额定功率 | 容量\nA1 | 额定功率 1500W（人工核验） | 1.8L",
  );
  assert.ok(saved.tokenCount > before.tokenCount);
  assert.equal(saved.embeddingEligible, true);
  assert.deepEqual(saved.embeddingExclusionReasons, []);
  assert.equal(saved.embeddingText, null);
  assert.match(String(payload.recomputed.display && (payload.recomputed.display as { html?: string }).html), /<table>/);
  assert.ok(saved.qualityFlags.includes("source_location_page_only"));
  assert.ok(!saved.qualityFlags.includes("image_asset_unavailable"));

  const refreshed = await getReview(fixture);
  assert.deepEqual(refreshed.sourceBlocks, originalSources);
  assert.deepEqual(refreshed.parsedDocument, originalParsedDocument);
  assert.deepEqual(tableChunk(refreshed.reviewState.draft!.chunks).sourceSegments, before.sourceSegments);
});

test("an optional table title can be cleared without making the table structure invalid", async () => {
  const fixture = await confirmedDemo();
  const before = tableChunk(fixture.review.reviewState.draft!.chunks);
  const titledModel = structuredClone(before.reviewedModel!);
  titledModel.title = "待清空表题";
  const titledResponse = await saveTable(fixture, before, titledModel);
  assert.equal(titledResponse.status, 200);
  const titled = tableChunk(((await titledResponse.json()) as ReviewPayload).reviewState.draft!.chunks);

  const clearedModel = structuredClone(titled.reviewedModel!);
  clearedModel.title = "";
  const clearedResponse = await saveTable(fixture, titled, clearedModel);
  assert.equal(clearedResponse.status, 200);
  const cleared = tableChunk(((await clearedResponse.json()) as ReviewPayload).reviewState.draft!.chunks);
  assert.equal(cleared.reviewedModel!.title, undefined);
  assert.ok(cleared.finalText.startsWith("型号 | 额定功率 | 容量"));
});

test("ordinary Table Chunk persists confirmed row and column operations and supports undo and redo", async () => {
  const fixture = await confirmedDemo();
  const before = tableChunk(fixture.review.reviewState.draft!.chunks);
  assertCanonicalTable(before);
  const model = structuredClone(before.reviewedModel!);
  model.columns.push("备注");
  model.rows.forEach((row, rowIndex) => row.push(cell(`added-${rowIndex}`, rowIndex ? "复核" : "铭牌", 1, 1)));
  model.rows.push(model.columns.map((_, index) =>
    cell(`added-row-${index}`, ["A2", "900W", "1.5L", "新增行"][index] ?? "", 1, 1)
  ));
  model.rowGroups[0].rowCount = model.rows.length;

  const saveResponse = await saveTable(fixture, before, model);
  assert.equal(saveResponse.status, 200);
  const saved = tableChunk(((await saveResponse.json()) as ReviewPayload).reviewState.draft!.chunks);
  assert.deepEqual(saved.reviewedModel, model);
  assert.match(saved.finalText, /型号 \| 额定功率 \| 容量 \| 备注/);
  assert.match(saved.finalText, /A2 \| 900W \| 1.5L \| 新增行/);

  const undone = await reviewAction(fixture, { type: "undo" });
  assert.deepEqual(tableChunk(undone.reviewState.draft!.chunks).reviewedModel, before.reviewedModel);
  const reopenedUndone = tableChunk((await getReview(fixture)).reviewState.draft!.chunks);
  assert.deepEqual(reopenedUndone.reviewedModel, before.reviewedModel);
  assert.equal(reopenedUndone.reviewRevision, 0);
  assert.deepEqual((await getExportedChunk(fixture, before.id)).reviewedModel, before.reviewedModel);

  const redone = await reviewAction(fixture, { type: "redo" });
  assert.deepEqual(tableChunk(redone.reviewState.draft!.chunks).reviewedModel, model);
  assert.equal(tableChunk(redone.reviewState.draft!.chunks).reviewRevision, 1);
  const reopenedRedone = tableChunk((await getReview(fixture)).reviewState.draft!.chunks);
  assert.deepEqual(reopenedRedone.reviewedModel, model);
  assert.equal(reopenedRedone.reviewRevision, 1);
  const exportedRedone = await getExportedChunk(fixture, before.id);
  assert.deepEqual(exportedRedone.reviewedModel, model);
  assert.equal(exportedRedone.reviewRevision, 1);
});

test("row and column deletions persist through public review and export APIs", async () => {
  const fixture = await confirmedDemo();
  const before = tableChunk(fixture.review.reviewState.draft!.chunks);
  assertCanonicalTable(before);

  const expanded = structuredClone(before.reviewedModel!);
  expanded.columns.push("待删除列");
  expanded.rows[0].push(cell("temporary-column", "待删除", 1, 1));
  expanded.rows.push(expanded.columns.map((_, index) =>
    cell(`temporary-row-${index}`, `临时 ${index + 1}`, 1, 1)
  ));
  expanded.rowGroups[0].rowCount += 1;
  const expandedResponse = await saveTable(fixture, before, expanded);
  assert.equal(expandedResponse.status, 200);
  const expandedChunk = tableChunk(
    ((await expandedResponse.json()) as ReviewPayload).reviewState.draft!.chunks,
  );

  const reduced = structuredClone(expandedChunk.reviewedModel!);
  reduced.rows.pop();
  reduced.rows[0].pop();
  reduced.columns.pop();
  reduced.rowGroups[0].rowCount -= 1;
  const reducedResponse = await saveTable(fixture, expandedChunk, reduced);
  assert.equal(reducedResponse.status, 200);
  const reducedChunk = tableChunk(
    ((await reducedResponse.json()) as ReviewPayload).reviewState.draft!.chunks,
  );
  assert.deepEqual(reducedChunk.reviewedModel, reduced);
  assert.equal(reducedChunk.reviewRevision, 2);
  assert.doesNotMatch(reducedChunk.finalText, /待删除|临时/);

  const reopened = tableChunk((await getReview(fixture)).reviewState.draft!.chunks);
  assert.deepEqual(reopened.reviewedModel, reduced);
  assert.equal(reopened.reviewRevision, 2);
  const exported = await getExportedChunk(fixture, before.id);
  assert.deepEqual(exported.reviewedModel, reduced);
  assert.equal(exported.reviewRevision, 2);
});

test("merged cells remain structural and render rowspan and colspan", async () => {
  const fixture = await confirmedDemo();
  const before = tableChunk(fixture.review.reviewState.draft!.chunks);
  assertCanonicalTable(before);
  const sourceIds = before.sourceSegments.map((segment) => segment.contentBlockId);
  const model: TableModel = {
    type: "table",
    tableId: before.reviewedModel!.tableId,
    title: "合并单元格参数",
    columns: ["项目", "数值", "单位"],
    rows: [
      [cell("merged-label", "额定参数", 2, 1), cell("power", "1200", 1, 1), cell("power-unit", "W", 1, 1)],
      [cell("capacity", "1.8 L", 1, 2)],
    ],
    rowGroups: [{
      rowGroupId: `${before.reviewedModel!.tableId}:group:1`,
      order: 0,
      repeatedHeader: false,
      sourceSegmentIds: sourceIds,
      rowStart: 0,
      rowCount: 2,
    }],
  };
  const response = await saveTable(fixture, before, model);
  assert.equal(response.status, 200);
  const payload = await response.json() as ReviewPayload & { recomputed: { display: { html: string } } };
  const saved = tableChunk(payload.reviewState.draft!.chunks);
  assert.deepEqual(saved.reviewedModel, model);
  assert.match(payload.recomputed.display.html, /rowspan="2"/);
  assert.match(payload.recomputed.display.html, /colspan="2"/);
  assert.doesNotMatch(saved.finalText, /rowspan|colspan|<td/i);
});

test("invalid and empty table structures return Chinese cause impact and next step without raw errors", async () => {
  for (const rows of [
    [],
    [[cell("bad", "越界", 1, 4)]],
    [[cell("same", "重复一", 1, 1), cell("same", "重复二", 1, 1)]],
  ]) {
    const fixture = await confirmedDemo();
    const before = tableChunk(fixture.review.reviewState.draft!.chunks);
    assertCanonicalTable(before);
    const model = { ...structuredClone(before.reviewedModel!), rows };
    const response = await saveTable(fixture, before, model);
    assert.equal(response.status, 422);
    const error = await response.json() as Record<string, unknown>;
    assert.match(String(error.error), /表格/);
    assert.match(String(error.impact), /保存|已保存/);
    assert.match(String(error.recovery), /检查|调整|重试/);
    assert.equal(error.code, undefined);
    assert.doesNotMatch(JSON.stringify(error), /Table requires|cellId|rowSpan|colSpan|stack|[A-Za-z]:\\/);
  }
});

test("table save rejects every client-owned derived field", async () => {
  const forbidden = [
    "finalText",
    "tokenCount",
    "qualityFlags",
    "display",
    "searchText",
    "embeddingEligible",
    "embeddingExclusionReasons",
    "embeddingText",
    "contextReviewState",
    "contextError",
    "stale",
    "reviewRevision",
  ];
  for (const field of forbidden) {
    const fixture = await confirmedDemo();
    const before = tableChunk(fixture.review.reviewState.draft!.chunks);
    assertCanonicalTable(before);
    const response = await fetch(reviewedModelUrl(fixture, before), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reviewedModel: before.reviewedModel,
        expectedRevision: before.reviewRevision,
        [field]: field === "reviewRevision" ? 99 : "客户端伪造值",
      }),
    });
    assert.equal(response.status, 400, field);
    const error = await response.json() as Record<string, unknown>;
    assert.match(String(error.error), /派生字段/);
    assert.equal(error.code, undefined);
  }
});

test("stale table revision is rejected without overwriting the saved model", async () => {
  const fixture = await confirmedDemo();
  const before = tableChunk(fixture.review.reviewState.draft!.chunks);
  assertCanonicalTable(before);
  const first = structuredClone(before.reviewedModel!);
  first.rows[0][1].text = "第一次保存";
  assert.equal((await saveTable(fixture, before, first)).status, 200);
  const stale = structuredClone(before.reviewedModel!);
  stale.rows[0][1].text = "过期客户端覆盖";
  const response = await saveTable(fixture, before, stale);
  assert.equal(response.status, 409);
  const error = await response.json() as Record<string, unknown>;
  assert.match(String(error.error), /版本|修订/);
  assert.match(String(error.impact), /未覆盖|保持/);
  assert.match(String(error.recovery), /刷新|重新打开/);
  assert.equal(error.code, undefined);
  const refreshed = tableChunk((await getReview(fixture)).reviewState.draft!.chunks);
  assert.equal(refreshed.reviewedModel!.rows[0][1].text, "第一次保存");
});

test("table changes make existing Context stale and recover through review and 2.1 export", async () => {
  const fixture = await confirmedDemo();
  const before = tableChunk(fixture.review.reviewState.draft!.chunks);
  assertCanonicalTable(before);
  const contextResponse = await fetch(
    `${baseUrl}/api/batches/${fixture.batchId}/documents/${fixture.documentId}/context/${encodeURIComponent(before.id)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contextText: "这是已存在的人工 Context。" }),
    },
  );
  assert.equal(contextResponse.status, 200);
  const withContext = tableChunk(((await contextResponse.json()) as ReviewPayload).reviewState.draft!.chunks);
  assert.equal(withContext.contextReviewState, "human_modified");

  const model = structuredClone(withContext.reviewedModel!);
  model.rows[0][1].text = "保存后 Context 应失效";
  const saveResponse = await saveTable(fixture, withContext, model);
  assert.equal(saveResponse.status, 200);
  const saved = tableChunk(((await saveResponse.json()) as ReviewPayload).reviewState.draft!.chunks);
  assert.equal(saved.contextReviewState, "stale");
  assert.equal(saved.contextText, "这是已存在的人工 Context。");
  assert.match(saved.contextError ?? "", /内容|结构|审阅/);

  const reopened = tableChunk((await getReview(fixture)).reviewState.draft!.chunks);
  assert.deepEqual(reopened.reviewedModel, model);
  assert.equal(reopened.reviewRevision, 1);
  assert.equal(reopened.contextReviewState, "stale");

  const batchResponse = await fetch(`${baseUrl}/api/batches/${fixture.batchId}`);
  assert.equal(batchResponse.status, 200);
  const exportResponse = await fetch(
    `${baseUrl}/api/batches/${fixture.batchId}/export?contractVersion=2.1`,
  );
  assert.equal(exportResponse.status, 200);
  const exported = await exportResponse.json() as {
    documents: Array<{ chunks: Array<Record<string, unknown>> }>;
  };
  const exportedChunk = exported.documents[0].chunks.find((chunk) => chunk.chunkId === before.id)!;
  assert.deepEqual(exportedChunk.reviewedModel, model);
  assert.equal(exportedChunk.finalText, saved.finalText);
  assert.equal(exportedChunk.reviewRevision, 1);
  assert.equal(exportedChunk.contextReviewState, "stale");
  assert.equal(exportedChunk.embeddingText, saved.embeddingEligible ? saved.finalText : null);
  assert.deepEqual(
    exportedChunk.sourceSegments,
    saved.sourceSegments.map(({ contentBlockId, page, ...segment }) => {
      const { blockId: _blockId, ...authoritative } = segment as typeof segment & { blockId?: string };
      return { contentBlockId, page, ...authoritative };
    }),
  );
  assert.ok(Array.isArray(exportedChunk.revisions));
  assert.ok((exportedChunk.revisions as unknown[]).length > 0);
});

test("cross-page table keeps one table id, ordered row groups, repeated headers, sources, and local edits", async () => {
  const fixture = await confirmedDemo({ tableScenario: "cross-page" });
  const tableChunks = fixture.review.reviewState.draft!.chunks.filter(
    (chunk) => chunk.finalType === "table" || chunk.type === "table",
  );
  assert.equal(tableChunks.length, 1, "cross-page rows remain one related Table Chunk");
  const before = tableChunks[0];
  assertCanonicalTable(before);
  const model = before.reviewedModel;
  assert.equal(model.tableId, "spec-table");
  assert.deepEqual(model.rowGroups.map((group) => group.order), [0, 1]);
  assert.deepEqual(model.rowGroups.map((group) => group.repeatedHeader), [false, true]);
  assert.deepEqual(before.sourceSegments.map((segment) => segment.page), [1, 2]);
  assert.ok(before.sourceSegments.every((segment) => segment.contentBlockId));
  assert.deepEqual(
    model.rowGroups.map((group) => group.sourceSegmentIds),
    before.sourceSegments.map((segment) => [segment.contentBlockId]),
  );
  assert.deepEqual(model.rows.map((row) => row[0].text), ["A1", "A2"]);

  const changed = structuredClone(model);
  const secondGroup = changed.rowGroups[1];
  changed.rows[secondGroup.rowStart][1].text = "900W（第二页核验）";
  const response = await saveTable(fixture, before, changed);
  assert.equal(response.status, 200);
  const saved = tableChunk(((await response.json()) as ReviewPayload).reviewState.draft!.chunks);
  assert.equal(saved.reviewedModel!.rows[0][1].text, model.rows[0][1].text);
  assert.equal(saved.reviewedModel!.rows[1][1].text, "900W（第二页核验）");
  assert.deepEqual(saved.reviewedModel!.rowGroups, model.rowGroups);
  assert.deepEqual(saved.sourceSegments, before.sourceSegments);
  assert.equal(saved.reviewedModel!.tableId, model.tableId);

  const exportResponse = await fetch(
    `${baseUrl}/api/batches/${fixture.batchId}/export?contractVersion=2.1`,
  );
  assert.equal(exportResponse.status, 200);
  const exported = await exportResponse.json() as {
    documents: Array<{ chunks: Array<Record<string, unknown>> }>;
  };
  const exportedChunk = exported.documents[0].chunks.find((chunk) => chunk.chunkId === before.id)!;
  assert.deepEqual(exportedChunk.reviewedModel, changed);
  assert.equal(exportedChunk.finalText, saved.finalText);
});

test("merged cells cannot cross authoritative cross-page row-group boundaries", async () => {
  const fixture = await confirmedDemo({ tableScenario: "cross-page" });
  const before = tableChunk(fixture.review.reviewState.draft!.chunks);
  assertCanonicalTable(before);
  const model = structuredClone(before.reviewedModel!);
  model.rows[0][0].rowSpan = 2;
  model.rows[1].shift();
  const response = await saveTable(fixture, before, model);
  assert.equal(response.status, 422);
  const error = await response.json() as Record<string, unknown>;
  assert.match(String(error.error), /表格结构/);
  assert.match(String(error.recovery), /合并单元格/);
});

test("client cannot overwrite authoritative cross-page row-group metadata", async () => {
  const fixture = await confirmedDemo({ tableScenario: "cross-page" });
  const before = tableChunk(fixture.review.reviewState.draft!.chunks);
  assertCanonicalTable(before);
  const model = structuredClone(before.reviewedModel!);
  model.rowGroups[1].repeatedHeader = false;
  const response = await saveTable(fixture, before, model);
  assert.equal(response.status, 422);
  const refreshed = tableChunk((await getReview(fixture)).reviewState.draft!.chunks);
  assert.equal(refreshed.reviewedModel!.rowGroups[1].repeatedHeader, true);
  assert.equal(refreshed.reviewRevision, 0);
});

function cell(cellId: string, text: string, rowSpan: number, colSpan: number): TableCell {
  return { cellId, text, rowSpan, colSpan };
}

function assertCanonicalTable(chunk: ReviewChunk): asserts chunk is ReviewChunk & {
  reviewedModel: TableModel;
  reviewRevision: number;
} {
  assert.equal(chunk.reviewedModel?.type, "table");
  assert.ok(chunk.reviewedModel.tableId);
  assert.ok(chunk.reviewedModel.rows.length);
  assert.ok(chunk.reviewedModel.rowGroups.length);
  assert.equal(chunk.reviewRevision, 0);
}

function tableChunk(chunks: ReviewChunk[]): ReviewChunk {
  const chunk = chunks.find((candidate) => candidate.finalType === "table" || candidate.type === "table");
  assert.ok(chunk, "demo exposes an ordinary Table Chunk");
  return chunk;
}

async function confirmedDemo(options: Record<string, unknown> = {}) {
  const demoResponse = await fetch(`${baseUrl}/api/demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  assert.equal(demoResponse.status, 200);
  const demo = await demoResponse.json() as { id: string; documents: Array<{ id: string }> };
  const fixture = { batchId: demo.id, documentId: demo.documents[0].id };
  const preview = await getReview(fixture);
  assertCanonicalTable(tableChunk(preview.reviewState.preview!.chunks));
  const confirmResponse = await fetch(
    `${baseUrl}/api/batches/${fixture.batchId}/documents/${fixture.documentId}/review/confirm`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  );
  assert.equal(confirmResponse.status, 200);
  return { ...fixture, review: await getReview(fixture) };
}

async function getReview(fixture: { batchId: string; documentId: string }): Promise<ReviewPayload> {
  const response = await fetch(
    `${baseUrl}/api/batches/${fixture.batchId}/documents/${fixture.documentId}/review`,
  );
  assert.equal(response.status, 200);
  return await response.json() as ReviewPayload;
}

function reviewedModelUrl(
  fixture: { batchId: string; documentId: string },
  chunk: ReviewChunk,
): string {
  return `${baseUrl}/api/batches/${fixture.batchId}/documents/${fixture.documentId}/chunks/${encodeURIComponent(chunk.id)}/reviewed-model`;
}

function saveTable(
  fixture: { batchId: string; documentId: string },
  chunk: ReviewChunk,
  reviewedModel: TableModel,
): Promise<Response> {
  return fetch(reviewedModelUrl(fixture, chunk), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reviewedModel, expectedRevision: chunk.reviewRevision }),
  });
}

async function reviewAction(
  fixture: { batchId: string; documentId: string },
  command: Record<string, unknown>,
): Promise<ReviewPayload> {
  const response = await fetch(
    `${baseUrl}/api/batches/${fixture.batchId}/documents/${fixture.documentId}/review/actions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    },
  );
  assert.equal(response.status, 200);
  return await response.json() as ReviewPayload;
}

async function getExportedChunk(
  fixture: { batchId: string; documentId: string },
  chunkId: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `${baseUrl}/api/batches/${fixture.batchId}/export?contractVersion=2.1`,
  );
  assert.equal(response.status, 200);
  const exported = await response.json() as {
    documents: Array<{ chunks: Array<Record<string, unknown>> }>;
  };
  const chunk = exported.documents[0].chunks.find((candidate) => candidate.chunkId === chunkId);
  assert.ok(chunk);
  return chunk;
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No TCP port"));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitFor(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Timed out waiting for T09 integration server");
}
