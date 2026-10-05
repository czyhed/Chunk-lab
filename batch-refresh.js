export function shouldLoadSelectedFile({
  previousSelectedFileId,
  nextSelectedFileId,
  previousSelectedState,
  nextSelectedState,
}) {
  if (!nextSelectedFileId || previousSelectedFileId !== nextSelectedFileId) return Boolean(nextSelectedFileId);
  return previousSelectedState !== nextSelectedState;
}
