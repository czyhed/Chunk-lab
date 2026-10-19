import { writeFileSync } from "node:fs";

const objects = [];
const add = (body) => (objects.push(body), objects.length);
const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
const pageText = [
  "A1 Ecommerce Appliance Manual - Safety and Installation",
  "A1 Parameters - Voltage 220V / Power 1200W / Warranty 24 months",
];
const streams = pageText.map((text, index) => add(`<< /Length ${text.length + 47} >>\nstream\nBT /F1 16 Tf 72 760 Td (${text}) Tj ET\nendstream`));
const pagesId = 6;
const pageIds = streams.map((stream, index) => add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`));
add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
let pdf = "%PDF-1.4\n";
const offsets = [0];
objects.forEach((body, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; });
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(new URL("./v21-source-sample.pdf", import.meta.url), pdf);
