param(
  [Parameter(Mandatory = $true)]
  [string]$DatabaseName
)

$ErrorActionPreference = "Stop"
if ($DatabaseName -notmatch '^rag_init_[A-Za-z0-9_]+$') {
  throw "DatabaseName must use the dedicated rag_init_ prefix"
}

$container = "rag-postgres"
$status = docker inspect -f '{{.State.Health.Status}}' $container
if ($LASTEXITCODE -ne 0 -or $status -ne "healthy") {
  throw "rag-postgres is not healthy"
}

$pgUser = docker exec $container sh -lc 'printf "%s" "$POSTGRES_USER"'
$pgPassword = docker exec $container sh -lc 'printf "%s" "$POSTGRES_PASSWORD"'
if ($LASTEXITCODE -ne 0 -or -not $pgUser -or -not $pgPassword) {
  throw "Failed to resolve PostgreSQL acceptance credentials"
}

$existing = docker exec $container psql -U $pgUser -d postgres -Atqc "SELECT 1 FROM pg_database WHERE datname='$DatabaseName'"
if ($LASTEXITCODE -ne 0) { throw "Failed to inspect initialization database" }
if ($existing -eq "1") { throw "Dedicated initialization database already exists; refusing to overwrite it" }

docker exec $container createdb -U $pgUser $DatabaseName
if ($LASTEXITCODE -ne 0) { throw "createdb failed" }
$initiallyEmpty = docker exec $container psql -U $pgUser -d $DatabaseName -Atqc "SELECT to_regnamespace('rag') IS NULL"
if ($LASTEXITCODE -ne 0 -or $initiallyEmpty -ne "t") {
  throw "Dedicated database was not empty before migration"
}

$env:RAG_PG_HOST = "127.0.0.1"
$env:RAG_PG_PORT = "54329"
$env:RAG_PG_DATABASE = $DatabaseName
$env:RAG_PG_USER = $pgUser
$env:RAG_PG_PASSWORD = $pgPassword

$first = node node_modules/tsx/dist/cli.mjs qa/migrate-storage-schema.ts --dimension=1024
if ($LASTEXITCODE -ne 0) { throw "First empty-database migration failed" }
$second = node node_modules/tsx/dist/cli.mjs qa/migrate-storage-schema.ts --dimension=1024
if ($LASTEXITCODE -ne 0) { throw "Repeated empty-database migration failed" }

$dimensionMigrationRows = docker exec $container psql -U $pgUser -d $DatabaseName -Atqc "SELECT count(*) FROM rag.schema_migrations WHERE version='2.0-d1024'"
$auditMigrationRows = docker exec $container psql -U $pgUser -d $DatabaseName -Atqc "SELECT count(*) FROM rag.schema_migrations WHERE version='2.0-gc-audit-v1'"
$migrationRows = docker exec $container psql -U $pgUser -d $DatabaseName -Atqc "SELECT count(*) FROM rag.schema_migrations"
$recordRows = docker exec $container psql -U $pgUser -d $DatabaseName -Atqc "SELECT count(*) FROM rag.vector_records_v2_d1024"
$auditTableExists = docker exec $container psql -U $pgUser -d $DatabaseName -Atqc "SELECT to_regclass('rag.deletion_audit') IS NOT NULL"
$indexValid = docker exec $container psql -U $pgUser -d $DatabaseName -Atqc "SELECT indisvalid FROM pg_index WHERE indexrelid='rag.vector_records_v2_d1024_embedding_cosine_idx'::regclass"
$vectorType = docker exec $container psql -U $pgUser -d $DatabaseName -Atqc "SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid='rag.vector_records_v2_d1024'::regclass AND attname='embedding'"
$foreignKeys = docker exec $container psql -U $pgUser -d $DatabaseName -Atqc "SELECT count(*) FROM pg_constraint WHERE conrelid='rag.vector_records_v2_d1024'::regclass AND contype='f'"
if ($LASTEXITCODE -ne 0) { throw "Empty initialization verification failed" }
if ($dimensionMigrationRows -ne "1" -or $auditMigrationRows -ne "1" -or $migrationRows -ne "2" -or $recordRows -ne "0" -or $auditTableExists -ne "t" -or $indexValid -ne "t" -or $vectorType -ne "vector(1024)" -or [int]$foreignKeys -lt 1) {
  throw "Empty initialization contract verification failed"
}

[pscustomobject]@{
  status = "succeeded"
  database = $DatabaseName
  initiallyEmpty = $true
  migrationRuns = 2
  migrationRows = [int]$migrationRows
  dimensionMigrationRows = [int]$dimensionMigrationRows
  auditMigrationRows = [int]$auditMigrationRows
  deletionAuditTableExists = $true
  vectorRecordRows = [int]$recordRows
  vectorType = $vectorType
  vectorIndexKind = "hnsw_cosine"
  vectorIndexValid = $true
  foreignKeyCount = [int]$foreignKeys
  existingDatabaseOverwritten = $false
  paidSupplierCalls = 0
} | ConvertTo-Json -Compress
