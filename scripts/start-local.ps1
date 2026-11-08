$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

function Stop-WithMessage([string]$Message) {
    Write-Host "`nERROR: $Message" -ForegroundColor Red
    exit 1
}

Write-Host 'Ligo Cash-In - entorno local' -ForegroundColor Cyan
Write-Host "Project: $ProjectRoot"

$node = Get-Command node -ErrorAction SilentlyContinue
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $node) { Stop-WithMessage 'Node.js not found. Install Node.js 22.12 or newer.' }
if (-not $npm) { Stop-WithMessage 'npm not found. Reinstall Node.js with npm included.' }
if (-not $docker) { Stop-WithMessage 'Docker not found. Install and start Docker Desktop.' }

$nodeVersionText = (& node -p 'process.versions.node').Trim()
try { $nodeVersion = [version]$nodeVersionText } catch { Stop-WithMessage "Could not read the Node.js version: $nodeVersionText" }
if ($nodeVersion -lt [version]'22.12') { Stop-WithMessage "Node.js $nodeVersionText is unsupported; version 22.12 or newer is required." }

& docker info *> $null
if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'Docker is installed, but its engine is not running. Start Docker Desktop and run this file again.' }

if (-not (Test-Path '.env')) {
    Copy-Item '.env.example' '.env'
    Write-Host 'Created .env from the local example configuration.' -ForegroundColor DarkGray
}
$port = 3000
$portLine = Select-String -Path '.env' -Pattern '^PORT=(\d+)$' | Select-Object -First 1
if ($portLine -and $portLine.Matches[0].Groups[1].Success) {
    $port = [int]$portLine.Matches[0].Groups[1].Value
}

if (-not (Test-Path 'node_modules/.bin/tsx.cmd')) {
    Write-Host 'Installing project dependencies...'
    & $npm.Source ci
    if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'Dependency installation failed.' }
}

Write-Host 'Starting PostgreSQL...'
& docker compose up -d postgres
if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'Could not start PostgreSQL with Docker Compose.' }

$ready = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    & docker compose exec -T postgres pg_isready -U challenge -d ligo_cash_in *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 2
}
if (-not $ready) { Stop-WithMessage 'PostgreSQL did not become ready within 120 seconds.' }

Write-Host 'Applying database migrations...'
& $npm.Source run migrate
if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'Database migration failed.' }

Write-Host 'Preparing the demo wallet...'
& $npm.Source run seed
if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'Demo data preparation failed.' }

if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    Stop-WithMessage "Port $port is already in use. Change PORT in .env and run the executable again."
}

Write-Host "`nAPI ready at http://localhost:$port" -ForegroundColor Green
Write-Host 'Press Ctrl+C to stop the API. PostgreSQL will keep running in Docker.'
& $npm.Source start
exit $LASTEXITCODE
