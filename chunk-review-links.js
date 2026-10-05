function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function sourceIdsForChunk(chunk) {
  return unique([
    ...(chunk?.sourceSegments ?? []).map(
      (segment) => segment.contentBlockId ?? segment.blockId,
    ),
    ...(chunk?.manualAnnotationIds ?? []),
  ]);
}

function chunkIdsForSources(chunks, sourceIds) {
  const selected = new Set(sourceIds);
  return chunks
    .filter((chunk) =>
      sourceIdsForChunk(chunk).some((sourceId) => selected.has(sourceId)),
    )
    .map((chunk) => chunk.id);
}

export function linkedTargetsForSource(chunks, sourceId) {
  const chunkIds = chunkIdsForSources(chunks, [sourceId]);
  return {
    chunkIds,
    primaryChunkId: chunkIds[0] ?? null,
    missing: chunkIds.length === 0,
  };
}

export function linkedTargetsForChunk(chunks, chunkId) {
  const chunk = chunks.find((candidate) => candidate.id === chunkId);
  const sourceIds = sourceIdsForChunk(chunk);
  const chunkIds = chunkIdsForSources(chunks, sourceIds);
  return {
    sourceIds,
    chunkIds: chunkIds.length ? chunkIds : chunk ? [chunk.id] : [],
    primaryChunkId: chunk ? chunk.id : null,
  };
}

export function scrollReviewTargetIntoView(element, block = "center") {
  if (!element || typeof element.scrollIntoView !== "function") return false;
  element.scrollIntoView({
    behavior: "smooth",
    block,
    inline: "nearest",
  });
  return true;
}

export function updateReviewLinkSelection(
  chunks,
  current,
  target,
  additive = false,
) {
  const previousSources = current?.sourceIds ?? [];
  let sourceIds;
  let preferredPrimary = current?.primaryChunkId ?? null;

  if (target.kind === "chunk") {
    const linked = linkedTargetsForChunk(chunks, target.id);
    if (!additive) {
      sourceIds = linked.sourceIds;
      preferredPrimary = linked.primaryChunkId;
    } else {
      const selected = new Set(previousSources);
      const remove = linked.sourceIds.length > 0 &&
        linked.sourceIds.every((sourceId) => selected.has(sourceId));
      for (const sourceId of linked.sourceIds) {
        if (remove) selected.delete(sourceId);
        else selected.add(sourceId);
      }
      sourceIds = [...selected];
      preferredPrimary = remove ? preferredPrimary : linked.primaryChunkId;
    }
  } else {
    if (!additive) sourceIds = [target.id];
    else {
      const selected = new Set(previousSources);
      if (selected.has(target.id)) selected.delete(target.id);
      else selected.add(target.id);
      sourceIds = [...selected];
    }
  }

  sourceIds = unique(sourceIds);
  const chunkIds = chunkIdsForSources(chunks, sourceIds);
  const missingSourceIds = sourceIds.filter(
    (sourceId) => linkedTargetsForSource(chunks, sourceId).missing,
  );
  const primaryChunkId = preferredPrimary && chunkIds.includes(preferredPrimary)
    ? preferredPrimary
    : chunkIds[0] ?? null;
  return { sourceIds, chunkIds, primaryChunkId, missingSourceIds };
}
