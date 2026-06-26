# pi-para — Interactive Setup (Windows)
# Usage:
#   irm https://raw.githubusercontent.com/picassio/pi-para/main/scripts/install.ps1 | iex

Write-Host ""
Write-Host "  🗂️  pi-para — Setup" -ForegroundColor Cyan
Write-Host "  ──────────────────"
Write-Host ""

$package = "pi-para"
$packageLatest = "$package@latest"
$minMajor = 20
$minMinor = 12

if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
    Write-Host "  ✗ npx not found." -ForegroundColor Red
    Write-Host ""
    Write-Host "  Install Node.js (>= $minMajor.$minMinor) from https://nodejs.org, then re-run." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

$nodeVer = (node -v 2>$null) -replace '^v',''
if (-not $nodeVer) {
    Write-Host "  ✗ Node.js not found on PATH." -ForegroundColor Red
    Write-Host "  Install Node.js (>= $minMajor.$minMinor) from https://nodejs.org, then re-run." -ForegroundColor Yellow
    exit 1
}

$parts = $nodeVer.Split('.')
$major = [int]$parts[0]
$minor = [int]$parts[1]
if ($major -lt $minMajor -or ($major -eq $minMajor -and $minor -lt $minMinor)) {
    Write-Host "  ✗ Node.js $nodeVer is too old (requires >= $minMajor.$minMinor)" -ForegroundColor Red
    Write-Host "  Upgrade Node.js: https://nodejs.org" -ForegroundColor Yellow
    exit 1
}

Write-Host "  → Using npx (Node $nodeVer)" -ForegroundColor Gray
Write-Host ""

# Always pin @latest so npx does a registry lookup instead of reusing an older
# cached package.
& npx -y $packageLatest setup @args
