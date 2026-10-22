param(
  [Parameter(Mandatory = $true)]
  [string]$BackupPath,
  [Parameter(Mandatory = $true)]
  [string]$RestoreDatabase
)

$ErrorActionPreference = "Stop"
if ($RestoreDatabase -notmatch '^rag_restore_[A-Za-z0-9_]+$') {
  throw "RestoreDatabase must use the dedicated rag_restore_ prefix"
}

$resolvedBackup = [System.IO.Path]::GetFullPath($BackupPath)
$backupParent = Split-Path -Parent $resolvedBackup
New-Item -ItemType Directory -Force -Path $backupParent | Out-Null
if (Test-Path -LiteralPath $resolvedBackup) {
  throw "BackupPath already exists; refusing to overwrite it"
}

$container = "rag-postgres"
$status = docker inspect -f '{{.State.Health.Status}}' $container
if ($LASTEXITCODE -ne 0 -or $status -ne "healthy") {
  throw "rag-postgres is not healthy"
}

$pgUser = docker exec $container sh -lc 'printf "%s" "$POSTGRES_USER"'
$pgDatabase = docker exec $container sh -lc 'printf "%s" "$POSTGRES_DB"'
if ($LASTEXITCODE -ne 0 -or -not $pgUser -or -not $pgDatabase) {
  throw "Failed to resolve non-secret PostgreSQL container identity"
}
$existing = docker exec $container psql -U $pgUser -d postgres -Atqc "SELECT 1 FROM pg_database WHERE datname='$RestoreDatabase'"
if ($LASTEXITCODE -ne 0) { throw "Failed to inspect restore database" }
if ($existing -eq "1") { throw "Dedicated restore database already exists; refusing to overwrite it" }

$containerBackup = "/tmp/rag-storage-restore.dump"
docker exec $container pg_dump -U $pgUser -d $pgDatabase -Fc -f $containerBackup
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed" }
docker cp "${container}:${containerBackup}" $resolvedBackup
if ($LASTEXITCODE -ne 0) { throw "docker cp backup failed" }

docker exec $container createdb -U $pgUser $RestoreDatabase
if ($LASTEXITCODE -ne 0) { throw "createdb failed" }
docker exec $container pg_restore -U $pgUser -d $RestoreDatabase $containerBackup
if ($LASTEXITCODE -ne 0) { throw "pg_restore failed" }

$verification = docker exec $container psql -U $pgUser -d $RestoreDatabase -Atqc "SELECT count(*) FROM rag.schema_migrations"
if ($LASTEXITCODE -ne 0) { throw "restore verification failed" }
$recordCount = docker exec $container psql -U $pgUser -d $RestoreDatabase -Atqc "SELECT count(*) FROM rag.vector_records_v2_d1024"
if ($LASTEXITCODE -ne 0) { throw "restored record verification failed" }
$indexValid = docker exec $container psql -U $pgUser -d $RestoreDatabase -Atqc "SELECT indisvalid FROM pg_index WHERE indexrelid='rag.vector_records_v2_d1024_embedding_cosine_idx'::regclass"
if ($LASTEXITCODE -ne 0 -or $indexValid -ne "t") { throw "restored index verification failed" }
$auditTableExists = docker exec $container psql -U $pgUser -d $RestoreDatabase -Atqc "SELECT to_regclass('rag.deletion_audit') IS NOT NULL"
$auditMigrationRows = docker exec $container psql -U $pgUser -d $RestoreDatabase -Atqc "SELECT count(*) FROM rag.schema_migrations WHERE version='2.0-gc-audit-v1'"
$deletionAuditRows = docker exec $container psql -U $pgUser -d $RestoreDatabase -Atqc "SELECT count(*) FROM rag.deletion_audit"
if ($LASTEXITCODE -ne 0 -or $auditTableExists -ne "t" -or $auditMigrationRows -ne "1") {
  throw "restored deletion audit contract verification failed"
}

[pscustomobject]@{
  backupCreated = Test-Path -LiteralPath $resolvedBackup
  restoreDatabase = $RestoreDatabase
  migrationRows = [int]$verification
  vectorRecordRows = [int]$recordCount
  vectorIndexValid = $true
  deletionAuditTableExists = $true
  auditMigrationRows = [int]$auditMigrationRows
  deletionAuditRows = [int]$deletionAuditRows
  sourceContainer = $container
} | ConvertTo-Json -Compress
