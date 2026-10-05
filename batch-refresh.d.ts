export function shouldLoadSelectedFile(input: {
  previousSelectedFileId: string | null;
  nextSelectedFileId: string | null | undefined;
  previousSelectedState: string | null;
  nextSelectedState: string | null | undefined;
}): boolean;
