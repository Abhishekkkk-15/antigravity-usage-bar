<#
.SYNOPSIS
  Installer script for Antigravity Multi-Account Usage Bar (agy-usage) on Windows.
.DESCRIPTION
  Installs agy-usage globally, configures command wrappers, and updates the user PATH.
#>

$ErrorActionPreference = 'Stop'

function Write-Info($msg) { Write-Host "  $msg" -ForegroundColor Cyan }
function Write-Success($msg) { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function Write-Err($msg) { Write-Host "  [ERROR] $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "✦ Antigravity Usage Bar (agy-usage) Installer" -ForegroundColor Magenta
Write-Host "------------------------------------------------" -ForegroundColor DarkGray

# 1. Check Node.js
try {
    $nodeVersionRaw = & node -v 2>$null
    if (-not $nodeVersionRaw) {
        throw "Node.js not found on PATH"
    }
    $nodeVer = [int]($nodeVersionRaw.TrimStart('v').Split('.')[0])
    if ($nodeVer -lt 18) {
        Write-Err "Node.js version 18+ required (detected $nodeVersionRaw)."
        exit 1
    }
    Write-Success "Found Node.js ($nodeVersionRaw)"
} catch {
    Write-Err "Node.js is not installed or not in PATH. Please install Node.js 18+ from https://nodejs.org/"
    exit 1
}

# 2. Determine installation source and target directory
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $scriptDir -or -not (Test-Path "$scriptDir\cli.mjs")) {
    $scriptDir = (Get-Location).Path
}

$installDir = Join-Path $env:USERPROFILE ".antigravity-usage"
$binDir = Join-Path $installDir "bin"
$appDir = Join-Path $installDir "app"

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
New-Item -ItemType Directory -Force -Path $appDir | Out-Null

# 3. Copy files to app directory
Write-Info "Installing application files to $appDir..."
Copy-Item -Path "$scriptDir\cli.mjs" -Destination "$appDir\cli.mjs" -Force
Copy-Item -Path "$scriptDir\package.json" -Destination "$appDir\package.json" -Force
Copy-Item -Path "$scriptDir\src" -Destination "$appDir" -Recurse -Force

# 4. Create Windows CMD and PowerShell wrappers in bin directory
$cmdWrapperContent = "@echo off`r`nnode `"%~dp0..\app\cli.mjs`" %*"
$psWrapperContent = "& node `"`$PSScriptRoot\..\app\cli.mjs`" `$args"

Set-Content -Path (Join-Path $binDir "agy-usage.cmd") -Value $cmdWrapperContent -Encoding ASCII
Set-Content -Path (Join-Path $binDir "antigravity-usage.cmd") -Value $cmdWrapperContent -Encoding ASCII
Set-Content -Path (Join-Path $binDir "agy-usage.ps1") -Value $psWrapperContent -Encoding UTF8
Set-Content -Path (Join-Path $binDir "antigravity-usage.ps1") -Value $psWrapperContent -Encoding UTF8

Write-Success "Created command wrappers (agy-usage, antigravity-usage)"

# 5. Add bin directory to User PATH if not already present
$userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
$pathParts = $userPath -split ';' | Where-Object { $_ -ne '' }
if ($pathParts -notcontains $binDir) {
    Write-Info "Adding $binDir to User PATH..."
    $newUserPath = ($pathParts + $binDir) -join ';'
    [Environment]::SetEnvironmentVariable("PATH", $newUserPath, "User")
    $env:PATH = "$env:PATH;$binDir"
    Write-Success "User PATH updated"
} else {
    Write-Success "$binDir is already in User PATH"
}

# 6. Verify installation
Write-Host ""
Write-Success "Installation successful!"
Write-Host ""
Write-Host "Commands available in your terminal:" -ForegroundColor White
Write-Host "  agy-usage status     - Show active accounts & session limits" -ForegroundColor Gray
Write-Host "  agy-usage watch      - Live dashboard auto-refreshed in terminal" -ForegroundColor Gray
Write-Host "  agy-usage switch     - Switch active Antigravity account" -ForegroundColor Gray
Write-Host "  agy-usage add        - Track current logged-in Antigravity account" -ForegroundColor Gray
Write-Host ""
Write-Host "Tip: Restart any open terminal windows to ensure PATH changes take effect." -ForegroundColor Cyan
Write-Host ""
