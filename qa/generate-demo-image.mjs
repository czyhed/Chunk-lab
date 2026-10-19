import { writeFileSync } from "node:fs";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
writeFileSync(new URL("./fixtures/demo-source.png", import.meta.url), Buffer.from(png, "base64"));
