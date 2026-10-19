import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";

const port = Number(process.env.FAKE_MINERU_PORT) || 0;
const logPath = resolve(
  process.env.FAKE_MINERU_LOG ?? "output/t01-upload-mineru/fake-calls.jsonl",
);
const multiImageContentList = JSON.parse(
  await readFile(resolve("qa/fixtures/t02-multi-image-content-list.json"), "utf8"),
);
const batches = new Map();
const attemptsByName = new Map();
let batchSequence = 0;

await mkdir(dirname(logPath), { recursive: true });

async function log(event, details = {}) {
  await appendFile(
    logPath,
    `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`,
    "utf8",
  );
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function envelope(data) {
  return JSON.stringify({ code: 0, msg: "ok", data });
}

function resultZip(file) {
  const markdown = `# ${file.name}\n\nDeterministic fake MinerU content.`;
  const contentList = file.name === "多图片PDF.pdf"
    ? multiImageContentList
    : [
        {
          type: "title",
          text: file.name,
          page_idx: 0,
          bbox: [10, 20, 300, 60],
          source_backend: "fake-mineru",
          source_version: "fake-v1",
        },
        {
          type: "text",
          text: "Deterministic fake MinerU content.",
          page_idx: 0,
          bbox: [10, 80, 500, 130],
          source_backend: "fake-mineru",
          source_version: "fake-v1",
        },
      ];
  return Buffer.from(
    zipSync({
      "result/full.md": strToU8(markdown),
      "result/content_list.json": strToU8(JSON.stringify(contentList)),
    }),
  );
}

function extractionResult(baseUrl, batch, file) {
  const common = { file_name: file.name, data_id: file.id };
  if (!file.uploaded) return { ...common, state: "waiting-file" };
  if (file.name.includes("remote-fail"))
    return { ...common, state: "failed", err_msg: "fake MinerU parse failure" };
  if (file.name.includes("timeout")) return { ...common, state: "running" };
  if (file.name.includes("retry-once") && file.attempt === 1)
    return { ...common, state: "failed", err_msg: "fake first attempt failure" };
  if (file.name.includes("corrupt"))
    return {
      ...common,
      state: "done",
      full_zip_url: `${baseUrl}/result/${batch.id}/${file.id}/corrupt.zip`,
    };
  const pendingUntil = file.name.includes("browser-slow") ? 2 : 1;
  const runningUntil = file.name.includes("browser-slow") ? 8 : 2;
  if (batch.polls <= pendingUntil) return { ...common, state: "pending" };
  if (batch.polls <= runningUntil)
    return {
      ...common,
      state: "running",
      extract_progress: { extracted_pages: 1, total_pages: 2 },
    };
  return {
    ...common,
    state: "done",
    full_zip_url: `${baseUrl}/result/${batch.id}/${file.id}/result.zip`,
  };
}

export const server = createServer(async (request, response) => {
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const url = new URL(request.url, baseUrl);
    if (request.method === "GET" && url.pathname === "/health") {
      response.end("ok");
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v4/file-urls/batch") {
      const body = JSON.parse((await readBody(request)).toString("utf8"));
      if (body.files.some((file) => file.name.includes("submit-fail"))) {
        await log("submit-rejected", {
          authorizationPresent: Boolean(request.headers.authorization),
          files: body.files.map((file) => ({ documentId: file.data_id, name: file.name })),
          status: 503,
        });
        response.statusCode = 503;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ code: 503, msg: "fake submit unavailable", data: null }));
        return;
      }
      const id = `fake-batch-${String(++batchSequence).padStart(3, "0")}`;
      const files = body.files.map((file) => {
        const attempt = (attemptsByName.get(file.name) ?? 0) + 1;
        attemptsByName.set(file.name, attempt);
        return { id: file.data_id, name: file.name, attempt, uploaded: false };
      });
      batches.set(id, { id, files, polls: 0 });
      await log("submit", {
        batchId: id,
        authorizationPresent: Boolean(request.headers.authorization),
        files: files.map(({ id: documentId, name, attempt }) => ({ documentId, name, attempt })),
        config: {
          modelVersion: body.model_version,
          language: body.language,
          enableFormula: body.enable_formula,
          enableTable: body.enable_table,
        },
      });
      response.setHeader("content-type", "application/json");
      response.end(
        envelope({
          batch_id: id,
          file_urls: files.map(
            (file) => `${baseUrl}/signed-upload/${id}/${encodeURIComponent(file.id)}`,
          ),
        }),
      );
      return;
    }
    const uploadMatch = /^\/signed-upload\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (request.method === "PUT" && uploadMatch) {
      const batch = batches.get(uploadMatch[1]);
      const file = batch?.files.find((candidate) => candidate.id === decodeURIComponent(uploadMatch[2]));
      const bytes = (await readBody(request)).byteLength;
      const failed = file?.name.includes("upload-fail");
      if (file && !failed) file.uploaded = true;
      await log("signed-upload", {
        batchId: batch?.id,
        documentId: file?.id,
        name: file?.name,
        bytes,
        authorizationPresent: Boolean(request.headers.authorization),
        status: failed ? 503 : 200,
      });
      response.statusCode = failed ? 503 : 200;
      response.end();
      return;
    }
    const pollMatch = /^\/api\/v4\/extract-results\/batch\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && pollMatch) {
      const batch = batches.get(pollMatch[1]);
      if (!batch) {
        response.statusCode = 404;
        response.end(JSON.stringify({ code: 404, msg: "unknown fake batch", data: null }));
        return;
      }
      batch.polls += 1;
      if (
        batch.polls === 1 &&
        batch.files.some((file) => file.name.includes("poll-error-once"))
      ) {
        await log("poll-rejected", { batchId: batch.id, poll: batch.polls, status: 503 });
        response.statusCode = 503;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ code: 503, msg: "fake poll unavailable", data: null }));
        return;
      }
      const results = batch.files.flatMap((file) => {
        const result = extractionResult(baseUrl, batch, file);
        return file.name.includes("duplicate") && result.state === "done"
          ? [result, structuredClone(result)]
          : [result];
      });
      await log("poll", {
        batchId: batch.id,
        poll: batch.polls,
        states: results.map((result) => ({ documentId: result.data_id, state: result.state })),
      });
      response.setHeader("content-type", "application/json");
      response.end(envelope({ extract_result: results }));
      return;
    }
    const resultMatch = /^\/result\/([^/]+)\/([^/]+)\/(corrupt|result)\.zip$/.exec(url.pathname);
    if (request.method === "GET" && resultMatch) {
      const batch = batches.get(resultMatch[1]);
      const file = batch?.files.find((candidate) => candidate.id === resultMatch[2]);
      await log("download-result", {
        batchId: batch?.id,
        documentId: file?.id,
        name: file?.name,
        kind: resultMatch[3],
      });
      response.setHeader("content-type", "application/zip");
      response.end(resultMatch[3] === "corrupt" ? Buffer.from("not a zip") : resultZip(file));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  } catch (error) {
    await log("fake-error", { message: error instanceof Error ? error.message : String(error) });
    response.statusCode = 500;
    response.end("fake error");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`FAKE_MINERU_READY ${server.address().port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
