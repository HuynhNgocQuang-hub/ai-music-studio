<#
.SYNOPSIS
  Khoi dong Full-Stack AI Music Studio (Redis + Audio Worker + Spring Boot Backend :8000 + Vite Frontend :3000)
#>
$ErrorActionPreference = 'Stop'
$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RootDir

# 1. Load .env into current session
$EnvFile = Join-Path $RootDir '.env'
if (Test-Path $EnvFile) {
  Get-Content $EnvFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#')) { return }
    $idx = $line.IndexOf('=')
    if ($idx -gt 0) {
      $k = $line.Substring(0, $idx).Trim()
      $v = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
      [Environment]::SetEnvironmentVariable($k, $v, 'Process')
    }
  }
}

$RedisPort = if ($env:REDIS_HOST_PORT) { $env:REDIS_HOST_PORT } else { '16379' }
if (-not $env:REDIS_URL) { $env:REDIS_URL = "redis://127.0.0.1:${RedisPort}/0" }
if (-not $env:AUDIO_WORKER_URL) { $env:AUDIO_WORKER_URL = 'http://127.0.0.1:8001' }
if (-not $env:SERVER_PORT) { $env:SERVER_PORT = '8000' }

Write-Host "==> 1/4 Khoi dong Docker Stack 'music' (Redis :${RedisPort} + Audio DSP Worker :8001)..." -ForegroundColor Cyan
docker info --format '{{.ServerVersion}}' *> $null
if ($LASTEXITCODE -ne 0) {
  throw "Docker Desktop chua chay. Vui long mo Docker Desktop truoc khi chay script nay."
}

# Clean up any legacy standalone Redis container so everything stays in Compose stack 'music'
$oldIso = docker ps -a --filter "name=^/ai-music-redis-iso$" --format "{{.Names}}"
if ($oldIso) {
  docker rm -f ai-music-redis-iso *> $null
}

docker compose -p music up -d redis audio-worker
if ($LASTEXITCODE -ne 0) {
  throw "Khong the khoi dong Docker Compose (redis, audio-worker)."
}

Write-Host "==> 2/4 Kiem tra Spring Boot Backend JAR (:8000)..." -ForegroundColor Cyan
$JarPath = Join-Path $RootDir 'backend\target\ai-music-studio-backend-1.0.0.jar'
$needsJarBuild = -not (Test-Path $JarPath)
if (-not $needsJarBuild) {
  $jarTime = (Get-Item $JarPath).LastWriteTimeUtc
  $latestSrc = Get-ChildItem (Join-Path $RootDir 'backend\src'), (Join-Path $RootDir 'backend\pom.xml') -Recurse -File |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if ($latestSrc -and $latestSrc.LastWriteTimeUtc -gt $jarTime) {
    $needsJarBuild = $true
  }
}
if ($needsJarBuild) {
  Write-Host "Dang build backend JAR moi nhat (mvn -DskipTests package)..." -ForegroundColor Yellow
  Push-Location (Join-Path $RootDir 'backend')
  mvn -q -DskipTests package
  if ($LASTEXITCODE -ne 0) { Pop-Location; throw "Maven build backend that bai." }
  Pop-Location
}

Write-Host "==> 3/4 Khoi dong Spring Boot Backend (http://127.0.0.1:$($env:SERVER_PORT))..." -ForegroundColor Cyan
$beAlive = $false
try {
  $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$($env:SERVER_PORT)/api/health" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
  if ($resp.StatusCode -eq 200) { $beAlive = $true }
} catch { }
if ($beAlive) {
  if ($needsJarBuild) {
    Write-Host "Canh bao: Backend cu dang chiem cong $($env:SERVER_PORT); hay dung process cu va chay lai neu muon nap JAR vua build." -ForegroundColor Yellow
  } else {
    Write-Host "Backend Spring Boot da chay san tren cong $($env:SERVER_PORT)." -ForegroundColor DarkGreen
  }
} else {
  Start-Process -FilePath 'java' -ArgumentList '-jar', $JarPath -WorkingDirectory $RootDir -WindowStyle Normal
}

Write-Host "==> 4/4 Khoi dong React + Vite Frontend (http://127.0.0.1:3000)..." -ForegroundColor Cyan
$FrontendDir = Join-Path $RootDir 'frontend'
if (-not (Test-Path (Join-Path $FrontendDir 'node_modules'))) {
  npm.cmd --prefix $FrontendDir install
}
Write-Host ""
Write-Host "AI Music Studio Full-Stack san sang tai: http://127.0.0.1:3000" -ForegroundColor Green
Write-Host "API Backend: http://127.0.0.1:8000  |  Audio DSP Worker: http://127.0.0.1:8001" -ForegroundColor Gray
npm.cmd --prefix $FrontendDir run dev -- --host 127.0.0.1
