import * as pdfjsLib from "/vendor/pdfjs/pdf.mjs";
import { beginPdfRender, cancelPdfRender } from "/pdf-render-coordinator.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";

const documents = new Map();

async function load(url) {
  if (!documents.has(url)) documents.set(url, pdfjsLib.getDocument({
    url,
    disableAutoFetch: true,
    disableStream: false,
    rangeChunkSize: 256 * 1024,
  }).promise);
  return documents.get(url);
}

export async function getPdfPageCount(url) {
  const pdf = await load(url);
  return pdf.numPages;
}

export function cancelPdfRenders(root) {
  return cancelPdfRender(root);
}

export async function renderPdfCanvases(root, url, scale = 1) {
  const session = beginPdfRender(root);
  await session.waitForPrevious;
  if (session.cancelled) return;
  const pdf = await load(url);
  if (session.cancelled) return;
  root.dataset.pdfPageCount = String(pdf.numPages);
  const canvases = [...root.querySelectorAll("canvas[data-pdf-page]")];
  let cursor = 0;
  async function worker() {
    while (cursor < canvases.length && !session.cancelled) {
      const canvas = canvases[cursor++];
      const page = await pdf.getPage(Number(canvas.dataset.pdfPage));
      if (session.cancelled) return;
    const viewport = page.getViewport({ scale: Math.max(.5, Math.min(2.5, scale)) });
    const outputScale = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
    const context = canvas.getContext("2d", { alpha: false });
    const renderTask = page.render({
      canvas,
      canvasContext: context,
      transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
      viewport,
    });
    session.track(renderTask);
    try {
      await renderTask.promise;
    } catch (error) {
      if (session.cancelled || error?.name === "RenderingCancelledException") return;
      throw error;
    } finally { session.untrack(renderTask); }
    if (session.cancelled) return;
    canvas.dataset.rendered = "true";
    }
  }
  await Promise.all([worker(), worker()]);
  session.complete();
  return pdf.numPages;
}
