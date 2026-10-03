import type { Bbox, BboxEvidence, SourceViewKind } from "./v21-provenance.js";

export type PageBox = readonly [number, number, number, number];
export type PageGeometry = {
  mediaBox: PageBox;
  cropBox: PageBox;
  rotation: 0 | 90 | 180 | 270;
  cssWidth: number;
  cssHeight: number;
  devicePixelRatio: number;
};

export type BboxMappingInput = {
  sourceDocumentVersion: string;
  visualCopyVersion?: string;
  sourceViewKind: SourceViewKind;
  page: number | null;
  bbox: Bbox | null;
  evidence?: BboxEvidence & { coordinateOrigin?: "top-left" | "bottom-left"; mediaBox?: PageBox; cropBox?: PageBox };
  pageGeometry: PageGeometry;
  current: { sourceDocumentVersion: string; visualCopyVersion?: string };
};

export type BboxMapping =
  | { quality: "exact"; page: number; cssBox: [number, number, number, number]; deviceBox: [number, number, number, number]; pageCssWidth: number; pageCssHeight: number }
  | { quality: "page_only" | "parsed_only" | "unavailable"; page: number | null };

const rotations = new Set([0, 90, 180, 270]);

export function mapTrustedBbox(input: BboxMappingInput): BboxMapping {
  const page = Number.isSafeInteger(input.page) && input.page! > 0 ? input.page! : null;
  if (page === null) return { quality: "unavailable", page };
  const evidence = input.evidence;
  if (!evidence || !input.bbox) return { quality: "page_only", page };
  if (evidence.page !== page) return { quality: "page_only", page };
  if (
    input.sourceDocumentVersion !== input.current.sourceDocumentVersion ||
    (input.sourceViewKind === "visual_copy" &&
      (!input.visualCopyVersion || evidence.visualCopyVersion !== input.current.visualCopyVersion || input.visualCopyVersion !== input.current.visualCopyVersion)) ||
    (input.sourceViewKind === "original_file" && evidence.sourceDocumentVersion !== input.current.sourceDocumentVersion)
  ) return { quality: "unavailable", page };
  if (!validEvidence(evidence) || !validGeometry(input.pageGeometry)) return { quality: "unavailable", page };
  if (evidence.orientation !== input.pageGeometry.rotation) return { quality: "unavailable", page };
  const [left, top, right, bottom] = input.bbox;
  if (
    !input.bbox.every(Number.isFinite) ||
    left < 0 || top < 0 || right <= left || bottom <= top ||
    right > evidence.pageWidth || bottom > evidence.pageHeight
  ) return { quality: "page_only", page };

  const geometry = input.pageGeometry;
  const media = evidence.mediaBox ?? geometry.mediaBox;
  const crop = evidence.cropBox ?? geometry.cropBox;
  if (!validBox(media) || !validBox(crop) || !boxInside(crop, media)) return { quality: "unavailable", page };
  const sourceCorners = [[left, top], [right, top], [right, bottom], [left, bottom]];
  const mediaCorners = sourceCorners.map(([x, y]) => {
    const sourceY = evidence.coordinateOrigin === "bottom-left" ? y : evidence.pageHeight - y;
    return applyTransform([x, sourceY], evidence.transform);
  });
  if (mediaCorners.some(([x, y]) => x < media[0] || x > media[2] || y < media[1] || y > media[3]))
    return { quality: "page_only", page };
  const cropWidth = crop[2] - crop[0];
  const cropHeight = crop[3] - crop[1];
  const localCorners = mediaCorners.map(([x, y]) => [x - crop[0], crop[3] - y] as [number, number]);
  if (localCorners.some(([x, y]) => x < 0 || x > cropWidth || y < 0 || y > cropHeight))
    return { quality: "page_only", page };
  const rotated = localCorners.map(([x, y]) => rotatePoint(x, y, cropWidth, cropHeight, geometry.rotation));
  const rotatedWidth = geometry.rotation === 90 || geometry.rotation === 270 ? cropHeight : cropWidth;
  const rotatedHeight = geometry.rotation === 90 || geometry.rotation === 270 ? cropWidth : cropHeight;
  const cssScaleX = geometry.cssWidth / rotatedWidth;
  const cssScaleY = geometry.cssHeight / rotatedHeight;
  const box = bounds(rotated);
  const cssBox: [number, number, number, number] = box.map((value, index) => value * (index % 2 === 0 ? cssScaleX : cssScaleY)) as [number, number, number, number];
  const dpr = geometry.devicePixelRatio;
  return {
    quality: "exact",
    page,
    cssBox,
    deviceBox: cssBox.map((value) => value * dpr) as [number, number, number, number],
    pageCssWidth: geometry.cssWidth,
    pageCssHeight: geometry.cssHeight,
  };
}

function validEvidence(evidence: BboxEvidence): boolean {
  return Number.isFinite(evidence.pageWidth) && evidence.pageWidth > 0 && Number.isFinite(evidence.pageHeight) && evidence.pageHeight > 0 &&
    typeof evidence.coordinateUnit === "string" && evidence.coordinateUnit.length > 0 && rotations.has(evidence.orientation) &&
    evidence.transform.length === 6 && evidence.transform.every(Number.isFinite) && typeof evidence.mappingVersion === "string" && evidence.mappingVersion.length > 0;
}

function validGeometry(geometry: PageGeometry): boolean {
  return validBox(geometry.mediaBox) && validBox(geometry.cropBox) && rotations.has(geometry.rotation) &&
    Number.isFinite(geometry.cssWidth) && geometry.cssWidth > 0 && Number.isFinite(geometry.cssHeight) && geometry.cssHeight > 0 &&
    Number.isFinite(geometry.devicePixelRatio) && geometry.devicePixelRatio > 0;
}

function validBox(box: PageBox): boolean { return box.length === 4 && box.every(Number.isFinite) && box[2] > box[0] && box[3] > box[1]; }
function boxInside(inner: PageBox, outer: PageBox): boolean { return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3]; }
function applyTransform([x, y]: [number, number], [a, b, c, d, e, f]: readonly [number, number, number, number, number, number]): [number, number] { return [a * x + c * y + e, b * x + d * y + f]; }
function rotatePoint(x: number, y: number, width: number, height: number, rotation: number): [number, number] {
  if (rotation === 90) return [height - y, x];
  if (rotation === 180) return [width - x, height - y];
  if (rotation === 270) return [y, width - x];
  return [x, y];
}
function bounds(points: [number, number][]): [number, number, number, number] {
  return [Math.min(...points.map(([x]) => x)), Math.min(...points.map(([, y]) => y)), Math.max(...points.map(([x]) => x)), Math.max(...points.map(([, y]) => y))];
}
