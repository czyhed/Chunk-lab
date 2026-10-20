import { readFile, writeFile } from "node:fs/promises";
const path = "output/parse-cache-acceptance/acceptance.json";
const evidence = JSON.parse(await readFile(path, "utf8"));
const baseUrl = process.env.PARSE_CACHE_BASE_URL || "http://127.0.0.1:3137";
for (const item of evidence.uploads) {
  const response = await fetch(`${baseUrl}/api/batches/${item.batchId}`);
  if (!response.ok) continue;
  const batch = await response.json();
  const document = batch.documents.find((candidate) => candidate.id === item.documentId);
  if (!document) continue;
  item.parseCacheStatus = document.parseCacheStatus;
  item.parseCacheReused = document.parseCacheReused === true;
  item.mineruBatchId = document.sourceContract?.parseJobId ?? item.mineruBatchId;
  item.state = document.state;
  item.publicAssetReferences = [document.parsedDocumentAssetRef, document.mineruResultAssetRef].filter(Boolean);
}
evidence.acceptance.sameContentDifferentName = evidence.uploads[1].parseCacheReused === true;
evidence.acceptance.sharedMineruBatchForReuse = evidence.uploads[0].mineruBatchId === evidence.uploads[1].mineruBatchId;
evidence.refreshedAt = new Date().toISOString();
await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(JSON.stringify(evidence, null, 2));
