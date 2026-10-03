export function pdfPagePlan(
  pages: readonly number[],
  currentPage: number,
): number[] {
  if (!pages.length) return [];
  const selected = pages.includes(currentPage) ? currentPage : pages[0];
  return pages.filter((page) => Math.abs(page - selected) <= 1);
}
