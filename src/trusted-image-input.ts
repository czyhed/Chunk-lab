import { readFile } from "node:fs/promises";
import { createCanvas } from "@napi-rs/canvas";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { sourceVersionFromFile } from "./v21-input.js";

type TrustedSegment = {
  sourceDocumentVersion?: string;
  sourceViewKind?: string;
  locationQuality?: string;
  page?: number | null;
  bbox?: readonly number[] | null;
  bboxEvidence?: { pageWidth: number; pageHeight: number; coordinateOrigin?: "top-left" | "bottom-left" };
};

export type TrustedImageInput = {
  sourceAsset: { path: string; mimeType: string };
  sourceDocumentVersion: string;
  sourceSegments: readonly TrustedSegment[];
};

export type ResolvedTrustedImage = {
  dataUrl: string;
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  source: "source_image" | "pdf_crop";
  page: number | null;
  pageRenderBytes?: Uint8Array;
  pageRenderPage?: number;
};

export async function resolveTrustedImageInput(
  input: TrustedImageInput,
): Promise<ResolvedTrustedImage> {
  const actualVersion = await sourceVersionFromFile(input.sourceAsset.path);
  if (actualVersion !== input.sourceDocumentVersion)
    throw new Error("原始图片资产版本不匹配");

  if (/^image\/(?:png|jpeg|webp)$/i.test(input.sourceAsset.mimeType)) {
    const bytes = await readFile(input.sourceAsset.path);
    return {
      dataUrl: `data:${input.sourceAsset.mimeType.toLowerCase()};base64,${bytes.toString("base64")}`,
      bytes,
      mimeType: input.sourceAsset.mimeType.toLowerCase() as ResolvedTrustedImage["mimeType"],
      source: "source_image",
      page: null,
    };
  }

  if (input.sourceAsset.mimeType !== "application/pdf")
    throw new Error("缺少可信图片资产或精确裁剪范围");
  if (input.sourceSegments.some((candidate) =>
    candidate.sourceDocumentVersion &&
    candidate.sourceDocumentVersion !== input.sourceDocumentVersion
  )) throw new Error("图片 Source Segment 版本不匹配");
  const segment = input.sourceSegments.find((candidate) =>
    candidate.sourceDocumentVersion === input.sourceDocumentVersion &&
    candidate.sourceViewKind === "original_file" &&
    candidate.locationQuality === "exact" &&
    Number.isSafeInteger(candidate.page) &&
    candidate.page! > 0 &&
    validBbox(candidate.bbox)
  );
  if (!segment)
    throw new Error("缺少可信图片资产或精确裁剪范围");

  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(await readFile(input.sourceAsset.path)),
  }).promise;
  try {
    if (segment.page! > pdf.numPages)
      throw new Error("图片裁剪页码超出原始 PDF");
    const page = await pdf.getPage(segment.page!);
    const viewport = page.getViewport({ scale: 2 });
    const pageCanvas = createCanvas(
      Math.max(1, Math.ceil(viewport.width)),
      Math.max(1, Math.ceil(viewport.height)),
    );
    await page.render({
      canvas: pageCanvas as never,
      canvasContext: pageCanvas.getContext("2d") as never,
      viewport,
    }).promise;
    const view = page.view as number[];
    const pageWidth = view[2] - view[0];
    const pageHeight = view[3] - view[1];
    const [x1, y1, x2, y2] = segment.bbox!;
    const evidenceWidth = segment.bboxEvidence?.pageWidth ?? pageWidth;
    const evidenceHeight = segment.bboxEvidence?.pageHeight ?? pageHeight;
    const scaleX = pageWidth / evidenceWidth;
    const scaleY = pageHeight / evidenceHeight;
    const left = Math.max(0, Math.floor(x1 * scaleX * 2));
    const right = Math.min(pageCanvas.width, Math.ceil(x2 * scaleX * 2));
    const topValue = segment.bboxEvidence?.coordinateOrigin === "bottom-left" ? pageHeight - y2 * scaleY : y1 * scaleY;
    const bottomValue = segment.bboxEvidence?.coordinateOrigin === "bottom-left" ? pageHeight - y1 * scaleY : y2 * scaleY;
    const top = Math.max(0, Math.floor(topValue * 2));
    const bottom = Math.min(pageCanvas.height, Math.ceil(bottomValue * 2));
    if (right <= left || bottom <= top)
      throw new Error("图片裁剪范围未命中原始 PDF");
    const crop = createCanvas(right - left, bottom - top);
    crop.getContext("2d").drawImage(
      pageCanvas,
      left,
      top,
      right - left,
      bottom - top,
      0,
      0,
      right - left,
      bottom - top,
    );
    const pageRenderBytes = pageCanvas.toBuffer("image/png");
    page.cleanup();
    const bytes = crop.toBuffer("image/png");
    return {
      dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
      bytes,
      mimeType: "image/png",
      source: "pdf_crop",
      page: segment.page!,
      pageRenderBytes,
      pageRenderPage: segment.page!,
    };
  } finally {
    await pdf.destroy();
  }
}

function validBbox(value: readonly number[] | null | undefined): value is readonly [number, number, number, number] {
  return Boolean(
    value &&
    value.length === 4 &&
    value.every(Number.isFinite) &&
    value[2] > value[0] &&
    value[3] > value[1],
  );
}
