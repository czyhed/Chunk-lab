/** Resolve context from the current draft, so excluded or revised children cannot leak stale text. */
export function parentContextFor(chunk, siblings) {
  const parent = chunk.parentChunk;
  if (!parent) return undefined;
  if (!siblings) return structuredClone(parent);
  const active = siblings.filter((item) => item.parentChunk?.id === parent.id && !item.excluded);
  if (active.length === parent.childCount && active.every((item) => item.finalText === item.automaticText && !item.revisions.length))
    return structuredClone(parent);
  let text = "";
  const sourceSegments = [];
  let previous;
  for (const child of active) {
    const next = child.finalText;
    if (!next.trim()) continue;
    let overlap = 0;
    if (previous?.finalText === previous?.automaticText && next === child.automaticText) {
      for (const segment of child.sourceSegments) {
        if (!segment.isOverlap || segment.chunkStart !== overlap || !previous?.sourceSegments.some(candidate =>
          candidate.blockId === segment.blockId && candidate.sourceStart <= segment.sourceStart && candidate.sourceEnd >= segment.sourceEnd)) break;
        overlap = segment.chunkEnd;
      }
      if (!text.endsWith(next.slice(0, overlap))) overlap = 0;
    }
    const separator = text && !overlap ? "\n\n" : "";
    const offset = text.length + separator.length;
    text += separator + next.slice(overlap);
    for (const segment of child.sourceSegments) {
      const exactOffsets = [segment.sourceStart, segment.sourceEnd, segment.chunkStart, segment.chunkEnd].every(Number.isInteger);
      if (next !== child.automaticText || !exactOffsets) {
        sourceSegments.push({ ...structuredClone(segment), chunkStart: offset, chunkEnd: text.length, mappingQuality: "block-only", isOverlap: false });
      } else if (segment.chunkEnd > overlap) {
        const start = Math.max(segment.chunkStart, overlap);
        sourceSegments.push({ ...structuredClone(segment), sourceStart: segment.sourceStart + start - segment.chunkStart,
          chunkStart: offset + start - overlap, chunkEnd: offset + segment.chunkEnd - overlap, isOverlap: false });
      }
    }
    previous = child;
  }
  return { ...structuredClone(parent), text, childCount: active.length, sourceSegments };
}
