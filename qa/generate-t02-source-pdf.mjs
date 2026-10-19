import { writeFileSync } from "node:fs";

const objects = [];
const add = (body) => (objects.push(body), objects.length);
const pageCount = 23;
const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
const streams = Array.from({ length: pageCount }, (_, index) => {
  const text = `Chunk Lab T02 fixture page ${index + 1}`;
  return add(`<< /Length ${text.length + 47} >>\nstream\nBT /F1 16 Tf 72 720 Td (${text}) Tj ET\nendstream`);
});
const pagesId = 2 + pageCount * 2;
const pageIds = streams.map((stream) =>
  add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`),
);
add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

let pdf = "%PDF-1.4\n";
const offsets = [0];
objects.forEach((body, index) => {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
});
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

writeFileSync(new URL("./fixtures/t02-source.pdf", import.meta.url), pdf);
