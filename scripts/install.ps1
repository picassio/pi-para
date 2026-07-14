# pi-para — Interactive Setup (Windows)
# Usage:
#   irm https://raw.githubusercontent.com/picassio/pi-para/main/scripts/install.ps1 | iex

Write-Host ""
Write-Host "  🗂️  pi-para — Setup" -ForegroundColor Cyan
Write-Host "  ──────────────────"
Write-Host ""

$package = "pi-para"
$packageLatest = "$package@latest"
# qmd-engine (embedded search SDK) requires Node >= 22.
$minMajor = 22

$nodeVer = (node -v 2>$null) -replace '^v',''
if (-not $nodeVer) {
    Write-Host "  ✗ Node.js not found on PATH." -ForegroundColor Red
    Write-Host "  Install Node.js (>= $minMajor) from https://nodejs.org, then re-run." -ForegroundColor Yellow
    exit 1
}

$parts = $nodeVer.Split('.')
$major = [int]$parts[0]
if ($major -lt $minMajor) {
    Write-Host "  ✗ Node.js $nodeVer is too old (pi-para requires Node >= $minMajor)" -ForegroundColor Red
    Write-Host "  Upgrade Node.js: https://nodejs.org" -ForegroundColor Yellow
    exit 1
}

# Resolve npx.cmd explicitly. Bare `npx` resolves to npx.ps1, which fails
# under restricted PowerShell execution policies.
$npx = $null
$npxCmd = Get-Command npx.cmd -ErrorAction SilentlyContinue
if ($npxCmd) {
    $npx = $npxCmd.Source
} else {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) {
        $candidate = Join-Path (Split-Path $nodeCmd.Source) "npx.cmd"
        if (Test-Path $candidate) { $npx = $candidate }
    }
}
if (-not $npx) {
    Write-Host "  ✗ npx.cmd not found." -ForegroundColor Red
    Write-Host "  Install Node.js (>= $minMajor) from https://nodejs.org, then re-run." -ForegroundColor Yellow
    exit 1
}

Write-Host "  → Using $npx (Node $nodeVer)" -ForegroundColor Gray
Write-Host ""

# Always pin @latest so npx does a registry lookup instead of reusing an older
# cached package.
& $npx -y $packageLatest setup @args
exit $LASTEXITCODE
