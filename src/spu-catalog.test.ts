import assert from "node:assert/strict";
import {
  createSpu,
  createSpuCategory,
  emptySpuCatalog,
  previewSpu,
  searchSpus,
  suggestCategoryCode,
} from "./spu-catalog.js";

const catalog = emptySpuCatalog();
assert.equal(suggestCategoryCode("mouse"), "MOUSE");
assert.match(suggestCategoryCode("鼠标"), /^[A-Z]{8}$/);

const category = createSpuCategory(catalog, { name: "鼠标", code: "mouse" }, "2026-08-26T00:00:00.000Z");
assert.equal(category.id, "CAT-MOUSE");
assert.equal(createSpuCategory(catalog, { name: "鼠标", code: "MOUSE" }), category);
assert.throws(() => createSpuCategory(catalog, { name: "键盘", code: "MOUSE" }), /已被/);

const deterministic = () => Buffer.alloc(8, 1);
const preview = previewSpu(catalog, { productName: "毒蝰 V3 Pro", categoryId: category.id }, deterministic);
assert.equal(preview.candidateSpuId, "SPU-MOUSE-11111111");
assert.equal(catalog.spus.length, 0, "preview must not persist the SPU");

const created = createSpu(catalog, {
  productName: "毒蝰 V3 Pro",
  categoryId: category.id,
  brand: "Razer",
  modelSeries: "Viper V3 Pro",
  candidateSpuId: preview.candidateSpuId,
  creationRequestId: "request-1",
}, { now: "2026-08-26T01:00:00.000Z", random: deterministic });
assert.equal(created.reused, false);
assert.equal(created.spu.spuId, preview.candidateSpuId);

const invalidCandidate = createSpu(catalog, {
  productName: "毒蝰 V3 Pro SE",
  categoryId: category.id,
  candidateSpuId: "SPU-MOUSE-ABC",
  creationRequestId: "request-invalid-candidate",
}, { random: () => Buffer.alloc(8, 2) });
assert.equal(invalidCandidate.spu.spuId, "SPU-MOUSE-22222222");

const retried = createSpu(catalog, {
  productName: "ignored on retry",
  categoryId: category.id,
  creationRequestId: "request-1",
}, { random: deterministic });
assert.equal(retried.reused, true);
assert.equal(retried.spu.spuId, created.spu.spuId);

for (let index = 0; index < 4; index += 1) {
  createSpu(catalog, {
    productName: `毒蝰 V3 Pro ${index}`,
    categoryId: category.id,
    creationRequestId: `duplicate-${index}`,
  });
}
assert.equal(searchSpus(catalog, { query: "毒蝰", categoryId: category.id, limit: 3 }).length, 3);
assert.equal(previewSpu(catalog, { productName: "毒蝰 V3 Pro", categoryId: category.id }).matches.length, 3);

console.log("SPU catalog tests passed");
