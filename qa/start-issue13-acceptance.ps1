param(
  [int]$Port = 4410,
  [int]$FakeModelPort = 4565
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$evidence = Join-Path $root "output\issue13-database-persistence"
New-Item -ItemType Directory -Force -Path $evidence | Out-Null

$minioAccessKey = [Environment]::GetEnvironmentVariable("MINIO_ACCESS_KEY", "User")
$minioSecretKey = [Environment]::GetEnvironmentVariable("MINIO_SECRET_KEY", "User")
$pgUser = [Environment]::GetEnvironmentVariable("RAG_PG_USER", "User")
$pgPassword = [Environment]::GetEnvironmentVariable("RAG_PG_PASSWORD", "User")
$pgDatabase = [Environment]::GetEnvironmentVariable("RAG_PG_DATABASE", "User")
if (-not $minioAccessKey -or -not $minioSecretKey -or -not $pgUser -or -not $pgPassword -or -not $pgDatabase) {
  throw "Local acceptance credentials are not configured"
}

$node = (Get-Command node).Source
$env:MODEL_FAKE_PORT = [string]$FakeModelPort
$fake = Start-Process -FilePath $node -ArgumentList @("qa/fake-model-server.mjs") -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $evidence "fake-model.stdout.log") -RedirectStandardError (Join-Path $evidence "fake-model.stderr.log") -PassThru

$env:NODE_ENV = "test"
$env:PORT = [string]$Port
$env:WORKSPACE_ROOT = Join-Path $root ".workspace\issue13-database"
$env:MINIO_ACCESS_KEY = $minioAccessKey
$env:MINIO_SECRET_KEY = $minioSecretKey
$env:RAG_PG_USER = $pgUser
$env:RAG_PG_PASSWORD = $pgPassword
$env:RAG_PG_DATABASE = $pgDatabase
$fakeKey = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(12))
$env:MODEL_PROFILES_JSON = ConvertTo-Json @(@{
  id = "fake-vlm"; name = "本地 Fake VLM"; capabilities = @("vlm", "context")
  baseUrl = "http://127.0.0.1:$FakeModelPort/v1"; apiKey = $fakeKey
  model = "deterministic-image-summary"; timeoutMs = 30000
}) -Compress
$env:DATABASE_PROFILES_JSON = ConvertTo-Json @(@{
  id = "local-pgvector"; name = "本地 PostgreSQL + pgvector"; kind = "pgvector"
  host = "127.0.0.1"; port = 54329; databaseEnv = "RAG_PG_DATABASE"
  userEnv = "RAG_PG_USER"; passwordEnv = "RAG_PG_PASSWORD"
  fakeFailureMode = "second-once"
}) -Compress
$app = Start-Process -FilePath $node -ArgumentList @("node_modules/tsx/dist/cli.mjs", "src/server.ts") -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $evidence "app.stdout.log") -RedirectStandardError (Join-Path $evidence "app.stderr.log") -PassThru

$deadline = (Get-Date).AddSeconds(30)
do {
  Start-Sleep -Milliseconds 500
  try { $healthy = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/api/health").StatusCode -eq 200 } catch { $healthy = $false }
} until ($healthy -or (Get-Date) -gt $deadline)

[pscustomobject]@{
  FakeModelStarted = -not $fake.HasExited
  AppStarted = -not $app.HasExited
  AppHealthy = $healthy
  DatabaseProfile = "local-pgvector"
  DatabasePort = 54329
} | ConvertTo-Json -Compress
