param(
  [int]$Port = 4400,
  [int]$FakeModelPort = 4555
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$evidence = Join-Path $root "output\issue10-image-reference-vlm"
New-Item -ItemType Directory -Force -Path $evidence | Out-Null

$minioAccessKey = [Environment]::GetEnvironmentVariable(
  "MINIO_ACCESS_KEY",
  "User"
)
$minioSecretKey = [Environment]::GetEnvironmentVariable(
  "MINIO_SECRET_KEY",
  "User"
)
if (-not $minioAccessKey -or -not $minioSecretKey) {
  throw "Local MinIO credentials are not configured"
}

$node = (Get-Command node).Source
$env:MODEL_FAKE_PORT = [string]$FakeModelPort
$fake = Start-Process `
  -FilePath $node `
  -ArgumentList @("qa/fake-model-server.mjs") `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $evidence "fake-model.stdout.log") `
  -RedirectStandardError (Join-Path $evidence "fake-model.stderr.log") `
  -PassThru

$env:NODE_ENV = "test"
$env:PORT = [string]$Port
$env:WORKSPACE_ROOT = Join-Path $root ".workspace\issue10-real-minio"
$env:MINIO_ACCESS_KEY = $minioAccessKey
$env:MINIO_SECRET_KEY = $minioSecretKey
$fakeKey = [Convert]::ToHexString(
  [Security.Cryptography.RandomNumberGenerator]::GetBytes(12)
)
$profile = @{
  id = "fake-vlm"
  name = "本地 Fake VLM"
  capabilities = @("vlm", "context")
  baseUrl = "http://127.0.0.1:$FakeModelPort/v1"
  apiKey = $fakeKey
  model = "deterministic-image-summary"
  timeoutMs = 30000
}
$env:MODEL_PROFILES_JSON = ConvertTo-Json @($profile) -Compress
$app = Start-Process `
  -FilePath $node `
  -ArgumentList @("node_modules/tsx/dist/cli.mjs", "src/server.ts") `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $evidence "app.stdout.log") `
  -RedirectStandardError (Join-Path $evidence "app.stderr.log") `
  -PassThru

$deadline = (Get-Date).AddSeconds(30)
do {
  Start-Sleep -Milliseconds 500
  try {
    $healthy = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/api/health").StatusCode -eq 200
  } catch {
    $healthy = $false
  }
} until ($healthy -or (Get-Date) -gt $deadline)

[pscustomobject]@{
  FakeModelStarted = -not $fake.HasExited
  AppStarted = -not $app.HasExited
  AppHealthy = $healthy
} | ConvertTo-Json -Compress
