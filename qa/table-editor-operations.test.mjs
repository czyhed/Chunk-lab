import assert from "node:assert/strict";
import { insertTableColumn, insertTableRow, removeSelectedTableColumn } from "../table-editor-operations.js";

const createModel = () => ({
  columns: ["A", "B", "C"],
  rows: [
    [cell("a1"), cell("b1"), cell("c1")],
    [cell("a2"), cell("b2"), cell("c2")],
    [cell("a3"), cell("b3"), cell("c3")],
  ],
  rowGroups: [
    { rowGroupId: "g1", rowStart: 0, rowCount: 2 },
    { rowGroupId: "g2", rowStart: 2, rowCount: 1 },
  ],
});
let sequence = 0;
const createCell = () => cell(`new-${++sequence}`);

const rowModel = createModel();
const rowSelection = new Set(["b2"]);
assert.equal(insertTableRow(rowModel, rowSelection, "before", createCell), null);
assert.equal(rowModel.rows[1][1].cellId, [...rowSelection][0]);
assert.deepEqual(rowModel.rowGroups.map(({ rowStart, rowCount }) => ({ rowStart, rowCount })), [{ rowStart: 0, rowCount: 3 }, { rowStart: 3, rowCount: 1 }]);

const rowAfterModel = createModel();
const rowAfterSelection = new Set(["b2"]);
assert.equal(insertTableRow(rowAfterModel, rowAfterSelection, "after", createCell), null);
assert.equal(rowAfterModel.rows[2][1].cellId, [...rowAfterSelection][0]);
assert.equal(rowAfterModel.rows[1][1].cellId, "b2");

const columnModel = createModel();
const columnSelection = new Set(["b2"]);
assert.equal(insertTableColumn(columnModel, columnSelection, "before", createCell), null);
assert.equal(columnModel.columns.length, 4);
assert.equal(columnModel.rows[1][1].cellId, [...columnSelection][0]);
assert.equal(removeSelectedTableColumn(columnModel, columnSelection), null);
assert.deepEqual(columnModel.columns, ["A", "B", "C"]);
assert.equal(columnModel.rows[1][1].cellId, "b2");

const columnAfterModel = createModel();
const columnAfterSelection = new Set(["b2"]);
assert.equal(insertTableColumn(columnAfterModel, columnAfterSelection, "after", createCell), null);
assert.equal(columnAfterModel.rows[1][2].cellId, [...columnAfterSelection][0]);
assert.equal(columnAfterModel.rows[1][1].cellId, "b2");
assert.equal(columnAfterModel.rows[1][3].cellId, "c2");

const ambiguous = createModel();
assert.match(insertTableRow(ambiguous, new Set(["a1", "b1"]), "after", createCell), /只选择一个/);

const merged = createModel();
merged.rows[0][0].colSpan = 2;
assert.match(insertTableColumn(merged, new Set(["a1"]), "after", createCell), /先拆分/);

console.log("Table editor position operations passed");

function cell(cellId) {
  return { cellId, text: cellId, rowSpan: 1, colSpan: 1 };
}
