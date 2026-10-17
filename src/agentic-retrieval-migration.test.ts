import assert from "node:assert/strict";
import { agenticRetrievalMigrationStatements } from "./agentic-retrieval-migration.js";

const sql = agenticRetrievalMigrationStatements(1024).join("\n");
assert.match(sql, /rag\.vector_records_v2_d1024/);
assert.match(sql, /vector\(1024\)/);
assert.match(sql, /USING hnsw/);
assert.match(sql, /retrieval_key text NOT NULL UNIQUE/);
assert.match(sql, /USING bm25/);
assert.match(sql, /key_field = 'retrieval_key'/);
assert.match(sql, /d\.status = 'active' AND c\.status = 'active'/);
assert.match(sql, /metadata_json::jsonb/);
assert.match(sql, /public\.rag_chunks/);
assert.match(sql, /public\.rag_index_documents/);
assert.doesNotMatch(sql, /vector_snapshots|vector_currents/);
assert.doesNotMatch(sql, /ILIKE/);
assert.throws(() => agenticRetrievalMigrationStatements(0), /dimension/);

console.log("Agentic retrieval migration contract tests passed");
