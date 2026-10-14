import { createHash, randomBytes } from "node:crypto";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export type SpuCategory = {
  id: string;
  name: string;
  code: string;
  createdAt: string;
};

export type SpuRecord = {
  spuId: string;
  productName: string;
  categoryId: string;
  categoryCode: string;
  brand: string;
  modelSeries: string;
  creationRequestId: string;
  createdAt: string;
};

export type SpuCatalog = {
  contractVersion: "spu-catalog-1";
  categories: SpuCategory[];
  spus: SpuRecord[];
};

export type SpuDraft = {
  productName: string;
  categoryId: string;
  brand?: string;
  modelSeries?: string;
};

export function emptySpuCatalog(): SpuCatalog {
  return { contractVersion: "spu-catalog-1", categories: [], spus: [] };
}

export function suggestCategoryCode(name: string): string {
  const words = name.toUpperCase().match(/[A-Z]+/g) ?? [];
  const joined = words.join("");
  if (joined.length >= 2) return joined.slice(0, 8);
  const digest = createHash("sha256").update(name.trim()).digest();
  return `CAT${[...digest.subarray(0, 5)].map((value) => String.fromCharCode(65 + value % 26)).join("")}`;
}

export function createSpuCategory(
  catalog: SpuCatalog,
  input: { name: string; code: string },
  now = new Date().toISOString(),
): SpuCategory {
  const name = input.name.trim();
  const code = input.code.trim().toUpperCase();
  if (!name) throw new Error("类目名称不能为空");
  if (!/^[A-Z]{2,8}$/.test(code)) throw new Error("类目编码必须是 2～8 位大写英文字母");
  const sameName = catalog.categories.find((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (sameName) {
    if (sameName.code !== code) throw new Error(`类目“${name}”已经使用编码 ${sameName.code}`);
    return sameName;
  }
  const sameCode = catalog.categories.find((item) => item.code === code);
  if (sameCode) throw new Error(`类目编码 ${code} 已被“${sameCode.name}”使用`);
  const category = { id: `CAT-${code}`, name, code, createdAt: now };
  catalog.categories.push(category);
  return category;
}

export function previewSpu(
  catalog: SpuCatalog,
  input: SpuDraft,
  random = randomBytes,
): { candidateSpuId: string; matches: SpuRecord[] } {
  const draft = normalizeSpuDraft(catalog, input);
  return {
    candidateSpuId: generateSpuId(catalog, draft.category.code, random),
    matches: searchSpus(catalog, {
      query: [draft.productName, draft.brand, draft.modelSeries].filter(Boolean).join(" "),
      categoryId: draft.category.id,
      limit: 3,
    }),
  };
}

export function createSpu(
  catalog: SpuCatalog,
  input: SpuDraft & { creationRequestId: string; candidateSpuId?: string },
  options: { now?: string; random?: typeof randomBytes } = {},
): { spu: SpuRecord; reused: boolean } {
  const creationRequestId = input.creationRequestId.trim();
  if (!creationRequestId) throw new Error("creationRequestId 不能为空");
  const existing = catalog.spus.find((item) => item.creationRequestId === creationRequestId);
  if (existing) return { spu: existing, reused: true };
  const draft = normalizeSpuDraft(catalog, input);
  const candidate = input.candidateSpuId?.trim().toUpperCase();
  const candidatePattern = new RegExp(`^SPU-${draft.category.code}-[${CROCKFORD_BASE32}]{8}$`);
  const candidateAvailable = candidate && candidatePattern.test(candidate) &&
    !catalog.spus.some((item) => item.spuId === candidate);
  const spu: SpuRecord = {
    spuId: candidateAvailable ? candidate : generateSpuId(catalog, draft.category.code, options.random ?? randomBytes),
    productName: draft.productName,
    categoryId: draft.category.id,
    categoryCode: draft.category.code,
    brand: draft.brand,
    modelSeries: draft.modelSeries,
    creationRequestId,
    createdAt: options.now ?? new Date().toISOString(),
  };
  catalog.spus.push(spu);
  return { spu, reused: false };
}

export function searchSpus(
  catalog: SpuCatalog,
  input: { query?: string; categoryId?: string; limit?: number },
): SpuRecord[] {
  const terms = normalizeSearch(input.query ?? "").split(" ").filter(Boolean);
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  return catalog.spus
    .filter((spu) => !input.categoryId || spu.categoryId === input.categoryId)
    .map((spu) => ({ spu, score: scoreSpu(spu, terms) }))
    .filter((entry) => !terms.length || entry.score > 0)
    .sort((left, right) => right.score - left.score || right.spu.createdAt.localeCompare(left.spu.createdAt) || left.spu.spuId.localeCompare(right.spu.spuId))
    .slice(0, limit)
    .map((entry) => entry.spu);
}

function normalizeSpuDraft(catalog: SpuCatalog, input: SpuDraft) {
  const productName = input.productName.trim();
  if (!productName) throw new Error("商品名称不能为空");
  const category = catalog.categories.find((item) => item.id === input.categoryId);
  if (!category) throw new Error("商品大类不存在");
  return {
    productName,
    category,
    brand: input.brand?.trim() ?? "",
    modelSeries: input.modelSeries?.trim() ?? "",
  };
}

function generateSpuId(catalog: SpuCatalog, categoryCode: string, random: typeof randomBytes): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const bytes = random(8);
    const shortCode = [...bytes].map((value) => CROCKFORD_BASE32[value % CROCKFORD_BASE32.length]).join("");
    const spuId = `SPU-${categoryCode}-${shortCode}`;
    if (!catalog.spus.some((item) => item.spuId === spuId)) return spuId;
  }
  throw new Error("无法生成唯一 SPU ID");
}

function normalizeSearch(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function scoreSpu(spu: SpuRecord, terms: string[]): number {
  if (!terms.length) return 1;
  const values = [spu.spuId, spu.productName, spu.brand, spu.modelSeries].map(normalizeSearch);
  return terms.reduce((total, term) => {
    const best = Math.max(...values.map((value, index) => {
      if (!value) return 0;
      if (value === term) return index === 1 ? 100 : 80;
      if (value.startsWith(term)) return index === 1 ? 60 : 45;
      return value.includes(term) ? (index === 1 ? 35 : 20) : 0;
    }));
    return total + best;
  }, 0);
}
