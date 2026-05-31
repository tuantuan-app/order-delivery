# ==========================================================
# Community Delivery backend - one-shot deploy (ASCII-only for PS 5.1 safety)
# Prereq (one-time, Google-enforced, only you can do):
#   1) Open https://script.google.com/home/usersettings -> turn ON "Google Apps Script API"
#   2) Run once:  clasp login
# Then this script: install clasp -> create project -> push -> deploy web app
#   -> write /exec URL into ../js/config.js -> health check
# ==========================================================
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:Path = "$env:APPDATA\npm;$env:Path"

# 1) ensure clasp
if (-not (Get-Command clasp -ErrorAction SilentlyContinue)) {
  Write-Host "Installing @google/clasp ..." -ForegroundColor Yellow
  npm install -g @google/clasp
}

# 2) ensure logged in (clasp v3)
$authed = $false
try { $u = (clasp show-authorized-user 2>$null | Out-String); if ($u -match '@') { $authed = $true } } catch {}
if (-not $authed -and (Test-Path "$HOME\.clasprc.json")) { $authed = $true }
if (-not $authed) {
  Write-Host "Not logged in. Run:  clasp login   then re-run this script." -ForegroundColor Red
  exit 1
}

# 3) create project if .clasp.json is placeholder/missing
$claspJson = if (Test-Path .clasp.json) { Get-Content .clasp.json -Raw } else { '' }
if ($claspJson -notmatch 'scriptId"\s*:\s*"[A-Za-z0-9_\-]{20,}') {
  if (Test-Path .clasp.json) { Remove-Item .clasp.json -Force }
  Write-Host "Creating new Apps Script project ..." -ForegroundColor Yellow
  clasp create --type standalone --title "Community Delivery Backend"
}

# 4) push code
Write-Host "Pushing code ..." -ForegroundColor Yellow
clasp push -f

# 5) deploy web app
Write-Host "Deploying web app ..." -ForegroundColor Yellow
$deployOut = (clasp deploy -d ("web app " + (Get-Date -Format "yyyyMMdd-HHmm"))) 2>&1 | Out-String
Write-Host $deployOut

# 6) parse /exec URL
$m = [regex]::Match($deployOut, 'AKfyc[A-Za-z0-9_\-]+')
if (-not $m.Success) {
  Write-Host "Could not parse deployment id. Run 'clasp deployments' and paste the /exec URL into ../js/config.js manually." -ForegroundColor Red
  exit 1
}
$execUrl = "https://script.google.com/macros/s/$($m.Value)/exec"
Write-Host "Web App URL: $execUrl" -ForegroundColor Green

# 7) write into ../js/config.js
$cfg = Join-Path $PSScriptRoot "..\js\config.js"
(Get-Content $cfg -Raw) -replace "apiBase:\s*'[^']*'", "apiBase: '$execUrl'" | Set-Content $cfg -Encoding utf8
Write-Host "Updated ../js/config.js apiBase" -ForegroundColor Green

# 8) health check (first call may need one-time browser authorization)
Write-Host "Health check ..." -ForegroundColor Yellow
try {
  $r = Invoke-RestMethod -Uri $execUrl -Method Get -TimeoutSec 25
  Write-Host ("Backend says: " + ($r | ConvertTo-Json -Compress)) -ForegroundColor Green
  Write-Host "DONE. Frontend is wired to the live backend." -ForegroundColor Green
} catch {
  Write-Host "Health check not OK yet (usually needs one-time authorization)." -ForegroundColor Yellow
  Write-Host "Open this URL once in a browser to authorize, or run setupSheet in the editor:" -ForegroundColor Yellow
  Write-Host "    $execUrl" -ForegroundColor Cyan
}
