const ROTATIONS = new Set([0, 90, 180, 270]);

export function mapTrustedBbox(input) {
  const page = Number.isSafeInteger(input.page) && input.page > 0 ? input.page : null;
  if (page === null) return { quality: "unavailable", page };
  const evidence = input.evidence;
  if (!evidence || !input.bbox) return { quality: "page_only", page };
  if (evidence.page !== page) return { quality: "page_only", page };
  if (input.sourceDocumentVersion !== input.current.sourceDocumentVersion) return { quality: "unavailable", page };
  if (input.sourceViewKind === "visual_copy" && (!input.visualCopyVersion || evidence.visualCopyVersion !== input.current.visualCopyVersion || input.visualCopyVersion !== input.current.visualCopyVersion)) return { quality: "unavailable", page };
  if (input.sourceViewKind === "original_file" && evidence.sourceDocumentVersion !== input.current.sourceDocumentVersion) return { quality: "unavailable", page };
  if (!validEvidence(evidence) || !validGeometry(input.pageGeometry)) return { quality: "unavailable", page };
  if (evidence.orientation !== input.pageGeometry.rotation) return { quality: "unavailable", page };
  const [left, top, right, bottom] = input.bbox;
  if (!input.bbox.every(Number.isFinite) || left < 0 || top < 0 || right <= left || bottom <= top || right > evidence.pageWidth || bottom > evidence.pageHeight) return { quality: "page_only", page };
  const media = evidence.mediaBox || input.pageGeometry.mediaBox;
  const crop = evidence.cropBox || input.pageGeometry.cropBox;
  if (!validBox(media) || !validBox(crop) || !boxInside(crop, media)) return { quality: "unavailable", page };
  const corners = [[left, top], [right, top], [right, bottom], [left, bottom]];
  const mediaCorners = corners.map(([x, y]) => applyTransform([x, evidence.coordinateOrigin === "bottom-left" ? y : evidence.pageHeight - y], evidence.transform));
  if (mediaCorners.some(([x, y]) => x < media[0] || x > media[2] || y < media[1] || y > media[3])) return { quality: "page_only", page };
  const width = crop[2] - crop[0], height = crop[3] - crop[1];
  const local = mediaCorners.map(([x, y]) => [x - crop[0], crop[3] - y]);
  if (local.some(([x, y]) => x < 0 || x > width || y < 0 || y > height)) return { quality: "page_only", page };
  const rotated = local.map(([x, y]) => rotatePoint(x, y, width, height, input.pageGeometry.rotation));
  const rotatedWidth = input.pageGeometry.rotation === 90 || input.pageGeometry.rotation === 270 ? height : width;
  const rotatedHeight = input.pageGeometry.rotation === 90 || input.pageGeometry.rotation === 270 ? width : height;
  const box = bounds(rotated);
  const cssBox = box.map((value, index) => value * (index % 2 === 0 ? input.pageGeometry.cssWidth / rotatedWidth : input.pageGeometry.cssHeight / rotatedHeight));
  return { quality: "exact", page, cssBox, deviceBox: cssBox.map((value) => value * input.pageGeometry.devicePixelRatio), pageCssWidth: input.pageGeometry.cssWidth, pageCssHeight: input.pageGeometry.cssHeight };
}

export function normalizeTrustedBbox(input) {
  const mapped = mapTrustedBbox(input);
  if (mapped.quality !== "exact") return null;
  return [
    mapped.cssBox[0] / mapped.pageCssWidth,
    mapped.cssBox[1] / mapped.pageCssHeight,
    mapped.cssBox[2] / mapped.pageCssWidth,
    mapped.cssBox[3] / mapped.pageCssHeight,
  ];
}

function validEvidence(e) { return Number.isFinite(e.pageWidth) && e.pageWidth > 0 && Number.isFinite(e.pageHeight) && e.pageHeight > 0 && typeof e.coordinateUnit === "string" && e.coordinateUnit.length > 0 && ROTATIONS.has(e.orientation) && Array.isArray(e.transform) && e.transform.length === 6 && e.transform.every(Number.isFinite) && typeof e.mappingVersion === "string" && e.mappingVersion.length > 0; }
function validGeometry(g) { return validBox(g.mediaBox) && validBox(g.cropBox) && ROTATIONS.has(g.rotation) && Number.isFinite(g.cssWidth) && g.cssWidth > 0 && Number.isFinite(g.cssHeight) && g.cssHeight > 0 && Number.isFinite(g.devicePixelRatio) && g.devicePixelRatio > 0; }
function validBox(b) { return Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[2] > b[0] && b[3] > b[1]; }
function boxInside(a, b) { return a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3]; }
function applyTransform([x, y], [a, b, c, d, e, f]) { return [a * x + c * y + e, b * x + d * y + f]; }
function rotatePoint(x, y, width, height, rotation) { if (rotation === 90) return [height - y, x]; if (rotation === 180) return [width - x, height - y]; if (rotation === 270) return [y, width - x]; return [x, y]; }
function bounds(points) { return [Math.min(...points.map(([x]) => x)), Math.min(...points.map(([, y]) => y)), Math.max(...points.map(([x]) => x)), Math.max(...points.map(([, y]) => y))]; }
