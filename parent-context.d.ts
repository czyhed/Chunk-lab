import type { Chunk } from "./src/chunking.js";
export function parentContextFor(chunk: Chunk, siblings?: readonly Chunk[]): Chunk["parentChunk"];
