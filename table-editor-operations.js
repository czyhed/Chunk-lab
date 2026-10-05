export function tablePlacements(model) {
  const occupied = [];
  return (model.rows ?? []).map((row, rowIndex) => {
    let columnIndex = 0;
    return row.map((cell) => {
      while (occupied[rowIndex]?.[columnIndex]) columnIndex++;
      const placement = { cell, rowIndex, columnIndex };
      for (let rowOffset = 0; rowOffset < (cell.rowSpan ?? 1); rowOffset++) {
        occupied[rowIndex + rowOffset] ??= [];
        for (let columnOffset = 0; columnOffset < (cell.colSpan ?? 1); columnOffset++)
          occupied[rowIndex + rowOffset][columnIndex + columnOffset] = true;
      }
      columnIndex += cell.colSpan ?? 1;
      return placement;
    });
  });
}

export function selectedTablePlacement(model, selected) {
  if (selected.size !== 1) return null;
  return tablePlacements(model).flat().find(({ cell }) => selected.has(cell.cellId)) ?? null;
}

export function insertTableRow(model, selected, direction, createCell) {
  const anchor = selectedTablePlacement(model, selected);
  if (!anchor) return "请只选择一个单元格作为插入行的位置。";
  if (model.rows.some((row) => row.some((cell) => (cell.rowSpan ?? 1) > 1)))
    return "表格包含跨行合并单元格，请先拆分后再插入行。";
  const insertAt = anchor.rowIndex + (direction === "after" ? 1 : 0);
  const group = (model.rowGroups ?? []).find((item) => anchor.rowIndex >= item.rowStart && anchor.rowIndex < item.rowStart + item.rowCount);
  model.rows.splice(insertAt, 0, model.columns.map(() => createCell(model)));
  if (group) group.rowCount++;
  (model.rowGroups ?? []).filter((item) => item !== group && item.rowStart >= insertAt).forEach((item) => item.rowStart++);
  selected.clear();
  selected.add(model.rows[insertAt][Math.min(anchor.columnIndex, model.columns.length - 1)].cellId);
  return null;
}

export function insertTableColumn(model, selected, direction, createCell) {
  const anchor = selectedTablePlacement(model, selected);
  if (!anchor) return "请只选择一个单元格作为插入列的位置。";
  if (hasMergedCells(model)) return "表格包含合并单元格，请先拆分后再插入列。";
  const insertAt = anchor.columnIndex + (direction === "after" ? 1 : 0);
  model.columns.splice(insertAt, 0, `列 ${insertAt + 1}`);
  model.rows.forEach((row) => row.splice(insertAt, 0, createCell(model)));
  selected.clear();
  selected.add(model.rows[anchor.rowIndex][insertAt].cellId);
  return null;
}

export function removeSelectedTableColumn(model, selected) {
  const anchor = selectedTablePlacement(model, selected);
  if (!anchor) return "请只选择一个单元格来指定要删除的列。";
  if (model.columns.length <= 1) return "表格至少需要一列。";
  if (hasMergedCells(model)) return "表格包含合并单元格，请先拆分后再删除列。";
  model.columns.splice(anchor.columnIndex, 1);
  model.rows.forEach((row) => row.splice(anchor.columnIndex, 1));
  selected.clear();
  const nextColumn = Math.min(anchor.columnIndex, model.columns.length - 1);
  selected.add(model.rows[anchor.rowIndex][nextColumn].cellId);
  return null;
}

function hasMergedCells(model) {
  return model.rows.some((row) => row.some((cell) => (cell.rowSpan ?? 1) > 1 || (cell.colSpan ?? 1) > 1));
}
