import assert from "node:assert/strict";
import {
  DATABASE_SCHEMA_VERSION,
  migrationStatements,
  TABLE_RETRIEVAL_SCHEMA_VERSION,
  tableBundleIndexName,
  tableBundleTableName,
  tableRetrievalMigrationStatements,
  vectorIndexName,
  vectorTableName,
} from "./database-schema.js";

assert.equal(DATABASE_SCHEMA_VERSION, "2.0");
assert.equal(TABLE_RETRIEVAL_SCHEMA_VERSION, "2.1");
assert.equal(vectorTableName(1536), "vector_records_v2_d1536");
assert.equal(vectorIndexName(1536), "vector_records_v2_d1536_embedding_cosine_idx");
assert.equal(tableBundleTableName(1536), "table_retrieval_bundles_v1_d1536");
assert.equal(tableBundleIndexName(1536), "table_retrieval_bundles_v1_d1536_embedding_cosine_idx");
const statements = migrationStatements(1536).join("\n");
assert.match(statements, /vector\(1536\)/);
assert.match(statements, /vector_cosine_ops/);
assert.match(statements, /retrieval_key/);
assert.match(statements, /USING bm25/);
assert.doesNotMatch(statements, /vector_snapshots|vector_currents/);
assert.match(statements, /schema_migrations/);
assert.match(statements, /FOREIGN KEY \(target_id, document_id\)/);
assert.match(statements, /deleted_at/);
assert.match(statements, /rag\.deletion_audit/);
assert.match(statements, /soft_delete/);
assert.match(statements, /physical_delete/);
assert.match(statements, /2\.0-gc-audit-v1/);
assert.match(statements, /ON CONFLICT \(version\) DO NOTHING/);
const tableStatements = tableRetrievalMigrationStatements(1536).join("\n");
assert.match(tableStatements, /table_artifacts/);
assert.match(tableStatements, /table_version_source_chunks/);
assert.match(tableStatements, /vector\(1536\)/);
assert.match(tableStatements, /embedding_input_hash/);
assert.match(tableStatements, /vector_ready/);
assert.match(tableStatements, /2\.1-table-retrieval-v1-d1536/);
assert.doesNotMatch(tableStatements, /rawTableHtml/);
assert.throws(() => vectorTableName(0), /dimension/);
assert.throws(() => migrationStatements(1.5), /dimension/);

console.log("Database schema migration contract tests passed");
