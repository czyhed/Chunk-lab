import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { strToU8, zipSync } from "fflate";

const target = resolve("output/t01-upload-mineru/fixtures");
await mkdir(target, { recursive: true });

for (const name of ["ok.pdf", "browser-slow.pdf", "retry-once.pdf", "remote-fail.pdf"]) {
  await copyFile(resolve("qa/v21-source-sample.pdf"), resolve(target, name));
}

await copyFile(resolve("qa/ecommerce-upload-sample.md"), resolve(target, "local.md"));
await writeFile(resolve(target, "unsupported.xyz"), "unsupported fixture", "utf8");

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>T01 Office parse fixture</w:t></w:r></w:p><w:sectPr/></w:body>
</w:document>`;
const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
const relationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
await writeFile(
  resolve(target, "office.docx"),
  Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8(contentTypes),
      "_rels/.rels": strToU8(relationships),
      "word/document.xml": strToU8(documentXml),
    }),
  ),
);

console.log(target);
