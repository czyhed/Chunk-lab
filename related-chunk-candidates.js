export function relatedChunkCandidates(chunks, targetChunkId, options = {}) {
  const query = String(options.query ?? "").trim().toLocaleLowerCase();
  const limit = options.limit ?? 10;
  const indexedCandidates = chunks.map((candidate, index) => ({ candidate, index })).filter(({ candidate }) => {
    if (candidate.id === targetChunkId || candidate.type !== "text" || candidate.excluded || !candidate.finalText?.trim()) return false;
    if (options.requireEmbeddingEligibility && (candidate.embeddingEligible !== true || (candidate.embeddingExclusionReasons ?? []).length)) return false;
    return true;
  });

  if (query) {
    return indexedCandidates
      .filter(({ candidate }) => `${candidate.id}\n${candidate.finalText}`.toLocaleLowerCase().includes(query))
      .slice(0, limit)
      .map(({ candidate }) => candidate);
  }

  const targetIndex = chunks.findIndex((candidate) => candidate.id === targetChunkId);
  if (targetIndex < 0) return indexedCandidates.slice(0, limit).map(({ candidate }) => candidate);

  const before = indexedCandidates.filter((item) => item.index < targetIndex).slice(-(options.before ?? 3));
  const after = indexedCandidates.filter((item) => item.index > targetIndex).slice(0, options.after ?? 3);
  const chosenIds = new Set([...before, ...after].map(({ candidate }) => candidate.id));
  const selectedIds = new Set(options.selectedIds ?? []);

  if (options.adjacentOnly) {
    const visibleIds = new Set(indexedCandidates
      .filter(({ candidate }) => selectedIds.has(candidate.id))
      .slice(0, limit)
      .map(({ candidate }) => candidate.id));
    const nearest = [...before, ...after].sort((left, right) =>
      Math.abs(left.index - targetIndex) - Math.abs(right.index - targetIndex) || left.index - right.index);
    for (const { candidate } of nearest) {
      if (visibleIds.size >= limit) break;
      visibleIds.add(candidate.id);
    }
    return indexedCandidates.filter(({ candidate }) => visibleIds.has(candidate.id)).map(({ candidate }) => candidate);
  }

  for (const { candidate } of indexedCandidates) {
    if (chosenIds.size >= limit) break;
    if (selectedIds.has(candidate.id)) chosenIds.add(candidate.id);
  }

  const nearest = indexedCandidates
    .filter(({ candidate }) => !chosenIds.has(candidate.id))
    .sort((left, right) => Math.abs(left.index - targetIndex) - Math.abs(right.index - targetIndex) || left.index - right.index);
  for (const { candidate } of nearest) {
    if (chosenIds.size >= limit) break;
    chosenIds.add(candidate.id);
  }

  return indexedCandidates.filter(({ candidate }) => chosenIds.has(candidate.id)).map(({ candidate }) => candidate);
}
